import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  House,
  LayoutGrid,
  Sparkles,
  Settings,
  Search,
  ArrowUpRight,
  ArrowRight,
  Sun,
  Moon,
  Monitor,
  Coffee,
  Leaf,
  Wifi,
  WifiOff,
  X,
  Lightbulb,
  Thermometer,
  ChevronRight,
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
  CircleHelp,
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
import { RoomIllustration } from './components/RoomIllustration';
import { useTheme, type Theme } from './lib/useTheme';

type Page = 'home' | 'rooms' | 'scenes' | 'settings';
const navigation = [
  { id: 'home', label: 'Overview', Icon: House },
  { id: 'rooms', label: 'Rooms', Icon: LayoutGrid },
  { id: 'scenes', label: 'Scenes', Icon: Sparkles },
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
  const { theme, resolvedTheme, setTheme } = useTheme();
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
  const lightsOn = entities.filter(
    (entity) => domainOf(entity) === 'light' && entity.state === 'on',
  ).length;
  const climate = entities.find(
    (entity) =>
      domainOf(entity) === 'climate' &&
      entity.attributes.current_temperature != null,
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
            <span>Your everyday, simplified</span>
          </div>
        </div>
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
        <header className="topbar">
          <div className="breadcrumb">
            <House size={16} />
            <span>{snapshot.locationName}</span>
            <ChevronRight size={13} />
            <strong>
              {navigation.find((item) => item.id === page)?.label}
            </strong>
          </div>
          <div className="topbar-actions">
            <button
              className={`connection-pill ${mode === 'live' && status !== 'connected' ? 'offline' : ''}`}
              onClick={openConnection}
            >
              <i />
              {connectionLabel}
            </button>
            <button
              className="profile-button"
              onClick={() =>
                setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')
              }
              aria-label={`Switch to ${resolvedTheme === 'dark' ? 'light' : 'dark'} mode`}
              title={`Switch to ${resolvedTheme === 'dark' ? 'light' : 'dark'} mode`}
            >
              {resolvedTheme === 'dark' ? (
                <Sun size={18} />
              ) : (
                <Moon size={18} />
              )}
            </button>
          </div>
        </header>
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
                  <p>Welcome to your little corner of calm.</p>
                </div>
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
              </section>
              <section className="welcome-card">
                <div className="welcome-copy">
                  <span className="hero-eyebrow">
                    <span />
                    {mode === 'demo'
                      ? 'A LITTLE LOOK AT WHAT’S POSSIBLE'
                      : 'YOUR HOME, AT A GLANCE'}
                  </span>
                  <h2>
                    Home feels
                    <br />
                    better together.
                  </h2>
                  <p>
                    A softer light. The right temperature.
                    <br />
                    The little things, just how you like them.
                  </p>
                  <div className="home-stats">
                    <span>
                      <Lightbulb size={16} />
                      {lightsOn} {lightsOn === 1 ? 'light' : 'lights'} on
                    </span>
                    {climate && (
                      <span>
                        <Thermometer size={16} />
                        {climate.attributes.current_temperature}
                        {unit} inside
                      </span>
                    )}
                  </div>
                </div>
                <RoomIllustration />
                <span className="hero-corner">
                  {mode === 'demo'
                    ? 'EXPLORE YOUR DEMO HOME'
                    : 'CONNECTED WITH HOME ASSISTANT'}
                  <Leaf size={13} />
                </span>
              </section>
              {scenes.length > 0 && (
                <section className="quick-scenes">
                  <div className="section-heading">
                    <h2>A moment for everything</h2>
                    <button
                      className="text-button"
                      onClick={() => navigate('scenes')}
                    >
                      All scenes
                      <ArrowRight size={15} />
                    </button>
                  </div>
                  <div className="scenes-grid">
                    {scenes.slice(0, 4).map((entity, index) => (
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
                      ? 'Your home, at your fingertips'
                      : rooms.find((area) => area.area_id === room)?.name}
                  </h2>
                  <p>Little adjustments. A big difference.</p>
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

          {page === 'scenes' && (
            <>
              <section className="page-intro">
                <div>
                  <span className="eyebrow date-label">SET THE FEELING</span>
                  <h1>One tap. A whole mood.</h1>
                  <p>Your Home Assistant scenes, ready when you are.</p>
                </div>
                <Sparkles className="intro-icon" size={34} strokeWidth={1.3} />
              </section>
              <div className="scenes-page-grid">
                {scenes.map((entity, index) => (
                  <SceneButton
                    key={entity.entity_id}
                    entity={entity}
                    index={index}
                  />
                ))}
              </div>
              {scenes.length === 0 && (
                <div className="empty-state">
                  <Sparkles size={32} />
                  <h3>Your next favourite moment.</h3>
                  <p>
                    Create a scene in Home Assistant and reconnect to see it
                    here.
                  </p>
                </div>
              )}
              <div className="help-note">
                <CircleHelp size={18} />
                <p>
                  Scenes bring several devices together. Create and edit them in
                  Home Assistant, then activate them here.
                </p>
              </div>
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
                <section className="settings-card appearance-card">
                  <span className="settings-icon">
                    <Moon size={25} />
                  </span>
                  <h2>A softer kind of screen</h2>
                  <p>
                    Find the light that feels right. Follow your device, or make
                    yourself comfortable in light or dark.
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
