import type { HassArea, HassDevice, HassEntity, HassSnapshot } from './home-assistant';
import {
  helperDomains,
  type HelperDomain,
  type HelperRecord,
  type HomeSetupTransport,
  type RoutineConfig,
  type RoutineKind,
  type RoutineService,
  type RoutineTrace,
  type RoutineValidation,
  type SceneConfig,
} from './home-setup-types';
import { applyDemoService, demoHelpers, demoRoutineConfigs, demoSceneConfigs } from './demo';
import { routineParts, slugify } from './home-routines';
import { isEntityId, isRecord } from './home-assistant-protocol';
import { SceneConfigNotFoundError } from './home-assistant-scenes';

/** Keep an entity suffix such as "battery" when its device is renamed. */
function demoEntityName(current: unknown, device: HassDevice, next: string): string {
  const previous = device.name_by_user || device.name || '';
  if (typeof current !== 'string' || !previous || current === previous) return next;
  return current.startsWith(`${previous} `) ? `${next}${current.slice(previous.length)}` : current;
}

interface DemoOptions {
  getSnapshot: () => HassSnapshot;
  setSnapshot: (snapshot: HassSnapshot) => void;
  isCurrent?: () => boolean;
}

/** The same setup operations as HA, confined to the current demo session. */
export class DemoHomeSetupTransport implements HomeSetupTransport {
  private readonly scenes = new Map<string, SceneConfig>(
    Object.entries(demoSceneConfigs).map(([id, config]) => [id, structuredClone(config)]),
  );

  private readonly routines: Record<RoutineKind, Map<string, RoutineConfig>> = {
    automation: new Map(Object.entries(structuredClone(demoRoutineConfigs.automation))),
    script: new Map(Object.entries(structuredClone(demoRoutineConfigs.script))),
  };
  private readonly helpers = new Map<HelperDomain, HelperRecord[]>(
    helperDomains.map((domain) => [domain, structuredClone(demoHelpers[domain] ?? [])]),
  );

  constructor(private readonly options: DemoOptions) {}

  private guard() {
    if (this.options.isCurrent && !this.options.isCurrent())
      throw new Error('The demo home changed. Start a new request.');
  }
  private publish(snapshot: HassSnapshot) {
    this.guard();
    this.options.setSnapshot({ ...snapshot, structureStatus: 'ready', structureError: undefined });
  }
  getSnapshot(): HassSnapshot { this.guard(); return this.options.getSnapshot(); }
  async refreshStructure(): Promise<HassSnapshot> { return this.getSnapshot(); }
  async refreshStates(): Promise<HassSnapshot> { return this.getSnapshot(); }

  async createArea(name: string): Promise<HassArea> {
    const snapshot = this.getSnapshot();
    const area = { area_id: `room_${crypto.randomUUID().replaceAll('-', '')}`, name };
    this.publish({ ...snapshot, areas: [...snapshot.areas, area] });
    return area;
  }
  async renameArea(areaId: string, name: string): Promise<HassArea> {
    const snapshot = this.getSnapshot();
    const area = snapshot.areas.find((item) => item.area_id === areaId);
    if (!area) throw new Error('The demo room no longer exists.');
    const changed = { ...area, name };
    this.publish({ ...snapshot, areas: snapshot.areas.map((item) => item.area_id === areaId ? changed : item) });
    return changed;
  }
  async deleteArea(areaId: string): Promise<void> {
    const snapshot = this.getSnapshot();
    this.publish({
      ...snapshot,
      areas: snapshot.areas.filter((item) => item.area_id !== areaId),
      devices: snapshot.devices.map((item) => item.area_id === areaId ? { ...item, area_id: null } : item),
      registry: snapshot.registry.map((item) => item.area_id === areaId ? { ...item, area_id: null } : item),
    });
  }
  async assignDeviceArea(deviceId: string, areaId: string | null): Promise<void> {
    const snapshot = this.getSnapshot();
    if (!snapshot.devices.some((item) => item.id === deviceId)) throw new Error('The demo device no longer exists.');
    if (areaId !== null && !snapshot.areas.some((item) => item.area_id === areaId)) throw new Error('The demo room no longer exists.');
    this.publish({ ...snapshot, devices: snapshot.devices.map((item) => item.id === deviceId ? { ...item, area_id: areaId } : item) });
  }
  async assignEntityArea(entityId: string, areaId: string | null): Promise<void> {
    const snapshot = this.getSnapshot();
    if (!snapshot.registry.some((item) => item.entity_id === entityId)) throw new Error('The demo entity no longer exists.');
    if (areaId !== null && !snapshot.areas.some((item) => item.area_id === areaId)) throw new Error('The demo room no longer exists.');
    this.publish({ ...snapshot, registry: snapshot.registry.map((item) => item.entity_id === entityId ? { ...item, area_id: areaId } : item) });
  }
  async renameDevice(deviceId: string, name: string | null): Promise<void> {
    const snapshot = this.getSnapshot();
    const device = snapshot.devices.find((item) => item.id === deviceId);
    if (!device) throw new Error('The demo device no longer exists.');
    const shown = name ?? device.name ?? deviceId;
    // Like Home Assistant, entities without their own name follow the device name.
    const following = new Set(snapshot.registry
      .filter((entry) => entry.device_id === deviceId && !entry.name)
      .map((entry) => entry.entity_id));
    this.publish({
      ...snapshot,
      devices: snapshot.devices.map((item) => item.id === deviceId ? { ...item, name_by_user: name } : item),
      entities: snapshot.entities.map((entity) => following.has(entity.entity_id)
        ? { ...entity, attributes: { ...entity.attributes, friendly_name: demoEntityName(entity.attributes.friendly_name, device, shown) } }
        : entity),
    });
  }
  async renameEntity(entityId: string, name: string | null): Promise<void> {
    const snapshot = this.getSnapshot();
    const entry = snapshot.registry.find((item) => item.entity_id === entityId);
    if (!entry) throw new Error('The demo entity no longer exists.');
    const device = snapshot.devices.find((item) => item.id === entry.device_id);
    const shown = name ?? entry.original_name ?? device?.name_by_user ?? device?.name ?? entityId;
    this.publish({
      ...snapshot,
      registry: snapshot.registry.map((item) => item.entity_id === entityId ? { ...item, name } : item),
      entities: snapshot.entities.map((entity) => entity.entity_id === entityId
        ? { ...entity, attributes: { ...entity.attributes, friendly_name: shown } }
        : entity),
    });
  }
  async readScene(configId: string): Promise<SceneConfig> {
    this.guard();
    const config = this.scenes.get(configId);
    if (!config) throw new SceneConfigNotFoundError();
    return structuredClone(config);
  }
  async saveScene(configId: string, config: SceneConfig): Promise<void> {
    const snapshot = this.getSnapshot();
    this.scenes.set(configId, structuredClone({ ...config, id: configId }));
    const existing = snapshot.entities.find((entity) => entity.entity_id.startsWith('scene.') && entity.attributes.id === configId);
    const entity = existing
      ? { ...existing, attributes: { ...existing.attributes, friendly_name: config.name, id: configId } }
      : { entity_id: `scene.${configId.toLowerCase()}`, state: 'unknown', attributes: { friendly_name: config.name, id: configId } };
    this.publish({
      ...snapshot,
      entities: existing ? snapshot.entities.map((item) => item.entity_id === existing.entity_id ? entity : item) : [...snapshot.entities, entity],
    });
  }
  async deleteScene(configId: string): Promise<void> {
    const snapshot = this.getSnapshot();
    this.scenes.delete(configId);
    const ids = new Set(snapshot.entities.filter((item) => item.entity_id.startsWith('scene.') && item.attributes.id === configId).map((item) => item.entity_id));
    this.publish({ ...snapshot, entities: snapshot.entities.filter((item) => !ids.has(item.entity_id)), registry: snapshot.registry.filter((item) => !ids.has(item.entity_id)) });
  }
  async relatedToArea(_areaId: string): Promise<Record<string, string[]>> {
    this.guard();
    // Demo moods target specific entities, and there are no area-targeted routines.
    return {};
  }
  async activateScene(entityId: string): Promise<void> {
    const snapshot = this.getSnapshot();
    const scene = snapshot.entities.find((item) => item.entity_id === entityId);
    const configId = scene?.attributes.id;
    if (typeof configId !== 'string') throw new Error('The demo mood cannot be found.');
    const config = this.scenes.get(configId);
    if (!config) throw new Error('The demo mood cannot be found.');
    this.publish({
      ...snapshot,
      entities: snapshot.entities.map((entity) => {
        if (entity.entity_id === entityId) return { ...entity, state: new Date().toISOString() };
        const target = config.entities[entity.entity_id];
        if (target === undefined || entity.state === 'unavailable') return entity;
        if (typeof target === 'string') return { ...entity, state: target };
        const { state, ...attributes } = target;
        const mode = attributes.hs_color !== undefined ? { color_mode: 'hs' } : attributes.color_temp_kelvin !== undefined ? { color_mode: 'color_temp' } : {};
        return { ...entity, state, attributes: { ...entity.attributes, ...attributes, ...mode } };
      }),
    });
  }

  async setEntityHidden(entityId: string, hidden: boolean): Promise<void> {
    const snapshot = this.getSnapshot();
    if (!snapshot.registry.some((item) => item.entity_id === entityId)) throw new Error('The demo entity no longer exists.');
    this.publish({ ...snapshot, registry: snapshot.registry.map((item) => item.entity_id === entityId ? { ...item, hidden_by: hidden ? 'user' : null } : item) });
  }

  private routineEntity(kind: RoutineKind, configId: string, snapshot: HassSnapshot): HassEntity | undefined {
    return snapshot.entities.find((entity) => entity.entity_id.startsWith(`${kind}.`) &&
      (kind === 'automation' ? entity.attributes.id === configId : entity.entity_id === `script.${configId}`));
  }
  async readRoutine(kind: RoutineKind, configId: string): Promise<RoutineConfig> {
    this.guard();
    const config = this.routines[kind].get(configId);
    if (!config) throw new SceneConfigNotFoundError(kind);
    return structuredClone(config);
  }
  async saveRoutine(kind: RoutineKind, configId: string, config: RoutineConfig): Promise<void> {
    const snapshot = this.getSnapshot();
    this.routines[kind].set(configId, structuredClone(config));
    const name = typeof config.alias === 'string' ? config.alias : configId;
    const existing = this.routineEntity(kind, configId, snapshot);
    if (existing) {
      this.publish({ ...snapshot, entities: snapshot.entities.map((item) => item === existing
        ? { ...item, attributes: { ...item.attributes, friendly_name: name, mode: config.mode } } : item) });
      return;
    }
    const base = kind === 'script' ? configId : slugify(name) || configId;
    let entityId = `${kind}.${base}`;
    for (let suffix = 2; snapshot.entities.some((item) => item.entity_id === entityId); suffix++) entityId = `${kind}.${base}_${suffix}`;
    this.publish({
      ...snapshot,
      entities: [...snapshot.entities, {
        entity_id: entityId,
        state: kind === 'automation' ? 'on' : 'off',
        attributes: { friendly_name: name, ...(kind === 'automation' ? { id: configId } : {}), last_triggered: null, mode: config.mode },
      }],
      registry: [...snapshot.registry, { entity_id: entityId, area_id: null, device_id: null, platform: kind, unique_id: configId }],
    });
  }
  async deleteRoutine(kind: RoutineKind, configId: string): Promise<void> {
    const snapshot = this.getSnapshot();
    if (!this.routines[kind].delete(configId)) throw new SceneConfigNotFoundError(kind);
    const entity = this.routineEntity(kind, configId, snapshot);
    if (!entity) return;
    this.publish({
      ...snapshot,
      entities: snapshot.entities.filter((item) => item !== entity),
      registry: snapshot.registry.filter((item) => item.entity_id !== entity.entity_id),
    });
  }
  async validateRoutine(): Promise<RoutineValidation> {
    this.guard();
    return { checked: false, errors: [] };
  }
  async deviceTriggers(_deviceId: string): Promise<Record<string, unknown>[]> {
    this.guard();
    // Demo remotes report presses through their event entities.
    return [];
  }
  async routineTraces(_kind: RoutineKind, _configId: string): Promise<RoutineTrace[]> {
    this.guard();
    return [];
  }
  async routineService(kind: RoutineKind, service: RoutineService, entityId: string): Promise<void> {
    const snapshot = this.getSnapshot();
    const entity = snapshot.entities.find((item) => item.entity_id === entityId && entityId.startsWith(`${kind}.`));
    if (!entity) throw new Error('The demo routine cannot be found.');
    if (kind === 'automation' && service !== 'trigger') {
      this.publish({ ...snapshot, entities: snapshot.entities.map((item) => item === entity ? { ...item, state: service === 'turn_on' ? 'on' : 'off' } : item) });
      return;
    }
    this.publish({ ...snapshot, entities: snapshot.entities.map((item) => item === entity
      ? { ...item, attributes: { ...item.attributes, last_triggered: new Date().toISOString() } } : item) });
    const configId = kind === 'automation' ? entity.attributes.id : entityId.slice('script.'.length);
    const config = typeof configId === 'string' ? this.routines[kind].get(configId) : undefined;
    if (config) await this.play(routineParts(kind, config).actions);
  }
  /** Carry out the plain device steps of a demo routine; anything else is skipped. */
  private async play(actions: Record<string, unknown>[]): Promise<void> {
    for (const step of actions) {
      const service = typeof step.action === 'string' ? step.action : typeof step.service === 'string' ? step.service : '';
      const [domain = '', name = ''] = service.split('.');
      const target = isRecord(step.target) ? step.target.entity_id : step.entity_id;
      const ids = (Array.isArray(target) ? target : [target]).filter(isEntityId);
      const data = isRecord(step.data) ? step.data : {};
      for (const id of ids) {
        try {
          if (domain === 'scene') await this.activateScene(id);
          else if (['light', 'switch', 'fan', 'input_boolean', 'cover', 'media_player'].includes(domain))
            this.publish(applyDemoService(this.getSnapshot(), domain, name, id, data));
        } catch {
          // A step the demo cannot play is left out, as an unavailable device would be.
        }
      }
    }
  }

  private helperList(domain: HelperDomain): HelperRecord[] {
    return this.helpers.get(domain) ?? [];
  }
  async listHelpers(domain: HelperDomain): Promise<HelperRecord[]> {
    this.guard();
    return structuredClone(this.helperList(domain));
  }
  async createHelper(domain: HelperDomain, fields: Record<string, unknown>): Promise<HelperRecord> {
    const snapshot = this.getSnapshot();
    const name = typeof fields.name === 'string' ? fields.name : 'Helper';
    const base = slugify(name) || 'helper';
    let id = base;
    for (let suffix = 2; snapshot.entities.some((item) => item.entity_id === `${domain}.${id}`); suffix++) id = `${base}_${suffix}`;
    const helper: HelperRecord = { ...structuredClone(fields), id, name };
    this.helpers.set(domain, [...this.helperList(domain), helper]);
    const options = Array.isArray(fields.options) ? fields.options : [];
    const state = domain === 'input_boolean' ? 'off'
      : domain === 'input_number' ? String(fields.min ?? 0)
        : domain === 'input_select' ? String(options[0] ?? '')
          : domain === 'input_datetime' ? (fields.has_time ? '00:00:00' : '2026-01-01')
            : domain === 'counter' ? String(fields.initial ?? 0)
              : domain === 'timer' ? 'idle' : domain === 'input_text' ? '' : 'unknown';
    this.publish({
      ...snapshot,
      entities: [...snapshot.entities, { entity_id: `${domain}.${id}`, state, attributes: { friendly_name: name } }],
      registry: [...snapshot.registry, { entity_id: `${domain}.${id}`, area_id: null, device_id: null, platform: domain, unique_id: id }],
    });
    return structuredClone(helper);
  }
  async updateHelper(domain: HelperDomain, helperId: string, fields: Record<string, unknown>): Promise<HelperRecord> {
    const snapshot = this.getSnapshot();
    const previous = this.helperList(domain).find((item) => item.id === helperId);
    if (!previous) throw new Error('The demo helper no longer exists.');
    const name = typeof fields.name === 'string' ? fields.name : previous.name;
    const helper: HelperRecord = { ...previous, ...structuredClone(fields), id: helperId, name };
    this.helpers.set(domain, this.helperList(domain).map((item) => item.id === helperId ? helper : item));
    this.publish({ ...snapshot, entities: snapshot.entities.map((item) => item.entity_id === `${domain}.${helperId}`
      ? { ...item, attributes: { ...item.attributes, friendly_name: name } } : item) });
    return structuredClone(helper);
  }
  async deleteHelper(domain: HelperDomain, helperId: string): Promise<void> {
    const snapshot = this.getSnapshot();
    this.helpers.set(domain, this.helperList(domain).filter((item) => item.id !== helperId));
    this.publish({
      ...snapshot,
      entities: snapshot.entities.filter((item) => item.entity_id !== `${domain}.${helperId}`),
      registry: snapshot.registry.filter((item) => item.entity_id !== `${domain}.${helperId}`),
    });
  }
}
