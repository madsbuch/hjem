import type { HassDevice, HassSnapshot } from './home-assistant';
import { helperDomains, type HelperDomain, type HomeSetup, type MoodTarget, type RoutineConfig, type RoutineKind } from './home-setup-types';
import { routineParts, routineReferences, rewriteReferences } from './home-routines';
import type { Theme } from './storage';
import { SceneConfigNotFoundError } from './home-assistant-scenes';
import { domainOf, nameOf } from './entities';

/**
 * A portable copy of the home setup. Devices are identified by hardware
 * identity (a Zigbee device's IEEE address) rather than Home Assistant's
 * internal IDs, so the file still applies after moving to a new server.
 * Credentials are never included.
 */
export const CONFIGURATION_FORMAT = 'hjem-configuration';
export const CONFIGURATION_VERSION = 1;
export const MAX_CONFIGURATION_BYTES = 2 * 1024 * 1024;

export interface ExportedEntity {
  entity_id: string;
  /** A name set for this entity alone; null follows the device. */
  name: string | null;
  /** A room set for this entity alone; null follows the device. */
  room: string | null;
}
export interface ExportedDevice {
  key: string;
  /** Hjem's name for it; null keeps the integration's default name. */
  name: string | null;
  default_name: string | null;
  room: string | null;
  manufacturer: string | null;
  model: string | null;
  entities: ExportedEntity[];
}
export interface ExportedMoodTarget extends MoodTarget {
  /** The target's device key, so the mood follows the device to a new server. */
  device: string | null;
}
export interface ExportedMood {
  name: string;
  targets: ExportedMoodTarget[];
}
/** An automation or script, with what it names recorded so it can follow the devices to a new server. */
export interface ExportedRoutine {
  kind: RoutineKind;
  name: string;
  /** False for an automation that was paused. */
  enabled: boolean;
  config: RoutineConfig;
  entities: EntityReference[];
  devices: { id: string; key: string }[];
  rooms: { id: string; name: string }[];
}
export interface ExportedHelper {
  domain: HelperDomain;
  name: string;
  settings: Record<string, unknown>;
}
export interface EntityReference {
  device: string | null;
  entity_id: string;
}
export interface ExportedSettings {
  theme: Theme;
  calendars: { name: string; url: string }[];
  favourites: EntityReference[];
  selected_speaker: EntityReference | null;
  hidden_apps: string[];
  pinned_apps: string[];
  concierge_model: string;
}
export interface HjemConfiguration {
  format: typeof CONFIGURATION_FORMAT;
  version: typeof CONFIGURATION_VERSION;
  exported_at: string;
  home_name: string;
  rooms: string[];
  devices: ExportedDevice[];
  /** Entity names and rooms for entities that have no device. */
  entities: ExportedEntity[];
  moods: ExportedMood[];
  routines: ExportedRoutine[];
  helpers: ExportedHelper[];
  settings: ExportedSettings;
}

const hex = (value: string) => value.toLowerCase().replace(/^0x/, '').replace(/[^0-9a-f]/g, '');
const ieee = (value: string) => {
  const digits = hex(value);
  return digits.length === 16 ? `zigbee:${digits}` : null;
};

/** The most stable identity Home Assistant reports for a device. */
export function deviceKey(device: HassDevice): string {
  for (const [type, id] of device.connections ?? []) {
    const key = type === 'zigbee' ? ieee(id) : null;
    if (key) return key;
  }
  for (const [domain, id] of device.identifiers ?? []) {
    const key = domain === 'zha' ? ieee(id)
      : domain === 'mqtt' ? ieee(/zigbee2mqtt_(0x[0-9a-f]{16})/i.exec(id)?.[1] ?? '')
        : null;
    if (key) return key;
  }
  const [first] = device.identifiers ?? [];
  if (first) return `${first[0]}:${first[1]}`;
  return `name:${(device.name || device.id).toLocaleLowerCase()}`;
}

const areaName = (snapshot: HassSnapshot, areaId: string | null | undefined) =>
  snapshot.areas.find((area) => area.area_id === areaId)?.name ?? null;

/** Where an entity belongs in the file: its device's key, if it has one. */
export function entityReference(snapshot: HassSnapshot, entityId: string): EntityReference {
  const deviceId = snapshot.registry.find((entry) => entry.entity_id === entityId)?.device_id;
  const device = snapshot.devices.find((item) => item.id === deviceId);
  return { device: device ? deviceKey(device) : null, entity_id: entityId };
}

export function buildConfiguration(
  snapshot: HassSnapshot,
  moods: ExportedMood[],
  settings: ExportedSettings,
  now = new Date(),
  routines: ExportedRoutine[] = [],
  helpers: ExportedHelper[] = [],
): HjemConfiguration {
  const overrides = (deviceId: string | null) => snapshot.registry
    .filter((entry) => entry.device_id === deviceId && (entry.name || entry.area_id))
    .map((entry) => ({ entity_id: entry.entity_id, name: entry.name || null, room: areaName(snapshot, entry.area_id) }));
  return {
    format: CONFIGURATION_FORMAT,
    version: CONFIGURATION_VERSION,
    exported_at: now.toISOString(),
    home_name: snapshot.locationName,
    rooms: snapshot.areas.map((area) => area.name),
    devices: snapshot.devices.map((device) => ({
      key: deviceKey(device),
      name: device.name_by_user || null,
      default_name: device.name || null,
      room: areaName(snapshot, device.area_id),
      manufacturer: device.manufacturer ?? null,
      model: device.model ?? null,
      entities: overrides(device.id),
    })),
    entities: overrides(null),
    moods,
    routines,
    helpers,
    settings,
  };
}

/**
 * Read every editable automation and script, and every helper. With `strict`,
 * a failed read is an error rather than a gap, so a partial copy never replaces a complete one.
 */
export async function exportRoutines(setup: HomeSetup, snapshot: HassSnapshot, strict = false): Promise<{ routines: ExportedRoutine[]; helpers: ExportedHelper[]; skipped: string[] }> {
  const routines: ExportedRoutine[] = [];
  const skipped: string[] = [];
  for (const kind of routineKinds) {
    for (const entity of snapshot.entities.filter((item) => domainOf(item) === kind)) {
      // Automations written in Home Assistant's own files have no id and cannot be saved again.
      if (kind === 'automation' && typeof entity.attributes.id !== 'string') {
        skipped.push(nameOf(entity));
        continue;
      }
      try {
        const inspected = await setup.inspectRoutine(entity.entity_id);
        if (!isRecord(inspected) || !isRecord(inspected.config)) throw new Error('Unreadable routine.');
        const { id: _id, ...config } = inspected.config;
        const references = routineReferences(kind, config);
        routines.push({
          kind,
          name: nameOf(entity),
          enabled: kind === 'script' || entity.state !== 'off',
          config,
          entities: references.entities.map((id) => entityReference(snapshot, id)),
          devices: references.devices.flatMap((id) => {
            const device = snapshot.devices.find((item) => item.id === id);
            return device ? [{ id, key: deviceKey(device) }] : [];
          }),
          rooms: references.areas.flatMap((id) => {
            const name = areaName(snapshot, id);
            return name ? [{ id, name }] : [];
          }),
        });
      } catch (error) {
        // A script kept in Home Assistant's own files reads as missing; anything else is a real failure.
        if (strict && !(error instanceof SceneConfigNotFoundError) && !(error instanceof Error && error.message.includes('own files'))) throw error;
        skipped.push(nameOf(entity));
      }
    }
  }
  const helpers: ExportedHelper[] = [];
  try {
    const listed = await setup.listHelpers();
    for (const item of isRecord(listed) ? list(listed.helpers) : []) {
      if (!isRecord(item)) continue;
      const domain = helperDomains.find((candidate) => candidate === item.domain);
      const name = text(item.name, 100);
      if (domain && name) helpers.push({ domain, name, settings: isRecord(item.settings) ? item.settings : {} });
    }
  } catch (error) {
    if (strict) throw error;
  }
  return { routines, helpers, skipped };
}
const routineKinds: RoutineKind[] = ['script', 'automation'];

/** Read every editable mood through the setup manager, keyed by device. */
export async function exportMoods(setup: HomeSetup, snapshot: HassSnapshot, strict = false): Promise<{ moods: ExportedMood[]; skipped: string[] }> {
  const moods: ExportedMood[] = [];
  const skipped: string[] = [];
  const scenes = snapshot.entities.filter((entity) => domainOf(entity) === 'scene' &&
    !snapshot.registry.some((entry) => entry.entity_id === entity.entity_id && (entry.hidden_by || entry.disabled_by)));
  for (const scene of scenes) {
    if (typeof scene.attributes.id !== 'string') {
      skipped.push(nameOf(scene));
      continue;
    }
    try {
      const inspected = await setup.inspectMood(scene.entity_id);
      const targets = isRecord(inspected) && Array.isArray(inspected.targets) ? inspected.targets.flatMap((item) => {
        const target = parseMoodTarget(item);
        return target ? [{ ...target, device: entityReference(snapshot, target.entity_id).device }] : [];
      }) : [];
      const name = isRecord(inspected) && typeof inspected.name === 'string' ? inspected.name : nameOf(scene);
      if (targets.length) moods.push({ name, targets });
      else skipped.push(name);
    } catch (error) {
      // A scene whose saved definition is gone is a gap; any other failed read is not.
      if (strict && !(error instanceof SceneConfigNotFoundError)) throw error;
      skipped.push(nameOf(scene));
    }
  }
  return { moods, skipped };
}

// ---- Reading a file ----

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown, maximum = 300): string | null =>
  typeof value === 'string' && value.trim() && value.length <= maximum && !/[\u0000-\u001f]/.test(value) ? value : null;
const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const entityId = (value: unknown): string | null =>
  typeof value === 'string' && /^[a-z0-9_]+\.[a-z0-9_]+$/.test(value) ? value : null;
const isTheme = (value: unknown): value is Theme => value === 'system' || value === 'light' || value === 'dark';

function parseMoodTarget(value: unknown): MoodTarget | null {
  if (!isRecord(value)) return null;
  const id = entityId(value.entity_id);
  const state = text(value.state, 40);
  if (!id || !state) return null;
  const target: MoodTarget = { entity_id: id, state };
  const brightness = finite(value.brightness_pct);
  const kelvin = finite(value.color_temp_kelvin);
  const temperature = finite(value.temperature);
  const position = finite(value.position);
  const volume = finite(value.volume_pct);
  if (brightness !== undefined) target.brightness_pct = brightness;
  if (kelvin !== undefined) target.color_temp_kelvin = kelvin;
  if (temperature !== undefined) target.temperature = temperature;
  if (position !== undefined) target.position = position;
  if (volume !== undefined) target.volume_pct = volume;
  if (typeof value.is_volume_muted === 'boolean') target.is_volume_muted = value.is_volume_muted;
  return target;
}

function parseEntityEntry(value: unknown): ExportedEntity | null {
  if (!isRecord(value)) return null;
  const id = entityId(value.entity_id);
  return id ? { entity_id: id, name: text(value.name, 100), room: text(value.room, 100) } : null;
}
function parseReference(value: unknown): EntityReference | null {
  if (!isRecord(value)) return null;
  const id = entityId(value.entity_id);
  return id ? { device: text(value.device), entity_id: id } : null;
}
const present = <T>(value: T | null): value is T => value !== null;

/** Validate an imported file. Unknown or malformed entries are dropped, never trusted. */
export function parseConfiguration(raw: string): HjemConfiguration {
  if (raw.length > MAX_CONFIGURATION_BYTES) throw new Error('This file is too large to be a Hjem configuration.');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('This file is not a Hjem configuration. Choose a file exported from Hjem.');
  }
  if (!isRecord(value) || value.format !== CONFIGURATION_FORMAT)
    throw new Error('This file is not a Hjem configuration. Choose a file exported from Hjem.');
  if (value.version !== CONFIGURATION_VERSION)
    throw new Error('This configuration was exported by a newer version of Hjem. Update Hjem, then import it again.');
  const settings = isRecord(value.settings) ? value.settings : {};
  return {
    format: CONFIGURATION_FORMAT,
    version: CONFIGURATION_VERSION,
    exported_at: text(value.exported_at, 40) ?? '',
    home_name: text(value.home_name, 100) ?? 'Home',
    rooms: [...new Set(list(value.rooms).map((room) => text(room, 100)).filter(present))],
    devices: list(value.devices).flatMap((item) => {
      if (!isRecord(item)) return [];
      const key = text(item.key);
      if (!key) return [];
      return [{
        key,
        name: text(item.name, 100),
        default_name: text(item.default_name),
        room: text(item.room, 100),
        manufacturer: text(item.manufacturer),
        model: text(item.model),
        entities: list(item.entities).map(parseEntityEntry).filter(present),
      }];
    }),
    entities: list(value.entities).map(parseEntityEntry).filter(present),
    moods: list(value.moods).flatMap((item) => {
      if (!isRecord(item)) return [];
      const name = text(item.name, 80);
      const targets = list(item.targets).flatMap((entry) => {
        const target = parseMoodTarget(entry);
        return target && isRecord(entry) ? [{ ...target, device: text(entry.device) }] : [];
      });
      return name && targets.length ? [{ name, targets }] : [];
    }),
    routines: list(value.routines).flatMap((item): ExportedRoutine[] => {
      if (!isRecord(item) || !isRecord(item.config)) return [];
      const kind = routineKinds.find((candidate) => candidate === item.kind);
      const name = text(item.name, 80);
      if (!kind || !name) return [];
      return [{
        kind,
        name,
        enabled: item.enabled !== false,
        config: item.config,
        entities: list(item.entities).map(parseReference).filter(present),
        devices: list(item.devices).flatMap((entry) => {
          const id = isRecord(entry) ? text(entry.id) : null;
          const key = isRecord(entry) ? text(entry.key) : null;
          return id && key ? [{ id, key }] : [];
        }),
        rooms: list(item.rooms).flatMap((entry) => {
          const id = isRecord(entry) ? text(entry.id) : null;
          const room = isRecord(entry) ? text(entry.name, 100) : null;
          return id && room ? [{ id, name: room }] : [];
        }),
      }];
    }),
    helpers: list(value.helpers).flatMap((item): ExportedHelper[] => {
      if (!isRecord(item)) return [];
      const domain = helperDomains.find((candidate) => candidate === item.domain);
      const name = text(item.name, 80);
      return domain && name ? [{ domain, name, settings: isRecord(item.settings) ? item.settings : {} }] : [];
    }),
    settings: {
      theme: isTheme(settings.theme) ? settings.theme : 'system',
      calendars: list(settings.calendars).flatMap((item) => {
        if (!isRecord(item)) return [];
        const name = text(item.name, 100);
        const url = text(item.url, 2000);
        return name && url ? [{ name, url }] : [];
      }),
      favourites: list(settings.favourites).map(parseReference).filter(present),
      selected_speaker: parseReference(settings.selected_speaker),
      hidden_apps: list(settings.hidden_apps).map((item) => text(item, 255)).filter(present),
      pinned_apps: list(settings.pinned_apps).map((item) => text(item, 255)).filter(present),
      concierge_model: text(settings.concierge_model, 200) ?? '',
    },
  };
}

// ---- Planning an import ----

export interface RenameStep { kind: 'device' | 'entity'; id: string; from: string; name: string }
export interface RoomStep { kind: 'device' | 'entity'; id: string; label: string; room: string }
export interface MoodStep { name: string; targets: MoodTarget[]; missing: number }
export interface ImportPlan {
  homeName: string;
  exportedAt: string;
  roomsToCreate: string[];
  matched: number;
  unmatched: ExportedDevice[];
  renames: RenameStep[];
  rooms: RoomStep[];
  moods: MoodStep[];
  /** Moods that already exist here by name and are left as they are. */
  existingMoods: string[];
  /** Helpers, scripts, and automations that are not here yet, in the order they are created. */
  helpers: ExportedHelper[];
  routines: ExportedRoutine[];
  /** Automations and scripts that already exist here by name and are left as they are. */
  existingRoutines: string[];
}

const same = (first: string, second: string) => first.toLocaleLowerCase() === second.toLocaleLowerCase();

/** Find this home's device and entity for an exported key and entity ID. */
function matcher(snapshot: HassSnapshot) {
  const byKey = new Map<string, HassDevice[]>();
  for (const device of snapshot.devices) byKey.set(deviceKey(device), [...(byKey.get(deviceKey(device)) ?? []), device]);
  // A key shared by two devices here (e.g. two devices with the same default name) is ambiguous.
  const deviceFor = (key: string | null) => {
    const found = key ? byKey.get(key) : undefined;
    return found?.length === 1 ? found[0] : undefined;
  };
  const resolveEntity = (device: string | null, id: string): string | null => {
    if (device) {
      const current = deviceFor(device);
      if (!current) return null;
      const candidates = snapshot.registry.filter((entry) => entry.device_id === current.id).map((entry) => entry.entity_id);
      if (candidates.includes(id)) return id;
      // Entity IDs can differ on a new server; a device's only light is still its light.
      const domain = id.split('.')[0];
      const sameDomain = candidates.filter((candidate) => candidate.split('.')[0] === domain);
      return sameDomain.length === 1 ? sameDomain[0] ?? null : null;
    }
    return snapshot.registry.some((entry) => entry.entity_id === id) ? id : null;
  };
  return { deviceFor, resolveEntity };
}

/** Match the file to this home and work out only what needs to change. Nothing is cleared. */
export function planImport(configuration: HjemConfiguration, snapshot: HassSnapshot): ImportPlan {
  const { deviceFor, resolveEntity } = matcher(snapshot);
  const shownEntityName = (id: string) => {
    const entity = snapshot.entities.find((item) => item.entity_id === id);
    return entity ? nameOf(entity) : id;
  };

  const roomExists = (name: string) => snapshot.areas.some((area) => same(area.name, name));
  const wanted = new Set([
    ...configuration.rooms,
    ...configuration.devices.flatMap((device) => [device.room, ...device.entities.map((entity) => entity.room)]),
    ...configuration.entities.map((entity) => entity.room),
  ].filter(present));
  const roomsToCreate = [...wanted].filter((room) => !roomExists(room));

  const renames: RenameStep[] = [];
  const rooms: RoomStep[] = [];
  const unmatched: ExportedDevice[] = [];
  let matched = 0;
  const planEntities = (device: string | null, entries: ExportedEntity[]) => {
    for (const entry of entries) {
      const id = resolveEntity(device, entry.entity_id);
      if (!id) continue;
      const registered = snapshot.registry.find((item) => item.entity_id === id);
      if (entry.name && registered?.name !== entry.name)
        renames.push({ kind: 'entity', id, from: shownEntityName(id), name: entry.name });
      if (entry.room && !same(areaName(snapshot, registered?.area_id) ?? '', entry.room))
        rooms.push({ kind: 'entity', id, label: entry.name ?? shownEntityName(id), room: entry.room });
    }
  };
  for (const exported of configuration.devices) {
    const device = deviceFor(exported.key);
    if (!device) {
      if (exported.name || exported.room || exported.entities.length) unmatched.push(exported);
      continue;
    }
    matched++;
    const current = device.name_by_user || device.name || device.id;
    if (exported.name && device.name_by_user !== exported.name)
      renames.push({ kind: 'device', id: device.id, from: current, name: exported.name });
    if (exported.room && !same(areaName(snapshot, device.area_id) ?? '', exported.room))
      rooms.push({ kind: 'device', id: device.id, label: exported.name ?? current, room: exported.room });
    planEntities(exported.key, exported.entities);
  }
  planEntities(null, configuration.entities);

  const existingMoods: string[] = [];
  const moods: MoodStep[] = [];
  const sceneNames = snapshot.entities.filter((entity) => domainOf(entity) === 'scene').map(nameOf);
  for (const mood of configuration.moods) {
    if (sceneNames.some((name) => same(name, mood.name))) {
      existingMoods.push(mood.name);
      continue;
    }
    const targets = mood.targets.flatMap(({ device, ...target }) => {
      const id = resolveEntity(device, target.entity_id);
      return id ? [{ ...target, entity_id: id }] : [];
    });
    if (targets.length) moods.push({ name: mood.name, targets, missing: mood.targets.length - targets.length });
  }
  const named = (domain: string) => snapshot.entities.filter((entity) => domainOf(entity) === domain).map(nameOf);
  const existingRoutines: string[] = [];
  const routines = configuration.routines.filter((routine) => {
    const exists = named(routine.kind).some((name) => same(name, routine.name));
    if (exists) existingRoutines.push(routine.name);
    return !exists;
  });
  return {
    homeName: configuration.home_name,
    exportedAt: configuration.exported_at,
    roomsToCreate,
    matched,
    unmatched,
    renames,
    rooms,
    moods,
    existingMoods,
    helpers: configuration.helpers.filter((helper) => !named(helper.domain).some((name) => same(name, helper.name))),
    routines,
    existingRoutines,
  };
}

/** A saved routine with its entities, devices, and rooms pointed at this home's. */
export function localizeRoutine(routine: ExportedRoutine, snapshot: HassSnapshot): RoutineConfig {
  const { deviceFor, resolveEntity } = matcher(snapshot);
  const entities = new Map<string, string>();
  for (const reference of routine.entities) {
    // A mood or helper created by this import has no device and keeps its id.
    const id = resolveEntity(reference.device, reference.entity_id);
    if (id) entities.set(reference.entity_id, id);
  }
  const devices = new Map<string, string>();
  for (const reference of routine.devices) {
    const device = deviceFor(reference.key);
    if (device) devices.set(reference.id, device.id);
  }
  const areas = new Map<string, string>();
  for (const room of routine.rooms) {
    const area = snapshot.areas.find((item) => same(item.name, room.name));
    if (area) areas.set(room.id, area.area_id);
  }
  const config = rewriteReferences(routine.config, { entities, devices, areas });
  if (!isRecord(config)) throw new Error('This routine could not be read.');
  return config;
}

/** Map exported entity references (favourites, speaker) to this home's entity IDs. */
export function resolveReferences(references: EntityReference[], snapshot: HassSnapshot): string[] {
  const { resolveEntity } = matcher(snapshot);
  return references.map((reference) => resolveEntity(reference.device, reference.entity_id)).filter(present);
}

export interface ImportProgress { done: number; total: number; current: string }
export interface ImportResult { applied: number; failures: string[] }

/** Apply a plan one validated setup change at a time; one failure does not stop the rest. */
export async function applyImport(
  plan: ImportPlan,
  setup: HomeSetup,
  currentSnapshot: () => HassSnapshot,
  onProgress: (progress: ImportProgress) => void,
  signal?: AbortSignal,
): Promise<ImportResult> {
  const steps: { label: string; run: () => Promise<unknown> }[] = [
    ...plan.roomsToCreate.map((room) => ({ label: `Create ${room}`, run: () => setup.createRoom(room, signal) })),
    ...plan.renames.map((step) => ({
      label: `Rename ${step.from} to ${step.name}`,
      run: () => step.kind === 'device' ? setup.renameDevice(step.id, step.name, signal) : setup.renameEntity(step.id, step.name, signal),
    })),
    ...plan.rooms.map((step) => ({
      label: `Put ${step.label} in ${step.room}`,
      run: () => {
        const area = currentSnapshot().areas.find((item) => same(item.name, step.room));
        if (!area) throw new Error(`${step.room} does not exist.`);
        return step.kind === 'device' ? setup.assignDevice(step.id, area.area_id, signal) : setup.assignEntity(step.id, area.area_id, signal);
      },
    })),
    ...plan.moods.map((mood) => ({ label: `Create mood ${mood.name}`, run: () => setup.saveMood({ name: mood.name, targets: mood.targets }, signal) })),
    ...plan.helpers.map((helper) => ({ label: `Create helper ${helper.name}`, run: () => setup.saveHelper({ domain: helper.domain, name: helper.name, settings: helper.settings }, signal) })),
    // Scripts come before automations, which may run them. Each is checked again against this home.
    ...[...plan.routines].sort((first, second) => Number(first.kind === 'automation') - Number(second.kind === 'automation')).map((routine) => ({
      label: `Create ${routine.kind} ${routine.name}`,
      run: () => {
        const config = localizeRoutine(routine, currentSnapshot());
        const parts = routineParts(routine.kind, config);
        const common = {
          name: routine.name,
          ...(typeof config.description === 'string' ? { description: config.description } : {}),
          ...(typeof config.mode === 'string' ? { mode: config.mode } : {}),
        };
        return routine.kind === 'automation'
          ? setup.saveAutomation({ ...common, triggers: parts.triggers, conditions: parts.conditions, actions: parts.actions, enabled: routine.enabled }, signal)
          : setup.saveScript({ ...common, sequence: parts.actions, ...(typeof config.icon === 'string' ? { icon: config.icon } : {}) }, signal);
      },
    })),
  ];
  const failures: string[] = [];
  let applied = 0;
  for (const [index, step] of steps.entries()) {
    if (signal?.aborted) throw new DOMException('Stopped.', 'AbortError');
    onProgress({ done: index, total: steps.length, current: step.label });
    try {
      await step.run();
      applied++;
    } catch (error) {
      if (signal?.aborted) throw error;
      failures.push(`${step.label}: ${error instanceof Error ? error.message : 'failed'}`);
    }
  }
  onProgress({ done: steps.length, total: steps.length, current: '' });
  return { applied, failures };
}

export const configurationFileName = (now = new Date()) =>
  `hjem-configuration-${now.toISOString().slice(0, 10)}.json`;
