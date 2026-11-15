import { describe, expect, it } from 'vitest';
import {
  calendarDay,
  calendarDate,
  parseCalendarEvents,
  calendarPosition,
} from './calendar';

describe('today’s calendar', () => {
  it('uses local midnights across daylight-saving changes', () => {
    const previous = process.env.TZ;
    process.env.TZ = 'Europe/Copenhagen';
    try {
      const spring = calendarDay(new Date('2026-03-29T12:00:00+02:00'));
      const autumn = calendarDay(new Date('2026-10-25T12:00:00+01:00'));
      expect(spring.date).toBe('2026-03-29');
      expect(Date.parse(spring.end) - Date.parse(spring.start)).toBe(
        23 * 3600000,
      );
      expect(Date.parse(autumn.end) - Date.parse(autumn.start)).toBe(
        25 * 3600000,
      );
      expect(calendarDate('2026-11-15').getHours()).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });
  it('keeps overlapping and all-day events, sorts them, and excludes adjacent days', () => {
    const day = calendarDay(new Date(2026, 10, 15, 12));
    const date = (hour: number) => {
      const value = new Date(day.start);
      value.setHours(hour);
      return value.toISOString();
    };
    const events = parseCalendarEvents(
      {
        response: {
          'calendar.family': {
            events: [
              { summary: 'Later', start: date(18), end: date(19) },
              { summary: 'All day', start: '2026-11-15', end: '2026-11-16' },
              { summary: 'Overnight', start: date(-1), end: date(1) },
              { summary: 'Yesterday', start: date(-2), end: day.start },
              { summary: 'Tomorrow', start: day.end, end: date(26) },
            ],
          },
        },
      },
      ['calendar.family'],
      day.start,
      day.end,
    );
    expect(events.map((event) => event.summary)).toEqual([
      'All day',
      'Overnight',
      'Later',
    ]);
    expect(events[0].allDay).toBe(true);
    expect(events[1].allDay).toBe(false);
  });
  it('surfaces malformed responses instead of claiming an empty day', () => {
    expect(() =>
      parseCalendarEvents(null, ['calendar.family'], '', ''),
    ).toThrow('no calendar events response');
    expect(() =>
      parseCalendarEvents({ response: {} }, ['calendar.family'], '', ''),
    ).toThrow('unreadable calendar');
    expect(() =>
      parseCalendarEvents(
        {
          response: {
            'calendar.family': {
              events: [{ start: 'not a date', end: '2026-11-16' }],
            },
          },
        },
        ['calendar.family'],
        '',
        '',
      ),
    ).toThrow('invalid date range');
    expect(Number.isNaN(calendarDate('2026-02-30').getTime())).toBe(true);
  });
});

it('lays out overlapping events in separate lanes and reuses space for consecutive events', () => {
  const day = calendarDay(new Date(2026, 10, 15, 12));
  const at = (hour: number) => {
    const value = new Date(day.start);
    value.setHours(hour);
    return value.toISOString();
  };
  const event = (id: string, start: number, end: number) => ({
    id,
    entityId: 'calendar.family',
    summary: id,
    start: at(start),
    end: at(end),
    allDay: false,
  });
  const positions = calendarPosition(
    [event('first', 9, 11), event('overlap', 10, 12), event('after', 12, 13)],
    day,
  );
  expect(
    positions.map(({ start, end, lane, columns }) => ({
      start,
      end,
      lane,
      columns,
    })),
  ).toEqual([
    { start: 540, end: 660, lane: 0, columns: 2 },
    { start: 600, end: 720, lane: 1, columns: 2 },
    { start: 720, end: 780, lane: 0, columns: 1 },
  ]);
});
