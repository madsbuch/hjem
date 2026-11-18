import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CirclePlus, Lightbulb, LoaderCircle, Radio, Square, X } from 'lucide-react';
import { MAX_PAIRING_SECONDS, type ZigbeeStack } from '../lib/home-assistant';

export type PairingStack = ZigbeeStack | 'demo';
type Kind = 'bulb' | 'remote';

interface Props {
  demo: boolean;
  /** Stacks detected from Home Assistant; empty when none could be recognised. */
  detected: ZigbeeStack[];
  disabled: boolean;
  onPermit: (stack: PairingStack, seconds: number) => Promise<void>;
  /** Called when pairing starts, so newly joined appliances can be told apart. */
  onStart: () => void;
  /** The appliances that joined since pairing started, each with its own controls. */
  joined: { id: string; content: ReactNode }[];
  onClose: () => void;
  notify: (text: string, error?: boolean) => void;
}

const stackNames: Record<ZigbeeStack, string> = { zha: 'ZHA', zigbee2mqtt: 'Zigbee2MQTT' };
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Pairing could not be started.';
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

const steps: Record<Kind, string[]> = {
  bulb: [
    'Put the bulb in a lamp within a few metres of your Raspberry Pi, or of another mains-powered Zigbee light.',
    'Select Start pairing.',
    'Switch the lamp off and on six times, about a second each time, and leave it on. The bulb dims or blinks briefly when it is ready to join. If nothing happens, some newer bulbs need twelve times.',
  ],
  remote: [
    'Select Start pairing, then hold the remote close to your Raspberry Pi.',
    'Press the pairing button four times within five seconds. It is under the battery cover or on the back; a small light on the remote starts to glow.',
    'Keep it close and press any button every few seconds until it appears below. Remotes go back to sleep quickly.',
  ],
};

export function AddAppliance({ demo, detected, disabled, onPermit, onStart, joined, onClose, notify }: Props) {
  const [kind, setKind] = useState<Kind>('bulb');
  const [chosen, setChosen] = useState<ZigbeeStack | null>(null);
  const [until, setUntil] = useState<number | null>(null);
  const [starting, setStarting] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const stack: PairingStack | null = demo ? 'demo' : chosen ?? (detected.length === 1 ? detected[0] ?? null : null);
  const active = useRef<PairingStack | null>(null);
  const onPermitRef = useRef(onPermit);
  onPermitRef.current = onPermit;
  const remaining = until === null ? 0 : Math.max(0, Math.ceil((until - now) / 1000));
  const pairing = until !== null && remaining > 0;

  useEffect(() => {
    if (until === null) return;
    const timer = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= until) {
        active.current = null;
        setUntil(null);
      }
    }, 1_000);
    return () => clearInterval(timer);
  }, [until]);

  // Leaving the planner closes the network instead of leaving it open unattended.
  useEffect(() => () => {
    if (active.current) void onPermitRef.current(active.current, 0).catch(() => undefined);
  }, []);

  async function start() {
    if (!stack || starting) return;
    setStarting(true);
    try {
      onStart();
      await onPermit(stack, MAX_PAIRING_SECONDS);
      active.current = stack;
      setNow(Date.now());
      setUntil(Date.now() + MAX_PAIRING_SECONDS * 1000);
    } catch (error) {
      notify(errorMessage(error), true);
    } finally {
      setStarting(false);
    }
  }

  async function stop() {
    const current = active.current;
    active.current = null;
    setUntil(null);
    if (!current) return;
    try {
      await onPermit(current, 0);
      notify('Pairing stopped.');
    } catch (error) {
      notify(errorMessage(error), true);
    }
  }

  return (
    <section className="add-appliance" aria-labelledby="add-appliance-title">
      <div className="add-appliance-heading">
        <h2 id="add-appliance-title">Add an appliance</h2>
        <button
          className="icon-button"
          aria-label="Close add appliance"
          onClick={() => {
            if (pairing) void stop();
            onClose();
          }}
        >
          <X size={18} />
        </button>
      </div>

      {!demo && (
        detected.length === 1 ? (
          <p className="add-appliance-stack">New appliances join through {stackNames[detected[0] ?? 'zha']} in Home Assistant.</p>
        ) : (
          <fieldset className="add-appliance-stack-choice" disabled={pairing}>
            <legend>
              {detected.length
                ? 'Home Assistant runs more than one Zigbee setup. Which should new appliances join?'
                : 'Which Zigbee setup does your Home Assistant use? You can check under Settings → Devices & services.'}
            </legend>
            {(['zha', 'zigbee2mqtt'] satisfies ZigbeeStack[]).map((option) => (
              <label key={option}>
                <input type="radio" name="zigbee-stack" checked={stack === option} onChange={() => setChosen(option)} />
                {stackNames[option]}
              </label>
            ))}
          </fieldset>
        )
      )}

      <div className="room-tabs add-appliance-kinds" role="group" aria-label="Appliance type">
        <button className={kind === 'bulb' ? 'active' : ''} aria-pressed={kind === 'bulb'} onClick={() => setKind('bulb')}>
          <Lightbulb size={14} /> Bulb
        </button>
        <button className={kind === 'remote' ? 'active' : ''} aria-pressed={kind === 'remote'} onClick={() => setKind('remote')}>
          <Radio size={14} /> Remote
        </button>
      </div>
      <ol className="add-appliance-steps">
        {steps[kind].map((step) => <li key={step}>{step}</li>)}
      </ol>

      <div className={`add-appliance-status ${pairing ? 'live' : ''}`} role="status">
        {pairing ? (
          <>
            <span className="listening-dot" aria-hidden="true" />
            <span>Pairing is open · {clock(remaining)} left. Joining can take up to a minute.</span>
            <button className="secondary-button" onClick={() => void stop()}>
              <Square size={13} fill="currentColor" /> Stop pairing
            </button>
          </>
        ) : (
          <>
            <span>
              {demo
                ? 'In the demo home, a new appliance joins a few seconds after pairing starts.'
                : `Pairing stays open for ${clock(MAX_PAIRING_SECONDS)} minutes, or until you stop it. Home Assistant administrator access is required.`}
            </span>
            <button className="primary-button" onClick={() => void start()} disabled={disabled || !stack || starting}>
              {starting ? <LoaderCircle size={16} className="spin" /> : <CirclePlus size={16} />} Start pairing
            </button>
          </>
        )}
      </div>

      {joined.length > 0 && (
        <div className="add-appliance-joined">
          <h3>Joined · give {joined.length === 1 ? 'it' : 'them'} a name and a room</h3>
          {joined.map((item) => <div key={item.id}>{item.content}</div>)}
        </div>
      )}
    </section>
  );
}
