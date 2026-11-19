import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  CircleAlert,
  MessageCircle,
  RotateCcw,
} from 'lucide-react';
import type { HassEntity, HassSnapshot } from '../lib/home-assistant';
import {
  helperDomains,
  type HelperDomain,
  type HomeSetup,
  type RoutineDescription,
  type SetupChange,
  type SetupTarget,
} from '../lib/home-setup-types';
import { domainOf, isActive, isUnavailable, nameOf, roomFor, visibleEntities } from '../lib/entities';
import { helperLabels } from '../lib/home-routines';
import '../home-studio.css';

type Tab = 'rooms' | 'automations' | 'scripts' | 'moods' | 'helpers' | 'changes';
type View = 'chat' | 'home';

interface Props {
  snapshot: HassSnapshot;
  demo: boolean;
  /** The home can be changed right now: connected, and nothing else is running. */
  ready: boolean;
  /** Concierge is working; the state keeps updating but Undo waits. */
  busy: boolean;
  setup: HomeSetup | undefined;
  changes: SetupChange[];
  now: Date;
  onUndo: (id: string) => void;
  /** Put a starting message in the Concierge field. */
  onAsk: (text: string) => void;
  onBack: () => void;
  /** The Concierge conversation, shown beside the home. */
  children: ReactNode;
}

const HIGHLIGHT_MS = 8_000;
const tabOf: Record<SetupTarget['kind'], Tab> = {
  room: 'rooms', device: 'rooms', entity: 'rooms', mood: 'moods',
  automation: 'automations', script: 'scripts', helper: 'helpers',
};
const isHelper = (entity: HassEntity) => helperDomains.some((domain) => domain === domainOf(entity));
const helperKind = (entity: HassEntity): string =>
  helperLabels[helperDomains.find((domain): domain is HelperDomain => domain === domainOf(entity)) ?? 'input_boolean'];

/** "3 min ago", "yesterday", or a date; routines that never ran say so. */
export function ago(value: unknown, now: Date): string {
  const time = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(time)) return 'Has not run yet';
  const minutes = Math.max(0, Math.round((now.getTime() - time) / 60_000));
  if (minutes < 1) return 'Ran just now';
  if (minutes < 60) return `Ran ${minutes} min ago`;
  if (minutes < 24 * 60) return `Ran ${Math.round(minutes / 60)} h ago`;
  if (minutes < 48 * 60) return 'Ran yesterday';
  return `Ran ${new Date(time).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
}

const words = (value: string) => {
  const text = value.replaceAll('_', ' ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
};
const number = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
/** The state of a device in a few words, as a person would say it. */
export function stateText(entity: HassEntity): string {
  if (entity.state === 'unavailable') return 'Not responding';
  if (entity.state === 'unknown') return 'No reading yet';
  const domain = domainOf(entity);
  const attributes = entity.attributes;
  const unit = typeof attributes.unit_of_measurement === 'string' ? ` ${attributes.unit_of_measurement}` : '';
  if (domain === 'light') {
    const brightness = number(attributes.brightness);
    return entity.state === 'on' ? `On${brightness === undefined ? '' : ` · ${Math.round(brightness / 2.55)}%`}` : 'Off';
  }
  if (domain === 'climate') {
    const target = number(attributes.temperature);
    const current = number(attributes.current_temperature);
    return [current !== undefined && `${current}°`, target !== undefined && `set to ${target}°`, entity.state === 'off' && 'off']
      .filter(Boolean).join(' · ') || words(entity.state);
  }
  if (domain === 'cover') {
    const position = number(attributes.current_position);
    return `${entity.state === 'closed' ? 'Closed' : 'Open'}${position === undefined || entity.state === 'closed' ? '' : ` · ${position}%`}`;
  }
  if (domain === 'media_player')
    return entity.state === 'playing' && typeof attributes.media_title === 'string' ? `Playing · ${attributes.media_title}` : words(entity.state);
  if (domain === 'binary_sensor') {
    const on = entity.state === 'on';
    const kind = attributes.device_class;
    if (kind === 'door' || kind === 'window' || kind === 'opening' || kind === 'garage_door') return on ? 'Open' : 'Closed';
    if (kind === 'motion' || kind === 'occupancy' || kind === 'presence') return on ? 'Movement' : 'Clear';
    return on ? 'On' : 'Off';
  }
  if (domain === 'sensor') return `${entity.state}${unit}`;
  if (domain === 'input_datetime') return entity.state.replace(/^(\d{2}:\d{2}):00$/, '$1');
  if (domain === 'input_button') return 'Ready';
  return `${words(entity.state)}${unit}`;
}

/** Load each listed routine's or mood's summary, a few at a time, again after every setup change. */
export function useSummaries<T>(ids: string[], revision: string, active: boolean, load: ((id: string, signal: AbortSignal) => Promise<T>) | undefined) {
  const [summaries, setSummaries] = useState<Record<string, T>>({});
  const loader = useRef(load);
  loader.current = load;
  const key = ids.join('|');
  useEffect(() => {
    if (!active || !loader.current || !key) return;
    const controller = new AbortController();
    const queue = key.split('|');
    const worker = async () => {
      for (let id = queue.shift(); id !== undefined && !controller.signal.aborted; id = queue.shift()) {
        const current = id;
        try {
          const read = loader.current;
          if (!read) return;
          const summary = await read(current, controller.signal);
          if (!controller.signal.aborted) setSummaries((previous) => ({ ...previous, [current]: summary }));
        } catch {
          // A summary that cannot be read is simply not shown; the card still lists the routine.
        }
      }
    };
    void Promise.all([worker(), worker(), worker()]);
    return () => controller.abort();
  }, [key, revision, active]);
  return summaries;
}

function Steps({ label, items }: { label: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div className="studio-steps">
      <dt>{label}</dt>
      <dd>{items.length === 1 ? items[0] : <ol>{items.map((item, index) => <li key={`${index}:${item}`}>{item}</li>)}</ol>}</dd>
    </div>
  );
}

export function HomeStudio({ snapshot, demo, ready, busy, setup, changes, now, onUndo, onAsk, onBack, children }: Props) {
  const [tab, setTab] = useState<Tab>('rooms');
  const [view, setView] = useState<View>('chat');
  const [highlight, setHighlight] = useState('');
  const body = useRef<HTMLDivElement>(null);
  const seen = useRef(changes[0]?.id);

  const devices = useMemo(() => visibleEntities(snapshot).filter((entity) => !isHelper(entity)), [snapshot]);
  const byDomain = (domain: string) => snapshot.entities.filter((entity) => domainOf(entity) === domain);
  const automations = byDomain('automation');
  const scripts = byDomain('script');
  const moods = byDomain('scene').filter((entity) => {
    const entry = snapshot.registry.find((item) => item.entity_id === entity.entity_id);
    return !entry?.hidden_by && !entry?.disabled_by;
  });
  const helpers = snapshot.entities.filter(isHelper);
  const rooms = [
    ...snapshot.areas.map((area) => ({ id: area.area_id, name: area.name, entities: devices.filter((entity) => roomFor(entity, snapshot) === area.area_id) })),
    { id: '', name: 'Not in a room yet', entities: devices.filter((entity) => roomFor(entity, snapshot) === null) },
  ].filter((room) => room.id || room.entities.length);

  const latest = changes[0];
  const revision = `${changes.length}:${latest?.id ?? ''}:${latest?.target?.id ?? ''}`;
  const routineSummaries = useSummaries<RoutineDescription>(
    [...automations, ...scripts].map((entity) => entity.entity_id), revision,
    tab === 'automations' || tab === 'scripts',
    setup ? (id, signal) => setup.describeRoutine(id, signal) : undefined,
  );
  const moodSummaries = useSummaries<string[]>(
    moods.filter((entity) => typeof entity.attributes.id === 'string').map((entity) => entity.entity_id), revision,
    tab === 'moods',
    setup ? (id, signal) => setup.describeMood(id, signal) : undefined,
  );

  // Follow Concierge: show what it just changed, and let it glow for a moment.
  useEffect(() => {
    if (!latest || latest.id === seen.current) {
      seen.current = latest?.id;
      return;
    }
    seen.current = latest.id;
    if (!latest.target) return;
    setTab(tabOf[latest.target.kind]);
    setHighlight(latest.target.id);
    const timer = setTimeout(() => setHighlight(''), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [latest?.id, latest?.target?.id, latest?.target?.kind]);
  useEffect(() => {
    if (!highlight) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    body.current?.querySelector('.is-changed')?.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
  }, [highlight, tab]);

  const changed = (...ids: (string | null | undefined)[]) => ids.includes(highlight) && highlight ? ' is-changed' : '';
  const ask = (text: string) => {
    setView('chat');
    onAsk(text);
  };
  const tabs: { id: Tab; label: string; count: number }[] = [
    { id: 'rooms', label: 'Rooms', count: snapshot.areas.length },
    { id: 'automations', label: 'Automations', count: automations.length },
    { id: 'scripts', label: 'Scripts', count: scripts.length },
    { id: 'moods', label: 'Moods', count: moods.length },
    { id: 'helpers', label: 'Helpers', count: helpers.length },
    { id: 'changes', label: 'Changes', count: changes.length },
  ];

  const routineCard = (entity: HassEntity, kind: 'automation' | 'script') => {
    const summary = routineSummaries[entity.entity_id];
    const paused = kind === 'automation' && entity.state === 'off';
    const name = nameOf(entity);
    const description = typeof summary?.config?.description === 'string' ? summary.config.description : '';
    return (
      <li key={entity.entity_id} className={`studio-card${paused ? ' is-paused' : ''}${changed(entity.entity_id)}`}>
        <div className="studio-card-heading">
          <h3>{name}</h3>
          {kind === 'automation' && <span className={`studio-pill${paused ? '' : ' on'}`}>{entity.state === 'unavailable' ? 'Unavailable' : paused ? 'Paused' : 'On'}</span>}
          {kind === 'script' && entity.state === 'on' && <span className="studio-pill on">Running</span>}
        </div>
        {description && <p className="studio-description">{description}</p>}
        {summary?.editable && (
          <dl>
            <Steps label="When" items={summary.when} />
            <Steps label="Only if" items={summary.conditions} />
            <Steps label={kind === 'automation' ? 'Then' : 'Does'} items={summary.then} />
          </dl>
        )}
        {summary && !summary.editable && <p className="studio-note">{summary.message}</p>}
        {summary?.problems.map((problem) => (
          <p className="studio-problem" key={problem}><CircleAlert size={14} aria-hidden="true" /> {problem}</p>
        ))}
        <div className="studio-card-footer">
          <span>{ago(entity.attributes.last_triggered, now)}</span>
          {summary?.config && (
            <details>
              <summary>Configuration</summary>
              <pre>{JSON.stringify(summary.config, null, 2)}</pre>
            </details>
          )}
          <button className="studio-ask" onClick={() => ask(`About the ${kind} “${name}”: `)} aria-label={`Ask Concierge about ${name}`}>
            <MessageCircle size={14} aria-hidden="true" /> Ask
          </button>
        </div>
      </li>
    );
  };
  const empty = (text: string, suggestion: string) => (
    <div className="studio-empty">
      <p>{text}</p>
      <button className="secondary-button" onClick={() => ask(suggestion)}>
        <MessageCircle size={16} aria-hidden="true" /> {suggestion}
      </button>
    </div>
  );

  return (
    <section className="home-studio" aria-label="Home setup" data-view={view}>
      <header className="studio-header">
        <div>
          <button className="studio-back" onClick={onBack}><ArrowLeft size={16} aria-hidden="true" /> Settings</button>
          <h1>Home setup<span>.</span></h1>
        </div>
        <div className="studio-view" role="group" aria-label="Show">
          <button aria-pressed={view === 'chat'} onClick={() => setView('chat')}>Concierge</button>
          <button aria-pressed={view === 'home'} onClick={() => setView('home')}>Your home</button>
        </div>
      </header>
      <div className="studio-split">
        <div className="studio-agent">{children}</div>
        <section className="studio-home" aria-label="Your home">
          <div className="studio-home-heading">
            <div>
              <h2>{demo ? 'Demo home' : snapshot.locationName}</h2>
              <p>{demo ? 'Changes here are simulated.' : ready || busy ? 'Live from Home Assistant.' : 'Home Assistant is offline. This is the last known state.'}</p>
            </div>
          </div>
          <div className="studio-tabs" role="tablist" aria-label="Parts of your home">
            {tabs.map(({ id, label, count }) => (
              <button key={id} role="tab" id={`studio-tab-${id}`} aria-selected={tab === id} aria-controls="studio-panel" className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
                <span>{label}</span>
                <span className="studio-count">{count}</span>
              </button>
            ))}
          </div>
          <div className="studio-body" ref={body} role="tabpanel" id="studio-panel" aria-labelledby={`studio-tab-${tab}`} tabIndex={0}>
            {tab === 'rooms' && (
              <ul className="studio-rooms">
                {rooms.map((room) => (
                  <li key={room.id || 'unassigned'} className={`studio-card${changed(room.id || undefined)}`}>
                    <div className="studio-card-heading">
                      <h3>{room.name}</h3>
                      <span className="studio-meta">{room.entities.filter(isActive).length} of {room.entities.length} active</span>
                    </div>
                    {room.entities.length === 0 && <p className="studio-note">Nothing here yet.</p>}
                    <ul className="studio-devices">
                      {room.entities.map((entity) => {
                        const entry = snapshot.registry.find((item) => item.entity_id === entity.entity_id);
                        return (
                          <li key={entity.entity_id} className={`${isActive(entity) ? 'active' : ''}${isUnavailable(entity) ? ' unavailable' : ''}${changed(entity.entity_id, entry?.device_id)}`}>
                            <i aria-hidden="true" />
                            <span>{nameOf(entity)}</span>
                            <strong>{stateText(entity)}</strong>
                          </li>
                        );
                      })}
                    </ul>
                    <div className="studio-card-footer">
                      <span />
                      <button className="studio-ask" onClick={() => ask(room.id ? `In the ${room.name}: ` : 'Help me put the devices without a room where they belong.')} aria-label={`Ask Concierge about ${room.name}`}>
                        <MessageCircle size={14} aria-hidden="true" /> Ask
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {tab === 'automations' && (automations.length
              ? <ul className="studio-list">{automations.map((entity) => routineCard(entity, 'automation'))}</ul>
              : empty('Automations make things happen by themselves: a light when a door opens, blinds at sunrise, a remote that does what you want.', 'Suggest three automations for my home'))}
            {tab === 'scripts' && (scripts.length
              ? <ul className="studio-list">{scripts.map((entity) => routineCard(entity, 'script'))}</ul>
              : empty('A script is a list of things to do, run when you ask or from an automation.', 'Make a script that gets the home ready for a film'))}
            {tab === 'moods' && (moods.length
              ? (
                <ul className="studio-list">
                  {moods.map((entity) => {
                    const lines = moodSummaries[entity.entity_id];
                    return (
                      <li key={entity.entity_id} className={`studio-card${changed(entity.entity_id)}`}>
                        <div className="studio-card-heading"><h3>{nameOf(entity)}</h3></div>
                        {lines && <ul className="studio-settings">{lines.map((line) => <li key={line}>{line}</li>)}</ul>}
                        {typeof entity.attributes.id !== 'string' && <p className="studio-note">From another integration; it can be used but not changed here.</p>}
                        <div className="studio-card-footer">
                          <span />
                          <button className="studio-ask" onClick={() => ask(`About the mood “${nameOf(entity)}”: `)} aria-label={`Ask Concierge about ${nameOf(entity)}`}>
                            <MessageCircle size={14} aria-hidden="true" /> Ask
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )
              : empty('A mood sets several lights and devices at once.', 'Set up a cosy evening mood'))}
            {tab === 'helpers' && (helpers.length
              ? (
                <ul className="studio-list">
                  {helpers.map((entity) => (
                    <li key={entity.entity_id} className={`studio-card studio-helper${changed(entity.entity_id)}`}>
                      <div className="studio-card-heading">
                        <h3>{nameOf(entity)}</h3>
                        <span className="studio-meta">{helperKind(entity)}</span>
                      </div>
                      <strong>{stateText(entity)}</strong>
                    </li>
                  ))}
                </ul>
              )
              : empty('Helpers are small values your automations can read, such as a wake-up time or a guest-mode switch. Concierge adds them when an automation needs one.', 'Add a guest mode switch my automations can check'))}
            {tab === 'changes' && (changes.length
              ? (
                <>
                  <p className="studio-note">{demo ? 'These changes are simulated in your demo home.' : 'These changes are saved in Home Assistant.'} They can be undone while this home stays open.</p>
                  <ul className="studio-changes">
                    {changes.map((change) => (
                      <li key={change.id}>
                        <span>{change.description}</span>
                        <button className="studio-ask" disabled={!ready || busy} onClick={() => onUndo(change.id)} aria-label={`Undo ${change.description}`}>
                          <RotateCcw size={14} aria-hidden="true" /> Undo
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )
              : <div className="studio-empty"><p>What Concierge changes in your home is listed here, with a way to undo it.</p></div>)}
          </div>
        </section>
      </div>
    </section>
  );
}
