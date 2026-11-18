import type { HassArea, HassDevice, HassSnapshot } from './home-assistant';
import type { HomeSetupTransport, SceneConfig } from './home-setup-types';
import { demoSceneConfigs } from './demo';
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
        return { ...entity, state, attributes: { ...entity.attributes, ...attributes } };
      }),
    });
  }
}
