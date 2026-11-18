import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import {
  House,
  LayoutGrid,
  Settings,
  Search,
  ArrowUpRight,
  ArrowRight,
  Sun,
  Moon,
  Monitor,
  Coffee,
  Wifi,
  WifiOff,
  X,
  Star,
  Sofa,
  CookingPot,
  BedDouble,
  DoorOpen,
  Check,
  LoaderCircle,
  SlidersHorizontal,
  ShieldCheck,
  MessageCircle,
  ScanLine,
  PencilRuler,
} from 'lucide-react';
import {
  HomeAssistantClient,
  normalizeServerUrl,
  type ActivityListener,
  type ConnectionStatus,
  type HassEntity,
  type HassSnapshot,
} from './lib/home-assistant';
import { demoSnapshot, applyDemoService, joinDemoAppliance } from './lib/demo';
import { HomeSetupManager } from './lib/home-setup';
import { DemoHomeSetupTransport } from './lib/demo-home-setup';
import { isRecord } from './lib/home-assistant-protocol';
import { SetupHistory } from './components/SetupHistory';
import './home-setup.css';
import {
  domainOf,
  isActive,
  nameOf,
  roomFor,
  visibleEntities,
} from './lib/entities';
import { DeviceCard } from './components/DeviceCard';
import { MusicPanel } from './components/MusicPanel';
import { TokenScanner } from './components/TokenScanner';
import { useTheme, type Theme } from './lib/useTheme';
import { AppLauncher } from './components/AppLauncher';
import { AppVisibilitySettings } from './components/AppVisibilitySettings';
import { useLauncher } from './lib/useLauncher';
import { useConcierge } from './lib/useConcierge';
import { useCalendar } from './lib/useCalendar';
import { CalendarToday } from './components/CalendarToday';
import { CalendarSettings } from './components/CalendarSettings';
import { selectWeather, WeatherSummary } from './components/WeatherSummary';
import { ConciergeChat } from './components/ConciergeChat';
import { ConciergeSettings } from './components/ConciergeSettings';
import { HomePlanner } from './components/HomePlanner';
import type { PairingStack } from './components/AddAppliance';
import type { LightStep } from './lib/home-planner';
import { ConfigurationTransfer } from './components/ConfigurationTransfer';
import { entityReference, resolveReferences, type ExportedSettings } from './lib/home-configuration';
import { saveConciergeSettings } from './lib/concierge-api';
import {
  launchApp,
  openHomeSettings,
  onHomeRequested,
  type LauncherApp,
} from './lib/launcher';
import {
  useStorage,
  getStorageSnapshot,
  saveConnection,
  forgetConnection,
  saveFavourites,
  saveSelectedSpeaker,
  addCalendarFeed,
  savePinnedApps,
  setAppHidden,
} from './lib/storage';

type Page = 'home' | 'apps' | 'controls' | 'planner' | 'concierge' | 'settings';
const navigation: { id: Page; label: string; Icon: typeof House }[] = [
  { id: 'home', label: 'Overview', Icon: House },
  { id: 'apps', label: 'Apps', Icon: LayoutGrid },
  { id: 'controls', label: 'Controls', Icon: SlidersHorizontal },
  { id: 'planner', label: 'Planner', Icon: PencilRuler },
  { id: 'concierge', label: 'Concierge', Icon: MessageCircle },
  { id: 'settings', label: 'Settings', Icon: Settings },
];
const themeOptions: { id: Theme; label: string; Icon: typeof Monitor }[] = [
  { id: 'system', label: 'System', Icon: Monitor },
  { id: 'light', label: 'Light', Icon: Sun },
  { id: 'dark', label: 'Dark', Icon: Moon },
];
const demoFavourites = [
  'light.living_pendant',
  'climate.living_room',
  'light.reading_lamp',
  'media_player.speaker',
];
const sceneIcons = [Sun, Moon, ArrowUpRight, Coffee];
const roomIcon = (name: string) =>
  /kitchen/i.test(name)
    ? CookingPot
    : /bed/i.test(name)
      ? BedDouble
      : /hall|entry/i.test(name)
        ? DoorOpen
        : Sofa;
const errorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : 'Something went wrong. Please try again.';

export default function App() {
  const storage = useStorage();
  const { theme, setTheme } = useTheme();
  const launcher = useLauncher();
  const launching = useRef(false);
  const [page, setPage] = useState<Page>('home');
  const [snapshot, updateSnapshot] = useState<HassSnapshot>(() =>
    storage.connection
      ? {
          entities: [],
          areas: [],
          devices: [],
          registry: [],
          locationName: 'My home',
        }
      : structuredClone(demoSnapshot),
  );
  const snapshotRef = useRef(snapshot);
  const setSnapshot = useCallback((value: HassSnapshot | ((current: HassSnapshot) => HassSnapshot)) => {
    const next = typeof value === 'function' ? value(snapshotRef.current) : value;
    snapshotRef.current = next;
    updateSnapshot(next);
  }, []);
  const [mode, setMode] = useState<'demo' | 'live'>(
    storage.connection ? 'live' : 'demo',
  );
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [connectionMessage, setConnectionMessage] = useState('');
  const [server, setServer] = useState(() => storage.serverUrl);
  const [connectedServer, setConnectedServer] = useState(
    storage.connection?.serverUrl ?? '',
  );
  const [token, setToken] = useState('');
  const [scanningToken, setScanningToken] = useState(false);
  const [formError, setFormError] = useState('');
  const [savingConnection, setSavingConnection] = useState(false);
  const [room, setRoom] = useState('all');
  const [query, setQuery] = useState('');
  const [onlyFavourites, setOnlyFavourites] = useState(false);
  const preferenceScope = mode === 'demo' ? 'demo' : connectedServer;
  const favourites =
    storage.favourites.find((item) => item.scope === preferenceScope)
      ?.entityIds ?? (mode === 'demo' ? demoFavourites : []);
  const selectedSpeakerId =
    storage.selectedSpeakers.find((item) => item.scope === preferenceScope)
      ?.entityId ?? '';
  const [pending, setPending] = useState<Set<string>>(new Set());
  const pendingRef = useRef(new Set<string>());
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(
    null,
  );
  const [now, setNow] = useState(new Date());
  const dialog = useRef<HTMLDialogElement>(null);
  const client = useRef<HomeAssistantClient | null>(null);
  const sessionVersion = useRef(0);
  const formIsBusy = status === 'connecting' || savingConnection;
  const canControl = !formIsBusy && (mode === 'demo' || status === 'connected');
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const setupSessionId = `${mode}:${sessionVersion.current}`;
  const setupClient = mode === 'live' ? client.current : null;
  const [, refreshSetupHistory] = useState(0);
  const [setupUiBusy, setSetupUiBusy] = useState(false);
  const [conciergeDraft, setConciergeDraft] = useState<{ id: number; text: string }>();
  const draftSequence = useRef(0);
  const setup = useMemo(() => {
    const version = sessionVersion.current;
    const isCurrent = () => sessionVersion.current === version && modeRef.current === mode;
    const transport = mode === 'demo'
      ? new DemoHomeSetupTransport({
          getSnapshot: () => snapshotRef.current,
          setSnapshot,
          isCurrent,
        })
      : setupClient;
    return transport ? new HomeSetupManager({
      transport,
      demo: mode === 'demo',
      isCurrent,
      onChange: () => { if (isCurrent()) refreshSetupHistory((value) => value + 1); },
    }) : undefined;
  }, [setupSessionId, mode, setupClient, setSnapshot]);

  useEffect(() => {
    if (!launcher.supported) return;
    let disposed = false;
    let removeListener: (() => void) | undefined;
    void onHomeRequested(() => {
      setPage('home');
      setRoom('all');
      setQuery('');
      setOnlyFavourites(false);
      dialog.current?.close();
      setScanningToken(false);
      window.scrollTo({ top: 0 });
    })
      .then((remove) => {
        if (disposed) remove();
        else removeListener = remove;
      })
      .catch((cause) => {
        if (!disposed) setToast({ text: errorMessage(cause), error: true });
      });
    return () => {
      disposed = true;
      removeListener?.();
    };
  }, [launcher.supported]);

  useEffect(() => {
    let active = true;
    const connection = new HomeAssistantClient({
      onSnapshot: (value) => {
        if (active) setSnapshot(value);
      },
      onStatus: (next, message) => {
        if (!active) return;
        setStatus(next);
        setConnectionMessage(message || '');
      },
    });
    client.current = connection;
    const saved = getStorageSnapshot().connection;
    if (saved) {
      setMode('live');
      setConnectedServer(saved.serverUrl);
      setSnapshot({
        entities: [],
        areas: [],
        devices: [],
        registry: [],
        locationName: 'My home',
      });
      void connection
        .connect(saved.serverUrl, saved.token, { retryInitial: true })
        .catch((cause: unknown) => {
          if (active) setConnectionMessage(errorMessage(cause));
        });
    }
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => {
      active = false;
      sessionVersion.current++;
      connection.disconnect();
      if (client.current === connection) client.current = null;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), toast.error ? 9000 : 3500);
    return () => clearTimeout(timer);
  }, [toast]);

  const notify = (text: string, error = false) => setToast({ text, error });
  async function openApp(app: LauncherApp) {
    if (launcher.preview) {
      notify(
        `${app.name} is a preview shortcut. Installed apps open in Hjem for Android.`,
      );
      return;
    }
    if (launching.current) return;
    launching.current = true;
    try {
      await launchApp(app.packageName);
    } catch (cause) {
      notify(errorMessage(cause), true);
    } finally {
      launching.current = false;
    }
  }
  async function chooseHomeApp() {
    try {
      await openHomeSettings();
    } catch (cause) {
      notify(errorMessage(cause), true);
    }
  }
  const launcherProps = {
    apps: launcher.apps,
    allAppsHidden: launcher.allApps.length > 0 && launcher.apps.length === 0,
    onLaunch: (app: LauncherApp) => void openApp(app),
    preview: launcher.preview,
    loading: launcher.loading,
    error: launcher.error,
    onRefresh: () => void launcher.refresh(),
  };
  const navigate = (next: Page) => {
    setPage(next);
    setRoom('all');
    setQuery('');
    setOnlyFavourites(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const askConcierge = (text: string) => {
    setConciergeDraft({ id: ++draftSequence.current, text });
    navigate('concierge');
  };
  const openConnection = () => {
    setFormError('');
    setToken(storage.connection?.token ?? '');
    dialog.current?.showModal();
  };
  const toggleFavourite = (id: string) => {
    const next = favourites.includes(id)
      ? favourites.filter((item) => item !== id)
      : [...favourites, id];
    void saveFavourites(preferenceScope, next).catch((cause: unknown) =>
      notify(errorMessage(cause), true),
    );
  };
  const selectSpeaker = (entityId: string) => {
    void saveSelectedSpeaker(preferenceScope, entityId).catch(
      (cause: unknown) => notify(errorMessage(cause), true),
    );
  };

  async function connect(event: FormEvent) {
    event.preventDefault();
    setFormError('');
    const version = ++sessionVersion.current;
    try {
      const normalized = normalizeServerUrl(server);
      const connection = client.current;
      if (!connection)
        throw new Error('Home Assistant is still starting. Please try again.');
      await connection.connect(normalized, token);
      if (sessionVersion.current !== version) return;
      try {
        setSavingConnection(true);
        await saveConnection({ serverUrl: normalized, token: token.trim() });
      } catch (cause) {
        connection.disconnect();
        if (mode === 'demo') setSnapshot(structuredClone(demoSnapshot));
        throw cause;
      }
      if (sessionVersion.current !== version) return;
      setServer(normalized);
      setConnectedServer(normalized);
      setMode('live');
      setRoom('all');
      setQuery('');
      setToken('');
      setOnlyFavourites(false);
      dialog.current?.close();
      notify('Home Assistant connected.');
    } catch (error) {
      if (sessionVersion.current === version) setFormError(errorMessage(error));
    } finally {
      setSavingConnection(false);
    }
  }

  function useDemo() {
    sessionVersion.current++;
    client.current?.disconnect();
    setMode('demo');
    setSnapshot(structuredClone(demoSnapshot));
    setToken('');
    setRoom('all');
    setQuery('');
    setOnlyFavourites(false);
    setFormError('');
    dialog.current?.close();
  }

  async function forgetHome() {
    try {
      await forgetConnection();
      useDemo();
      setServer('');
      setConnectedServer('');
      notify('Saved connection removed.');
    } catch (cause) {
      notify(errorMessage(cause), true);
    }
  }

  async function act(
    entity: HassEntity,
    service: string,
    data: Record<string, unknown> = {},
  ) {
    if (!canControl || pendingRef.current.has(entity.entity_id)) return false;
    const version = sessionVersion.current;
    pendingRef.current.add(entity.entity_id);
    setPending(new Set(pendingRef.current));
    try {
      if (domainOf(entity) === 'scene' && setup) {
        const result = await setup.activateMood(entity.entity_id);
        if (sessionVersion.current === version) {
          const message = isRecord(result) && typeof result.message === 'string'
            ? result.message
            : `${nameOf(entity)} requested. Check the devices for the result.`;
          notify(message, isRecord(result) && result.status === 'partial');
        }
        return true;
      }
      if (mode === 'demo')
        setSnapshot((current) =>
          applyDemoService(
            current,
            domainOf(entity),
            service,
            entity.entity_id,
            data,
          ),
        );
      else {
        const connection = client.current;
        if (!connection) throw new Error('Home Assistant is not connected.');
        await connection.callService(
          domainOf(entity),
          service,
          entity.entity_id,
          data,
        );
      }
      if (sessionVersion.current === version && domainOf(entity) === 'scene')
        notify(
          `${nameOf(entity)} requested${mode === 'demo' ? ' in your demo home' : ''}.`,
        );
      return true;
    } catch (error) {
      if (sessionVersion.current === version) notify(errorMessage(error), true);
      return false;
    } finally {
      pendingRef.current.delete(entity.entity_id);
      setPending(new Set(pendingRef.current));
    }
  }

  /** The planner's identify blink: a plain light command, without per-device locking. */
  async function sendLightStep(entity: HassEntity, step: LightStep) {
    if (!canControl) throw new Error('Home Assistant is not connected.');
    if (mode === 'demo') {
      setSnapshot((current) => applyDemoService(current, 'light', step.service, entity.entity_id, step.data));
      return;
    }
    const connection = client.current;
    if (!connection) throw new Error('Home Assistant is not connected.');
    await connection.callService('light', step.service, entity.entity_id, step.data);
  }
  const demoPairing = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(demoPairing.current), []);
  /** Open or close the Zigbee network for new appliances; the demo adds one itself. */
  async function permitJoin(stack: PairingStack, seconds: number) {
    if (stack === 'demo') {
      clearTimeout(demoPairing.current);
      if (seconds > 0 && mode === 'demo') {
        const version = sessionVersion.current;
        demoPairing.current = setTimeout(() => {
          if (sessionVersion.current === version && modeRef.current === 'demo') setSnapshot(joinDemoAppliance);
        }, 2_500);
      }
      return;
    }
    if (seconds > 0 && !canControl) throw new Error('Home Assistant is not connected.');
    const connection = client.current;
    if (!connection) throw new Error('Home Assistant is not connected.');
    await connection.permitJoin(stack, seconds);
  }
  const subscribeActivity = useCallback((listener: ActivityListener) => {
    if (mode !== 'live') return () => undefined;
    return client.current?.onActivity(listener) ?? (() => undefined);
  }, [mode]);

  const concierge = useConcierge({
    sessionId: `${mode}:${sessionVersion.current}`,
    snapshot,
    demo: mode === 'demo',
    connected: status === 'connected',
    apps: launcher.apps,
    appsPreview: launcher.preview,
    action: act,
    launch: launchApp,
    setup,
  }, mode === 'demo' ? 'demo' : connectedServer);

  /** Hjem's own settings for a configuration file; entities are keyed by device. */
  function collectSettings(): ExportedSettings {
    const stored = getStorageSnapshot();
    const home = snapshotRef.current;
    return {
      theme: stored.theme,
      calendars: stored.calendarFeeds.map((feed) => ({ name: feed.name, url: feed.url })),
      favourites: favourites.map((id) => entityReference(home, id)),
      selected_speaker: selectedSpeakerId ? entityReference(home, selectedSpeakerId) : null,
      hidden_apps: stored.hiddenApps.find((item) => item.scope === 'android')?.packageNames ?? [],
      pinned_apps: stored.pinnedApps.find((item) => item.scope === 'android')?.packageNames ?? [],
      concierge_model: concierge.settings.model,
    };
  }

  /** Merge imported settings into this tablet's; nothing existing is removed. */
  async function restoreSettings(settings: ExportedSettings): Promise<string[]> {
    const failures: string[] = [];
    const attempt = async (label: string, run: () => Promise<unknown>) => {
      try {
        await run();
      } catch (cause) {
        failures.push(`${label}: ${errorMessage(cause)}`);
      }
    };
    const stored = getStorageSnapshot();
    const home = snapshotRef.current;
    await attempt('Appearance', () => setTheme(settings.theme));
    for (const calendar of settings.calendars) {
      if (stored.calendarFeeds.some((feed) => feed.url === calendar.url)) continue;
      await attempt(`Calendar ${calendar.name}`, () => addCalendarFeed(calendar.name, calendar.url));
    }
    const hidden = stored.hiddenApps.find((item) => item.scope === 'android')?.packageNames ?? [];
    for (const packageName of settings.hidden_apps.filter((item) => !hidden.includes(item)))
      await attempt('Hidden apps', () => setAppHidden('android', packageName, true));
    const pinned = stored.pinnedApps.find((item) => item.scope === 'android')?.packageNames ?? [];
    if (settings.pinned_apps.some((item) => !pinned.includes(item)))
      await attempt('Pinned apps', () => savePinnedApps('android', [...new Set([...pinned, ...settings.pinned_apps])]));
    const restoredFavourites = resolveReferences(settings.favourites, home);
    if (restoredFavourites.some((item) => !favourites.includes(item)))
      await attempt('Pinned devices', () => saveFavourites(preferenceScope, [...new Set([...favourites, ...restoredFavourites])]));
    const [speaker] = settings.selected_speaker ? resolveReferences([settings.selected_speaker], home) : [];
    if (speaker) await attempt('Music speaker', () => saveSelectedSpeaker(preferenceScope, speaker));
    if (settings.concierge_model && settings.concierge_model !== concierge.settings.model)
      await attempt('Concierge model', async () => concierge.setSettings(await saveConciergeSettings(undefined, settings.concierge_model)));
    return failures;
  }

  async function undoSetup(changeId: string) {
    if (!setup || setupUiBusy || concierge.busy || !canControl) return;
    const version = sessionVersion.current;
    setSetupUiBusy(true);
    try {
      const result = await setup.undo(changeId);
      if (sessionVersion.current === version)
        notify(isRecord(result) && typeof result.message === 'string' ? result.message : 'Setup change undone.');
    } catch (cause) {
      if (sessionVersion.current === version) notify(errorMessage(cause), true);
    } finally {
      setSetupUiBusy(false);
    }
  }

  const calendar = useCalendar({
    client: client.current,
    status,
    mode,
    snapshot,
    now,
  });
  const entities = visibleEntities(snapshot);
  const speakers = entities.filter(
    (entity) => domainOf(entity) === 'media_player',
  );
  const scenes = snapshot.entities.filter(
    (entity) =>
      domainOf(entity) === 'scene' &&
      !snapshot.registry.find((reg) => reg.entity_id === entity.entity_id)
        ?.hidden_by &&
      !snapshot.registry.find((reg) => reg.entity_id === entity.entity_id)
        ?.disabled_by,
  );
  const hasUnassigned = entities.some((entity) => roomFor(entity, snapshot) === null);
  const rooms = [
    ...snapshot.areas.map((area) => ({ ...area, selection: `area:${area.area_id}` })),
    ...(hasUnassigned
      ? [{ area_id: null, selection: 'unassigned', name: 'Other devices' }]
      : []),
  ];
  useEffect(() => {
    if ((room === 'unassigned' && !hasUnassigned) ||
        (room !== 'all' && room !== 'unassigned' && !snapshot.areas.some((area) => `area:${area.area_id}` === room)))
      setRoom('all');
  }, [room, snapshot.areas, hasUnassigned]);
  const roomName = (entity: HassEntity) =>
    rooms.find((area) => area.area_id === roomFor(entity, snapshot))?.name ||
    'Other devices';
  const shown = entities.filter(
    (entity) =>
      (room === 'all' || (roomFor(entity, snapshot) === null ? 'unassigned' : `area:${roomFor(entity, snapshot)}`) === room) &&
      (!onlyFavourites || favourites.includes(entity.entity_id)) &&
      `${nameOf(entity)} ${roomName(entity)}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const weather = selectWeather(snapshot);
  const greeting =
    now.getHours() < 12
      ? 'Good morning'
      : now.getHours() < 18
        ? 'Good afternoon'
        : 'Good evening';
  const unit = snapshot.unitSystem?.temperature ?? '';
  const connectionLabel = formIsBusy
    ? 'Connecting…'
    : mode === 'demo'
      ? 'Demo home'
      : status === 'connected'
        ? 'Home connected'
        : status === 'reconnecting'
          ? 'Reconnecting…'
          : 'Home offline';
  const needsConnection = mode === 'live' && status !== 'connected';
  const connectionDescription = connectionMessage ||
    'Reconnecting to Home Assistant. Controls will be available when your home is back online.';
  const connectionNotice = needsConnection && (
    <div className="connection-notice" role="status">
      <button
        onClick={openConnection}
        title={connectionDescription}
        aria-label={`Connection settings: ${connectionDescription}`}
      >
        <WifiOff size={16} aria-hidden="true" />
        <span>{connectionLabel}</span>
      </button>
    </div>
  );

  const renderDevice = (entity: HassEntity) => (
    <DeviceCard
      key={entity.entity_id}
      entity={entity}
      room={roomName(entity)}
      platform={
        snapshot.registry.find((item) => item.entity_id === entity.entity_id)
          ?.platform
      }
      unit={unit}
      favourite={favourites.includes(entity.entity_id)}
      onFavourite={() => toggleFavourite(entity.entity_id)}
      onAction={act}
      disabled={!canControl}
      pending={pending.has(entity.entity_id)}
    />
  );

  const SceneButton = ({
    entity,
    index,
  }: {
    entity: HassEntity;
    index: number;
  }) => {
    const Icon = /night|evening/i.test(nameOf(entity))
      ? Moon
      : /morning/i.test(nameOf(entity))
        ? Sun
        : /away|out/i.test(nameOf(entity))
          ? ArrowUpRight
          : sceneIcons[index % sceneIcons.length];
    return (
      <button
        className={`scene-button scene-${index % 4}`}
        onClick={() => void act(entity, 'turn_on')}
        disabled={
          !canControl ||
          concierge.busy ||
          setupUiBusy ||
          pending.has(entity.entity_id) ||
          entity.state === 'unavailable'
        }
      >
        <span className="scene-icon">
          {pending.has(entity.entity_id) ? (
            <LoaderCircle size={21} className="spin" />
          ) : (
            <Icon size={21} strokeWidth={1.7} />
          )}
        </span>
        <span>{nameOf(entity)}</span>
        <ArrowUpRight size={17} className="scene-arrow" />
      </button>
    );
  };

  return (
    <div className={`app-shell${page === 'concierge' ? ' app-shell-concierge' : ''}`}>
      <aside className="sidebar">
        <button
          className="brand"
          onClick={() => navigate('home')}
          aria-label="Hjem overview"
        >
          <img src="/brand/logo.svg" alt="" />
          <span>
            hjem<span className="brand-dot">.</span>
          </span>
        </button>
        <nav aria-label="Main navigation">
          <div className="sidebar-links">
            {navigation.filter(({ id }) => id !== 'settings').map(({ id, label, Icon }) => (
              <button
                key={id}
                className={`nav-item ${page === id ? 'selected' : ''}`}
                aria-label={label}
                aria-current={page === id ? 'page' : undefined}
                onClick={() => navigate(id)}
              >
                <Icon size={20} strokeWidth={1.8} />
                <span>{label}</span>
                {page === id && <i />}
              </button>
            ))}
          </div>
          <div className="sidebar-footer-actions">
            <div className="connection-status-slot">{connectionNotice}</div>
            <button
              className={`nav-item nav-settings ${page === 'settings' ? 'selected' : ''}`}
              aria-label="Settings"
              aria-current={page === 'settings' ? 'page' : undefined}
              onClick={() => navigate('settings')}
            >
              <Settings size={20} strokeWidth={1.8} />
              <span>Settings</span>
              {page === 'settings' && <i />}
            </button>
          </div>
        </nav>
      </aside>

      <div className="main-shell">
        <main>
          {page === 'home' && (
            <>
              <section className="page-intro">
                <div>
                  <span className="eyebrow date-label">
                    {now.toLocaleDateString(undefined, {
                      weekday: 'long',
                      day: 'numeric',
                      month: 'long',
                    })}
                  </span>
                  <h1>
                    {greeting}
                    <span className="greeting-dot">.</span>
                  </h1>
                </div>
                <div className="home-at-a-glance">
                  <time
                    className="home-clock"
                    dateTime={now.toISOString()}
                    aria-label="Current time"
                  >
                    {now.toLocaleTimeString(undefined, {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </time>
                  <WeatherSummary weather={weather} />
                </div>
              </section>
              <div className="home-overview-grid">
                <section className="home-music" aria-label="Music controls">
                  <div className="section-heading">
                    <h2>Music</h2>
                  </div>
                  {speakers.length ? (
                    <MusicPanel
                      speakers={speakers}
                      snapshot={snapshot}
                      selectedId={selectedSpeakerId}
                      onSelect={selectSpeaker}
                      onAction={act}
                      disabled={!canControl}
                      pending={pending}
                    />
                  ) : (
                    <div className="home-section-empty">
                      Your Sonos speakers and other media players will appear
                      here when available in Home Assistant.
                    </div>
                  )}
                </section>
                <CalendarToday
                  calendar={calendar}
                  snapshot={snapshot}
                  now={now}
                />
              </div>
                <section className="quick-scenes" aria-label="Moods">
                  <div className="section-heading">
                    <h2>A whole mood</h2>
                    <button className="setup-link" onClick={() => askConcierge('Help me set up a mood using the rooms and devices in my home.')}>
                      <MessageCircle size={16} /> Set up a mood
                    </button>
                  </div>
                  {scenes.length === 0 && (
                    <p className="setup-empty">Make your home feel just right. Concierge can create a mood from your lights and devices.</p>
                  )}
                  <div className="scenes-grid">
                    {scenes.map((entity, index) => (
                      <SceneButton
                        key={entity.entity_id}
                        entity={entity}
                        index={index}
                      />
                    ))}
                  </div>
                </section>
            </>
          )}

          {page === 'controls' && (
            <>
              <section className="page-intro setup-controls-intro">
                <div>
                  <span className="eyebrow date-label">YOUR DEVICES</span>
                  <h1>Home controls</h1>
                  <p>
                    Lights, temperature, blinds, and more. Filter by room or
                    find a device.
                  </p>
                </div>
                <div className="setup-room-actions">
                  <span className="count-pill">{snapshot.areas.length} rooms</span>
                  <button className="secondary-button" onClick={() => askConcierge('Help me organize my rooms and the devices assigned to them.')}>
                    <MessageCircle size={16} /> Organize rooms
                  </button>
                </div>
              </section>
              <div className="rooms-grid">
                {rooms.map((area) => {
                  const Icon = roomIcon(area.name);
                  const roomEntities = entities.filter(
                    (entity) => roomFor(entity, snapshot) === area.area_id,
                  );
                  return (
                    <button
                      key={area.selection}
                      className={`room-card ${room === area.selection ? 'selected' : ''}`}
                      onClick={() =>
                        setRoom(room === area.selection ? 'all' : area.selection)
                      }
                      aria-pressed={room === area.selection}
                    >
                      <Icon size={30} strokeWidth={1.5} />
                      <h2>{area.name}</h2>
                      <span>
                        {roomEntities.length} devices ·{' '}
                        {roomEntities.filter(isActive).length} active
                      </span>
                      <ArrowUpRight size={19} />
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {page === 'controls' && (
            <section className="devices-section">
              <div className="section-heading device-section-heading">
                <div>
                  <h2>
                    {room === 'all'
                      ? 'All devices'
                      : rooms.find((area) => area.selection === room)?.name}
                  </h2>
                </div>
                <label className="search">
                  <Search size={17} />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Find a device…"
                    aria-label="Find a device"
                  />
                  {query && (
                    <button
                      onClick={() => setQuery('')}
                      aria-label="Clear search"
                    >
                      <X size={14} />
                    </button>
                  )}
                </label>
              </div>
              <div className="device-toolbar">
                <div className="room-tabs" aria-label="Filter by room">
                  <button
                    className={room === 'all' ? 'active' : ''}
                    onClick={() => setRoom('all')}
                  >
                    All rooms
                  </button>
                  {rooms.map((area) => (
                    <button
                      key={area.selection}
                      className={room === area.selection ? 'active' : ''}
                      onClick={() => setRoom(area.selection)}
                    >
                      {area.name}
                    </button>
                  ))}
                </div>
                <button
                  aria-label="Pinned"
                  className={`favourite-filter ${onlyFavourites ? 'active' : ''}`}
                  onClick={() => setOnlyFavourites(!onlyFavourites)}
                  aria-pressed={onlyFavourites}
                >
                  <Star
                    size={15}
                    fill={onlyFavourites ? 'currentColor' : 'none'}
                  />
                  <span>Pinned</span>
                </button>
              </div>
              <div className="devices-grid">{shown.map(renderDevice)}</div>
              {shown.length === 0 && (
                <div className="empty-state">
                  <Search size={30} />
                  <h3>
                    {onlyFavourites
                      ? 'Keep your favourites close.'
                      : 'A little quiet here.'}
                  </h3>
                  <p>
                    {onlyFavourites
                      ? 'Tap the star on a device to pin it here.'
                      : query
                        ? 'Try a different device name or room.'
                        : 'Devices in this room will appear when available in Home Assistant.'}
                  </p>
                  <button
                    className="secondary-button"
                    onClick={() => {
                      setRoom('all');
                      setQuery('');
                      setOnlyFavourites(false);
                    }}
                  >
                    Show all devices
                  </button>
                </div>
              )}
            </section>
          )}

          {page === 'planner' && (
            <HomePlanner
              snapshot={snapshot}
              demo={mode === 'demo'}
              disabled={!canControl}
              setupBusy={concierge.busy || setupUiBusy}
              setup={setup}
              onLightStep={sendLightStep}
              subscribe={subscribeActivity}
              onPermit={permitJoin}
              notify={notify}
            />
          )}

          {page === 'apps' && (
            <>
              <section className="page-intro">
                <div>
                  <span className="eyebrow date-label">
                    A PLACE FOR YOUR EVERYDAY
                  </span>
                  <h1>Your apps. Right at home.</h1>
                  <p>Find and open your apps.</p>
                </div>
                <LayoutGrid
                  className="intro-icon"
                  size={32}
                  strokeWidth={1.3}
                />
              </section>
              <AppLauncher {...launcherProps} />
            </>
          )}

          {page === 'concierge' && (
            <>
              <ConciergeChat
                messages={concierge.messages}
                busy={concierge.busy}
                status={concierge.status}
                settingsPending={concierge.settingsBusy}
                configured={
                  concierge.settings.hasApiKey &&
                  concierge.settings.model.length > 0
                }
                onSend={(text) => void concierge.send(text)}
                onSendVoice={concierge.sendVoice}
                voiceSessionKey={concierge.voiceSessionKey}
                chats={concierge.chats}
                chatId={concierge.chatId}
                historyLoading={concierge.historyLoading}
                historyError={concierge.historyError}
                saveError={concierge.saveError}
                readOnly={concierge.readOnly}
                onOpenChat={concierge.openChat}
                onRefreshChats={concierge.refreshChats}
                onRetrySaving={concierge.retrySaving}
                onStop={concierge.stop}
                onClear={concierge.clear}
                onOpenSettings={() => navigate('settings')}
                draftRequest={conciergeDraft}
                onDraftApplied={(id) => setConciergeDraft((current) => current?.id === id ? undefined : current)}
              >
                <SetupHistory
                  changes={setup?.changes() ?? []}
                  demo={mode === 'demo'}
                  disabled={!canControl || concierge.busy || setupUiBusy}
                  onUndo={(id) => void undoSetup(id)}
                />
                {concierge.usage?.cost != null && (
                  <p className="concierge-usage">
                    Last turn: ${concierge.usage.cost.toFixed(4)} reported by
                    OpenRouter
                  </p>
                )}
              </ConciergeChat>
            </>
          )}

          {page === 'settings' && (
            <>
              <section className="page-intro">
                <div>
                  <span className="eyebrow date-label">MAKE IT YOURS</span>
                  <h1>A home that fits you.</h1>
                  <p>A few simple things to bring it all together.</p>
                </div>
                <SlidersHorizontal
                  className="intro-icon"
                  size={32}
                  strokeWidth={1.3}
                />
              </section>
              <div className="settings-grid">
                <CalendarSettings />
                <ConciergeSettings
                  settings={concierge.settings}
                  onChange={concierge.setSettings}
                  onBusyChange={concierge.setSettingsBusy}
                  disabled={concierge.busy || concierge.settingsBusy || concierge.historyLoading}
                  initialError={concierge.settingsError}
                />
                <section className="settings-card">
                  <span className="settings-icon">
                    <Wifi size={25} />
                  </span>
                  <h2>Home Assistant</h2>
                  <p>
                    Connect Hjem to the devices and scenes you already love.
                  </p>
                  <div className="setting-row">
                    <span>Connection</span>
                    <strong>{connectionLabel}</strong>
                  </div>
                  {mode === 'live' && (
                    <div className="setting-row">
                      <span>Server</span>
                      <strong className="server-value">{server}</strong>
                    </div>
                  )}
                  {storage.connection && (
                    <button
                      className="text-button disconnect"
                      disabled={formIsBusy}
                      onClick={() => void forgetHome()}
                    >
                      Forget connection
                    </button>
                  )}
                  <button className="primary-button" onClick={openConnection}>
                    {mode === 'demo'
                      ? 'Connect your home'
                      : 'Manage connection'}
                    <ArrowRight size={17} />
                  </button>
                  {mode === 'live' && (
                    <button
                      className="text-button disconnect"
                      onClick={useDemo}
                    >
                      Disconnect and explore demo
                    </button>
                  )}
                </section>
                <section className="settings-card">
                  <span className="settings-icon amber">
                    <Star size={25} />
                  </span>
                  <h2>The everyday essentials</h2>
                  <p>
                    Pin the devices you reach for most. Your favourites stay on
                    this device, ready for next time.
                  </p>
                  <div className="setting-row">
                    <span>Pinned devices</span>
                    <strong>{favourites.length}</strong>
                  </div>
                  <button
                    className="secondary-button"
                    onClick={() => {
                      navigate('controls');
                      setOnlyFavourites(true);
                    }}
                  >
                    See pinned devices
                    <ArrowRight size={17} />
                  </button>
                </section>
                <ConfigurationTransfer
                  snapshot={snapshot}
                  getSnapshot={() => snapshotRef.current}
                  setup={setup}
                  demo={mode === 'demo'}
                  disabled={!canControl || concierge.busy}
                  nativeFiles={launcher.supported}
                  collectSettings={collectSettings}
                  restoreSettings={restoreSettings}
                  onBusyChange={setSetupUiBusy}
                  notify={notify}
                />
                <AppVisibilitySettings
                  apps={launcher.allApps}
                  hidden={launcher.hidden}
                  preview={launcher.preview}
                  loading={launcher.loading}
                  error={launcher.error}
                  onSetHidden={launcher.setHidden}
                  onRefresh={() => void launcher.refresh()}
                />
                <section className="settings-card home-screen-card">
                  <span className="settings-icon">
                    <House size={25} />
                  </span>
                  <h2>A home for your tablet</h2>
                  <p>
                    {launcher.supported
                      ? 'Make Hjem your default home screen to return to your apps, music, and home controls whenever you press Home.'
                      : 'Install Hjem on your Android tablet to open installed apps and use it as your home screen. This preview uses sample apps.'}
                  </p>
                  <div className="setting-row">
                    <span>Home screen</span>
                    <strong>
                      {launcher.isDefaultHome
                        ? 'Hjem is your default'
                        : launcher.supported
                          ? 'Ready to set up'
                          : 'Preview'}
                    </strong>
                  </div>
                  <button
                    className="primary-button"
                    disabled={!launcher.supported || launcher.loading}
                    onClick={() => void chooseHomeApp()}
                  >
                    Choose default home app
                    <ArrowUpRight size={17} />
                  </button>
                </section>
                <section className="settings-card appearance-card">
                  <span className="settings-icon">
                    <Moon size={25} />
                  </span>
                  <h2>Appearance</h2>
                  <p>
                    System follows your device’s light and dark schedule,
                    including sunset and sunrise when enabled on the tablet.
                  </p>
                  <div
                    className="theme-options"
                    role="group"
                    aria-label="Appearance"
                  >
                    {themeOptions.map(({ id, label, Icon }) => (
                      <button
                        key={id}
                        className={`theme-option ${theme === id ? 'selected' : ''}`}
                        aria-pressed={theme === id}
                        onClick={() =>
                          void setTheme(id).catch((cause: unknown) =>
                            notify(errorMessage(cause), true),
                          )
                        }
                      >
                        <Icon size={22} />
                        <span>{label}</span>
                      </button>
                    ))}
                  </div>
                </section>
                <section className="about-card">
                  <img src="/brand/logo.svg" alt="Hjem logo" />
                  <div>
                    <h2>
                      Hjem<span>.</span>
                    </h2>
                    <p>
                      Danish for home. Made for the little things that make it
                      yours.
                    </p>
                    <span>
                      Version 0.1.0 · Built with Tauri & Home Assistant
                    </span>
                  </div>
                </section>
              </div>
            </>
          )}
        </main>
      </div>

      <div className="mobile-navigation">
        <div className="connection-status-slot">{connectionNotice}</div>
        <nav className="mobile-nav" aria-label="Mobile navigation">
          {navigation.map(({ id, label, Icon }) => (
            <button
              key={id}
              className={page === id ? 'selected' : ''}
              aria-label={label}
              aria-current={page === id ? 'page' : undefined}
              onClick={() => navigate(id)}
            >
              <Icon size={22} strokeWidth={1.7} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
      </div>
      <dialog
        ref={dialog}
        className="connection-dialog"
        onClose={() => setScanningToken(false)}
        onCancel={(event) => {
          if (formIsBusy) event.preventDefault();
        }}
      >
        <form onSubmit={connect}>
          <div className="dialog-heading">
            <span className="settings-icon">
              <House size={25} />
            </span>
            <button
              type="button"
              className="icon-button"
              disabled={formIsBusy}
              onClick={() => dialog.current?.close()}
              aria-label="Close connection settings"
            >
              <X size={22} />
            </button>
          </div>
          <span className="eyebrow">WELCOME HOME</span>
          <h2>Let’s bring your home in.</h2>
          <p>
            Connect to Home Assistant to see your rooms, devices, and scenes in
            Hjem.
          </p>
          {needsConnection && !formError && (
            <p className="connection-detail">{connectionDescription}</p>
          )}
          <label className="field-label" htmlFor="server">
            Home Assistant address
          </label>
          <input
            id="server"
            className="text-input"
            type="text"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            placeholder="http://homeassistant.local:8123"
            value={server}
            onChange={(e) => setServer(e.target.value)}
            required
            disabled={formIsBusy}
          />
          <div className="token-label-row">
            <label className="field-label" htmlFor="token">
              Long-lived access token
            </label>
            <button
              type="button"
              className="scan-token-button"
              disabled={formIsBusy}
              onClick={() => setScanningToken(true)}
            >
              <ScanLine size={18} />
              Scan QR code
            </button>
          </div>
          <input
            id="token"
            className="text-input"
            type="password"
            autoComplete="off"
            placeholder="Paste your access token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            required
            disabled={formIsBusy}
          />
          <p className="field-help">
            In Home Assistant, open your profile → Security → Long-lived access
            tokens. Create a token for Hjem, then select Generate QR code.
          </p>
          {isTauri() && (
            <div className="privacy-note">
              <ShieldCheck size={17} />
              <p>
                Hjem saves your connection on this device and reconnects
                automatically.
              </p>
            </div>
          )}
          {formError && (
            <p className="form-error" role="alert">
              {formError}
            </p>
          )}
          <button
            type="submit"
            className="primary-button"
            disabled={formIsBusy}
          >
            {formIsBusy ? (
              <>
                <LoaderCircle size={17} className="spin" />
                Connecting to your home…
              </>
            ) : (
              <>
                Connect Home Assistant
                <ArrowRight size={17} />
              </>
            )}
          </button>
          <button
            type="button"
            className="text-button demo-button"
            disabled={savingConnection}
            onClick={useDemo}
          >
            {formIsBusy
              ? 'Cancel and return to demo'
              : mode === 'demo'
                ? 'Keep exploring the demo'
                : 'Disconnect and explore demo'}
          </button>
        </form>
      </dialog>
      {scanningToken && (
        <TokenScanner
          onClose={() => setScanningToken(false)}
          onToken={(scanned) => {
            setToken(scanned);
            setFormError('');
            setScanningToken(false);
            notify('Access token scanned');
            requestAnimationFrame(() =>
              document.getElementById('token')?.focus(),
            );
          }}
        />
      )}
      {toast && (
        <div
          className={`toast ${toast.error ? 'error' : ''}`}
          role={toast.error ? 'alert' : 'status'}
        >
          {toast.error ? <WifiOff size={18} /> : <Check size={18} />}
          <span>{toast.text}</span>
          <button
            className="icon-button"
            onClick={() => setToast(null)}
            aria-label="Dismiss notification"
          >
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
