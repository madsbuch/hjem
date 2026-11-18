import type { HassDevice, HassEntity, HassSnapshot, HomeActivity, ZigbeeStack } from './home-assistant';
import { domainOf, isUnavailable, nameOf, numberAttribute, supportsBrightness } from './entities';

/** What a rename or room change is written to in Home Assistant. */
export type PlannerTarget =
  | { kind: 'device'; id: string }
  | { kind: 'entity'; id: string };

export interface PlannerLight {
  entity: HassEntity;
  name: string;
  /** null for lights Home Assistant cannot rename (no unique ID). */
  target: PlannerTarget | null;
  areaId: string | null;
  model: string;
}

export interface PlannerRemote {
  device: HassDevice;
  name: string;
  areaId: string | null;
  model: string;
  battery: number | null;
  /** Actions the remote declares, when its integration reports them. */
  actions: string[];
}

export interface RemotePress {
  deviceId: string;
  action: string;
  at: number;
}

const controllableDomains = new Set(['light', 'switch', 'fan', 'climate', 'cover', 'media_player', 'lock', 'vacuum']);
const remoteModel = /remote|button|dimmer|wireless|scene switch|wall switch|tap dial|rotary|knob|shortcut|pico/i;
const actionSensor = /^sensor\.[a-z0-9_]+_(action|click)$/;
const MAX_PRESS_AGE = 15_000;

function deviceName(device: HassDevice | undefined): string | undefined {
  return device?.name_by_user || device?.name || undefined;
}
function modelOf(device: HassDevice | undefined): string {
  return [device?.manufacturer, device?.model].filter((part) => !!part && part !== 'Demo').join(' ');
}
const registryEntry = (snapshot: HassSnapshot, entityId: string) =>
  snapshot.registry.find((entry) => entry.entity_id === entityId);
const listedEntry = (snapshot: HassSnapshot, entityId: string) => {
  const entry = registryEntry(snapshot, entityId);
  return !entry?.disabled_by;
};

/** Lights on their own device are named as the device, the way Home Assistant shows them. */
export function plannerLights(snapshot: HassSnapshot): PlannerLight[] {
  const lights = snapshot.entities.filter((entity) =>
    domainOf(entity) === 'light' &&
    !Array.isArray(entity.attributes.entity_id) &&
    !registryEntry(snapshot, entity.entity_id)?.hidden_by &&
    listedEntry(snapshot, entity.entity_id));
  return lights.map((entity) => {
    const entry = registryEntry(snapshot, entity.entity_id);
    const device = snapshot.devices.find((item) => item.id === entry?.device_id);
    const soleLight = !!device && snapshot.registry.filter((item) =>
      item.device_id === device.id && item.entity_id.startsWith('light.') && !item.disabled_by).length === 1;
    const target: PlannerTarget | null = device && soleLight && !entry?.area_id && !entry?.name
      ? { kind: 'device', id: device.id }
      : entry ? { kind: 'entity', id: entity.entity_id } : null;
    return {
      entity,
      name: target?.kind === 'device' ? deviceName(device) ?? nameOf(entity) : nameOf(entity),
      target,
      areaId: entry?.area_id || device?.area_id || null,
      model: modelOf(device),
    };
  }).sort((first, second) => first.name.localeCompare(second.name));
}

function remoteSignals(snapshot: HassSnapshot, deviceId: string) {
  const entries = snapshot.registry.filter((entry) => entry.device_id === deviceId && !entry.disabled_by);
  const ids = new Set(entries.map((entry) => entry.entity_id));
  const entities = snapshot.entities.filter((entity) => ids.has(entity.entity_id));
  return { entries, entities };
}

/**
 * Remotes are recognised from event entities, Zigbee2MQTT-style action sensors,
 * their model name, or simply because one was pressed during this session.
 */
export function plannerRemotes(snapshot: HassSnapshot, pressed: ReadonlySet<string> = new Set()): PlannerRemote[] {
  const remotes: PlannerRemote[] = [];
  for (const device of snapshot.devices) {
    const { entries, entities } = remoteSignals(snapshot, device.id);
    const controls = entries.some((entry) => controllableDomains.has(entry.entity_id.split('.')[0] ?? ''));
    const buttonEvents = entities.filter((entity) => domainOf(entity) === 'event' && entity.attributes.device_class !== 'motion');
    const actionSensors = entries.filter((entry) => actionSensor.test(entry.entity_id));
    const byModel = remoteModel.test(`${device.model ?? ''} ${device.name ?? ''}`);
    if (!pressed.has(device.id) && (controls || (!buttonEvents.length && !actionSensors.length && !byModel))) continue;
    const battery = entities.find((entity) => domainOf(entity) === 'sensor' &&
      entity.attributes.device_class === 'battery' && !isUnavailable(entity));
    const level = battery ? Number(battery.state) : NaN;
    const actions = [...new Set(buttonEvents.flatMap((entity) => Array.isArray(entity.attributes.event_types)
      ? entity.attributes.event_types.filter((type: unknown): type is string => typeof type === 'string').map((type) => type.replaceAll('_', ' '))
      : []))];
    remotes.push({
      device,
      name: deviceName(device) ?? device.id,
      areaId: device.area_id,
      model: modelOf(device),
      battery: Number.isFinite(level) ? Math.max(0, Math.min(100, Math.round(level))) : null,
      actions,
    });
  }
  return remotes.sort((first, second) => first.name.localeCompare(second.name));
}

/** Translate live Home Assistant activity into a remote press, if it is one. */
export function pressFromActivity(activity: HomeActivity, snapshot: HassSnapshot, now = Date.now()): RemotePress | null {
  if (activity.kind === 'device_event') {
    const fired = Date.parse(activity.event.time_fired ?? '');
    return { deviceId: activity.event.device_id, action: activity.event.action, at: Number.isFinite(fired) ? Math.min(fired, now) : now };
  }
  const state = activity.change.new_state;
  if (!state || isUnavailable(state)) return null;
  const deviceId = registryEntry(snapshot, state.entity_id)?.device_id;
  if (!deviceId) return null;
  if (domainOf(state) === 'event') {
    // An event entity's state is the time of its latest event. Ignore restored, stale events.
    const fired = Date.parse(state.state);
    if (!Number.isFinite(fired) || Math.abs(now - fired) > MAX_PRESS_AGE) return null;
    const type = state.attributes.event_type;
    return { deviceId, action: typeof type === 'string' && type ? type.replaceAll('_', ' ') : 'pressed', at: now };
  }
  if (actionSensor.test(state.entity_id)) {
    const action = state.state.trim();
    if (!action || action === 'None') return null;
    return { deviceId, action: action.replaceAll('_', ' ').slice(0, 60), at: now };
  }
  return null;
}

export interface LightStep {
  service: 'turn_on' | 'turn_off';
  data: Record<string, unknown>;
}

/** Three clear blinks, then the light's original on/off state and brightness. */
export function identifySteps(entity: HassEntity, blinks = 3): LightStep[] {
  const dimmable = supportsBrightness(entity);
  const bright: LightStep = { service: 'turn_on', data: dimmable ? { brightness_pct: 100 } : {} };
  const dark: LightStep = { service: 'turn_off', data: {} };
  const wasOn = entity.state === 'on';
  const steps: LightStep[] = [];
  for (let blink = 0; blink < blinks; blink++) steps.push(...(wasOn ? [dark, bright] : [bright, dark]));
  if (wasOn) {
    const brightness = numberAttribute(entity, 'brightness', NaN);
    steps.push({
      service: 'turn_on',
      data: dimmable && Number.isFinite(brightness)
        ? { brightness_pct: Math.max(1, Math.min(100, Math.round(brightness / 2.55))) }
        : {},
    });
  }
  return steps;
}

const pause = (milliseconds: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Stopped.', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop);
      resolve();
    }, milliseconds);
    const stop = () => {
      clearTimeout(timer);
      reject(new DOMException('Stopped.', 'AbortError'));
    };
    signal?.addEventListener('abort', stop, { once: true });
  });

/**
 * Blink a light so it can be found in the room. If interrupted, the last
 * step still restores the original state.
 */
export async function identifyLight(
  entity: HassEntity,
  send: (step: LightStep) => Promise<void>,
  options: { interval?: number; signal?: AbortSignal } = {},
): Promise<void> {
  const steps = identifySteps(entity);
  const restore: LightStep | undefined = entity.state === 'on' ? steps.at(-1) : { service: 'turn_off', data: {} };
  try {
    for (const [index, step] of steps.entries()) {
      if (index > 0) await pause(options.interval ?? 700, options.signal);
      await send(step);
    }
  } catch (error) {
    if (restore) await send(restore).catch(() => undefined);
    throw error;
  }
}

/** Which Zigbee stacks this Home Assistant appears to run, from what it registered. */
export function zigbeeStacks(snapshot: HassSnapshot): ZigbeeStack[] {
  const stacks: ZigbeeStack[] = [];
  if (snapshot.registry.some((entry) => entry.platform === 'zha')) stacks.push('zha');
  if (snapshot.devices.some((device) => device.manufacturer === 'Zigbee2MQTT' || /zigbee2mqtt/i.test(device.name ?? '')) ||
      snapshot.registry.some((entry) => entry.entity_id.includes('zigbee2mqtt_bridge')))
    stacks.push('zigbee2mqtt');
  return stacks;
}
