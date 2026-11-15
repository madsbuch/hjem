import { parseCalendarFeed } from './calendar-feed';
import { isRecord } from './calendar-feed-types';
self.onmessage = (message: MessageEvent<unknown>) => {
  try {
    const data = message.data;
    if (
      !isRecord(data) ||
      typeof data.text !== 'string' ||
      !isRecord(data.feed) ||
      typeof data.feed.id !== 'number' ||
      typeof data.feed.name !== 'string' ||
      !isRecord(data.day) ||
      typeof data.day.start !== 'string' ||
      typeof data.day.end !== 'string'
    )
      throw new Error('Invalid calendar request.');
    self.postMessage({
      events: parseCalendarFeed(
        data.text,
        { id: data.feed.id, name: data.feed.name },
        { start: data.day.start, end: data.day.end },
      ),
    });
  } catch (cause) {
    self.postMessage({
      error:
        cause instanceof Error
          ? cause.message
          : 'Could not read this calendar.',
    });
  }
};
