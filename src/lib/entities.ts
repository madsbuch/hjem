import type { HassEntity, HassSnapshot } from './home-assistant';

export const domainOf = (entity: HassEntity) => entity.entity_id.split('.')[0] ?? '';
export function textAttribute(entity: HassEntity, key: string, fallback = ''): string {
  const value = entity.attributes[key];
  return typeof value === 'string' ? value : fallback;
}
export function numberAttribute(entity: HassEntity, key: string, fallback = 0): number {
  const value = entity.attributes[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
export const nameOf = (entity: HassEntity) => textAttribute(entity, 'friendly_name') ||
  (entity.entity_id.split('.')[1] ?? entity.entity_id).replaceAll('_', ' ');
export const isUnavailable = (entity: HassEntity) =>
  ['unavailable', 'unknown'].includes(entity.state);
export const isActive = (entity: HassEntity) =>
  ![
    'off',
    'idle',
    'paused',
    'standby',
    'closed',
    'unavailable',
    'unknown',
  ].includes(entity.state);
export const supports = (entity: HassEntity, flag: number) =>
  (numberAttribute(entity, 'supported_features') & flag) !== 0;
export const supportsBrightness = (entity: HassEntity) =>
  Array.isArray(entity.attributes.supported_color_modes) &&
  entity.attributes.supported_color_modes.some(
    (mode: unknown) => typeof mode === 'string' && !['onoff', 'unknown'].includes(mode),
  );

export function roomFor(entity: HassEntity, snapshot: HassSnapshot): string {
  const registration = snapshot.registry.find(
    (item) => item.entity_id === entity.entity_id,
  );
  const area =
    registration?.area_id ||
    snapshot.devices.find((device) => device.id === registration?.device_id)
      ?.area_id;
  return area || 'unassigned';
}

export function visibleEntities(snapshot: HassSnapshot): HassEntity[] {
  const domains = [
    'light',
    'switch',
    'input_boolean',
    'fan',
    'climate',
    'cover',
    'media_player',
    'sensor',
    'binary_sensor',
  ];
  return snapshot.entities.filter((entity) => {
    const reg = snapshot.registry.find(
      (item) => item.entity_id === entity.entity_id,
    );
    return (
      domains.includes(domainOf(entity)) && !reg?.hidden_by && !reg?.disabled_by
    );
  });
}
