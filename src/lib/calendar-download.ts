const LIMIT = 2 * 1024 * 1024;
const googlePrivateLinkHelp = 'In Google Calendar → Settings → select the calendar → Integrate calendar, copy “Secret address in iCal format” instead.';

class CalendarDownloadError extends Error {}

function isGooglePublicCalendar(address: string): boolean {
  try {
    const url = new URL(address);
    return url.hostname === 'calendar.google.com' &&
      url.pathname.startsWith('/calendar/ical/') &&
      url.pathname.includes('/public/') && url.pathname.endsWith('.ics');
  } catch {
    return false;
  }
}

function httpError(status: number, address: string): string {
  if ([401, 403, 404, 410].includes(status) && isGooglePublicCalendar(address))
    return `This Google Calendar public link is not accessible. The calendar may not be shared publicly, or the address may be incorrect. ${googlePrivateLinkHelp}`;
  if (status === 401 || status === 403)
    return 'This calendar link is not authorized. Use the calendar’s private iCal/ICS subscription address.';
  if (status === 404 || status === 410)
    return `This calendar link is unavailable (HTTP ${status}). Check its iCal/ICS subscription address and sharing settings.`;
  if (status === 429)
    return 'This calendar is temporarily rate limited. Please try again shortly.';
  return 'The calendar provider could not supply this calendar. Please try again shortly.';
}

/** Keep known HTTP, size and encoding failures distinct from opaque CORS/network errors. */
export async function downloadCalendarText(address: string): Promise<string> {
  try {
    const response = await fetch(address, {
      signal: AbortSignal.timeout(30_000),
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new CalendarDownloadError(httpError(response.status, address));
    }
    if (!response.body) throw new CalendarDownloadError('The calendar provider returned an empty response. Check the iCal/ICS link.');
    const declaredSize = Number(response.headers.get('Content-Length'));
    if (Number.isFinite(declaredSize) && declaredSize > LIMIT) {
      await response.body.cancel().catch(() => undefined);
      throw new CalendarDownloadError('This calendar is larger than the 2 MiB limit.');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > LIMIT) throw new CalendarDownloadError('This calendar is larger than the 2 MiB limit.');
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    const combined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(combined);
    } catch {
      throw new CalendarDownloadError('This calendar is not valid UTF-8 text.');
    }
  } catch (cause) {
    if (cause instanceof CalendarDownloadError) throw cause;
    if (cause instanceof Error && ['AbortError', 'TimeoutError'].includes(cause.name))
      throw new Error('This calendar took too long to respond. Please retry.');
    const hint = isGooglePublicCalendar(address)
      ? ` Google public links must be publicly accessible. ${googlePrivateLinkHelp}`
      : '';
    throw new Error(`This calendar could not be downloaded in the browser preview. The link may be unavailable, or its provider may block browser access. Check the iCal/ICS link, then try the installed Hjem app.${hint}`);
  }
}
