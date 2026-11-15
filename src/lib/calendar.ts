export interface HassCalendarEvent {
  id: string;
  entityId: string;
  summary: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
}

export function calendarDate(value: string): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(year, month - 1, day);
    return date.getFullYear() === year &&
      date.getMonth() === month - 1 &&
      date.getDate() === day
      ? date
      : new Date(NaN);
  }
  return new Date(value);
}

export function calendarDay(now: Date) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const date = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
  return { start: start.toISOString(), end: end.toISOString(), date };
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
export function parseCalendarEvents(
  result: unknown,
  entityIds: string[],
  start: string,
  end: string,
): HassCalendarEvent[] {
  if (!record(result) || !record(result.response))
    throw new Error(
      'Home Assistant returned no calendar events response. Check that calendar.get_events is supported.',
    );
  const events: HassCalendarEvent[] = [];
  for (const entityId of entityIds) {
    const calendar = result.response[entityId];
    if (!record(calendar) || !Array.isArray(calendar.events))
      throw new Error('Home Assistant returned an unreadable calendar.');
    for (const [index, event] of calendar.events.entries()) {
      if (
        !record(event) ||
        typeof event.start !== 'string' ||
        typeof event.end !== 'string'
      )
        throw new Error('A calendar event has an unreadable date.');
      const from = calendarDate(event.start).getTime();
      const until = calendarDate(event.end).getTime();
      if (!Number.isFinite(from) || !Number.isFinite(until) || until <= from)
        throw new Error('A calendar event has an invalid date range.');
      if (until <= Date.parse(start) || from >= Date.parse(end)) continue;
      events.push({
        id: `${entityId}:${typeof event.uid === 'string' ? event.uid : index}:${event.start}`,
        entityId,
        summary:
          typeof event.summary === 'string' ? event.summary : 'Untitled event',
        start: event.start,
        end: event.end,
        allDay: /^\d{4}-\d{2}-\d{2}$/.test(event.start),
        ...(typeof event.location === 'string' && event.location
          ? { location: event.location }
          : {}),
      });
    }
  }
  return events.sort(
    (a, b) =>
      Number(b.allDay) - Number(a.allDay) ||
      calendarDate(a.start).getTime() - calendarDate(b.start).getTime() ||
      a.summary.localeCompare(b.summary),
  );
}

export function demoCalendarEvents(
  day: ReturnType<typeof calendarDay>,
): HassCalendarEvent[] {
  const instant = (hour: number, minute = 0) => {
    const date = new Date(day.start);
    date.setHours(hour, minute, 0, 0);
    return date.toISOString();
  };
  return [
    {
      id: 'sample-breakfast',
      entityId: 'calendar.demo',
      summary: 'Breakfast together',
      start: instant(9),
      end: instant(10),
      allDay: false,
      location: 'Home',
    },
    {
      id: 'sample-walk',
      entityId: 'calendar.demo',
      summary: 'Afternoon walk',
      start: instant(14),
      end: instant(15),
      allDay: false,
    },
    {
      id: 'sample-dinner',
      entityId: 'calendar.demo',
      summary: 'Dinner with friends',
      start: instant(18, 30),
      end: instant(20, 30),
      allDay: false,
    },
  ];
}

export function calendarPosition(
  events: HassCalendarEvent[],
  day: ReturnType<typeof calendarDay>,
) {
  const midnight = Date.parse(day.start);
  const nextMidnight = Date.parse(day.end);
  const minutes = (date: Date) =>
    date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
  const positioned = events
    .filter((event) => !event.allDay)
    .map((event) => {
      const startDate = calendarDate(event.start);
      const endDate = calendarDate(event.end);
      const start = Math.max(
        0,
        startDate.getTime() <= midnight ? 0 : minutes(startDate),
      );
      const clockEnd =
        endDate.getTime() >= nextMidnight ? 1440 : minutes(endDate);
      // Repeated clock hours on the autumn DST boundary still need visible duration.
      const end = Math.min(
        1440,
        clockEnd > start
          ? clockEnd
          : start + (endDate.getTime() - startDate.getTime()) / 60000,
      );
      return { event, start, end, lane: 0, columns: 1 };
    })
    .filter((item) => item.end > item.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  let group: typeof positioned = [];
  let groupEnd = -1;
  const arrange = () => {
    const lanes: number[] = [];
    for (const item of group) {
      let lane = lanes.findIndex((end) => end <= item.start);
      if (lane === -1) lane = lanes.length;
      lanes[lane] = item.end;
      item.lane = lane;
    }
    for (const item of group) item.columns = lanes.length;
  };
  for (const item of positioned) {
    if (item.start >= groupEnd) {
      arrange();
      group = [];
      groupEnd = -1;
    }
    group.push(item);
    groupEnd = Math.max(groupEnd, item.end);
  }
  arrange();
  return positioned;
}
