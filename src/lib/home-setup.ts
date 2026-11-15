import type { HassArea, HassEntity, HassSnapshot } from './home-assistant';
import { domainOf, isUnavailable, nameOf, roomFor, supports, supportsBrightness } from './entities';
import { SceneConfigNotFoundError, SceneRequestError } from './home-assistant-scenes';
import type {
  HomeSetup,
  HomeSetupTransport,
  MoodTarget,
  SaveMoodRequest,
  SceneConfig,
  SceneEntityState,
  SetupChange,
} from './home-setup-types';

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
  private remember(description: string, undo: UndoEntry['undo']): SetupChange {
    const change = { id: crypto.randomUUID(), description, createdAt: new Date().toISOString() };
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
      });
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
      });
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
      });
      await this.dispatch(change, () => write(areaId));
      const after = await this.structure(signal);
      const result = kind === 'device' ? after.devices.find((item) => item.id === id) : after.registry.find((item) => item.entity_id === id);
      if (!result || result.area_id !== areaId) throw new Error('Home Assistant has not confirmed the assignment. Check change history before retrying.');
      return { changed: true, demo: this.options.demo, kind, id, area_id: areaId, change_id: change.id, related_routines: related, message: `${resourceName} assigned to ${area?.name || (kind === 'entity' ? 'its device room' : 'no room')}.` };
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
      });
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
      if (scene) this.inspectedMoods.set(scene.entity_id, structuredClone(readBack));
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

  async undo(changeId: string, signal?: AbortSignal) {
    return this.exclusive(signal, async () => {
      const entry = this.entries.find((item) => item.change.id === changeId);
      if (!entry) throw new Error('This change is no longer available to undo. Read the setup change history again.');
      await entry.undo(signal);
      this.guard(signal);
      this.entries.splice(this.entries.indexOf(entry), 1);
      this.inspectedMoods.clear();
      this.options.onChange?.();
      return { changed: true, demo: this.options.demo, undone_change_id: changeId, message: `Undone: ${entry.change.description}.` };
    });
  }
}
