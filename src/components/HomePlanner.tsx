import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  BatteryLow,
  BatteryMedium,
  CirclePlus,
  Cpu,
  Lightbulb,
  LoaderCircle,
  MousePointerClick,
  PencilRuler,
  Plus,
  Radio,
  Sparkles,
  Square,
} from 'lucide-react';
import type { ActivityListener, HassEntity, HassSnapshot } from '../lib/home-assistant';
import type { HomeSetup } from '../lib/home-setup-types';
import { isRecord } from '../lib/home-assistant-protocol';
import { isUnavailable } from '../lib/entities';
import {
  identifyLight,
  plannerLights,
  plannerRemotes,
  pressFromActivity,
  zigbeeStacks,
  type LightStep,
  type PlannerLight,
  type PlannerRemote,
  type PlannerTarget,
  type RemotePress,
} from '../lib/home-planner';
import { demoRemotes } from '../lib/demo';
import { NameField, RoomSelect } from './PlannerFields';
import { AddAppliance, type PairingStack } from './AddAppliance';
import '../home-planner.css';

type Tab = 'lights' | 'remotes';
type Filter = 'all' | 'unassigned';

interface Props {
  snapshot: HassSnapshot;
  demo: boolean;
  /** Controls are unavailable, e.g. while the home is offline. */
  disabled: boolean;
  /** Another setup change, such as a Concierge request, is running. */
  setupBusy: boolean;
  setup: HomeSetup | undefined;
  onLightStep: (entity: HassEntity, step: LightStep) => Promise<void>;
  subscribe: (listener: ActivityListener) => () => void;
  onPermit: (stack: PairingStack, seconds: number) => Promise<void>;
  notify: (text: string, error?: boolean) => void;
}

const GLOW_MS = 4_000;
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong. Please try again.';
const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const resultMessage = (result: unknown, fallback: string) =>
  isRecord(result) && typeof result.message === 'string' ? result.message : fallback;

function ago(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min ago` : new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function RemoteVisual({ press, glowing }: { press: RemotePress | undefined; glowing: boolean }) {
  return (
    <div className="remote-visual" aria-hidden="true">
      <span className="remote-body">
        <i />
        <i />
        <i />
      </span>
      {glowing && press && <span key={press.at} className="remote-ripple" />}
    </div>
  );
}

export function HomePlanner({ snapshot, demo, disabled, setupBusy, setup, onLightStep, subscribe, onPermit, notify }: Props) {
  const [tab, setTab] = useState<Tab>('lights');
  const [filter, setFilter] = useState<Filter>('all');
  const [saving, setSaving] = useState<string | null>(null);
  const [identifying, setIdentifying] = useState<ReadonlySet<string>>(new Set());
  const [presses, setPresses] = useState<ReadonlyMap<string, RemotePress>>(new Map());
  const [lastPress, setLastPress] = useState<RemotePress | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [newRoom, setNewRoom] = useState('');
  const [adding, setAdding] = useState(false);
  /** Devices known when pairing started; anything else joined since. */
  const [baseline, setBaseline] = useState<ReadonlySet<string> | null>(null);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const blinkers = useRef(new Map<string, AbortController>());
  const mounted = useRef(true);
  const demoTurn = useRef(0);

  useEffect(() => {
    mounted.current = true;
    const running = blinkers.current;
    return () => {
      mounted.current = false;
      for (const controller of running.values()) controller.abort();
    };
  }, []);

  const recordPress = useCallback((press: RemotePress) => {
    setPresses((current) => new Map(current).set(press.deviceId, press));
    setLastPress(press);
    setNow(Date.now());
  }, []);

  useEffect(() => subscribe((activity) => {
    const press = pressFromActivity(activity, snapshotRef.current);
    if (press) recordPress(press);
  }), [subscribe, recordPress]);

  // Tick only while a recent press is still glowing or its time label is changing.
  useEffect(() => {
    if (!lastPress) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [lastPress]);

  const pressedIds = useMemo(() => new Set(presses.keys()), [presses]);
  const lights = useMemo(() => plannerLights(snapshot), [snapshot]);
  const remotes = useMemo(() => plannerRemotes(snapshot, pressedIds), [snapshot, pressedIds]);
  const areas = useMemo(() => [...snapshot.areas].sort((first, second) => first.name.localeCompare(second.name)), [snapshot.areas]);
  const lastRemote = lastPress ? remotes.find((remote) => remote.device.id === lastPress.deviceId) : undefined;

  // Bring a pressed remote into view, without moving the page while someone types.
  useEffect(() => {
    if (!lastPress || tab !== 'remotes') return;
    const active = document.activeElement;
    if (active instanceof HTMLInputElement || active instanceof HTMLSelectElement) return;
    const card = document.querySelector(`[data-remote-id="${CSS.escape(lastPress.deviceId)}"]`);
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    card?.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
  }, [lastPress, tab]);

  const editLocked = disabled || setupBusy || !setup || saving !== null;

  async function write(key: string, task: (manager: HomeSetup) => Promise<unknown>, fallback: string): Promise<boolean> {
    if (!setup || saving !== null || disabled || setupBusy) return false;
    setSaving(key);
    try {
      const result = await task(setup);
      if (mounted.current) notify(resultMessage(result, fallback));
      return true;
    } catch (error) {
      if (mounted.current) notify(errorMessage(error), true);
      return false;
    } finally {
      if (mounted.current) setSaving(null);
    }
  }
  const rename = (target: PlannerTarget, name: string) =>
    write(`${target.id}:name`, (manager) => target.kind === 'device'
      ? manager.renameDevice(target.id, name)
      : manager.renameEntity(target.id, name), 'Name saved.');
  const assign = (target: PlannerTarget, areaId: string | null) =>
    void write(`${target.id}:room`, (manager) => target.kind === 'device'
      ? manager.assignDevice(target.id, areaId)
      : manager.assignEntity(target.id, areaId), 'Room saved.');

  async function addRoom(event: FormEvent) {
    event.preventDefault();
    const name = newRoom.trim();
    if (!name) return;
    if (await write('room:new', (manager) => manager.createRoom(name), `${name} created.`) && mounted.current) setNewRoom('');
  }

  async function identify(light: PlannerLight) {
    const id = light.entity.entity_id;
    const running = blinkers.current.get(id);
    if (running) {
      running.abort();
      return;
    }
    const controller = new AbortController();
    blinkers.current.set(id, controller);
    setIdentifying((current) => new Set(current).add(id));
    try {
      await identifyLight(light.entity, (step) => onLightStep(light.entity, step), { signal: controller.signal });
    } catch (error) {
      if (!isAbort(error) && mounted.current) notify(errorMessage(error), true);
    } finally {
      blinkers.current.delete(id);
      if (mounted.current)
        setIdentifying((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        });
    }
  }

  function simulatePress() {
    const available = demoRemotes.filter((remote) => snapshot.devices.some((device) => device.id === remote.deviceId));
    const remote = available[demoTurn.current++ % Math.max(1, available.length)];
    if (!remote) return;
    const action = remote.actions[Math.floor(Math.random() * remote.actions.length)] ?? 'pressed';
    recordPress({ deviceId: remote.deviceId, action, at: Date.now() });
  }

  const joinedIds = new Set(baseline ? snapshot.devices.filter((device) => !baseline.has(device.id)).map((device) => device.id) : []);
  const deviceOf = (light: PlannerLight) =>
    snapshot.registry.find((entry) => entry.entity_id === light.entity.entity_id)?.device_id ?? null;
  // While the add panel is open, new appliances are shown there instead of in the lists.
  const shownLights = lights.filter((light) => (filter === 'all' || !light.areaId) && !joinedIds.has(deviceOf(light) ?? ''));
  const shownRemotes = remotes.filter((remote) => (filter === 'all' || !remote.areaId) && !joinedIds.has(remote.device.id));
  const unassigned = tab === 'lights'
    ? lights.filter((light) => !light.areaId).length
    : remotes.filter((remote) => !remote.areaId).length;

  const renderLight = (light: PlannerLight) => {
    const id = light.entity.entity_id;
    const blinking = identifying.has(id);
    const offline = isUnavailable(light.entity);
    const on = light.entity.state === 'on';
    return (
      <article
        key={id}
        className={`planner-card light-plan ${on ? 'is-on' : ''} ${blinking ? 'is-identifying' : ''}`}
        aria-label={light.name}
      >
        <div className="planner-card-top">
          <span className="light-visual" aria-hidden="true">
            <Lightbulb size={22} strokeWidth={1.7} />
          </span>
          <button
            className={`identify-button ${blinking ? 'active' : ''}`}
            onClick={() => void identify(light)}
            disabled={(disabled || offline) && !blinking}
            aria-label={blinking ? `Stop blinking ${light.name}` : `Blink ${light.name}`}
            title="Blink the lamp so you can spot it"
          >
            {blinking ? <Square size={13} fill="currentColor" /> : <Sparkles size={15} />}
            <span>{blinking ? 'Blinking…' : 'Blink'}</span>
          </button>
        </div>
        {light.target ? (
          <NameField
            value={light.name}
            label={`Name for ${light.name}`}
            disabled={editLocked}
            onSave={(name) => light.target ? rename(light.target, name) : Promise.resolve(false)}
          />
        ) : (
          <strong className="planner-name static" title="Give this light a unique ID in Home Assistant to rename it here.">{light.name}</strong>
        )}
        <span className="planner-meta">
          {[offline ? 'Offline' : on ? 'On' : 'Off', light.model].filter(Boolean).join(' · ')}
          {saving?.startsWith(`${light.target?.id}:`) && <LoaderCircle size={12} className="spin" aria-label="Saving" />}
        </span>
        <RoomSelect
          value={light.areaId}
          label={`Room for ${light.name}`}
          areas={areas}
          disabled={editLocked || !light.target}
          onChange={(areaId) => light.target && assign(light.target, areaId)}
        />
      </article>
    );
  };

  const renderRemote = (remote: PlannerRemote) => {
    const press = presses.get(remote.device.id);
    const glowing = !!press && now - press.at < GLOW_MS;
    const target: PlannerTarget = { kind: 'device', id: remote.device.id };
    const Battery = remote.battery !== null && remote.battery < 20 ? BatteryLow : BatteryMedium;
    return (
      <article
        key={remote.device.id}
        data-remote-id={remote.device.id}
        className={`planner-card remote-plan ${glowing ? 'is-pressed' : ''}`}
        aria-label={remote.name}
      >
        <div className="planner-card-top">
          <RemoteVisual press={press} glowing={glowing} />
          {remote.battery !== null && (
            <span className={`remote-battery ${remote.battery < 20 ? 'low' : ''}`} title="Battery">
              <Battery size={15} aria-hidden="true" /> {remote.battery}%
            </span>
          )}
        </div>
        <NameField
          value={remote.name}
          label={`Name for ${remote.name}`}
          disabled={editLocked}
          onSave={(name) => rename(target, name)}
        />
        <span className="planner-meta">
          {remote.model || 'Remote'}
          {saving?.startsWith(`${remote.device.id}:`) && <LoaderCircle size={12} className="spin" aria-label="Saving" />}
        </span>
        <RoomSelect
          value={remote.areaId}
          label={`Room for ${remote.name}`}
          areas={areas}
          disabled={editLocked}
          onChange={(areaId) => assign(target, areaId)}
        />
        <p className="remote-last">
          {press
            ? <>Last press: <strong>{press.action}</strong> · {ago(press.at, now)}</>
            : 'Press a button to see it here.'}
        </p>
      </article>
    );
  };

  const renderOther = (deviceId: string) => {
    const device = snapshot.devices.find((item) => item.id === deviceId);
    if (!device) return null;
    const name = device.name_by_user || device.name || device.id;
    const target: PlannerTarget = { kind: 'device', id: device.id };
    return (
      <article className="planner-card" aria-label={name}>
        <div className="planner-card-top">
          <span className="light-visual" aria-hidden="true"><Cpu size={22} strokeWidth={1.7} /></span>
        </div>
        <NameField value={name} label={`Name for ${name}`} disabled={editLocked} onSave={(next) => rename(target, next)} />
        <span className="planner-meta">{[device.manufacturer, device.model].filter(Boolean).join(' ') || 'Appliance'}</span>
        <RoomSelect value={device.area_id} label={`Room for ${name}`} areas={areas} disabled={editLocked} onChange={(areaId) => assign(target, areaId)} />
      </article>
    );
  };
  const joined = [...joinedIds].map((id) => {
    const light = lights.find((item) => deviceOf(item) === id);
    const remote = remotes.find((item) => item.device.id === id);
    return { id, content: light ? renderLight(light) : remote ? renderRemote(remote) : renderOther(id) };
  });

  return (
    <div className="home-planner">
      <section className="page-intro">
        <div>
          <span className="eyebrow date-label">HOME PLANNER</span>
          <h1>Find, name, and place.</h1>
          <p>Give each light and remote a name you recognise, and put it in the right room.</p>
        </div>
        {adding ? (
          <PencilRuler className="intro-icon" size={32} strokeWidth={1.3} />
        ) : (
          <button className="primary-button add-appliance-open" onClick={() => setAdding(true)} disabled={disabled || !setup}>
            <CirclePlus size={17} /> Add appliance
          </button>
        )}
      </section>

      {adding && (
        <AddAppliance
          demo={demo}
          detected={zigbeeStacks(snapshot)}
          disabled={disabled || !setup}
          onPermit={onPermit}
          onStart={() => setBaseline((current) => current ?? new Set(snapshotRef.current.devices.map((device) => device.id)))}
          joined={joined}
          onClose={() => {
            setAdding(false);
            setBaseline(null);
          }}
          notify={notify}
        />
      )}

      <div className="planner-toolbar">
        <div className="planner-tabs" role="tablist" aria-label="Planner">
          <button role="tab" id="planner-tab-lights" aria-controls="planner-panel" aria-selected={tab === 'lights'} className={tab === 'lights' ? 'active' : ''} onClick={() => setTab('lights')}>
            <Lightbulb size={16} /> Lights <span className="planner-count">{lights.length}</span>
          </button>
          <button role="tab" id="planner-tab-remotes" aria-controls="planner-panel" aria-selected={tab === 'remotes'} className={tab === 'remotes' ? 'active' : ''} onClick={() => setTab('remotes')}>
            <Radio size={16} /> Remotes <span className="planner-count">{remotes.length}</span>
          </button>
        </div>
        <form className="planner-add-room" onSubmit={(event) => void addRoom(event)}>
          <input
            value={newRoom}
            onChange={(event) => setNewRoom(event.target.value)}
            placeholder="New room…"
            aria-label="New room name"
            maxLength={80}
            disabled={editLocked}
          />
          <button type="submit" aria-label="Add room" disabled={editLocked || !newRoom.trim()}>
            <Plus size={16} />
          </button>
        </form>
      </div>

      {!setup && !disabled && (
        <p className="planner-note">The room and device registry is unavailable for this connection.</p>
      )}

      <section id="planner-panel" role="tabpanel" aria-labelledby={`planner-tab-${tab}`} className="planner-panel">
        <div className="planner-panel-heading">
          <p>
            {tab === 'lights'
              ? 'Not sure which lamp is which? Tap Blink and look around.'
              : 'Press a button on any remote; its card lights up here.'}
          </p>
          <div className="room-tabs planner-filter" aria-label="Show">
            <button className={filter === 'all' ? 'active' : ''} aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>Everything</button>
            <button className={filter === 'unassigned' ? 'active' : ''} aria-pressed={filter === 'unassigned'} onClick={() => setFilter('unassigned')}>
              Needs a room{unassigned ? ` (${unassigned})` : ''}
            </button>
          </div>
        </div>

        {tab === 'remotes' && (
          <div className={`remote-spotlight ${lastPress && now - lastPress.at < GLOW_MS ? 'live' : ''}`} role="status" aria-live="polite">
            <span className="listening-dot" aria-hidden="true" />
            <span className="remote-spotlight-text">
              {lastPress
                ? <><strong>{lastRemote?.name ?? 'A remote'}</strong> · {lastPress.action} · {ago(lastPress.at, now)}</>
                : demo ? 'Listening for button presses in the demo home.' : 'Listening for button presses…'}
            </span>
            {demo && (
              <button className="secondary-button" onClick={simulatePress}>
                <MousePointerClick size={15} /> Simulate a press
              </button>
            )}
          </div>
        )}

        {tab === 'lights' && (
          <div className="planner-grid">{shownLights.map(renderLight)}</div>
        )}
        {tab === 'remotes' && (
          <div className="planner-grid">{shownRemotes.map(renderRemote)}</div>
        )}
        {(tab === 'lights' ? shownLights : shownRemotes).length === 0 && (
          <div className="planner-empty">
            {filter === 'unassigned'
              ? `Every ${tab === 'lights' ? 'light' : 'remote'} has a room.`
              : tab === 'lights'
                ? 'Lights appear here when Home Assistant reports them.'
                : 'No remotes found yet. Press a button on one and it will appear here.'}
          </div>
        )}
      </section>
    </div>
  );
}
