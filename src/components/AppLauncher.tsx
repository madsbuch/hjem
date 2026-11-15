import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  CalendarDays,
  CirclePlay,
  Grid2X2,
  Images,
  Info,
  LoaderCircle,
  Music2,
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
  onLaunch: (app: LauncherApp) => void;
  preview: boolean;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  allAppsHidden?: boolean;
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

function AppButton({ app, onLaunch, onOptions }: {
  app: LauncherApp;
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
      className="launcher-open"
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
      <span className="launcher-app-name">{app.name}</span>
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
  onLaunch,
  preview,
  loading,
  error,
  onRefresh,
  allAppsHidden = false,
}: AppLauncherProps) {
  const [query, setQuery] = useState('');
  const [optionsApp, setOptionsApp] = useState<LauncherApp | null>(null);
  const shown = apps.filter((app) =>
    `${app.name} ${app.packageName}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );

  return (
    <section
      className="app-launcher launcher-full"
      aria-label="Apps"
    >
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
      ) : shown.length > 0 ? (
        <ul className="launcher-grid">
          {shown.map((app) => (
            <li className="launcher-tile" key={app.packageName}>
              <AppButton app={app} onLaunch={onLaunch} onOptions={setOptionsApp} />
            </li>
          ))}
        </ul>
      ) : (
        <div className="launcher-empty">
          <Search size={27} />
          <h3>
            {query
              ? 'No apps found.'
              : allAppsHidden
                ? 'All apps are hidden.'
                : 'Your apps will feel at home here.'}
          </h3>
          <p>
            {query
              ? 'Try another app name.'
              : allAppsHidden
                ? 'Show apps in Settings → App visibility.'
                : 'Refresh to find apps installed on this device.'}
          </p>
          {query && (
            <button
              className="secondary-button"
              onClick={() => {
                setQuery('');
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
