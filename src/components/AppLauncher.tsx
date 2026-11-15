import { useEffect, useState } from 'react';
import {
  ArrowRight,
  CalendarDays,
  CirclePlay,
  Grid2X2,
  Images,
  LoaderCircle,
  Music2,
  Pin,
  RefreshCw,
  Search,
  Smartphone,
  Globe2,
  X,
} from 'lucide-react';
import type { LauncherApp } from '../lib/launcher';

interface AppLauncherProps {
  apps: LauncherApp[];
  pinned: string[];
  onTogglePin: (packageName: string) => void;
  onLaunch: (app: LauncherApp) => void;
  onOpenAll: () => void;
  preview: boolean;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  compact?: boolean;
}

function AppGlyph({ app }: { app: LauncherApp }) {
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [app.icon]);
  const identity = `${app.packageName} ${app.name}`.toLowerCase();
  const Icon = /sonos|spotify|music|audio/.test(identity)
    ? Music2
    : /youtube|video|player/.test(identity)
      ? CirclePlay
      : /calendar/.test(identity)
        ? CalendarDays
        : /chrome|browser|firefox|internet/.test(identity)
          ? Globe2
          : /photo|gallery|image/.test(identity)
            ? Images
            : Grid2X2;
  const colour =
    Array.from(app.packageName).reduce(
      (sum, character) => sum + character.charCodeAt(0),
      0,
    ) % 6;

  return (
    <span
      className={`launcher-glyph launcher-colour-${colour}`}
      aria-hidden="true"
    >
      {app.icon && !imageFailed ? (
        <img
          src={app.icon}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setImageFailed(true)}
        />
      ) : (
        <Icon size={26} strokeWidth={1.7} />
      )}
    </span>
  );
}

export function AppLauncher({
  apps,
  pinned,
  onTogglePin,
  onLaunch,
  onOpenAll,
  preview,
  loading,
  error,
  onRefresh,
  compact = false,
}: AppLauncherProps) {
  const [query, setQuery] = useState('');
  const [onlyPinned, setOnlyPinned] = useState(false);
  const pinnedApps = pinned.flatMap((id) => {
    const app = apps.find((candidate) => candidate.packageName === id);
    return app ? [app] : [];
  });
  const shown = (onlyPinned ? pinnedApps : apps).filter((app) =>
    `${app.name} ${app.packageName}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );

  return (
    <section
      className={`app-launcher ${compact ? 'launcher-compact' : 'launcher-full'}`}
      aria-label={compact ? 'Your everyday apps' : 'Apps'}
    >
      {compact ? (
        <div className="launcher-heading">
          <div>
            <h2>Your everyday apps</h2>
            <p>
              {preview
                ? 'Sample app previews'
                : 'A little closer to everything you use.'}
            </p>
          </div>
          <button className="text-button" onClick={onOpenAll}>
            Edit apps
            <ArrowRight size={15} />
          </button>
        </div>
      ) : (
        <>
          <div className="launcher-toolbar">
            <label className="launcher-search">
              <Search size={18} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Find an app…"
                aria-label="Find an app"
              />
              {query && (
                <button
                  onClick={() => setQuery('')}
                  aria-label="Clear app search"
                >
                  <X size={16} />
                </button>
              )}
            </label>
            <div className="launcher-toolbar-actions">
              <div
                className="launcher-filter"
                role="group"
                aria-label="Show apps"
              >
                <button
                  className={!onlyPinned ? 'selected' : ''}
                  aria-pressed={!onlyPinned}
                  onClick={() => setOnlyPinned(false)}
                >
                  All apps
                </button>
                <button
                  className={onlyPinned ? 'selected' : ''}
                  aria-pressed={onlyPinned}
                  onClick={() => setOnlyPinned(true)}
                >
                  <Pin size={13} />
                  Pinned
                </button>
              </div>
              <button
                className="launcher-refresh"
                onClick={onRefresh}
                disabled={loading}
                aria-label="Refresh apps"
                title="Refresh apps"
              >
                <RefreshCw size={17} className={loading ? 'spin' : ''} />
              </button>
            </div>
          </div>
          <div className="launcher-summary">
            <span>
              {shown.length} {shown.length === 1 ? 'app' : 'apps'}
              {!onlyPinned && ` · ${pinnedApps.length} pinned`}
            </span>
            {preview && (
              <span className="launcher-preview-label">
                <Smartphone size={13} />
                Sample previews
              </span>
            )}
          </div>
          {preview && (
            <p className="launcher-preview-note">
              These are sample app previews. Your installed apps appear when you
              use Hjem on Android.
            </p>
          )}
        </>
      )}

      {error && (
        <div className="launcher-error" role="alert">
          <span>{error}</span>
          <button onClick={onRefresh} disabled={loading}>
            Try again
          </button>
        </div>
      )}

      {loading && apps.length === 0 ? (
        <div className="launcher-empty" role="status">
          <LoaderCircle size={25} className="spin" />
          <p>Finding your apps…</p>
        </div>
      ) : compact ? (
        pinnedApps.length > 0 ? (
          <ul className="launcher-dock">
            {pinnedApps.map((app) => (
              <li key={app.packageName}>
                <button
                  className="launcher-dock-app"
                  onClick={() => onLaunch(app)}
                  aria-label={`Open ${app.name}`}
                >
                  <AppGlyph app={app} />
                  <span>{app.name}</span>
                </button>
              </li>
            ))}
            <li>
              <button
                className="launcher-dock-app launcher-all-apps"
                onClick={onOpenAll}
                aria-label="All apps"
              >
                <span className="launcher-glyph">
                  <Grid2X2 size={25} strokeWidth={1.7} />
                </span>
                <span>All apps</span>
              </button>
            </li>
          </ul>
        ) : (
          <div className="launcher-pin-prompt">
            <span>
              <Pin size={18} />
              Keep your favourite apps close.
            </span>
            <button onClick={onOpenAll}>
              Choose apps
              <ArrowRight size={15} />
            </button>
          </div>
        )
      ) : shown.length > 0 ? (
        <ul className="launcher-grid">
          {shown.map((app) => {
            const isPinned = pinned.includes(app.packageName);
            return (
              <li
                className={`launcher-tile ${isPinned ? 'is-pinned' : ''}`}
                key={app.packageName}
              >
                <button
                  className="launcher-open"
                  onClick={() => onLaunch(app)}
                  aria-label={`Open ${app.name}`}
                >
                  <AppGlyph app={app} />
                  <span className="launcher-app-name">{app.name}</span>
                </button>
                <button
                  className={`launcher-pin ${isPinned ? 'selected' : ''}`}
                  onClick={() => onTogglePin(app.packageName)}
                  aria-label={`${isPinned ? 'Unpin' : 'Pin'} ${app.name}`}
                  aria-pressed={isPinned}
                  title={`${isPinned ? 'Unpin' : 'Pin'} ${app.name}`}
                >
                  <Pin size={15} fill={isPinned ? 'currentColor' : 'none'} />
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="launcher-empty">
          {onlyPinned ? <Pin size={26} /> : <Search size={27} />}
          <h3>
            {query
              ? 'No apps found.'
              : onlyPinned
                ? 'Make room for your favourites.'
                : 'Your apps will feel at home here.'}
          </h3>
          <p>
            {query
              ? 'Try another app name.'
              : onlyPinned
                ? 'Pin an app to find it in your favourites.'
                : 'Refresh to find apps installed on this device.'}
          </p>
          {(query || onlyPinned) && (
            <button
              className="secondary-button"
              onClick={() => {
                setQuery('');
                setOnlyPinned(false);
              }}
            >
              Show all apps
            </button>
          )}
        </div>
      )}
    </section>
  );
}
