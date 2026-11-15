import ICAL from 'ical.js';
import { Temporal } from '@js-temporal/polyfill';
import { calendarDate, type HassCalendarEvent } from './calendar';

import { type CalendarFeed, type CalendarRange } from './calendar-feed-types';
export * from './calendar-feed-types';
const unreadable = () =>
  new Error(
    'This link did not return a readable iCal calendar. Use the calendar’s iCal/ICS subscription address.',
  );

type IcalEvent = InstanceType<typeof ICAL.Event>;
type IcalTime = InstanceType<typeof ICAL.Time>;

// Give ical.js real timezone offsets when a provider omits VTIMEZONE. This
// makes recurrence IDs, EXDATE and duration calculations agree with rendering.
class IanaTimezone extends ICAL.Timezone {
  constructor(tzid: string) {
    super({ tzid });
  }
  override utcOffset(time: IcalTime): number {
    const fields = {
      year: time.year,
      month: time.month,
      day: time.day,
      hour: time.hour,
      minute: time.minute,
      second: time.second,
    };
    const zoned = Temporal.ZonedDateTime.from(
      { ...fields, timeZone: this.tzid },
      { overflow: 'reject', disambiguation: 'compatible' },
    );
    const wall = Temporal.ZonedDateTime.from(
      { ...fields, timeZone: 'UTC' },
      { overflow: 'reject' },
    );
    // Computing from wall and resolved instants also follows RFC 5545's rule
    // for nonexistent spring times (use the offset before the gap).
    return (wall.epochMilliseconds - zoned.epochMilliseconds) / 1000;
  }
}
const textProperty = (event: IcalEvent, name: string): string => {
  const value: unknown = event.component.getFirstPropertyValue(name);
  return typeof value === 'string' ? value : '';
};
function instant(time: IcalTime, event: IcalEvent, property: string): string {
  if (!(time instanceof ICAL.Time)) throw unreadable();
  if (time.isDate) return time.toString();
  const parameter: unknown = (
    event.component.getFirstProperty(property) ??
    event.component.getFirstProperty('dtstart')
  )?.getParameter('tzid');
  if (
    time.zone === ICAL.Timezone.localTimezone &&
    typeof parameter === 'string' &&
    parameter
  ) {
    // Some providers omit VTIMEZONE for standard IANA identifiers. Temporal uses
    // the device's timezone database, including DST, instead of treating them as local.
    const zoned = Temporal.ZonedDateTime.from(
      {
        timeZone: parameter,
        year: time.year,
        month: time.month,
        day: time.day,
        hour: time.hour,
        minute: time.minute,
        second: time.second,
      },
      { overflow: 'reject' },
    );
    return new Date(zoned.epochMilliseconds).toISOString();
  }
  return time.toJSDate().toISOString();
}

function occurrenceEnd(
  start: IcalTime,
  fallback: IcalTime,
  item: IcalEvent,
): string {
  const duration: unknown = item.component.getFirstPropertyValue('duration');
  if (duration instanceof ICAL.Duration) {
    if (duration.isNegative) throw unreadable();
    if (
      start.isDate &&
      (duration.hours || duration.minutes || duration.seconds)
    )
      throw unreadable();
    const nominal = start.clone();
    nominal.adjust(duration.weeks * 7 + duration.days, 0, 0, 0);
    if (start.isDate) return instant(nominal, item, 'dtstart');
    const exact =
      (duration.hours * 3600 + duration.minutes * 60 + duration.seconds) * 1000;
    return new Date(
      Date.parse(instant(nominal, item, 'dtstart')) + exact,
    ).toISOString();
  }
  if (!start.isDate && item.component.hasProperty('dtend')) {
    // DTEND defines an exact elapsed duration for every recurrence; ical.js
    // adds this duration in wall-clock fields, which differs at a DST change.
    const elapsed =
      Date.parse(instant(item.endDate, item, 'dtend')) -
      Date.parse(instant(item.startDate, item, 'dtstart'));
    return new Date(
      Date.parse(instant(start, item, 'dtstart')) + elapsed,
    ).toISOString();
  }
  return instant(fallback, item, 'dtend');
}

/** Parse in a dedicated worker in the app. No calendar contents become HTML. */
export function parseCalendarFeed(
  text: string,
  feed: Pick<CalendarFeed, 'id' | 'name'>,
  day: CalendarRange,
): HassCalendarEvent[] {
  if (text.length > 2 * 1024 * 1024 || !/^\s*BEGIN:VCALENDAR\s*$/im.test(text))
    throw unreadable();
  const dayStart = Date.parse(day.start);
  const dayEnd = Date.parse(day.end);
  if (
    !Number.isFinite(dayStart) ||
    !Number.isFinite(dayEnd) ||
    dayEnd <= dayStart
  )
    throw unreadable();
  const deadline = Date.now() + 5000;
  let steps = 0;
  const budget = () => {
    if (++steps > 100_000 || Date.now() > deadline)
      throw new Error(
        'This calendar has too many recurring occurrences to display.',
      );
  };
  const registered: string[] = [];
  try {
    const calendar = ICAL.Component.fromString(text);
    if (calendar.name !== 'vcalendar') throw unreadable();
    const components = calendar.getAllSubcomponents('vevent');
    for (const component of components) {
      for (const property of component.getAllProperties()) {
        budget();
        const tzid: unknown = property.getParameter('tzid');
        if (
          typeof tzid === 'string' &&
          tzid &&
          !calendar.getTimeZoneByID(tzid) &&
          !ICAL.TimezoneService.has(tzid)
        ) {
          Temporal.ZonedDateTime.from({
            timeZone: tzid,
            year: 2000,
            month: 1,
            day: 1,
          });
          ICAL.TimezoneService.register(new IanaTimezone(tzid), tzid);
          registered.push(tzid);
        }
      }
    }
    const items = components.map(
      (component) =>
        new ICAL.Event(component, { exceptions: [], strictExceptions: true }),
    );
    const grouped = new Map<string, IcalEvent[]>();
    for (const item of items) {
      budget();
      if (!item.uid) throw unreadable();
      const group = grouped.get(item.uid) ?? [];
      group.push(item);
      grouped.set(item.uid, group);
    }
    const result = new Map<string, HassCalendarEvent>();
    const append = (
      item: IcalEvent,
      start: IcalTime,
      end: IcalTime,
      occurrence: string,
    ) => {
      if (textProperty(item, 'status') === 'CANCELLED') return;
      const from = instant(start, item, 'dtstart');
      let until = occurrenceEnd(start, end, item);
      const fromMs = calendarDate(from).getTime();
      let untilMs = calendarDate(until).getTime();
      if (
        !Number.isFinite(fromMs) ||
        !Number.isFinite(untilMs) ||
        untilMs < fromMs
      )
        throw unreadable();
      // An RFC 5545 event with no end/duration is instantaneous. Give it one
      // minute on the timeline so its start remains visible.
      if (untilMs === fromMs) {
        untilMs += 60_000;
        until = new Date(untilMs).toISOString();
      }
      if (fromMs >= dayEnd || untilMs <= dayStart) return;
      const id = `feed:${feed.id}:${item.uid}:${occurrence}`;
      const location = textProperty(item, 'location');
      result.set(id, {
        id,
        entityId: `feed.${feed.id}`,
        calendarName: feed.name,
        summary: textProperty(item, 'summary') || 'Untitled event',
        start: from,
        end: until,
        allDay: start.isDate,
        ...(location ? { location } : {}),
      });
      if (result.size > 2000)
        throw new Error('This calendar has too many events in one day.');
    };
    for (const group of grouped.values()) {
      const master = group.find((item) => !item.isRecurrenceException());
      const exceptions = group.filter((item) => item.isRecurrenceException());
      if (master && textProperty(master, 'status') === 'CANCELLED') continue;
      // Include moved exceptions independently; their original recurrence can
      // lie beyond today's expansion window. The occurrence ID deduplicates them.
      for (const exception of exceptions) {
        if (textProperty(exception, 'status') === 'CANCELLED') {
          if (!exception.startDate)
            exception.startDate = exception.recurrenceId.clone();
        } else
          append(
            exception,
            exception.startDate,
            exception.endDate,
            instant(exception.recurrenceId, exception, 'recurrence-id'),
          );
      }
      if (!master || textProperty(master, 'status') === 'CANCELLED') continue;
      if (!(master.startDate instanceof ICAL.Time)) throw unreadable();
      for (const exception of exceptions) master.relateException(exception);
      if (!master.isRecurring()) {
        append(
          master,
          master.startDate,
          master.endDate,
          instant(master.startDate, master, 'dtstart'),
        );
        continue;
      }
      let shift = 0;
      for (const exception of exceptions) {
        if (exception.modifiesFuture())
          shift = Math.max(
            shift,
            Math.abs(
              Date.parse(instant(exception.startDate, exception, 'dtstart')) -
                Date.parse(
                  instant(exception.recurrenceId, exception, 'recurrence-id'),
                ),
            ),
          );
      }
      const iterator = master.iterator();
      for (
        let occurrence = iterator.next();
        occurrence;
        occurrence = iterator.next()
      ) {
        budget();
        const occurrenceId = instant(occurrence, master, 'dtstart');
        if (calendarDate(occurrenceId).getTime() > dayEnd + shift) break;
        const details = master.getOccurrenceDetails(occurrence);
        append(details.item, details.startDate, details.endDate, occurrenceId);
      }
    }
    return [...result.values()].sort(
      (a, b) =>
        calendarDate(a.start).getTime() - calendarDate(b.start).getTime(),
    );
  } catch (cause) {
    if (
      cause instanceof Error &&
      cause.message.startsWith('This calendar has too many')
    )
      throw cause;
    throw unreadable();
  } finally {
    for (const tzid of registered) ICAL.TimezoneService.remove(tzid);
  }
}
