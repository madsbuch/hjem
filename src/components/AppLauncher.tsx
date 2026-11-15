import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowRight,
  CalendarDays,
  CirclePlay,
  Grid2X2,
  Images,
  Info,
  LoaderCircle,
  Music2,
  Pin,
  RefreshCw,
  Search,
  Smartphone,
  Trash2,
  Globe2,
  X,
} from 'lucide-react';
import { openAppInfo, uninstallApp, type LauncherApp } from '../lib/launcher';

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
  allAppsHidden?: boolean;
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

function AppButton({ app, compact, onLaunch, onOptions }: {
  app: LauncherApp;
  compact: boolean;
  onLaunch: (app: LauncherApp) => void;
  onOptions: (app: LauncherApp) => void;
}) {
  const press = useRef<{ pointerId: number; x: number; y: number; timer: number } | null>(null);
  const suppressClick = useRef(false);
  const cancelPress = () => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  };
  useEffect(() => {
    document.addEventListener('scroll', cancelPress, true);
    window.addEventListener('blur', cancelPress);
    return () => {
      cancelPress();
      document.removeEventListener('scroll', cancelPress, true);
      window.removeEventListener('blur', cancelPress);
    };
  }, []);

  return (
    <button
      className={compact ? 'launcher-dock-app' : 'launcher-open'}
      aria-label={`Open ${app.name}`}
      aria-haspopup="dialog"
      title={`Open ${app.name}. Hold for app options.`}
      onPointerDown={(event) => {
        cancelPress();
        suppressClick.current = false;
        if (!event.isPrimary || event.button !== 0) return;
        press.current = {
          pointerId: event.pointerId, x: event.clientX, y: event.clientY,
          timer: window.setTimeout(() => {
            press.current = null;
            suppressClick.current = true;
            onOptions(app);
          }, 500),
        };
      }}
      onPointerMove={(event) => {
        const current = press.current;
        if (current && current.pointerId === event.pointerId &&
          Math.hypot(event.clientX - current.x, event.clientY - current.y) > 10) cancelPress();
      }}
      onPointerUp={cancelPress}
      onPointerCancel={cancelPress}
      onPointerLeave={cancelPress}
      onContextMenu={(event) => {
        event.preventDefault();
        cancelPress();
        suppressClick.current = true;
        onOptions(app);
      }}
      onKeyDown={(event) => {
        if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
          event.preventDefault();
          cancelPress();
          onOptions(app);
        }
      }}
      onClick={(event) => {
        if (suppressClick.current && event.detail !== 0) {
          event.preventDefault();
          suppressClick.current = false;
          return;
        }
        onLaunch(app);
      }}
    >
      <AppGlyph app={app} />
      <span className={compact ? undefined : 'launcher-app-name'}>{app.name}</span>
    </button>
  );
}

function AppOptions({ app, preview, onClose }: {
  app: LauncherApp;
  preview: boolean;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const active = useRef(true);
  const previousFocus = useRef(document.activeElement);
  const titleId = useId();
  const descriptionId = useId();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const modal = dialog.current;
    if (!modal) return;
    active.current = true;
    modal.showModal();
    return () => {
      active.current = false;
      modal.close();
      if (previousFocus.current instanceof HTMLElement && previousFocus.current.isConnected)
        previousFocus.current.focus({ preventScroll: true });
    };
  }, []);
  const run = async (action: (packageName: string) => Promise<void>) => {
    if (preview || pending) return;
    setPending(true);
    setError('');
    try {
      await action(app.packageName);
      if (active.current) onClose();
    } catch (cause: unknown) {
      if (active.current) setError(cause instanceof Error ? cause.message :
        typeof cause === 'string' ? cause : 'Could not open Android app settings. Please try again.');
    } finally {
      if (active.current) setPending(false);
    }
  };
  return createPortal(
    <dialog ref={dialog} className="launcher-app-options" aria-labelledby={titleId}
      aria-describedby={descriptionId} onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="launcher-options-content">
        <div className="launcher-options-heading">
          <AppGlyph app={app} />
          <div><p>App options</p><h2 id={titleId}>{app.name}</h2></div>
        </div>
        <p id={descriptionId} className="launcher-options-description">
          {preview ? 'This is a sample app. App management is available on Android.' :
            'Manage this app in Android settings. Android will ask you to confirm before uninstalling.'}
        </p>
        <div className="launcher-options-actions" aria-busy={pending}>
          <button disabled={preview || pending} onClick={() => void run(openAppInfo)}>
            <Info size={20} /> App info
          </button>
          <button className="launcher-uninstall" disabled={preview || pending} onClick={() => void run(uninstallApp)}>
            <Trash2 size={20} /> Uninstall app
          </button>
        </div>
        {error && <p className="launcher-options-error" role="alert">{error}</p>}
        <button className="launcher-options-cancel" onClick={onClose} autoFocus>Cancel</button>
      </div>
    </dialog>, document.body,
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
  allAppsHidden = false,
  compact = false,
}: AppLauncherProps) {
  const [query, setQuery] = useState('');
  const [onlyPinned, setOnlyPinned] = useState(false);
  const [optionsApp, setOptionsApp] = useState<LauncherApp | null>(null);
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
                <AppButton app={app} compact onLaunch={onLaunch} onOptions={setOptionsApp} />
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
                <AppButton app={app} compact={false} onLaunch={onLaunch} onOptions={setOptionsApp} />
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
              : allAppsHidden
                ? 'All apps are hidden.'
                : onlyPinned
                  ? 'Make room for your favourites.'
                  : 'Your apps will feel at home here.'}
          </h3>
          <p>
            {query
              ? 'Try another app name.'
              : allAppsHidden
                ? 'Show apps in Settings → App visibility.'
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
      {optionsApp && <AppOptions key={optionsApp.packageName} app={optionsApp} preview={preview}
        onClose={() => setOptionsApp(null)} />}
    </section>
  );
}
