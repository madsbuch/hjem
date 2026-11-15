import type { HassEntity, HassSnapshot } from './home-assistant';

export const domainOf = (entity: HassEntity) => entity.entity_id.split('.')[0];
export const nameOf = (entity: HassEntity) => String(entity.attributes.friendly_name || entity.entity_id.split('.')[1].replaceAll('_', ' '));
export const isUnavailable = (entity: HassEntity) => ['unavailable', 'unknown'].includes(entity.state);
export const isActive = (entity: HassEntity) => !['off', 'idle', 'paused', 'standby', 'closed', 'unavailable', 'unknown'].includes(entity.state);
export const supports = (entity: HassEntity, flag: number) => (Number(entity.attributes.supported_features || 0) & flag) !== 0;
export const supportsBrightness = (entity: HassEntity) => Array.isArray(entity.attributes.supported_color_modes) && entity.attributes.supported_color_modes.some((mode: string) => !['onoff', 'unknown'].includes(mode));

export function roomFor(entity: HassEntity, snapshot: HassSnapshot): string {
  const registration = snapshot.registry.find((item) => item.entity_id === entity.entity_id);
  const area = registration?.area_id || snapshot.devices.find((device) => device.id === registration?.device_id)?.area_id;
  return area || 'unassigned';
}

export function visibleEntities(snapshot: HassSnapshot): HassEntity[] {
  const domains = ['light', 'switch', 'input_boolean', 'fan', 'climate', 'cover', 'media_player', 'sensor', 'binary_sensor'];
  return snapshot.entities.filter((entity) => {
    const reg = snapshot.registry.find((item) => item.entity_id === entity.entity_id);
    return domains.includes(domainOf(entity)) && !reg?.hidden_by && !reg?.disabled_by;
  });
}

export function readPreference<T>(key: string, fallback: T): T {
  try { const value = localStorage.getItem(key); return value ? JSON.parse(value) as T : fallback; } catch { return fallback; }
}
export function savePreference(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Preferences are optional when storage is disabled. */ }
}
