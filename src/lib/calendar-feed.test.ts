import { describe, expect, it } from 'vitest';
import { parseCalendarFeed } from './calendar-feed';
import {
  normalizeCalendarUrl,
  parseFeed,
  parseFeedEvents,
} from './calendar-feed-types';
import { calendarDay } from './calendar';

const feed = { id: 7, name: 'Family' };
const day = { start: '2026-03-29T00:00:00Z', end: '2026-03-30T00:00:00Z' };
const event = (...lines: string[]) =>
  ['BEGIN:VEVENT', ...lines, 'END:VEVENT'].join('\r\n');
const calendar = (...components: string[]) =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Hjem tests//EN',
    ...components,
    'END:VCALENDAR',
  ].join('\r\n');
const parse = (...components: string[]) =>
  parseCalendarFeed(calendar(...components), feed, day);
const master = (uid = 'weekly') =>
  event(
    `UID:${uid}`,
    'DTSTART:20260322T100000Z',
    'DTEND:20260322T110000Z',
    'RRULE:FREQ=WEEKLY;COUNT=4',
    'SUMMARY:Original',
  );
const copenhagen = [
  'BEGIN:VTIMEZONE',
  'TZID:Custom/Copenhagen',
  'BEGIN:DAYLIGHT',
  'DTSTART:19700329T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'DTSTART:19701025T030000',
  'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'END:STANDARD',
  'END:VTIMEZONE',
].join('\r\n');

describe('calendar subscriptions', () => {
  it('parses UTC times, DURATION, and folded escaped text without rendering markup', () => {
    const events = parse(
      event(
        'UID:utc',
        'DTSTART:20260329T100000Z',
        'DURATION:PT1H30M',
        'SUMMARY:Family\\, breakfast and',
        '  a walk <b>outside</b>',
        'LOCATION:Kitchen\\;',
        '\tHome',
      ),
    );
    expect(events).toEqual([
      {
        id: 'feed:7:utc:2026-03-29T10:00:00.000Z',
        entityId: 'feed.7',
        calendarName: 'Family',
        summary: 'Family, breakfast and a walk <b>outside</b>',
        start: '2026-03-29T10:00:00.000Z',
        end: '2026-03-29T11:30:00.000Z',
        allDay: false,
        location: 'Kitchen;Home',
      },
    ]);
  });

  it('preserves all-day dates and treats DTEND as an exclusive date', () => {
    const range = calendarDay(new Date(2026, 2, 29, 12));
    const events = parseCalendarFeed(
      calendar(
        event(
          'UID:all-day',
          'DTSTART;VALUE=DATE:20260329',
          'DTEND;VALUE=DATE:20260330',
          'SUMMARY:Birthday',
        ),
      ),
      feed,
      range,
    );
    expect(events[0]).toMatchObject({
      start: '2026-03-29',
      end: '2026-03-30',
      allDay: true,
    });
    expect(
      parseCalendarFeed(
        calendar(
          event(
            'UID:ended',
            'DTSTART;VALUE=DATE:20260328',
            'DTEND;VALUE=DATE:20260329',
          ),
        ),
        feed,
        range,
      ),
    ).toEqual([]);
  });

  it('defaults an all-day event to one day and gives an instantaneous event a visible minute', () => {
    expect(
      parse(event('UID:all-day', 'DTSTART;VALUE=DATE:20260329'))[0],
    ).toMatchObject({ start: '2026-03-29', end: '2026-03-30', allDay: true });
    expect(
      parse(event('UID:instant', 'DTSTART:20260329T120000Z'))[0],
    ).toMatchObject({
      start: '2026-03-29T12:00:00.000Z',
      end: '2026-03-29T12:01:00.000Z',
    });
  });

  it('expands RRULE and honours EXDATE and RDATE', () => {
    expect(
      parse(
        event(
          'UID:excluded',
          'DTSTART:20260322T100000Z',
          'DURATION:PT1H',
          'RRULE:FREQ=WEEKLY;COUNT=4',
          'EXDATE:20260329T100000Z',
        ),
      ),
    ).toEqual([]);
    expect(
      parse(
        event(
          'UID:extra',
          'DTSTART:20260322T100000Z',
          'DURATION:PT1H',
          'RDATE:20260329T140000Z',
        ),
      )[0],
    ).toMatchObject({
      start: '2026-03-29T14:00:00.000Z',
      end: '2026-03-29T15:00:00.000Z',
    });
  });

  it('deduplicates moved exceptions while isolating unrelated UIDs', () => {
    const events = parse(
      master('one'),
      master('two'),
      event(
        'UID:one',
        'RECURRENCE-ID:20260329T100000Z',
        'DTSTART:20260329T140000Z',
        'DURATION:PT30M',
        'SUMMARY:Moved',
      ),
    );
    expect(events.map((item) => [item.summary, item.start])).toEqual([
      ['Original', '2026-03-29T10:00:00.000Z'],
      ['Moved', '2026-03-29T14:00:00.000Z'],
    ]);
    expect(new Set(events.map((item) => item.id)).size).toBe(2);
  });

  it('includes an exception moved into today from an occurrence beyond the expansion window', () => {
    expect(
      parse(
        master(),
        event(
          'UID:weekly',
          'RECURRENCE-ID:20260412T100000Z',
          'DTSTART:20260329T180000Z',
          'DURATION:PT1H',
          'SUMMARY:Early',
        ),
      ).map((item) => item.summary),
    ).toEqual(['Original', 'Early']);
  });

  it('cancels an individual occurrence even when the cancellation omits DTSTART', () => {
    expect(
      parse(
        master(),
        event(
          'UID:weekly',
          'RECURRENCE-ID:20260329T100000Z',
          'STATUS:CANCELLED',
        ),
      ),
    ).toEqual([]);
  });

  it('suppresses exceptions when their entire series is cancelled', () => {
    expect(
      parse(
        event(
          'UID:cancelled',
          'DTSTART:20260322T100000Z',
          'RRULE:FREQ=WEEKLY;COUNT=4',
          'STATUS:CANCELLED',
        ),
        event(
          'UID:cancelled',
          'RECURRENCE-ID:20260329T100000Z',
          'DTSTART:20260329T140000Z',
          'SUMMARY:Stale exception',
        ),
      ),
    ).toEqual([]);
  });

  it('applies THISANDFUTURE time and duration changes and future cancellations', () => {
    expect(
      parse(
        master(),
        event(
          'UID:weekly',
          'RECURRENCE-ID;RANGE=THISANDFUTURE:20260322T100000Z',
          'DTSTART:20260322T120000Z',
          'DURATION:PT2H',
          'SUMMARY:Shifted',
        ),
      )[0],
    ).toMatchObject({
      summary: 'Shifted',
      start: '2026-03-29T12:00:00.000Z',
      end: '2026-03-29T14:00:00.000Z',
    });
    expect(
      parse(
        master(),
        event(
          'UID:weekly',
          'RECURRENCE-ID;RANGE=THISANDFUTURE:20260322T100000Z',
          'STATUS:CANCELLED',
        ),
      ),
    ).toEqual([]);
  });

  it('keeps an IANA recurring wall time stable across DST without VTIMEZONE', () => {
    const events = parseCalendarFeed(
      calendar(
        event(
          'UID:iana',
          'DTSTART;TZID=Europe/Copenhagen:20260328T090000',
          'DTEND;TZID=Europe/Copenhagen:20260328T100000',
          'RRULE:FREQ=DAILY;COUNT=3',
        ),
      ),
      feed,
      { start: '2026-03-28T00:00:00Z', end: '2026-03-31T00:00:00Z' },
    );
    expect(events.map((item) => item.start)).toEqual([
      '2026-03-28T08:00:00.000Z',
      '2026-03-29T07:00:00.000Z',
      '2026-03-30T07:00:00.000Z',
    ]);
  });

  it('uses embedded VTIMEZONE rules even for non-IANA identifiers', () => {
    expect(
      parse(
        copenhagen,
        event(
          'UID:custom',
          'DTSTART;TZID=Custom/Copenhagen:20260329T090000',
          'DTEND;TZID=Custom/Copenhagen:20260329T100000',
        ),
      )[0],
    ).toMatchObject({
      start: '2026-03-29T07:00:00.000Z',
      end: '2026-03-29T08:00:00.000Z',
    });
  });

  it('preserves exact elapsed hours for DURATION across the DST spring gap', () => {
    for (const timezone of ['Europe/Copenhagen', 'Custom/Copenhagen']) {
      expect(
        parse(
          copenhagen,
          event(
            'UID:duration',
            `DTSTART;TZID=${timezone}:20260329T013000`,
            'DURATION:PT2H',
          ),
        )[0],
      ).toMatchObject({
        start: '2026-03-29T00:30:00.000Z',
        end: '2026-03-29T02:30:00.000Z',
      });
    }
  });

  it('preserves nominal days for DURATION across DST', () => {
    expect(
      parse(
        event(
          'UID:nominal',
          'DTSTART;TZID=Europe/Copenhagen:20260328T120000',
          'DURATION:P1D',
        ),
      )[0],
    ).toMatchObject({
      start: '2026-03-28T11:00:00.000Z',
      end: '2026-03-29T10:00:00.000Z',
    });
  });

  it('keeps a recurring DTEND duration exact when the first event crosses DST', () => {
    const events = parseCalendarFeed(
      calendar(
        event(
          'UID:exact',
          'DTSTART;TZID=Europe/Copenhagen:20260329T013000',
          'DTEND;TZID=Europe/Copenhagen:20260329T033000',
          'RRULE:FREQ=DAILY;COUNT=2',
        ),
      ),
      feed,
      { start: '2026-03-29T00:00:00Z', end: '2026-03-31T00:00:00Z' },
    );
    expect(
      events.map((item) => Date.parse(item.end) - Date.parse(item.start)),
    ).toEqual([3600000, 3600000]);
  });

  it('matches a UTC recurrence exception to an IANA series occurrence', () => {
    expect(
      parse(
        event(
          'UID:mixed-zone',
          'DTSTART;TZID=Europe/Copenhagen:20260322T090000',
          'DURATION:PT1H',
          'RRULE:FREQ=WEEKLY;COUNT=3',
        ),
        event(
          'UID:mixed-zone',
          'RECURRENCE-ID:20260329T070000Z',
          'STATUS:CANCELLED',
        ),
      ),
    ).toEqual([]);
  });

  it('rejects HTML, missing event dates, negative durations, and invalid ranges', () => {
    expect(() =>
      parseCalendarFeed('<html>Sign in to your calendar</html>', feed, day),
    ).toThrow(/readable iCal/);
    expect(() => parse(event('UID:missing-date', 'SUMMARY:Broken'))).toThrow(
      /readable iCal/,
    );
    expect(() =>
      parse(
        event('UID:negative', 'DTSTART:20260329T100000Z', 'DURATION:-PT1H'),
      ),
    ).toThrow(/readable iCal/);
    expect(() =>
      parseCalendarFeed(calendar(), feed, { start: 'bad', end: 'bad' }),
    ).toThrow(/readable iCal/);
  });

  it('normalizes private webcal links without dropping their query tokens', () => {
    expect(
      normalizeCalendarUrl(
        ' WEBCAL://calendar.example/private.ics?token=secret%2Fvalue ',
      ),
    ).toBe('https://calendar.example/private.ics?token=secret%2Fvalue');
    expect(
      normalizeCalendarUrl(
        'http://homeassistant.local:8123/calendar.ics?key=token',
      ),
    ).toBe('http://homeassistant.local:8123/calendar.ics?key=token');
    for (const url of [
      'file:///private',
      'https://user:secret@calendar.example/calendar.ics',
      'https://calendar.example/calendar.ics#secret',
      'https://calendar.example/\nsecret',
    ]) {
      expect(() => normalizeCalendarUrl(url)).toThrow();
    }
  });

  it('rejects malformed IPC records and non-finite calendar dates', () => {
    expect(() =>
      parseFeed({ id: 1.5, name: 'Test', url: 'https://calendar.example' }),
    ).toThrow();
    expect(() =>
      parseFeedEvents([
        {
          id: 'broken',
          entityId: 'feed.7',
          summary: 'Bad',
          start: 'invalid',
          end: 'invalid',
          allDay: false,
          calendarName: 'Test',
        },
      ]),
    ).toThrow();
  });
});
