import { useEffect, useRef, useState } from 'react';
import { Eye, Grid2X2, LoaderCircle, RefreshCw, Search, X } from 'lucide-react';
import type { LauncherApp } from '../lib/launcher';
import '../app-visibility-settings.css';

interface AppVisibilitySettingsProps {
  apps: LauncherApp[];
  hidden: string[];
  preview: boolean;
  loading: boolean;
  error: string | null;
  onSetHidden: (packageName: string, hidden: boolean) => Promise<void>;
  onRefresh: () => void;
}

function AppIcon({ app }: { app: LauncherApp }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [app.icon]);
  return (
    <span className="app-visibility-icon" aria-hidden="true">
      {app.icon && !failed ? (
        <img src={app.icon} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
      ) : <Grid2X2 size={21} strokeWidth={1.7} />}
    </span>
  );
}

export function AppVisibilitySettings({
  apps, hidden, preview, loading, error, onSetHidden, onRefresh,
}: AppVisibilitySettingsProps) {
  const [query, setQuery] = useState('');
  const [onlyHidden, setOnlyHidden] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [saveError, setSaveError] = useState('');
  const writing = useRef(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  const hiddenPackages = new Set(hidden);
  const hiddenCount = apps.filter((app) => hiddenPackages.has(app.packageName)).length;
  const search = query.trim().toLocaleLowerCase();
  const shown = apps.filter((app) =>
    (!onlyHidden || hiddenPackages.has(app.packageName)) &&
    `${app.name} ${app.packageName}`.toLocaleLowerCase().includes(search),
  );
  const names = new Map<string, number>();
  for (const app of apps) names.set(app.name, (names.get(app.name) ?? 0) + 1);
  const busy = loading || pending !== null;
  const displayedError = saveError || error;

  const changeVisibility = async (app: LauncherApp) => {
    if (writing.current || loading) return;
    writing.current = true;
    setPending(app.packageName);
    setSaveError('');
    try {
      await onSetHidden(app.packageName, !hiddenPackages.has(app.packageName));
    } catch (cause: unknown) {
      if (active.current) setSaveError(cause instanceof Error ? cause.message :
        typeof cause === 'string' ? cause : 'Could not save app visibility. Please try again.');
    } finally {
      writing.current = false;
      if (active.current) setPending(null);
    }
  };

  return (
    <section className="settings-card app-visibility-settings" aria-labelledby="app-visibility-title" aria-busy={busy}>
      <span className="settings-icon"><Eye size={25} /></span>
      <h2 id="app-visibility-title">App visibility</h2>
      <p>Choose which apps appear in Hjem.</p>

      <div className="app-visibility-toolbar">
        <label className="app-visibility-search">
          <Search size={18} aria-hidden="true" />
          <input value={query} onChange={(event) => setQuery(event.target.value)}
            placeholder="Find an app…" aria-label="Find installed apps" disabled={busy} />
          {query && <button type="button" aria-label="Clear installed app search" disabled={busy}
            onClick={() => setQuery('')}><X size={17} /></button>}
        </label>
        <button type="button" className="app-visibility-refresh" aria-label="Refresh installed apps"
          disabled={busy} onClick={() => { setSaveError(''); onRefresh(); }}>
          <RefreshCw size={19} className={loading ? 'spin' : undefined} aria-hidden="true" />
        </button>
      </div>

      <div className="app-visibility-list-heading">
        <div className="app-visibility-filter" role="group" aria-label="App visibility filter">
          <button type="button" aria-pressed={!onlyHidden} disabled={busy} onClick={() => setOnlyHidden(false)}>All apps</button>
          <button type="button" aria-pressed={onlyHidden} disabled={busy} onClick={() => setOnlyHidden(true)}>Hidden</button>
        </div>
        <span>{hiddenCount} hidden</span>
      </div>

      {displayedError && <p className="app-visibility-error" role="alert">{displayedError}</p>}

      {loading && apps.length === 0 ? (
        <p className="app-visibility-empty" role="status"><LoaderCircle size={20} className="spin" /> Loading apps…</p>
      ) : shown.length > 0 ? (
        <ul className="app-visibility-list" aria-label="Installed app visibility">
          {shown.map((app) => {
            const isHidden = hiddenPackages.has(app.packageName);
            return (
              <li key={app.packageName}>
                <AppIcon app={app} />
                <div className="app-visibility-name">
                  <strong>{app.name}</strong>
                  {(names.get(app.name) ?? 0) > 1 && <span>{app.packageName}</span>}
                  <span>{pending === app.packageName ? 'Saving…' : isHidden ? 'Hidden' : 'Shown'}</span>
                </div>
                <button type="button" className="app-visibility-switch" role="switch"
                  aria-label={`Show ${app.name} in launcher`} aria-checked={!isHidden} aria-disabled={busy}
                  onClick={() => void changeVisibility(app)}>
                  <span className="app-visibility-switch-track" aria-hidden="true"><span /></span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="app-visibility-empty">
          {query ? 'No apps match your search.' : onlyHidden ? 'No apps are hidden.' : error ? 'App list unavailable.' : 'No installed apps found.'}
        </p>
      )}
      {preview && <p className="app-visibility-preview">Sample apps in this preview.</p>}
    </section>
  );
}
