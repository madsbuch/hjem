import { useEffect, useRef, useState, type FormEvent } from 'react';
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
  Heart,
  PlugZap,
  MessageCircle,
} from 'lucide-react';
import {
  HomeAssistantClient,
  normalizeServerUrl,
  type ConnectionStatus,
  type HassEntity,
  type HassSnapshot,
} from './lib/home-assistant';
import { demoSnapshot, applyDemoService } from './lib/demo';
import {
  domainOf,
  isActive,
  nameOf,
  readPreference,
  roomFor,
  savePreference,
  visibleEntities,
} from './lib/entities';
import { DeviceCard } from './components/DeviceCard';
import { useTheme, type Theme } from './lib/useTheme';
import { AppLauncher } from './components/AppLauncher';
import { useLauncher } from './lib/useLauncher';
import { useConcierge } from './lib/useConcierge';
import { ConciergeChat } from './components/ConciergeChat';
import { ConciergeSettings } from './components/ConciergeSettings';
import {
  launchApp,
  openHomeSettings,
  onHomeRequested,
  type LauncherApp,
} from './lib/launcher';

type Page = 'home' | 'apps' | 'rooms' | 'concierge' | 'settings';
const navigation = [
  { id: 'home', label: 'Overview', Icon: House },
  { id: 'apps', label: 'Apps', Icon: LayoutGrid },
  { id: 'rooms', label: 'Rooms', Icon: Sofa },
  { id: 'concierge', label: 'Concierge', Icon: MessageCircle },
  { id: 'settings', label: 'Settings', Icon: Settings },
] as const;
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
  const { theme, setTheme } = useTheme();
  const launcher = useLauncher();
  const launching = useRef(false);
  const [page, setPage] = useState<Page>('home');
  const [snapshot, setSnapshot] = useState<HassSnapshot>(() =>
    structuredClone(demoSnapshot),
  );
  const [mode, setMode] = useState<'demo' | 'live'>('demo');
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [connectionMessage, setConnectionMessage] = useState('');
  const [server, setServer] = useState(() => readPreference('hjem.server', ''));
  const [connectedServer, setConnectedServer] = useState('');
  const [token, setToken] = useState('');
  const [formError, setFormError] = useState('');
  const [room, setRoom] = useState('all');
  const [query, setQuery] = useState('');
  const [onlyFavourites, setOnlyFavourites] = useState(false);
  const [favourites, setFavourites] = useState<string[]>(() =>
    readPreference('hjem.favourites.demo', [
      'light.living_pendant',
      'climate.living_room',
      'light.reading_lamp',
      'media_player.speaker',
    ]),
  );
  const [pending, setPending] = useState<Set<string>>(new Set());
  const pendingRef = useRef(new Set<string>());
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(
    null,
  );
  const [now, setNow] = useState(new Date());
  const dialog = useRef<HTMLDialogElement>(null);
  const client = useRef<HomeAssistantClient | null>(null);
  const sessionVersion = useRef(0);
  const formIsBusy = status === 'connecting';
  const canControl = !formIsBusy && (mode === 'demo' || status === 'connected');

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
    client.current = new HomeAssistantClient({
      onSnapshot: setSnapshot,
      onStatus: (next, message) => {
        setStatus(next);
        setConnectionMessage(message || '');
      },
    });
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => {
      sessionVersion.current++;
      client.current?.disconnect();
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
    pinned: launcher.pinned,
    onTogglePin: launcher.togglePin,
    onLaunch: (app: LauncherApp) => void openApp(app),
    onOpenAll: () => navigate('apps'),
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
  const openConnection = () => {
    setFormError('');
    dialog.current?.showModal();
  };
  const favouriteKey = `hjem.favourites.${mode === 'demo' ? 'demo' : connectedServer}`;
  const toggleFavourite = (id: string) =>
    setFavourites((current) => {
      const next = current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id];
      savePreference(favouriteKey, next);
      return next;
    });

  async function connect(event: FormEvent) {
    event.preventDefault();
    setFormError('');
    const version = ++sessionVersion.current;
    try {
      const normalized = normalizeServerUrl(server);
      await client.current!.connect(normalized, token);
      if (sessionVersion.current !== version) return;
      setServer(normalized);
      setConnectedServer(normalized);
      savePreference('hjem.server', normalized);
      setFavourites(readPreference(`hjem.favourites.${normalized}`, []));
      setMode('live');
      setRoom('all');
      setQuery('');
      setToken('');
      setOnlyFavourites(false);
      dialog.current?.close();
      notify('Welcome home. Home Assistant is connected.');
    } catch (error) {
      if (sessionVersion.current === version) setFormError(errorMessage(error));
    }
  }

  function useDemo() {
    sessionVersion.current++;
    client.current?.disconnect();
    setMode('demo');
    setSnapshot(structuredClone(demoSnapshot));
    setToken('');
    setFavourites(
      readPreference('hjem.favourites.demo', [
        'light.living_pendant',
        'climate.living_room',
        'light.reading_lamp',
        'media_player.speaker',
      ]),
    );
    setRoom('all');
    setQuery('');
    setOnlyFavourites(false);
    setFormError('');
    dialog.current?.close();
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
      else
        await client.current!.callService(
          domainOf(entity),
          service,
          entity.entity_id,
          data,
        );
      if (sessionVersion.current === version && domainOf(entity) === 'scene')
        notify(
          `${nameOf(entity)} activated${mode === 'demo' ? ' in your demo home' : ''}.`,
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

  const concierge = useConcierge({
    sessionId: `${mode}:${sessionVersion.current}`,
    snapshot,
    demo: mode === 'demo',
    connected: status === 'connected',
    apps: launcher.apps,
    appsPreview: launcher.preview,
    action: act,
    launch: launchApp,
  });

  const entities = visibleEntities(snapshot);
  const scenes = snapshot.entities.filter(
    (entity) =>
      domainOf(entity) === 'scene' &&
      !snapshot.registry.find((reg) => reg.entity_id === entity.entity_id)
        ?.hidden_by,
  );
  const rooms = [
    ...snapshot.areas.filter((area) =>
      entities.some((entity) => roomFor(entity, snapshot) === area.area_id),
    ),
    ...(entities.some((entity) => roomFor(entity, snapshot) === 'unassigned')
      ? [{ area_id: 'unassigned', name: 'Other devices' }]
      : []),
  ];
  const roomName = (entity: HassEntity) =>
    rooms.find((area) => area.area_id === roomFor(entity, snapshot))?.name ||
    'Other devices';
  const shown = entities.filter(
    (entity) =>
      (room === 'all' || roomFor(entity, snapshot) === room) &&
      (!onlyFavourites || favourites.includes(entity.entity_id)) &&
      `${nameOf(entity)} ${roomName(entity)}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const weather = snapshot.entities.find(
    (entity) => domainOf(entity) === 'weather',
  );
  const greeting =
    now.getHours() < 12
      ? 'Good morning'
      : now.getHours() < 18
        ? 'Good afternoon'
        : 'Good evening';
  const unit = snapshot.unitSystem?.temperature || '°C';
  const connectionLabel = formIsBusy
    ? 'Connecting…'
    : mode === 'demo'
      ? 'Demo home'
      : status === 'connected'
        ? 'Home connected'
        : status === 'reconnecting'
          ? 'Reconnecting…'
          : 'Home offline';

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
    <div className="app-shell">
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
        <div className="home-selector">
          <span className="home-avatar">
            <House size={19} />
          </span>
          <div>
            <strong>
              {mode === 'demo' ? 'Our home' : snapshot.locationName}
            </strong>
          </div>
        </div>
        <button
          className={`connection-pill sidebar-connection ${mode === 'live' && status !== 'connected' ? 'offline' : ''}`}
          onClick={openConnection}
        >
          <i />
          {connectionLabel}
        </button>
        <span className="nav-label">YOUR SPACE</span>
        <nav aria-label="Main navigation">
          {navigation.map(({ id, label, Icon }) => (
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
        </nav>
        <div className="sidebar-bottom">
          <div className="connection-card">
            <span className="connection-symbol">
              <PlugZap size={23} />
            </span>
            <strong>
              {mode === 'demo' ? 'Make yourself at home.' : 'A connected home.'}
            </strong>
            <p>
              {mode === 'demo'
                ? 'Bring your devices together with Home Assistant.'
                : 'Your devices, one peaceful place.'}
            </p>
            <button onClick={openConnection}>
              {mode === 'demo' ? 'Connect your home' : 'Connection settings'}
              <ArrowRight size={16} />
            </button>
          </div>
          <span className="sidebar-footer">
            <Heart size={12} /> A little more at home.
          </span>
        </div>
      </aside>

      <div className="main-shell">
        <main>
          {mode === 'live' && status !== 'connected' && (
            <div className="offline-banner" role="status">
              <WifiOff size={19} />
              <span>
                {connectionMessage ||
                  'Reconnecting to Home Assistant. Controls will be available when your home is back online.'}
              </span>
              <button onClick={openConnection}>Connection settings</button>
            </div>
          )}
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
                  <button
                    className={`connection-pill mobile-connection ${mode === 'live' && status !== 'connected' ? 'offline' : ''}`}
                    onClick={openConnection}
                  >
                    <i />
                    {connectionLabel}
                  </button>
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
                  {weather && weather.attributes.temperature != null && (
                    <div className="weather">
                      <Sun size={29} strokeWidth={1.5} />
                      <div>
                        <strong>
                          {weather.attributes.temperature}
                          {weather.attributes.temperature_unit || unit}
                        </strong>
                        <span>
                          {String(weather.state)
                            .replace('partlycloudy', 'Partly cloudy')
                            .replaceAll('_', ' ')}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              </section>
              <AppLauncher {...launcherProps} compact />
              {scenes.length > 0 && (
                <section className="quick-scenes">
                  <div className="section-heading">
                    <h2>A whole mood</h2>
                  </div>
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
              )}
            </>
          )}

          {page === 'rooms' && (
            <>
              <section className="page-intro">
                <div>
                  <span className="eyebrow date-label">
                    ROOM TO FEEL AT HOME
                  </span>
                  <h1>Every room. Your way.</h1>
                  <p>Find a space and make it feel just right.</p>
                </div>
                <span className="count-pill">{rooms.length} rooms</span>
              </section>
              <div className="rooms-grid">
                {rooms.map((area) => {
                  const Icon = roomIcon(area.name);
                  const roomEntities = entities.filter(
                    (entity) => roomFor(entity, snapshot) === area.area_id,
                  );
                  return (
                    <button
                      key={area.area_id}
                      className={`room-card ${room === area.area_id ? 'selected' : ''}`}
                      onClick={() =>
                        setRoom(room === area.area_id ? 'all' : area.area_id)
                      }
                      aria-pressed={room === area.area_id}
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

          {(page === 'home' || page === 'rooms') && (
            <section className="devices-section">
              <div className="section-heading device-section-heading">
                <div>
                  <h2>
                    {room === 'all'
                      ? 'Home controls'
                      : rooms.find((area) => area.area_id === room)?.name}
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
                      key={area.area_id}
                      className={room === area.area_id ? 'active' : ''}
                      onClick={() => setRoom(area.area_id)}
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
              <div className="devices-grid">
                {shown.map((entity) => (
                  <DeviceCard
                    key={entity.entity_id}
                    entity={entity}
                    room={roomName(entity)}
                    platform={
                      snapshot.registry.find(
                        (item) => item.entity_id === entity.entity_id,
                      )?.platform
                    }
                    unit={unit}
                    favourite={favourites.includes(entity.entity_id)}
                    onFavourite={() => toggleFavourite(entity.entity_id)}
                    onAction={act}
                    disabled={!canControl}
                    pending={pending.has(entity.entity_id)}
                  />
                ))}
              </div>
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

          {page === 'apps' && (
            <>
              <section className="page-intro">
                <div>
                  <span className="eyebrow date-label">
                    A PLACE FOR YOUR EVERYDAY
                  </span>
                  <h1>Your apps. Right at home.</h1>
                  <p>Open an app, or pin it to keep it close.</p>
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
                configured={
                  concierge.settings.hasApiKey && !!concierge.settings.model
                }
                model={concierge.settings.model}
                onSend={(text) => void concierge.send(text)}
                onStop={concierge.stop}
                onClear={concierge.clear}
                onOpenSettings={() => navigate('settings')}
              />
              {concierge.usage?.cost != null && (
                <p className="concierge-usage">
                  Last turn: ${concierge.usage.cost.toFixed(4)} reported by
                  OpenRouter
                </p>
              )}
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
                <ConciergeSettings
                  settings={concierge.settings}
                  onChange={concierge.setSettings}
                  disabled={concierge.busy}
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
                      navigate('home');
                      setOnlyFavourites(true);
                    }}
                  >
                    See pinned devices
                    <ArrowRight size={17} />
                  </button>
                </section>
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
                    {(
                      [
                        { id: 'system', label: 'System', Icon: Monitor },
                        { id: 'light', label: 'Light', Icon: Sun },
                        { id: 'dark', label: 'Dark', Icon: Moon },
                      ] as const
                    ).map(({ id, label, Icon }) => (
                      <button
                        key={id}
                        className={`theme-option ${theme === id ? 'selected' : ''}`}
                        aria-pressed={theme === id}
                        onClick={() => setTheme(id as Theme)}
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

          <footer className="main-footer">
            <span>
              <img src="/brand/logo.svg" alt="" />
              Less managing. More living.
            </span>
            <span>
              {mode === 'demo'
                ? 'Demo home · Sample devices'
                : 'Connected with Home Assistant'}
            </span>
          </footer>
        </main>
      </div>

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
      <dialog
        ref={dialog}
        className="connection-dialog"
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
          <label className="field-label" htmlFor="token">
            Long-lived access token
          </label>
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
            tokens. Create a token for Hjem.
          </p>
          <div className="privacy-note">
            <Heart size={17} />
            <p>
              Your token stays in memory for this session. You’ll enter it again
              when you reopen Hjem.
            </p>
          </div>
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
