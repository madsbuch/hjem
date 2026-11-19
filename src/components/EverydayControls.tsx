import type { ReactNode } from 'react';
import { LightbulbOff, LoaderCircle, MessageCircle } from 'lucide-react';
import type { HassEntity } from '../lib/home-assistant';
import type { HomeSetup, RoutineDescription } from '../lib/home-setup-types';
import { nameOf } from '../lib/entities';
import { ago, useSummaries } from './HomeStudio';
import '../home-controls.css';

export type ControlsTab = 'lights' | 'moods' | 'automations' | 'devices';

interface TabsProps {
  tab: ControlsTab;
  onTab: (tab: ControlsTab) => void;
  lightsOn: number;
  moods: number;
  automationsOn: number;
}

/** The three everyday things, and everything else behind a fourth tab. */
export function ControlsTabs({ tab, onTab, lightsOn, moods, automationsOn }: TabsProps) {
  const tabs: { id: ControlsTab; label: string; count?: string }[] = [
    { id: 'lights', label: 'Lights', count: `${lightsOn} on` },
    { id: 'moods', label: 'Moods', count: String(moods) },
    { id: 'automations', label: 'Automations', count: `${automationsOn} on` },
    { id: 'devices', label: 'All devices' },
  ];
  return (
    <div className="controls-tabs" role="tablist" aria-label="Home controls">
      {tabs.map(({ id, label, count }) => (
        <button key={id} role="tab" id={`controls-tab-${id}`} aria-selected={tab === id} aria-controls="controls-panel" className={tab === id ? 'active' : ''} onClick={() => onTab(id)}>
          <span>{label}</span>
          {count !== undefined && <span className="controls-count">{count}</span>}
        </button>
      ))}
    </div>
  );
}

interface LightsProps {
  rooms: { key: string; name: string; lights: HassEntity[] }[];
  /** A light's own card, with its switch and brightness. */
  renderLight: (entity: HassEntity) => ReactNode;
  disabled: boolean;
  /** Switch several lights at once; resolves when Home Assistant has answered for each. */
  onSwitch: (lights: HassEntity[], on: boolean) => void;
}

const isOn = (entity: HassEntity) => entity.state === 'on';
const usable = (entity: HassEntity) => entity.state !== 'unavailable';

export function LightsPanel({ rooms, renderLight, disabled, onSwitch }: LightsProps) {
  const all = rooms.flatMap((room) => room.lights);
  const on = all.filter(isOn);
  if (!all.length)
    return <p className="controls-empty">Your lights appear here when Home Assistant has them.</p>;
  return (
    <>
      <div className="controls-summary">
        <p>{on.length ? `${on.length} of ${all.length} lights on` : 'All lights are off'}</p>
        <button className="secondary-button" disabled={disabled || !on.length} onClick={() => onSwitch(on, false)}>
          <LightbulbOff size={16} aria-hidden="true" /> All lights off
        </button>
      </div>
      {rooms.filter((room) => room.lights.length).map((room) => {
        const lit = room.lights.filter(isOn);
        const reachable = room.lights.filter(usable);
        return (
          <section className="controls-room" key={room.key} aria-label={room.name}>
            <div className="controls-room-heading">
              <h2>{room.name}</h2>
              <span>{lit.length ? `${lit.length} on` : 'Off'}</span>
              <button
                className="controls-room-switch"
                disabled={disabled || !reachable.length}
                onClick={() => onSwitch(lit.length ? lit : reachable, !lit.length)}
                aria-label={`Turn ${lit.length ? 'off' : 'on'} the lights in ${room.name}`}
              >
                {lit.length ? 'Turn off' : 'Turn on'}
              </button>
            </div>
            <div className="devices-grid">{room.lights.map(renderLight)}</div>
          </section>
        );
      })}
    </>
  );
}

interface AutomationsProps {
  automations: HassEntity[];
  setup: HomeSetup | undefined;
  /** Changes whenever the setup changes, so descriptions are read again. */
  revision: string;
  now: Date;
  disabled: boolean;
  pending: Set<string>;
  onToggle: (entity: HassEntity, on: boolean) => void;
  /** Open Home setup, where Concierge creates and changes automations. */
  onSetUp: () => void;
}

/** What an automation does, in one line a person would recognise. */
function summary(description: RoutineDescription | undefined): string {
  if (!description?.editable) return '';
  const saved = typeof description.config?.description === 'string' ? description.config.description : '';
  if (saved) return saved;
  const when = description.when.join(' or ');
  const then = description.then.join(', then ');
  return when && then ? `${when} → ${then}` : then || when;
}

export function AutomationsPanel({ automations, setup, revision, now, disabled, pending, onToggle, onSetUp }: AutomationsProps) {
  const descriptions = useSummaries<RoutineDescription>(
    automations.map((entity) => entity.entity_id), revision, true,
    setup ? (id, signal) => setup.describeRoutine(id, signal) : undefined,
  );
  if (!automations.length)
    return (
      <div className="controls-empty">
        <p>Automations make things happen by themselves, such as a light when a door opens. Once you have some, switch them on and off here.</p>
        <button className="secondary-button" onClick={onSetUp}><MessageCircle size={16} aria-hidden="true" /> Set up an automation</button>
      </div>
    );
  return (
    <>
      <ul className="controls-automations">
        {automations.map((entity) => {
          const on = entity.state === 'on';
          const waiting = pending.has(entity.entity_id);
          const name = nameOf(entity);
          const line = summary(descriptions[entity.entity_id]);
          return (
            <li key={entity.entity_id} className={on ? 'on' : ''}>
              <div>
                <h2>{name}</h2>
                {line && <p>{line}</p>}
                <span>{entity.state === 'unavailable' ? 'Unavailable' : on ? ago(entity.attributes.last_triggered, now) : 'Paused'}</span>
              </div>
              {waiting && <LoaderCircle size={16} className="spin" aria-hidden="true" />}
              <button
                role="switch"
                aria-checked={on}
                aria-label={name}
                className="controls-switch"
                disabled={disabled || waiting || entity.state === 'unavailable'}
                onClick={() => onToggle(entity, !on)}
              >
                <i aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>
      <button className="setup-link controls-more" onClick={onSetUp}>
        <MessageCircle size={16} aria-hidden="true" /> Add or change automations
      </button>
    </>
  );
}
