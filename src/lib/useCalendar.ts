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
  const calendars = snapshot.entities.filter((entity) => {
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
  const calendarCount = calendars.length;
  const unavailableCount = calendarCount - available.length;
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{
    events: HassCalendarEvent[];
    loading: boolean;
    error: string;
  }>({ events: [], loading: false, error: '' });
  useEffect(() => {
    if (mode === 'demo') {
      setState({ events: [], loading: false, error: '' });
      return;
    }
    if (status !== 'connected' || !client) {
      setState({
        events: [],
        loading: false,
        error:
          'Calendar is offline. Reconnect to Home Assistant to see today’s events.',
      });
      return;
    }
    const ids = (JSON.parse(calendarKey) as string[][]).map(([id]) => id);
    if (!ids.length) {
      setState({
        events: [],
        loading: false,
        error: unavailableCount
          ? 'Your calendars are currently unavailable in Home Assistant.'
          : '',
      });
      return;
    }
    let active = true;
    let fetching = false;
    const load = async () => {
      if (fetching || !active) return;
      fetching = true;
      setState((previous) => ({ ...previous, loading: true, error: '' }));
      try {
        const events = await client.getCalendarEvents(ids, day.start, day.end);
        if (active)
          setState({
            events,
            loading: false,
            error: unavailableCount
              ? 'Some calendars are unavailable. Showing events from the others.'
              : '',
          });
      } catch (cause) {
        if (active)
          setState((previous) => ({
            ...previous,
            loading: false,
            error: `Could not refresh today’s calendar. ${cause instanceof Error ? cause.message : 'Please try again.'}`,
          }));
      } finally {
        fetching = false;
      }
    };
    // Clear the previous home/day before loading a new scope.
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
    calendarKey,
    unavailableCount,
    day.start,
    day.end,
    revision,
  ]);
  return {
    ...state,
    events: mode === 'demo' ? demoCalendarEvents(day) : state.events,
    calendarCount: mode === 'demo' ? 1 : calendarCount,
    demo: mode === 'demo',
    day,
    refresh: () => setRevision((value) => value + 1),
  };
}
