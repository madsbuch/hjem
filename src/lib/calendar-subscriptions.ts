import { invoke, isTauri } from '@tauri-apps/api/core';
import {
  isRecord,
  parseFeedEvents,
  type CalendarFeed,
  type CalendarRange,
} from './calendar-feed-types';
import type { HassCalendarEvent } from './calendar';
import { downloadCalendarText } from './calendar-download';

export async function loadCalendarFeed(
  feed: CalendarFeed,
  day: CalendarRange,
): Promise<HassCalendarEvent[]> {
  let text: string;
  if (isTauri()) {
    try {
      const response: unknown = await invoke<unknown>('calendar_fetch_feed', {
        id: feed.id,
      });
      if (typeof response !== 'string')
        throw new Error('Unreadable calendar response.');
      text = response;
    } catch (cause) {
      throw new Error(
        typeof cause === 'string'
          ? cause
          : 'Could not download this calendar. Check its link and the network.',
      );
    }
  } else {
    text = await downloadCalendarText(feed.url);
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL('./calendar-worker.ts', import.meta.url),
      { type: 'module' },
    );
    const stop = () => {
      clearTimeout(timeout);
      worker.terminate();
    };
    const timeout = setTimeout(() => {
      worker.terminate();
      reject(new Error('This calendar took too long to process.'));
    }, 10_000);
    worker.onmessage = (message: MessageEvent<unknown>) => {
      stop();
      try {
        if (!isRecord(message.data))
          throw new Error('Could not read this calendar.');
        if (typeof message.data.error === 'string')
          throw new Error(message.data.error);
        resolve(parseFeedEvents(message.data.events));
      } catch (cause) {
        reject(cause);
      }
    };
    worker.onerror = () => {
      stop();
      reject(new Error('Could not read this calendar.'));
    };
    worker.postMessage({ text, feed: { id: feed.id, name: feed.name }, day });
  });
}
