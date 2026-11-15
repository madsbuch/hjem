import { useEffect, useRef, useState, type FormEvent } from 'react';
import { CalendarDays, Check, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { isTauri } from '@tauri-apps/api/core';
import {
  addCalendarFeed,
  removeCalendarFeed,
  updateCalendarFeed,
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
  const [editing, setEditing] = useState<number | null>(null);
  const [feedback, setFeedback] = useState('');
  const nameInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState<number | null>(null);
  const [checks, setChecks] = useState<Record<number, string>>({});
  useEffect(() => {
    if (editing !== null) nameInput.current?.focus();
  }, [editing]);
  const resetForm = () => {
    setEditing(null);
    setName('');
    setUrl('');
    setError('');
  };
  const edit = (feed: CalendarFeed) => {
    setEditing(feed.id);
    setName(feed.name);
    setUrl(feed.url);
    setError('');
    setFeedback('');
  };
  const fail = (cause: unknown) =>
    setError(
      cause instanceof Error
        ? cause.message
        : 'Could not save the calendar. Please try again.',
    );
  async function save(event: FormEvent) {
    event.preventDefault();
    setError('');
    setFeedback('');
    setBusy(true);
    try {
      if (editing === null) await addCalendarFeed(name, url);
      else {
        await updateCalendarFeed(editing, name, url);
        setChecks((current) => {
          const next = { ...current };
          delete next[editing];
          return next;
        });
        setFeedback('Calendar updated.');
      }
      resetForm();
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
      if (editing === feed.id) resetForm();
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
        <p>
          Keep this secret link private; it grants read access without making
          your calendar public. A <strong>Public address in iCal format</strong>{' '}
          only works for a calendar that is already shared publicly.
        </p>
      </details>
      {calendarFeeds.length > 0 && (
        <ul className="calendar-feed-list">
          {calendarFeeds.map((feed) => (
            <li key={feed.id}>
              <div className="calendar-feed-title">
                <strong>{feed.name}</strong>
                <span className="calendar-feed-url">{feed.url}</span>
              </div>
              <div className="calendar-feed-actions">
                <button
                  type="button"
                  className="icon-button"
                  disabled={busy || checking !== null}
                  aria-label={`Edit ${feed.name} calendar`}
                  onClick={() => edit(feed)}
                >
                  <Pencil size={17} />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  disabled={checking !== null || busy || editing !== null}
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
        onSubmit={(event) => void save(event)}
        className="calendar-link-form"
      >
        <h3>{editing === null ? 'Add a calendar' : 'Edit calendar'}</h3>
        <label htmlFor="calendar-name">Calendar name</label>
        <input
          id="calendar-name"
          ref={nameInput}
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
          type="url"
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
        {feedback && <p role="status" className="calendar-feed-status">{feedback}</p>}
        <div className="calendar-form-actions">
          <button type="submit" className="primary-button" disabled={busy}>
            {busy ? 'Saving…' : editing === null ? 'Add calendar' : 'Save changes'}
            {editing === null ? <Plus size={17} /> : <Check size={17} />}
          </button>
          {editing !== null && (
            <button type="button" className="secondary-button" disabled={busy} onClick={resetForm}>
              Cancel edit
            </button>
          )}
        </div>
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
