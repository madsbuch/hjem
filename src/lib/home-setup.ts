import type { HassArea, HassEntity, HassSnapshot } from './home-assistant';
import { domainOf, isUnavailable, nameOf, roomFor, supports, supportsBrightness } from './entities';
import { SceneConfigNotFoundError, SceneRequestError } from './home-assistant-scenes';
import {
  helperDomains,
  type AutomationRequest,
  type HelperDomain,
  type HelperRecord,
  type HelperRequest,
  type HomeSetup,
  type HomeSetupTransport,
  type MoodTarget,
  type RoutineConfig,
  type RoutineDescription,
  type RoutineKind,
  type SaveMoodRequest,
  type SceneConfig,
  type SceneEntityState,
  type ScriptRequest,
  type SetupChange,
  type SetupTarget,
} from './home-setup-types';
import {
  compileAutomation,
  compileHelper,
  compileScript,
  describeParts,
  helperLabels,
  normalizeRoutine,
  routineParts,
  routineProblems,
  slugify,
  validRoutineId,
} from './home-routines';

interface Options {
  transport: HomeSetupTransport;
  demo: boolean;
  isCurrent: () => boolean;
  onChange?: () => void;
}
interface UndoEntry {
  change: SetupChange;
  undo: (signal?: AbortSignal) => Promise<void>;
}
interface MoodReading {
  entity: HassEntity;
  configId: string;
  config: SceneConfig;
}
const MAX_CHANGES = 30;
const MAX_TARGETS = 50;
const moodDomains = new Set(['light', 'switch', 'input_boolean', 'fan', 'climate', 'cover', 'media_player']);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const label = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 80 || /[\u0000-\u001f]/.test(trimmed))
    throw new Error('Use a name between 1 and 80 characters.');
  return trimmed;
};
const numeric = (value: number | undefined, minimum: number, maximum: number, name: string) => {
  if (!finite(value) || value < minimum || value > maximum)
    throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
  return value;
};
const cleanError = (cause: unknown) => cause instanceof Error ? cause.message : 'The operation could not be confirmed.';
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
function sameScene(first: SceneConfig, second: SceneConfig): boolean {
  // HA supplies the configuration id when saving; it does not change the scene.
  const { id: _firstId, ...firstContent } = first;
  const { id: _secondId, ...secondContent } = second;
  return canonical(firstContent) === canonical(secondContent);
}
function ensureArea(snapshot: HassSnapshot, areaId: string | null): HassArea | null {
  if (areaId === null) return null;
  const area = snapshot.areas.find((candidate) => candidate.area_id === areaId);
  if (!area) throw new Error('That room no longer exists. Read the home structure again.');
  return area;
}
function ensureAvailable(entity: HassEntity, snapshot: HassSnapshot) {
  const entry = snapshot.registry.find((candidate) => candidate.entity_id === entity.entity_id);
  if (entry?.hidden_by || entry?.disabled_by) throw new Error(`${nameOf(entity)} is hidden or disabled.`);
  if (isUnavailable(entity)) throw new Error(`${nameOf(entity)} is unavailable. Choose an available device for this mood.`);
}
function sceneVisible(entity: HassEntity, snapshot: HassSnapshot): boolean {
  const entry = snapshot.registry.find((candidate) => candidate.entity_id === entity.entity_id);
  return domainOf(entity) === 'scene' && !entry?.hidden_by && !entry?.disabled_by;
}
function capabilitiesOf(entity: HassEntity | undefined): Record<string, number | string | string[]> {
  const capabilities: Record<string, number | string | string[]> = {};
  if (!entity || !moodDomains.has(domainOf(entity))) return capabilities;
  for (const key of ['supported_features', 'min_color_temp_kelvin', 'max_color_temp_kelvin', 'min_temp', 'max_temp', 'target_temp_step']) {
    const value = entity.attributes[key];
    if (finite(value)) capabilities[key] = value;
  }
  for (const key of ['supported_color_modes', 'hvac_modes']) {
    if (entity.attributes[key] !== undefined) capabilities[key] = stringList(entity.attributes[key]).slice(0, 30).map((value) => value.slice(0, 100));
  }
  if (typeof entity.attributes.device_class === 'string') capabilities.device_class = entity.attributes.device_class.slice(0, 100);
  return capabilities;
}

/** Compile the small authoring vocabulary into actual HA scene states. */
export function compileMoodTargets(targets: MoodTarget[], snapshot: HassSnapshot): SceneConfig['entities'] {
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > MAX_TARGETS)
    throw new Error(`A mood needs between 1 and ${MAX_TARGETS} devices.`);
  const entities: SceneConfig['entities'] = {};
  for (const target of targets) {
    if (Object.hasOwn(entities, target.entity_id)) throw new Error('A mood cannot set the same entity twice.');
    const entity = snapshot.entities.find((candidate) => candidate.entity_id === target.entity_id);
    if (!entity) throw new Error(`The device ${target.entity_id} no longer exists. Read the home again.`);
    ensureAvailable(entity, snapshot);
    const fields = Object.keys(target).filter((key) => key !== 'entity_id' && key !== 'state');
    const state: SceneEntityState = { state: target.state };
    const domain = domainOf(entity);
    let allowed: string[] = [];
    if (['light', 'switch', 'input_boolean', 'fan'].includes(domain)) {
      if (!['on', 'off'].includes(target.state)) throw new Error(`${nameOf(entity)} requires an on or off state.`);
      if (domain === 'light') {
        allowed = ['brightness_pct', 'color_temp_kelvin'];
        if (target.brightness_pct !== undefined) {
          if (!supportsBrightness(entity)) throw new Error(`${nameOf(entity)} does not support brightness.`);
          state.brightness = Math.round(numeric(target.brightness_pct, 1, 100, 'Brightness') * 255 / 100);
        }
        if (target.color_temp_kelvin !== undefined) {
          if (!stringList(entity.attributes.supported_color_modes).includes('color_temp'))
            throw new Error(`${nameOf(entity)} does not support colour temperature.`);
          const minimum = entity.attributes.min_color_temp_kelvin;
          const maximum = entity.attributes.max_color_temp_kelvin;
          if (!finite(minimum) || !finite(maximum)) throw new Error(`${nameOf(entity)} does not report its colour-temperature range.`);
          state.color_temp_kelvin = numeric(target.color_temp_kelvin, minimum, maximum, 'Colour temperature');
        }
        if (target.state === 'off' && fields.length) throw new Error('An off light cannot also set brightness or colour temperature.');
      }
    } else if (domain === 'climate') {
      allowed = ['temperature'];
      const modes = stringList(entity.attributes.hvac_modes);
      if (!(modes.length ? modes.includes(target.state) : target.state === entity.state))
        throw new Error(`${nameOf(entity)} does not support that climate mode.`);
      if (target.temperature !== undefined) {
        if (!supports(entity, 1)) throw new Error(`${nameOf(entity)} does not support a target temperature.`);
        const minimum = entity.attributes.min_temp;
        const maximum = entity.attributes.max_temp;
        if (!finite(minimum) || !finite(maximum)) throw new Error(`${nameOf(entity)} does not report its temperature range.`);
        state.temperature = numeric(target.temperature, minimum, maximum, 'Temperature');
      }
    } else if (domain === 'cover') {
      allowed = ['position'];
      if (!['blind', 'curtain', 'shade', 'shutter'].includes(String(entity.attributes.device_class)) || !supports(entity, 4))
        throw new Error('Only blinds, curtains, shades, and shutters with position controls can be included.');
      if (!['open', 'closed'].includes(target.state)) throw new Error('A blind mood requires an open or closed state.');
      state.current_position = numeric(target.position, 0, 100, 'Blind position');
      if ((target.state === 'closed') !== (state.current_position === 0)) throw new Error('The blind state must match its position.');
    } else if (domain === 'media_player') {
      allowed = ['volume_pct', 'is_volume_muted'];
      if (!(target.state === 'playing' && supports(entity, 16384)) && !(target.state === 'paused' && supports(entity, 1)))
        throw new Error(`${nameOf(entity)} does not support that playback state.`);
      if (target.volume_pct !== undefined) {
        if (!supports(entity, 4)) throw new Error(`${nameOf(entity)} does not support volume.`);
        state.volume_level = numeric(target.volume_pct, 0, 100, 'Volume') / 100;
      }
      if (target.is_volume_muted !== undefined) {
        if (!supports(entity, 8) || typeof target.is_volume_muted !== 'boolean') throw new Error(`${nameOf(entity)} does not support that mute setting.`);
        state.is_volume_muted = target.is_volume_muted;
      }
    } else throw new Error(`${domain} devices cannot be authored into a mood.`);
    if (fields.some((key) => !allowed.includes(key))) throw new Error(`${nameOf(entity)} received unsupported mood settings.`);
    entities[target.entity_id] = state;
  }
  return entities;
}

const ignoredSceneAttributes = new Set([
  'friendly_name', 'icon', 'supported_features', 'supported_color_modes', 'color_mode',
  'min_color_temp_kelvin', 'max_color_temp_kelvin', 'min_mireds', 'max_mireds',
  'device_class', 'unit_of_measurement', 'assumed_state', 'entity_picture',
]);
function targetsFromConfig(config: SceneConfig): { targets: MoodTarget[]; unsupported: string[] } {
  const unsupported: string[] = [];
  const targets = Object.entries(config.entities).map(([entity_id, value]): MoodTarget => {
    const state = typeof value === 'string' ? { state: value } : value;
    const target: MoodTarget = { entity_id, state: state.state };
    for (const [key, attribute] of Object.entries(state)) {
      if (key === 'state' || ignoredSceneAttributes.has(key)) continue;
      if (key === 'brightness' && finite(attribute)) target.brightness_pct = Math.round(attribute / 255 * 10000) / 100;
      else if (key === 'brightness_pct' && finite(attribute)) target.brightness_pct = attribute;
      else if (key === 'color_temp_kelvin' && finite(attribute)) target.color_temp_kelvin = attribute;
      else if (key === 'temperature' && finite(attribute)) target.temperature = attribute;
      else if (key === 'current_position' && finite(attribute)) target.position = attribute;
      else if (key === 'volume_level' && finite(attribute)) target.volume_pct = attribute * 100;
      else if (key === 'is_volume_muted' && typeof attribute === 'boolean') target.is_volume_muted = attribute;
      else unsupported.push(`${entity_id}: ${key}`);
    }
    return target;
  });
  return { targets, unsupported };
}
function sceneProblems(config: SceneConfig, snapshot: HassSnapshot): string[] {
  const problems: string[] = [];
  for (const [id, value] of Object.entries(config.entities)) {
    const entity = snapshot.entities.find((candidate) => candidate.entity_id === id);
    if (!entity) { problems.push(`${id} is missing.`); continue; }
    if (isUnavailable(entity)) { problems.push(`${nameOf(entity)} is unavailable.`); continue; }
    const expected = typeof value === 'string' ? { state: value } : value;
    if (entity.state !== expected.state) problems.push(`${nameOf(entity)} is ${entity.state}; expected ${expected.state}.`);
    if (expected.brightness_pct !== undefined) {
      const wanted = expected.brightness_pct;
      const actual = entity.attributes.brightness;
      if (!finite(wanted) || !finite(actual) || Math.abs(wanted * 255 / 100 - actual) > 2)
        problems.push(`${nameOf(entity)} has not confirmed its brightness setting.`);
    }
    for (const key of ['brightness', 'color_temp_kelvin', 'temperature', 'current_position', 'volume_level', 'is_volume_muted']) {
      const wanted = expected[key];
      if (wanted === undefined) continue;
      const actual = entity.attributes[key];
      const tolerance = key === 'brightness' ? 2 : key === 'color_temp_kelvin' ? 60 : key === 'volume_level' ? 0.015 : key === 'temperature' ? 0.1 : 1;
      if (finite(wanted) && finite(actual) ? Math.abs(wanted - actual) > tolerance : wanted !== actual)
        problems.push(`${nameOf(entity)} has not confirmed its ${key.replaceAll('_', ' ')} setting.`);
    }
  }
  return problems;
}

export class HomeSetupManager implements HomeSetup {
  private readonly transport: HomeSetupTransport;
  private readonly entries: UndoEntry[] = [];
  private readonly inspectedMoods = new Map<string, SceneConfig>();
  private readonly inspectedRoutines = new Map<string, RoutineConfig>();
  private writing = false;

  constructor(private readonly options: Options) { this.transport = options.transport; }

  private guard(signal?: AbortSignal) {
    if (!this.options.isCurrent()) throw new Error('The home connection changed. Start a new request for this home.');
    if (signal?.aborted) throw new DOMException('Stopped.', 'AbortError');
  }
  private async structure(signal?: AbortSignal) {
    this.guard(signal);
    const snapshot = await this.transport.refreshStructure();
    this.guard(signal);
    if (snapshot.structureStatus === 'unavailable') throw new Error(snapshot.structureError || 'Home structure could not be read. No setup changes were sent.');
    return snapshot;
  }
  private async exclusive<T>(signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
    this.guard(signal);
    if (this.writing) throw new Error('Another setup change is still running. Wait for it to finish.');
    this.writing = true;
    try { return await run(); } finally { this.writing = false; }
  }
  private remember(description: string, undo: UndoEntry['undo'], target?: SetupTarget): SetupChange {
    const change: SetupChange = { id: crypto.randomUUID(), description, createdAt: new Date().toISOString(), ...(target ? { target } : {}) };
    this.entries.push({ change, undo });
    if (this.entries.length > MAX_CHANGES) this.entries.shift();
    this.options.onChange?.();
    return change;
  }
  private async dispatch<T>(change: SetupChange, write: () => Promise<T>): Promise<T> {
    try { return await write(); }
    catch (error) {
      if (error instanceof SceneRequestError && error.definitelyRejected) {
        const index = this.entries.findIndex((entry) => entry.change.id === change.id);
        if (index >= 0) this.entries.splice(index, 1);
        this.options.onChange?.();
      }
      throw error;
    }
  }
  changes(): SetupChange[] { return this.entries.map(({ change }) => ({ ...change })).reverse(); }

  async inspect(signal?: AbortSignal) {
    const snapshot = await this.structure(signal);
    const entityIds = [...new Set([...snapshot.registry.map((entry) => entry.entity_id), ...snapshot.entities.map((entity) => entity.entity_id)])];
    return {
      demo: this.options.demo,
      areas: snapshot.areas.map((area) => ({ area_id: area.area_id, name: area.name })),
      devices: snapshot.devices.map((device) => ({
        id: device.id,
        name: device.name_by_user || device.name || snapshot.entities.find((entity) => snapshot.registry.some((entry) => entry.device_id === device.id && entry.entity_id === entity.entity_id))?.attributes.friendly_name || device.id,
        area_id: device.area_id,
        entity_ids: snapshot.registry.filter((entry) => entry.device_id === device.id).map((entry) => entry.entity_id),
        entity_overrides: snapshot.registry.filter((entry) => entry.device_id === device.id && entry.area_id !== null).map((entry) => ({ entity_id: entry.entity_id, area_id: entry.area_id })),
      })),
      entities: entityIds.map((id) => {
        const entity = snapshot.entities.find((candidate) => candidate.entity_id === id);
        const entry = snapshot.registry.find((candidate) => candidate.entity_id === id);
        const deviceArea = snapshot.devices.find((device) => device.id === entry?.device_id)?.area_id ?? null;
        return {
          entity_id: id,
          name: entity ? nameOf(entity) : entry?.name || entry?.original_name || id,
          device_id: entry?.device_id ?? null,
          explicit_area_id: entry?.area_id ?? null,
          effective_area_id: entry?.area_id || deviceArea,
          area_source: entry?.area_id ? 'entity' : deviceArea ? 'device' : 'unassigned',
          state: entity && moodDomains.has(domainOf(entity)) ? entity.state.slice(0, 100) : null,
          available: !!entity && !isUnavailable(entity) && !entry?.disabled_by && !entry?.hidden_by,
          capabilities: capabilitiesOf(entity),
        };
      }),
      scenes: snapshot.entities.filter((entity) => sceneVisible(entity, snapshot)).map((entity) => ({ entity_id: entity.entity_id, name: nameOf(entity), editable: typeof entity.attributes.id === 'string' })),
      changes: this.changes(),
    };
  }

  async createRoom(name: string, signal?: AbortSignal) {
    return this.exclusive(signal, async () => {
      const nextName = label(name);
      const before = await this.structure(signal);
      const existing = before.areas.find((area) => area.name.toLocaleLowerCase() === nextName.toLocaleLowerCase());
      if (existing) return { changed: false, demo: this.options.demo, area: existing, message: `${existing.name} already exists.` };
      this.guard(signal);
      const area = await this.transport.createArea(nextName);
      // Retain the inverse even when Stop arrives after HA accepted the write.
      const change = this.remember(`Created ${area.name}`, async (undoSignal) => {
        const current = await this.structure(undoSignal);
        const currentArea = current.areas.find((item) => item.area_id === area.area_id);
        if (!currentArea) return;
        if (canonical(currentArea) !== canonical(area) || current.devices.some((device) => device.area_id === area.area_id) || current.registry.some((entry) => entry.area_id === area.area_id))
          throw new Error('This room has changed or contains devices. Undo its later changes before removing it.');
        const related = await this.transport.relatedToArea(area.area_id);
        this.guard(undoSignal);
        if (Object.values(related).some((items) => items.length > 0)) throw new Error('This room is now referenced elsewhere. Its creation cannot be undone automatically.');
        await this.transport.deleteArea(area.area_id);
        const after = await this.structure(undoSignal);
        if (after.areas.some((item) => item.area_id === area.area_id)) throw new Error('Home Assistant has not confirmed removing the room.');
      }, { kind: 'room', id: area.area_id });
      const after = await this.structure(signal);
      if (!after.areas.some((item) => item.area_id === area.area_id && item.name === area.name)) throw new Error('The room was sent to Home Assistant, but read-back did not confirm it. Check the change history before retrying.');
      return { changed: true, demo: this.options.demo, area, change_id: change.id, message: `${area.name} created${this.options.demo ? ' in the demo home' : ''}.` };
    });
  }

  async renameRoom(areaId: string, name: string, signal?: AbortSignal) {
    return this.exclusive(signal, async () => {
      const nextName = label(name);
      const before = await this.structure(signal);
      const area = ensureArea(before, areaId);
      if (!area) throw new Error('Choose a room to rename.');
      if (area.name === nextName) return { changed: false, area, message: 'The room already has that name.' };
      if (before.areas.some((item) => item.area_id !== areaId && item.name.toLocaleLowerCase() === nextName.toLocaleLowerCase())) throw new Error('Another room already uses that name.');
      const previousName = area.name;
      const change = this.remember(`Renamed ${previousName} to ${nextName}`, async (undoSignal) => {
        const current = await this.structure(undoSignal);
        const currentArea = ensureArea(current, areaId);
        if (currentArea?.name === previousName) return;
        if (currentArea?.name !== nextName) throw new Error('The room name has changed since this edit. Read it again before making another change.');
        if (current.areas.some((item) => item.area_id !== areaId && item.name.toLocaleLowerCase() === previousName.toLocaleLowerCase())) throw new Error('Another room now uses the previous name.');
        this.guard(undoSignal);
        await this.transport.renameArea(areaId, previousName);
        const restored = await this.structure(undoSignal);
        if (ensureArea(restored, areaId)?.name !== previousName) throw new Error('Home Assistant has not confirmed restoring the room name.');
      }, { kind: 'room', id: areaId });
      this.guard(signal);
      const renamed = await this.dispatch(change, () => this.transport.renameArea(areaId, nextName));
      const after = await this.structure(signal);
      if (ensureArea(after, areaId)?.name !== nextName) throw new Error('Home Assistant has not confirmed the room name. Check change history before retrying.');
      return { changed: true, demo: this.options.demo, area: renamed, change_id: change.id, message: `${previousName} is now ${nextName}.` };
    });
  }

  private async related(areaIds: (string | null)[], signal?: AbortSignal) {
    const areas: { area_id: string; related: Record<string, string[]> }[] = [];
    let checked = true;
    for (const areaId of new Set(areaIds)) {
      if (!areaId) continue;
      this.guard(signal);
      try { areas.push({ area_id: areaId, related: await this.transport.relatedToArea(areaId) }); }
      catch { this.guard(signal); checked = false; }
    }
    return { checked, areas, note: checked ? 'Room-targeted routines may include a different set of devices after this move. Explicit entity assignments are preserved.' : 'Related routines could not all be inspected. Room-targeted routines may be affected by this move.' };
  }

  async assignDevice(deviceId: string, areaId: string | null, signal?: AbortSignal) {
    return this.assign('device', deviceId, areaId, signal);
  }
  async assignEntity(entityId: string, areaId: string | null, signal?: AbortSignal) {
    return this.assign('entity', entityId, areaId, signal);
  }
  private async assign(kind: 'device' | 'entity', id: string, areaId: string | null, signal?: AbortSignal) {
    return this.exclusive(signal, async () => {
      const before = await this.structure(signal);
      const area = ensureArea(before, areaId);
      const resource = kind === 'device' ? before.devices.find((item) => item.id === id) : before.registry.find((item) => item.entity_id === id);
      if (!resource) throw new Error('That device or entity is not registered. Read the home structure again.');
      const previousArea = resource.area_id;
      if (previousArea === areaId) return { changed: false, message: 'This assignment is already in place.' };
      const entity = before.entities.find((item) => item.entity_id === id);
      const device = before.devices.find((item) => item.id === id);
      const resourceName = kind === 'device' ? device?.name_by_user || device?.name || id : entity ? nameOf(entity) : id;
      const effectiveBefore = kind === 'entity' && entity ? roomFor(entity, before) : previousArea;
      const entityEntry = kind === 'entity' ? before.registry.find((item) => item.entity_id === id) : undefined;
      const effectiveAfter = areaId ?? (kind === 'entity' ? before.devices.find((item) => item.id === entityEntry?.device_id)?.area_id ?? null : null);
      const related = await this.related([effectiveBefore, effectiveAfter], signal);
      this.guard(signal);
      const write = async (value: string | null) => {
        if (kind === 'device') await this.transport.assignDeviceArea(id, value);
        else await this.transport.assignEntityArea(id, value);
      };
      const change = this.remember(`Moved ${resourceName} to ${area?.name || (kind === 'entity' ? 'its device room' : 'unassigned')}`, async (undoSignal) => {
        const current = await this.structure(undoSignal);
        ensureArea(current, previousArea);
        const currentResource = kind === 'device' ? current.devices.find((item) => item.id === id) : current.registry.find((item) => item.entity_id === id);
        if (!currentResource) throw new Error('This device or entity no longer exists.');
        if (currentResource.area_id === previousArea) return;
        if (currentResource.area_id !== areaId) throw new Error('This assignment was changed elsewhere. Undo will not overwrite it.');
        this.guard(undoSignal);
        await write(previousArea);
        const restored = await this.structure(undoSignal);
        const result = kind === 'device' ? restored.devices.find((item) => item.id === id) : restored.registry.find((item) => item.entity_id === id);
        if (!result || result.area_id !== previousArea) throw new Error('Home Assistant has not confirmed restoring this assignment.');
      }, { kind, id });
      await this.dispatch(change, () => write(areaId));
      const after = await this.structure(signal);
      const result = kind === 'device' ? after.devices.find((item) => item.id === id) : after.registry.find((item) => item.entity_id === id);
      if (!result || result.area_id !== areaId) throw new Error('Home Assistant has not confirmed the assignment. Check change history before retrying.');
      return { changed: true, demo: this.options.demo, kind, id, area_id: areaId, change_id: change.id, related_routines: related, message: `${resourceName} assigned to ${area?.name || (kind === 'entity' ? 'its device room' : 'no room')}.` };
    });
  }

  async renameDevice(deviceId: string, name: string | null, signal?: AbortSignal) {
    return this.rename('device', deviceId, name, signal);
  }
  async renameEntity(entityId: string, name: string | null, signal?: AbortSignal) {
    return this.rename('entity', entityId, name, signal);
  }
  /** `null` restores the integration's own name. */
  private async rename(kind: 'device' | 'entity', id: string, name: string | null, signal?: AbortSignal) {
    return this.exclusive(signal, async () => {
      const nextName = name === null ? null : label(name);
      const before = await this.structure(signal);
      const customName = (snapshot: HassSnapshot): string | null | undefined => {
        if (kind === 'device') {
          const device = snapshot.devices.find((item) => item.id === id);
          return device ? device.name_by_user ?? null : undefined;
        }
        const entry = snapshot.registry.find((item) => item.entity_id === id);
        return entry ? entry.name ?? null : undefined;
      };
      const shownName = (snapshot: HassSnapshot, custom: string | null): string => {
        if (custom) return custom;
        if (kind === 'device') return snapshot.devices.find((item) => item.id === id)?.name || id;
        const entity = snapshot.entities.find((item) => item.entity_id === id);
        return snapshot.registry.find((item) => item.entity_id === id)?.original_name || (entity ? nameOf(entity) : id);
      };
      const previous = customName(before);
      if (previous === undefined) throw new Error('That device or entity is not registered. Read the home structure again.');
      if (previous === nextName) return { changed: false, message: 'It already has that name.' };
      const previousShown = shownName(before, previous);
      const nextShown = shownName(before, nextName);
      const write = async (value: string | null) => {
        if (kind === 'device') await this.transport.renameDevice(id, value);
        else await this.transport.renameEntity(id, value);
      };
      const change = this.remember(`Renamed ${previousShown} to ${nextShown}`, async (undoSignal) => {
        const current = customName(await this.structure(undoSignal));
        if (current === undefined) throw new Error('This device or entity no longer exists.');
        if (current === previous) return;
        if (current !== nextName) throw new Error('This name was changed elsewhere. Undo will not overwrite it.');
        this.guard(undoSignal);
        await write(previous);
        if (customName(await this.structure(undoSignal)) !== previous) throw new Error('Home Assistant has not confirmed restoring the name.');
      }, { kind, id });
      this.guard(signal);
      await this.dispatch(change, () => write(nextName));
      if (customName(await this.structure(signal)) !== nextName) throw new Error('Home Assistant has not confirmed the name. Check change history before retrying.');
      return { changed: true, demo: this.options.demo, kind, id, name: nextShown, change_id: change.id, message: `${previousShown} is now ${nextShown}.` };
    });
  }

  private async readMood(entityId: string, signal?: AbortSignal): Promise<MoodReading> {
    this.guard(signal);
    const snapshot = this.transport.getSnapshot();
    const entity = snapshot.entities.find((item) => item.entity_id === entityId && sceneVisible(item, snapshot));
    if (!entity) throw new Error('That mood no longer exists. Read the home again.');
    const configId = entity.attributes.id;
    if (typeof configId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(configId)) throw new Error('This scene is provided by another integration and cannot be edited here.');
    const config = await this.transport.readScene(configId);
    this.guard(signal);
    return { entity, configId, config };
  }

  async inspectMood(entityId: string, signal?: AbortSignal) {
    await this.structure(signal);
    const { entity, configId, config } = await this.readMood(entityId, signal);
    const parsed = targetsFromConfig(config);
    this.inspectedMoods.set(entityId, structuredClone(config));
    const snapshot = this.transport.getSnapshot();
    const issues = parsed.targets.flatMap((target) => {
      const item = snapshot.entities.find((candidate) => candidate.entity_id === target.entity_id);
      if (!item) return [`${target.entity_id} is missing.`];
      if (isUnavailable(item)) return [`${nameOf(item)} is unavailable.`];
      return [];
    });
    return { entity_id: entityId, config_id: configId, name: config.name, editable: parsed.unsupported.length === 0, targets: parsed.targets, unsupported_settings: parsed.unsupported, issues, demo: this.options.demo, message: `${nameOf(entity)} inspected.` };
  }

  async saveMood(request: SaveMoodRequest, signal?: AbortSignal) {
    return this.exclusive(signal, async () => {
      const name = label(request.name);
      const snapshot = await this.structure(signal);
      const entities = compileMoodTargets(request.targets, snapshot);
      let previous: SceneConfig | undefined;
      let configId = `hjem_${crypto.randomUUID().replaceAll('-', '')}`;
      if (request.entity_id) {
        const observed = this.inspectedMoods.get(request.entity_id);
        if (!observed) throw new Error('Inspect the mood before updating it.');
        const current = await this.readMood(request.entity_id, signal);
        if (!sameScene(observed, current.config)) throw new Error('The mood changed since it was inspected. Inspect it again before saving.');
        if (targetsFromConfig(current.config).unsupported.length) throw new Error('This mood contains settings Concierge cannot preserve. Create a separate mood with supported settings.');
        previous = current.config;
        configId = current.configId;
      } else if (snapshot.entities.some((entity) => domainOf(entity) === 'scene' && nameOf(entity).toLocaleLowerCase() === name.toLocaleLowerCase())) {
        throw new Error('A mood already uses that name. Inspect it to update it, or choose another name.');
      }
      const config: SceneConfig = { ...(previous ?? {}), id: configId, name, entities };
      if (previous && sameScene(previous, config)) return { changed: false, entity_id: request.entity_id, config_id: configId, message: 'This mood already has those settings.' };
      const prior = previous ? structuredClone(previous) : undefined;
      const saved = structuredClone(config);
      const change = this.remember(`${previous ? 'Updated' : 'Created'} mood ${name}`, async (undoSignal) => {
        this.guard(undoSignal);
        let current: SceneConfig;
        try { current = await this.transport.readScene(configId); }
        catch (error) {
          this.guard(undoSignal);
          if (!prior && error instanceof SceneConfigNotFoundError) {
            await this.transport.refreshStates();
            await this.structure(undoSignal);
            return;
          }
          throw error;
        }
        this.guard(undoSignal);
        if (prior && sameScene(current, prior)) return;
        if (!sameScene(current, saved)) throw new Error('This mood was edited elsewhere. Undo will not overwrite those changes.');
        if (prior) await this.transport.saveScene(configId, prior);
        else await this.transport.deleteScene(configId);
        this.guard(undoSignal);
        if (prior) {
          const restored = await this.transport.readScene(configId);
          if (!sameScene(restored, prior)) throw new Error('Home Assistant has not confirmed restoring the mood.');
        } else {
          let removed = false;
          try { await this.transport.readScene(configId); }
          catch (error) {
            if (error instanceof SceneConfigNotFoundError) removed = true;
            else throw error;
          }
          if (!removed) throw new Error('Home Assistant has not confirmed deleting this mood.');
        }
        await this.transport.refreshStates();
        await this.structure(undoSignal);
      }, request.entity_id ? { kind: 'mood', id: request.entity_id } : undefined);
      this.guard(signal);
      await this.dispatch(change, () => this.transport.saveScene(configId, config));
      this.guard(signal);
      const readBack = await this.transport.readScene(configId);
      this.guard(signal);
      if (!sameScene(config, readBack)) throw new Error('Home Assistant did not return the saved mood unchanged. Check change history before retrying.');
      let scene: HassEntity | undefined;
      for (let attempt = 0; attempt < 5; attempt++) {
        const after = await this.transport.refreshStates();
        this.guard(signal);
        scene = after.entities.find((entity) => domainOf(entity) === 'scene' && entity.attributes.id === configId);
        if (scene) break;
        if (attempt < 4) await new Promise<void>((resolve) => setTimeout(resolve, 400));
        this.guard(signal);
      }
      await this.structure(signal);
      if (scene) {
        this.inspectedMoods.set(scene.entity_id, structuredClone(readBack));
        this.retarget(change, { kind: 'mood', id: scene.entity_id });
      }
      return { changed: true, demo: this.options.demo, entity_id: scene?.entity_id, config_id: configId, change_id: change.id, verification: 'saved', message: `${name} saved${this.options.demo ? ' in the demo home' : ' in Home Assistant'}.${scene ? '' : ' Its button will appear when Home Assistant publishes the scene.'}` };
    });
  }

  async activateMood(entityId: string, signal?: AbortSignal) {
    return this.exclusive(signal, async () => {
      this.guard(signal);
      const snapshot = this.transport.getSnapshot();
      const entity = snapshot.entities.find((item) => item.entity_id === entityId && sceneVisible(item, snapshot));
      if (!entity || entity.state === 'unavailable') throw new Error('Choose an available mood.');
      let config: SceneConfig | undefined;
      let reason = '';
      try { config = (await this.readMood(entityId, signal)).config; }
      catch (error) { this.guard(signal); reason = cleanError(error); }
      this.guard(signal);
      await this.transport.activateScene(entityId);
      this.guard(signal);
      const unsupported = config ? targetsFromConfig(config).unsupported : [];
      if (!config || !Object.keys(config.entities).length || unsupported.length) return { accepted: true, verified: false, status: 'unverified', demo: this.options.demo, entity_id: entityId, issues: [reason || 'Some scene settings cannot be checked by Hjem.'], message: `${nameOf(entity)} sent to Home Assistant; its device results could not be fully verified.` };
      let issues: string[] = [];
      try {
        for (let attempt = 0; attempt < 5; attempt++) {
          this.guard(signal);
          const snapshot = await this.transport.refreshStates();
          this.guard(signal);
          issues = sceneProblems(config, snapshot);
          if (!issues.length) return { accepted: true, verified: true, status: 'verified', demo: this.options.demo, entity_id: entityId, issues: [], message: `${nameOf(entity)} applied${this.options.demo ? ' in the demo home' : ''}; device states confirmed.` };
          if (attempt < 4) await new Promise<void>((resolve) => setTimeout(resolve, 400));
        }
      } catch (error) {
        this.guard(signal);
        return { accepted: true, verified: false, status: 'unverified', demo: this.options.demo, entity_id: entityId, issues: [cleanError(error)], message: `${nameOf(entity)} sent; device results could not be checked.` };
      }
      return { accepted: true, verified: false, status: 'partial', demo: this.options.demo, entity_id: entityId, issues, message: `${nameOf(entity)} sent, but ${issues.length} device setting${issues.length === 1 ? ' is' : 's are'} still unconfirmed. ${issues.slice(0, 2).join(' ')}` };
    });
  }

  /** Point a change at what it created, once Home Assistant has named it. */
  private retarget(change: SetupChange, target: SetupTarget) {
    const entry = this.entries.find((item) => item.change.id === change.id);
    if (!entry) return;
    entry.change.target = target;
    this.options.onChange?.();
  }

  async describeMood(entityId: string, signal?: AbortSignal): Promise<string[]> {
    const { config } = await this.readMood(entityId, signal);
    const snapshot = this.transport.getSnapshot();
    return targetsFromConfig(config).targets.map((target) => {
      const entity = snapshot.entities.find((item) => item.entity_id === target.entity_id);
      const settings = [
        target.brightness_pct !== undefined && `${Math.round(target.brightness_pct)}%`,
        target.color_temp_kelvin !== undefined && `${target.color_temp_kelvin} K`,
        target.temperature !== undefined && `${target.temperature}°`,
        target.position !== undefined && `${target.position}%`,
        target.volume_pct !== undefined && `volume ${Math.round(target.volume_pct)}%`,
        target.is_volume_muted && 'muted',
      ].filter(Boolean);
      return `${entity ? nameOf(entity) : target.entity_id}: ${[target.state.replaceAll('_', ' '), ...settings].join(', ')}`;
    });
  }

  async deleteRoom(areaId: string, signal?: AbortSignal) {
    return this.exclusive(signal, async () => {
      const before = await this.structure(signal);
      const area = ensureArea(before, areaId);
      if (!area) throw new Error('Choose a room to delete.');
      if (before.devices.some((device) => device.area_id === areaId) || before.registry.some((entry) => entry.area_id === areaId))
        throw new Error(`${area.name} still has devices. Move them to another room first.`);
      const related = await this.transport.relatedToArea(areaId);
      this.guard(signal);
      if (Object.values(related).some((items) => items.length > 0))
        throw new Error(`${area.name} is used by an automation, script, or mood. Change those first.`);
      const change = this.remember(`Deleted room ${area.name}`, async (undoSignal) => {
        const current = await this.structure(undoSignal);
        if (current.areas.some((item) => item.name.toLocaleLowerCase() === area.name.toLocaleLowerCase())) return;
        this.guard(undoSignal);
        await this.transport.createArea(area.name);
        const restored = await this.structure(undoSignal);
        if (!restored.areas.some((item) => item.name === area.name)) throw new Error('Home Assistant has not confirmed restoring the room.');
      });
      await this.dispatch(change, () => this.transport.deleteArea(areaId));
      const after = await this.structure(signal);
      if (after.areas.some((item) => item.area_id === areaId)) throw new Error('Home Assistant has not confirmed deleting the room. Check change history before retrying.');
      return { changed: true, demo: this.options.demo, area_id: areaId, change_id: change.id, message: `${area.name} deleted.` };
    });
  }

  async setEntityHidden(entityId: string, hidden: boolean, signal?: AbortSignal) {
    return this.exclusive(signal, async () => {
      const before = await this.structure(signal);
      const entry = before.registry.find((item) => item.entity_id === entityId);
      if (!entry) throw new Error('That entity is not registered. Read the home structure again.');
      if (!!entry.hidden_by === hidden) return { changed: false, message: hidden ? 'It is already hidden.' : 'It is already shown.' };
      const entity = before.entities.find((item) => item.entity_id === entityId);
      const shown = entity ? nameOf(entity) : entityId;
      const isHidden = async (check?: AbortSignal) => !!(await this.structure(check)).registry.find((item) => item.entity_id === entityId)?.hidden_by;
      const change = this.remember(`${hidden ? 'Hid' : 'Showed'} ${shown}`, async (undoSignal) => {
        if (await isHidden(undoSignal) !== hidden) return;
        this.guard(undoSignal);
        await this.transport.setEntityHidden(entityId, !hidden);
        if (await isHidden(undoSignal) === hidden) throw new Error('Home Assistant has not confirmed restoring this setting.');
      }, { kind: 'entity', id: entityId });
      await this.dispatch(change, () => this.transport.setEntityHidden(entityId, hidden));
      if (await isHidden(signal) !== hidden) throw new Error('Home Assistant has not confirmed the change. Check change history before retrying.');
      return { changed: true, demo: this.options.demo, entity_id: entityId, hidden, change_id: change.id, message: `${shown} is now ${hidden ? 'hidden from Hjem’s controls' : 'shown in Hjem’s controls'}.` };
    });
  }

  private routineRef(entityId: string, snapshot: HassSnapshot) {
    const kind: RoutineKind | undefined = entityId.startsWith('automation.') ? 'automation' : entityId.startsWith('script.') ? 'script' : undefined;
    const entity = snapshot.entities.find((item) => item.entity_id === entityId);
    if (!kind || !entity) throw new Error('That automation or script no longer exists. Read the routines again.');
    const entry = snapshot.registry.find((item) => item.entity_id === entityId);
    const configId = kind === 'automation' ? entity.attributes.id : entry?.unique_id ?? entityId.slice('script.'.length);
    if (typeof configId !== 'string' || !validRoutineId(configId))
      throw new Error(`This ${kind} is written in Home Assistant’s own files and cannot be edited from Hjem.`);
    return { kind, entity, configId };
  }
  private async readRoutineConfig(entityId: string, signal?: AbortSignal) {
    this.guard(signal);
    const reference = this.routineRef(entityId, this.transport.getSnapshot());
    const config = await this.transport.readRoutine(reference.kind, reference.configId);
    this.guard(signal);
    return { ...reference, config };
  }
  private sameRoutine(first: RoutineConfig | undefined, second: RoutineConfig | undefined): boolean {
    if (!first || !second) return first === second;
    // Home Assistant adds the id when saving an automation; it is not part of the routine.
    const { id: _firstId, ...firstContent } = first;
    const { id: _secondId, ...secondContent } = second;
    return canonical(firstContent) === canonical(secondContent);
  }
  /** The saved configuration, or undefined once it has been deleted. */
  private async currentRoutine(kind: RoutineKind, configId: string, signal?: AbortSignal): Promise<RoutineConfig | undefined> {
    this.guard(signal);
    try {
      const config = await this.transport.readRoutine(kind, configId);
      this.guard(signal);
      return config;
    } catch (error) {
      this.guard(signal);
      if (error instanceof SceneConfigNotFoundError) return undefined;
      throw error;
    }
  }
  private async awaitRoutine(kind: RoutineKind, configId: string, signal?: AbortSignal): Promise<HassEntity | undefined> {
    for (let attempt = 0; attempt < 5; attempt++) {
      await this.transport.refreshStates();
      const snapshot = await this.structure(signal);
      const entity = snapshot.entities.find((item) => item.entity_id.startsWith(`${kind}.`) && (kind === 'automation'
        ? item.attributes.id === configId
        : item.entity_id === `script.${configId}` || snapshot.registry.some((entry) => entry.entity_id === item.entity_id && entry.unique_id === configId)));
      if (entity) return entity;
      if (attempt < 4) await new Promise<void>((resolve) => setTimeout(resolve, 400));
      this.guard(signal);
    }
    return undefined;
  }
  /** Restore `prior` (or delete when there was none), unless someone else has edited it since. */
  private routineUndo(kind: RoutineKind, configId: string, prior: RoutineConfig | undefined, saved: RoutineConfig | undefined): UndoEntry['undo'] {
    return async (undoSignal) => {
      const current = await this.currentRoutine(kind, configId, undoSignal);
      if (!this.sameRoutine(current, prior)) {
        if (!this.sameRoutine(current, saved)) throw new Error(`This ${kind} was edited elsewhere. Undo will not overwrite those changes.`);
        if (prior) await this.transport.saveRoutine(kind, configId, prior);
        else await this.transport.deleteRoutine(kind, configId);
        if (!this.sameRoutine(await this.currentRoutine(kind, configId, undoSignal), prior))
          throw new Error(`Home Assistant has not confirmed restoring this ${kind}.`);
      }
      await this.transport.refreshStates();
      await this.structure(undoSignal);
    };
  }

  async listRoutines(signal?: AbortSignal) {
    const snapshot = await this.structure(signal);
    const routines = (kind: RoutineKind) => snapshot.entities.filter((entity) => entity.entity_id.startsWith(`${kind}.`)).slice(0, 200);
    const basics = (entity: HassEntity) => ({
      entity_id: entity.entity_id,
      name: nameOf(entity),
      last_triggered: typeof entity.attributes.last_triggered === 'string' ? entity.attributes.last_triggered : null,
    });
    return {
      demo: this.options.demo,
      automations: routines('automation').map((entity) => ({ ...basics(entity), enabled: entity.state === 'on', editable: typeof entity.attributes.id === 'string' })),
      scripts: routines('script').map((entity) => ({ ...basics(entity), running: entity.state === 'on' })),
    };
  }

  async inspectRoutine(entityId: string, signal?: AbortSignal) {
    await this.structure(signal);
    const { kind, entity, configId, config } = await this.readRoutineConfig(entityId, signal);
    this.inspectedRoutines.set(entityId, structuredClone(config));
    return {
      entity_id: entityId, kind, config_id: configId, name: nameOf(entity), editable: true,
      ...(kind === 'automation' ? { enabled: entity.state === 'on' } : {}),
      last_triggered: typeof entity.attributes.last_triggered === 'string' ? entity.attributes.last_triggered : null,
      config: normalizeRoutine(kind, config),
      issues: routineProblems(kind, config, this.transport.getSnapshot()),
      demo: this.options.demo,
      message: `${nameOf(entity)} inspected.`,
    };
  }

  async describeRoutine(entityId: string, signal?: AbortSignal): Promise<RoutineDescription> {
    const kind: RoutineKind = entityId.startsWith('script.') ? 'script' : 'automation';
    try {
      const { config } = await this.readRoutineConfig(entityId, signal);
      const snapshot = this.transport.getSnapshot();
      return { kind, editable: true, ...describeParts(kind, config, snapshot), problems: routineProblems(kind, config, snapshot), config: normalizeRoutine(kind, config) };
    } catch (error) {
      this.guard(signal);
      return { kind, editable: false, when: [], conditions: [], then: [], problems: [], message: cleanError(error) };
    }
  }

  async deviceTriggers(deviceId: string, signal?: AbortSignal) {
    const snapshot = await this.structure(signal);
    const device = snapshot.devices.find((item) => item.id === deviceId);
    if (!device) throw new Error('That device is not registered. Read the home structure again.');
    let triggers: Record<string, unknown>[] = [];
    let note = '';
    try { triggers = await this.transport.deviceTriggers(deviceId); }
    catch (error) { this.guard(signal); note = cleanError(error); }
    this.guard(signal);
    const events = snapshot.registry.filter((entry) => entry.device_id === deviceId && entry.entity_id.startsWith('event.')).flatMap((entry) => {
      const entity = snapshot.entities.find((item) => item.entity_id === entry.entity_id);
      return entity ? [{ entity_id: entity.entity_id, name: nameOf(entity), event_types: stringList(entity.attributes.event_types).slice(0, 40) }] : [];
    });
    return {
      device_id: deviceId,
      name: device.name_by_user || device.name || deviceId,
      triggers: triggers.slice(0, 80),
      event_entities: events,
      note: note || (triggers.length || events.length
        ? 'Use a returned trigger unchanged in save_automation, or a state trigger on an event entity with attribute event_type.'
        : 'This device offers no triggers. Use a state trigger on one of its entities instead.'),
    };
  }

  private async storeRoutine(
    kind: RoutineKind,
    request: { entity_id?: string; name: string },
    build: (name: string, snapshot: HassSnapshot, previous?: RoutineConfig) => RoutineConfig,
    signal?: AbortSignal,
  ) {
    const name = label(request.name);
    const snapshot = await this.structure(signal);
    const taken = (id: string) => snapshot.entities.some((entity) => entity.entity_id === id) || snapshot.registry.some((entry) => entry.entity_id === id);
    let previous: RoutineConfig | undefined;
    let configId: string;
    if (request.entity_id) {
      const observed = this.inspectedRoutines.get(request.entity_id);
      if (!observed) throw new Error(`Inspect the ${kind} before updating it.`);
      const current = await this.readRoutineConfig(request.entity_id, signal);
      if (current.kind !== kind) throw new Error(`That is not ${kind === 'automation' ? 'an automation' : 'a script'}.`);
      if (!this.sameRoutine(observed, current.config)) throw new Error(`The ${kind} changed since it was inspected. Inspect it again before saving.`);
      previous = current.config;
      configId = current.configId;
    } else {
      if (snapshot.entities.some((entity) => entity.entity_id.startsWith(`${kind}.`) && nameOf(entity).toLocaleLowerCase() === name.toLocaleLowerCase()))
        throw new Error(`${kind === 'automation' ? 'An automation' : 'A script'} already uses that name. Inspect it to update it, or choose another name.`);
      if (kind === 'automation') configId = `hjem_${crypto.randomUUID().replaceAll('-', '')}`;
      else {
        const base = slugify(name) || 'script';
        let suffix = 1;
        configId = base;
        while (taken(`script.${configId}`)) configId = `${base}_${++suffix}`;
      }
    }
    const built = build(name, snapshot, previous);
    const config: RoutineConfig = kind === 'automation' ? { ...built, id: configId } : built;
    if (previous && this.sameRoutine(previous, config))
      return { changed: false, entity_id: request.entity_id, config_id: configId, message: `This ${kind} already has those settings.` };
    const parts = routineParts(kind, config);
    const validation = await this.transport.validateRoutine({
      ...(parts.triggers.length ? { triggers: parts.triggers } : {}),
      ...(parts.conditions.length ? { conditions: parts.conditions } : {}),
      actions: parts.actions,
    });
    this.guard(signal);
    if (validation.errors.length)
      throw new Error(`Home Assistant does not accept this ${kind}, so nothing was saved. ${validation.errors.join(' ')}`);
    const prior = previous ? structuredClone(previous) : undefined;
    const change = this.remember(`${previous ? 'Updated' : 'Created'} ${kind} ${name}`, this.routineUndo(kind, configId, prior, structuredClone(config)),
      request.entity_id ? { kind, id: request.entity_id } : undefined);
    this.guard(signal);
    await this.dispatch(change, () => this.transport.saveRoutine(kind, configId, config));
    const readBack = await this.currentRoutine(kind, configId, signal);
    if (!readBack || !this.sameRoutine(config, readBack))
      throw new Error(`Home Assistant did not return the saved ${kind} unchanged. Check change history before retrying.`);
    const entity = await this.awaitRoutine(kind, configId, signal);
    if (entity) {
      this.inspectedRoutines.set(entity.entity_id, structuredClone(readBack));
      this.retarget(change, { kind, id: entity.entity_id });
    }
    return {
      changed: true, demo: this.options.demo, entity_id: entity?.entity_id, config_id: configId, change_id: change.id,
      checked_by_home_assistant: validation.checked,
      message: `${name} saved${this.options.demo ? ' in the demo home' : ' in Home Assistant'}.${entity ? '' : ' It will appear when Home Assistant has loaded it.'}`,
    };
  }

  async saveAutomation(request: AutomationRequest, signal?: AbortSignal) {
    return this.exclusive(signal, async () => {
      const result = await this.storeRoutine('automation', request, (name, snapshot, previous) => compileAutomation(request, name, snapshot, previous), signal);
      const entityId = result.entity_id;
      if (request.enabled === undefined || !entityId) return result;
      const entity = this.transport.getSnapshot().entities.find((item) => item.entity_id === entityId);
      if (!entity || (entity.state === 'on') === request.enabled) return { ...result, enabled: request.enabled };
      await this.transport.routineService('automation', request.enabled ? 'turn_on' : 'turn_off', entityId);
      this.guard(signal);
      await this.transport.refreshStates();
      return { ...result, changed: true, enabled: request.enabled, message: `${result.message} It is ${request.enabled ? 'on' : 'paused'}.` };
    });
  }

  async saveScript(request: ScriptRequest, signal?: AbortSignal) {
    return this.exclusive(signal, () =>
      this.storeRoutine('script', request, (name, snapshot, previous) => compileScript(request, name, snapshot, previous), signal));
  }

  async deleteRoutine(entityId: string, signal?: AbortSignal) {
    return this.exclusive(signal, async () => {
      await this.structure(signal);
      const observed = this.inspectedRoutines.get(entityId);
      if (!observed) throw new Error('Inspect the automation or script before deleting it.');
      const { kind, entity, configId, config } = await this.readRoutineConfig(entityId, signal);
      if (!this.sameRoutine(observed, config)) throw new Error(`The ${kind} changed since it was inspected. Inspect it again before deleting.`);
      const name = nameOf(entity);
      const paused = kind === 'automation' && entity.state === 'off';
      const restore = this.routineUndo(kind, configId, structuredClone(config), undefined);
      const change = this.remember(`Deleted ${kind} ${name}`, async (undoSignal) => {
        await restore(undoSignal);
        if (!paused) return;
        const restored = await this.awaitRoutine(kind, configId, undoSignal);
        if (restored?.state === 'on') await this.transport.routineService('automation', 'turn_off', restored.entity_id);
      }, { kind, id: entityId });
      this.guard(signal);
      await this.dispatch(change, () => this.transport.deleteRoutine(kind, configId));
      if (await this.currentRoutine(kind, configId, signal))
        throw new Error(`Home Assistant has not confirmed deleting this ${kind}. Check change history before retrying.`);
      this.inspectedRoutines.delete(entityId);
      await this.transport.refreshStates();
      await this.structure(signal);
      return { changed: true, demo: this.options.demo, entity_id: entityId, change_id: change.id, message: `${name} deleted${this.options.demo ? ' in the demo home' : ''}. It can be restored from recent setup changes.` };
    });
  }

  private automation(entityId: string): HassEntity {
    const entity = this.transport.getSnapshot().entities.find((item) => item.entity_id === entityId);
    if (!entity || !entityId.startsWith('automation.')) throw new Error('That automation no longer exists. Read the routines again.');
    return entity;
  }

  async setAutomationEnabled(entityId: string, enabled: boolean, signal?: AbortSignal) {
    return this.exclusive(signal, async () => {
      this.guard(signal);
      const entity = this.automation(entityId);
      if (entity.state === 'unavailable') throw new Error(`${nameOf(entity)} is unavailable in Home Assistant.`);
      if ((entity.state === 'on') === enabled) return { changed: false, enabled, message: `${nameOf(entity)} is already ${enabled ? 'on' : 'paused'}.` };
      const settle = async (wanted: boolean, check?: AbortSignal) => {
        for (let attempt = 0; attempt < 5; attempt++) {
          const snapshot = await this.transport.refreshStates();
          this.guard(check);
          if ((snapshot.entities.find((item) => item.entity_id === entityId)?.state === 'on') === wanted) return true;
          if (attempt < 4) await new Promise<void>((resolve) => setTimeout(resolve, 400));
        }
        return false;
      };
      const change = this.remember(`${enabled ? 'Turned on' : 'Paused'} automation ${nameOf(entity)}`, async (undoSignal) => {
        this.guard(undoSignal);
        if ((this.automation(entityId).state === 'on') !== enabled) return;
        await this.transport.routineService('automation', enabled ? 'turn_off' : 'turn_on', entityId);
        if (!await settle(!enabled, undoSignal)) throw new Error('Home Assistant has not confirmed restoring this automation.');
      }, { kind: 'automation', id: entityId });
      await this.dispatch(change, () => this.transport.routineService('automation', enabled ? 'turn_on' : 'turn_off', entityId));
      this.guard(signal);
      if (!await settle(enabled, signal)) throw new Error('Home Assistant has not confirmed the change. Check the automation before retrying.');
      return { changed: true, demo: this.options.demo, entity_id: entityId, enabled, change_id: change.id, message: `${nameOf(entity)} is now ${enabled ? 'on' : 'paused'}.` };
    });
  }

  async runRoutine(entityId: string, signal?: AbortSignal) {
    return this.exclusive(signal, async () => {
      this.guard(signal);
      const { kind, entity } = this.routineRef(entityId, this.transport.getSnapshot());
      if (entity.state === 'unavailable') throw new Error(`${nameOf(entity)} is unavailable in Home Assistant.`);
      await this.transport.routineService(kind, kind === 'automation' ? 'trigger' : 'turn_on', entityId);
      this.guard(signal);
      return {
        accepted: true, verified: false, demo: this.options.demo, entity_id: entityId,
        message: `${nameOf(entity)} started${this.options.demo ? ' in the demo home' : ''}${kind === 'automation' ? ', skipping its conditions' : ''}. Its effect on devices was not checked.`,
      };
    });
  }

  async routineRuns(entityId: string, signal?: AbortSignal) {
    this.guard(signal);
    const { kind, entity, configId } = this.routineRef(entityId, this.transport.getSnapshot());
    const traces = await this.transport.routineTraces(kind, configId);
    this.guard(signal);
    return {
      entity_id: entityId, name: nameOf(entity), demo: this.options.demo,
      ...(kind === 'automation' ? { enabled: entity.state === 'on' } : {}),
      last_triggered: typeof entity.attributes.last_triggered === 'string' ? entity.attributes.last_triggered : null,
      runs: traces.slice(-8).reverse(),
      note: traces.length ? 'Newest first. failed_conditions means it was triggered but a condition stopped it.' : 'Home Assistant has no stored runs for this routine.',
    };
  }

  private helperEntity(domain: HelperDomain, helperId: string, snapshot: HassSnapshot): HassEntity | undefined {
    const entry = snapshot.registry.find((item) => item.platform === domain && item.unique_id === helperId);
    return snapshot.entities.find((item) => item.entity_id === (entry?.entity_id ?? `${domain}.${helperId}`));
  }

  async listHelpers(signal?: AbortSignal) {
    const snapshot = await this.structure(signal);
    const lists = await Promise.all(helperDomains.map(async (domain) => ({ domain, items: await this.transport.listHelpers(domain) })));
    this.guard(signal);
    return {
      demo: this.options.demo,
      helpers: lists.flatMap(({ domain, items }) => items.map(({ id, name, ...settings }) => {
        const entity = this.helperEntity(domain, id, snapshot);
        return { domain, kind: helperLabels[domain], helper_id: id, name, entity_id: entity?.entity_id ?? null, state: entity?.state ?? null, settings };
      })),
    };
  }

  async saveHelper(request: HelperRequest, signal?: AbortSignal) {
    return this.exclusive(signal, async () => {
      const { domain } = request;
      if (!helperDomains.includes(domain)) throw new Error('That kind of helper is not supported.');
      const name = label(request.name);
      await this.structure(signal);
      const existing = await this.transport.listHelpers(domain);
      this.guard(signal);
      const find = async (id: string) => (await this.transport.listHelpers(domain)).find((item) => item.id === id);
      const entityOf = async (id: string) => {
        for (let attempt = 0; attempt < 5; attempt++) {
          await this.transport.refreshStates();
          const entity = this.helperEntity(domain, id, await this.structure(signal));
          if (entity) return entity;
          if (attempt < 4) await new Promise<void>((resolve) => setTimeout(resolve, 400));
          this.guard(signal);
        }
        return undefined;
      };
      if (request.helper_id) {
        const helperId = request.helper_id;
        const previous = existing.find((item) => item.id === helperId);
        if (!previous) throw new Error('That helper no longer exists. Read the helpers again.');
        const next: Record<string, unknown> = { name, ...compileHelper(domain, request.settings, false) };
        const differs = (record: HelperRecord, fields: Record<string, unknown>) => Object.keys(fields).some((key) => canonical(record[key]) !== canonical(fields[key]));
        if (!differs(previous, next)) return { changed: false, helper_id: helperId, message: 'This helper already has those settings.' };
        const before = Object.fromEntries(Object.keys(next).flatMap((key) => previous[key] === undefined ? [] : [[key, previous[key]]]));
        const change = this.remember(`Updated helper ${name}`, async (undoSignal) => {
          this.guard(undoSignal);
          const current = await find(helperId);
          if (!current) throw new Error('This helper no longer exists.');
          if (!differs(current, before)) return;
          if (differs(current, next)) throw new Error('This helper was edited elsewhere. Undo will not overwrite those changes.');
          await this.transport.updateHelper(domain, helperId, before);
          await this.transport.refreshStates();
        }, { kind: 'helper', id: this.helperEntity(domain, helperId, this.transport.getSnapshot())?.entity_id ?? helperId });
        await this.dispatch(change, () => this.transport.updateHelper(domain, helperId, next));
        this.guard(signal);
        const entity = await entityOf(helperId);
        return { changed: true, demo: this.options.demo, domain, helper_id: helperId, entity_id: entity?.entity_id, change_id: change.id, message: `${name} updated.` };
      }
      if (existing.some((item) => item.name.toLocaleLowerCase() === name.toLocaleLowerCase()))
        throw new Error('A helper of this kind already uses that name. Update it, or choose another name.');
      const fields = compileHelper(domain, request.settings, true);
      const created = await this.transport.createHelper(domain, { name, ...fields });
      // Retain the inverse even when Stop arrives after Home Assistant accepted the write.
      const change = this.remember(`Created helper ${name}`, async (undoSignal) => {
        this.guard(undoSignal);
        const current = await find(created.id);
        if (!current) return;
        if (canonical(current) !== canonical(created)) throw new Error('This helper was edited elsewhere. Undo will not remove it.');
        await this.transport.deleteHelper(domain, created.id);
        if (await find(created.id)) throw new Error('Home Assistant has not confirmed removing the helper.');
        await this.transport.refreshStates();
        await this.structure(undoSignal);
      });
      this.guard(signal);
      const entity = await entityOf(created.id);
      if (entity) this.retarget(change, { kind: 'helper', id: entity.entity_id });
      return {
        changed: true, demo: this.options.demo, domain, helper_id: created.id, entity_id: entity?.entity_id, change_id: change.id,
        message: `${name} created${this.options.demo ? ' in the demo home' : ''}.${entity ? ` Routines can use ${entity.entity_id}.` : ''}`,
      };
    });
  }

  async deleteHelper(domain: HelperDomain, helperId: string, signal?: AbortSignal) {
    return this.exclusive(signal, async () => {
      if (!helperDomains.includes(domain)) throw new Error('That kind of helper is not supported.');
      await this.structure(signal);
      const previous = (await this.transport.listHelpers(domain)).find((item) => item.id === helperId);
      this.guard(signal);
      if (!previous) throw new Error('That helper no longer exists. Read the helpers again.');
      const { id: _id, ...fields } = previous;
      const change = this.remember(`Deleted helper ${previous.name}`, async (undoSignal) => {
        this.guard(undoSignal);
        const current = await this.transport.listHelpers(domain);
        if (current.some((item) => item.id === helperId || item.name === previous.name)) return;
        await this.transport.createHelper(domain, fields);
        await this.transport.refreshStates();
        await this.structure(undoSignal);
      });
      await this.dispatch(change, () => this.transport.deleteHelper(domain, helperId));
      this.guard(signal);
      if ((await this.transport.listHelpers(domain)).some((item) => item.id === helperId))
        throw new Error('Home Assistant has not confirmed deleting the helper. Check change history before retrying.');
      await this.transport.refreshStates();
      await this.structure(signal);
      return { changed: true, demo: this.options.demo, domain, helper_id: helperId, change_id: change.id, message: `${previous.name} deleted. Routines that used it need another look.` };
    });
  }

  async undo(changeId: string, signal?: AbortSignal) {
    return this.exclusive(signal, async () => {
      const entry = this.entries.find((item) => item.change.id === changeId);
      if (!entry) throw new Error('This change is no longer available to undo. Read the setup change history again.');
      await entry.undo(signal);
      this.guard(signal);
      this.entries.splice(this.entries.indexOf(entry), 1);
      this.inspectedMoods.clear();
      this.inspectedRoutines.clear();
      this.options.onChange?.();
      return { changed: true, demo: this.options.demo, undone_change_id: changeId, message: `Undone: ${entry.change.description}.` };
    });
  }
}
