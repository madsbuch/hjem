import { useEffect, useState } from 'react';
import type {
  HomeAssistantClient,
  HassSnapshot,
  ConnectionStatus,
} from './home-assistant';
import {
  calendarDay,
  demoCalendarEvents,
  type HassCalendarEvent,
} from './calendar';
import { loadCalendarFeed } from './calendar-subscriptions';
import { useStorage } from './storage';

export function useCalendar({
  client,
  status,
  mode,
  snapshot,
  now = new Date(),
}: {
  client: HomeAssistantClient | null;
  status: ConnectionStatus;
  mode: 'demo' | 'live';
  snapshot: HassSnapshot;
  now?: Date;
}) {
  const day = calendarDay(now);
  const { calendarFeeds } = useStorage();
  const demo = mode === 'demo' && calendarFeeds.length === 0;
  const calendars =
    mode === 'demo'
      ? []
      : snapshot.entities.filter((entity) => {
          const registry = snapshot.registry.find(
            (item) => item.entity_id === entity.entity_id,
          );
          return (
            entity.entity_id.startsWith('calendar.') &&
            !registry?.hidden_by &&
            !registry?.disabled_by
          );
        });
  const available = calendars.filter(
    (entity) => entity.state !== 'unavailable' && entity.state !== 'unknown',
  );
  const calendarKey = JSON.stringify(
    available
      .map((entity) => [
        entity.entity_id,
        entity.last_updated || '',
        entity.state,
      ])
      .sort(),
  );
  const feedKey = JSON.stringify(calendarFeeds);
  const calendarCount = calendars.length + calendarFeeds.length;
  const unavailableCount = calendars.length - available.length;
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{
    events: HassCalendarEvent[];
    loading: boolean;
    error: string;
  }>({ events: [], loading: false, error: '' });
  useEffect(() => {
    if (demo) {
      setState({ events: [], loading: false, error: '' });
      return;
    }
    let active = true;
    let fetching = false;
    const previous = new Map<string, HassCalendarEvent[]>();
    const load = async () => {
      if (fetching || !active) return;
      fetching = true;
      setState((current) => ({ ...current, loading: true, error: '' }));
      const errors: string[] = [];
      const tasks: {
        key: string;
        name: string;
        load: () => Promise<HassCalendarEvent[]>;
      }[] = calendarFeeds.map((feed) => ({
        key: `feed:${feed.id}`,
        name: feed.name,
        load: () => loadCalendarFeed(feed, day),
      }));
      if (mode === 'live') {
        if (status !== 'connected' || !client)
          errors.push(
            'Calendar is offline. Reconnect to Home Assistant to see its events.',
          );
        else {
          if (available.length)
            tasks.push({
              key: 'home-assistant',
              name: 'Home Assistant',
              load: () =>
                client.getCalendarEvents(
                  available.map((item) => item.entity_id),
                  day.start,
                  day.end,
                ),
            });
          if (unavailableCount)
            errors.push('Some calendars are unavailable in Home Assistant.');
        }
      }
      await Promise.all(
        tasks.map(async (task) => {
          try {
            previous.set(task.key, await task.load());
          } catch (cause) {
            errors.push(
              `${task.name}: Could not refresh. ${cause instanceof Error ? cause.message : 'Please try again.'}`,
            );
          }
        }),
      );
      if (active)
        setState({
          events: [...previous.values()]
            .flat()
            .sort((a, b) => a.start.localeCompare(b.start)),
          loading: false,
          error: errors.join(' '),
        });
      fetching = false;
    };
    setState({ events: [], loading: true, error: '' });
    void load();
    const timer = window.setInterval(() => void load(), 5 * 60_000);
    const visible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('focus', visible);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('focus', visible);
    };
  }, [
    client,
    status,
    mode,
    demo,
    calendarKey,
    feedKey,
    unavailableCount,
    day.start,
    day.end,
    revision,
  ]);
  return {
    ...state,
    events: demo ? demoCalendarEvents(day) : state.events,
    calendarCount: demo ? 1 : calendarCount,
    demo,
    day,
    refresh: () => setRevision((value) => value + 1),
  };
}
