import { invoke, isTauri } from '@tauri-apps/api/core';
import {
  isRecord,
  parseFeedEvents,
  type CalendarFeed,
  type CalendarRange,
} from './calendar-feed-types';
import type { HassCalendarEvent } from './calendar';

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
    try {
      const response = await fetch(feed.url, {
        signal: AbortSignal.timeout(30_000),
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
      if (!response.ok || !response.body)
        throw new Error('Could not download calendar.');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 2 * 1024 * 1024) {
          await reader.cancel();
          throw new Error('Calendar too large.');
        }
        chunks.push(value);
      }
      const combined = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.length;
      }
      text = new TextDecoder('utf-8', { fatal: true }).decode(combined);
    } catch {
      throw new Error(
        'This link could not be read in the browser preview. Try it in the installed Hjem app, where calendar links do not require browser sharing permissions.',
      );
    }
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
