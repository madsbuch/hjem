import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadCalendarText } from './calendar-download';

const googlePublic = 'https://calendar.google.com/calendar/ical/fixture%40group.calendar.google.com/public/basic.ics';
const privateFeed = 'https://calendar.example.test/private-fixture-token/basic.ics';

afterEach(() => vi.unstubAllGlobals());

describe('calendar download errors', () => {
  it.each([401, 403, 404, 410])('explains unavailable Google public feeds for HTTP %i without asserting deletion', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('private upstream details', { status })));
    const result = downloadCalendarText(googlePublic);
    await expect(result).rejects.toThrow('may not be shared publicly');
    await expect(result).rejects.toThrow('Secret address in iCal format');
    await expect(result).rejects.not.toThrow('private upstream details');
    await expect(result).rejects.not.toThrow('fixture%40');
  });

  it('keeps generic HTTP errors separate from browser access failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not found', { status: 404 })));
    const result = downloadCalendarText(privateFeed);
    await expect(result).rejects.toThrow('unavailable (HTTP 404)');
    await expect(result).rejects.not.toThrow('browser access');
    await expect(result).rejects.not.toThrow('private-fixture-token');
  });

  it('only identifies Google public ICS links on the exact provider hostname', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not found', { status: 404 })));
    await expect(downloadCalendarText('https://calendar.google.com.example.test/calendar/ical/fixture/public/basic.ics')).rejects.not.toThrow('Google');
  });

  it('explains opaque network/browser failures without claiming CORS was the cause', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const result = downloadCalendarText(googlePublic);
    await expect(result).rejects.toThrow('link may be unavailable');
    await expect(result).rejects.toThrow('provider may block browser access');
    await expect(result).rejects.toThrow('Secret address in iCal format');
  });

  it('preserves size and UTF-8 decoding errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('x'.repeat(2 * 1024 * 1024 + 1))));
    await expect(downloadCalendarText(privateFeed)).rejects.toThrow('2 MiB limit');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array([0xff]))));
    await expect(downloadCalendarText(privateFeed)).rejects.toThrow('not valid UTF-8');
  });

  it('reports timeout and rate limiting distinctly', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('Timed out', 'TimeoutError')));
    await expect(downloadCalendarText(privateFeed)).rejects.toThrow('too long to respond');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 429 })));
    await expect(downloadCalendarText(privateFeed)).rejects.toThrow('rate limited');
  });

  it('downloads a valid ICS response without sending browser credentials or a referrer', async () => {
    const calendar = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n';
    const fetch = vi.fn().mockResolvedValue(new Response(calendar));
    vi.stubGlobal('fetch', fetch);
    expect(await downloadCalendarText(privateFeed)).toBe(calendar);
    expect(fetch).toHaveBeenCalledWith(privateFeed, expect.objectContaining({ credentials: 'omit', referrerPolicy: 'no-referrer' }));
  });
});
