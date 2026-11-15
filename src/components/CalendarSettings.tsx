import { useState, type FormEvent } from 'react';
import { CalendarDays, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { isTauri } from '@tauri-apps/api/core';
import {
  addCalendarFeed,
  removeCalendarFeed,
  useStorage,
} from '../lib/storage';
import { loadCalendarFeed } from '../lib/calendar-subscriptions';
import { calendarDay } from '../lib/calendar';
import type { CalendarFeed } from '../lib/calendar-feed-types';
import '../calendar-settings.css';

export function CalendarSettings() {
  const { calendarFeeds } = useStorage();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState<number | null>(null);
  const [checks, setChecks] = useState<Record<number, string>>({});
  const fail = (cause: unknown) =>
    setError(
      cause instanceof Error
        ? cause.message
        : 'Could not save the calendar. Please try again.',
    );
  async function add(event: FormEvent) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await addCalendarFeed(name, url);
      setName('');
      setUrl('');
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  }
  async function remove(feed: CalendarFeed) {
    setError('');
    setBusy(true);
    try {
      await removeCalendarFeed(feed.id);
      setChecks((current) => {
        const next = { ...current };
        delete next[feed.id];
        return next;
      });
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  }
  async function check(feed: CalendarFeed) {
    setChecking(feed.id);
    try {
      const events = await loadCalendarFeed(feed, calendarDay(new Date()));
      setChecks((current) => ({
        ...current,
        [feed.id]: `Connected · ${events.length} ${events.length === 1 ? 'event' : 'events'} today`,
      }));
    } catch (cause) {
      setChecks((current) => ({
        ...current,
        [feed.id]:
          cause instanceof Error
            ? cause.message
            : 'Could not read this calendar.',
      }));
    } finally {
      setChecking(null);
    }
  }
  return (
    <section
      className="settings-card calendar-settings"
      aria-labelledby="calendar-settings-title"
    >
      <span className="settings-icon">
        <CalendarDays size={25} />
      </span>
      <h2 id="calendar-settings-title">Calendars</h2>
      <p>
        Add iCal/ICS subscription links. Events appear on today’s calendar and
        refresh every five minutes.
      </p>
      <details className="calendar-link-help">
        <summary>Get a Google Calendar link</summary>
        <p>
          On your own device, open Google Calendar → Settings → select a
          calendar → Integrate calendar. Copy its{' '}
          <strong>Secret address in iCal format</strong> and paste it here. No
          Google login is needed on the tablet.
        </p>
        <p>Keep this link private; it grants read access to that calendar.</p>
      </details>
      {calendarFeeds.length > 0 && (
        <ul className="calendar-feed-list">
          {calendarFeeds.map((feed) => (
            <li key={feed.id}>
              <div className="calendar-feed-title">
                <strong>{feed.name}</strong>
                <span>{new URL(feed.url).hostname}</span>
              </div>
              <div className="calendar-feed-actions">
                <button
                  type="button"
                  className="icon-button"
                  disabled={checking !== null || busy}
                  aria-label={`Check ${feed.name} calendar`}
                  onClick={() => void check(feed)}
                >
                  <RefreshCw
                    size={17}
                    className={checking === feed.id ? 'spin' : ''}
                  />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  disabled={busy || checking === feed.id}
                  aria-label={`Remove ${feed.name} calendar`}
                  onClick={() => void remove(feed)}
                >
                  <Trash2 size={17} />
                </button>
              </div>
              {checks[feed.id] && (
                <p className="calendar-feed-status" role="status">
                  {checks[feed.id]}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      <form
        onSubmit={(event) => void add(event)}
        className="calendar-link-form"
      >
        <label htmlFor="calendar-name">Calendar name</label>
        <input
          id="calendar-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Family"
          maxLength={100}
          autoComplete="off"
          required
          disabled={busy}
        />
        <label htmlFor="calendar-url">iCal / ICS link</label>
        <input
          id="calendar-url"
          type="password"
          inputMode="url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://…/basic.ics"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          required
          disabled={busy}
        />
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <button type="submit" className="primary-button" disabled={busy}>
          {busy ? 'Saving…' : 'Add calendar'}
          <Plus size={17} />
        </button>
      </form>
      {!isTauri() && (
        <p className="field-help">
          Preview links last until reload. Install Hjem to save calendars on the
          device.
        </p>
      )}
    </section>
  );
}
