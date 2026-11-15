import { calendarDate, type HassCalendarEvent } from './calendar';

export interface CalendarFeed {
  id: number;
  name: string;
  url: string;
}
export interface CalendarRange {
  start: string;
  end: string;
}
const unreadable = () =>
  new Error(
    'This link did not return a readable iCal calendar. Use the calendar’s iCal/ICS subscription address.',
  );
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export function parseFeed(value: unknown): CalendarFeed {
  if (
    !isRecord(value) ||
    typeof value.id !== 'number' ||
    !Number.isSafeInteger(value.id) ||
    value.id <= 0 ||
    typeof value.name !== 'string' ||
    !value.name.trim() ||
    value.name.length > 120 ||
    typeof value.url !== 'string'
  )
    throw unreadable();
  return {
    id: value.id,
    name: value.name,
    url: normalizeCalendarUrl(value.url),
  };
}
export function normalizeCalendarUrl(input: string): string {
  if (/[\u0000-\u001f\u007f]/.test(input.trim()))
    throw new Error('Enter a valid calendar subscription link.');
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error('Enter a complete iCal/ICS link.');
  }
  if (url.protocol === 'webcal:') url.protocol = 'https:';
  // URL does not switch non-special webcal schemes to special HTTPS schemes.
  if (url.protocol === 'webcal:')
    url = new URL(input.trim().replace(/^webcal:/i, 'https:'));
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error(
      'Use an HTTP, HTTPS, or webcal calendar link without a username, password, or fragment.',
    );
  if (url.href.length > 8192)
    throw new Error('This calendar link is too long.');
  return url.href;
}

export function parseFeedEvents(value: unknown): HassCalendarEvent[] {
  if (!Array.isArray(value) || value.length > 2000) throw unreadable();
  const events: unknown[] = value;
  return events.map((event) => {
    if (
      !isRecord(event) ||
      typeof event.id !== 'string' ||
      typeof event.entityId !== 'string' ||
      typeof event.summary !== 'string' ||
      typeof event.start !== 'string' ||
      typeof event.end !== 'string' ||
      typeof event.allDay !== 'boolean' ||
      typeof event.calendarName !== 'string' ||
      (event.location !== undefined && typeof event.location !== 'string')
    )
      throw unreadable();
    const start = calendarDate(event.start).getTime();
    const end = calendarDate(event.end).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
      throw unreadable();
    return {
      id: event.id,
      entityId: event.entityId,
      summary: event.summary,
      start: event.start,
      end: event.end,
      allDay: event.allDay,
      calendarName: event.calendarName,
      ...(typeof event.location === 'string'
        ? { location: event.location }
        : {}),
    };
  });
}
