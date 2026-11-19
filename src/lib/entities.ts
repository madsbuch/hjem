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

export function roomFor(entity: HassEntity, snapshot: HassSnapshot): string | null {
  const registration = snapshot.registry.find(
    (item) => item.entity_id === entity.entity_id,
  );
  const area =
    registration?.area_id ||
    snapshot.devices.find((device) => device.id === registration?.device_id)
      ?.area_id;
  return area || null;
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

const colorModes = ['hs', 'xy', 'rgb', 'rgbw', 'rgbww'];
const modesOf = (entity: HassEntity): string[] =>
  Array.isArray(entity.attributes.supported_color_modes)
    ? entity.attributes.supported_color_modes.filter((mode: unknown): mode is string => typeof mode === 'string') : [];
/** The light can show colours, not only shades of white. */
export const supportsColor = (entity: HassEntity) => modesOf(entity).some((mode) => colorModes.includes(mode));
/** The light can move between warm and cool white. */
export const supportsColorTemperature = (entity: HassEntity) => modesOf(entity).includes('color_temp');
/** The warmest and coolest white a light reports, in kelvin. */
export function whiteRange(entity: HassEntity): [number, number] {
  const low = numberAttribute(entity, 'min_color_temp_kelvin', 2200);
  const high = numberAttribute(entity, 'max_color_temp_kelvin', 6500);
  return low < high ? [low, high] : [2200, 6500];
}

/** A fully bright colour for a hue (0–360) and saturation (0–100), as red, green, blue. */
export function hsToRgb(hue: number, saturation: number): [number, number, number] {
  const s = Math.max(0, Math.min(100, saturation)) / 100;
  const h = ((hue % 360) + 360) % 360 / 60;
  const x = 1 - Math.abs(h % 2 - 1);
  const [r, g, b] = h < 1 ? [1, x, 0] : h < 2 ? [x, 1, 0] : h < 3 ? [0, 1, x] : h < 4 ? [0, x, 1] : h < 5 ? [x, 0, 1] : [1, 0, x];
  const channel = (value: number) => Math.round((1 - s + s * value) * 255);
  return [channel(r), channel(g), channel(b)];
}
/** Roughly what a white of this many kelvin looks like: amber when warm, bluish when cool. */
export function kelvinToCss(kelvin: number): string {
  const t = Math.max(0, Math.min(1, (kelvin - 2000) / 4500));
  const mix = (warm: number, cool: number) => Math.round(warm + (cool - warm) * t);
  return `rgb(${mix(255, 214)}, ${mix(176, 228)}, ${mix(92, 255)})`;
}
const pair = (value: unknown): [number, number] | null =>
  Array.isArray(value) && value.length === 2 && typeof value[0] === 'number' && typeof value[1] === 'number' ? [value[0], value[1]] : null;
/** The hue and saturation a light is showing, when it is showing a colour. */
export function colorOf(entity: HassEntity): [number, number] | null {
  return entity.attributes.color_mode === 'color_temp' ? null : pair(entity.attributes.hs_color);
}
/** The colour a light is showing now, for a small swatch. */
export function lightColorCss(entity: HassEntity): string {
  const color = colorOf(entity);
  if (color) {
    const [r, g, b] = hsToRgb(color[0], color[1]);
    return `rgb(${r}, ${g}, ${b})`;
  }
  return kelvinToCss(numberAttribute(entity, 'color_temp_kelvin', 2700));
}
/** Colours offered as one tap; hue and saturation as Home Assistant takes them. */
export const colorPresets: { name: string; hue: number; saturation: number }[] = [
  { name: 'Red', hue: 0, saturation: 100 },
  { name: 'Orange', hue: 28, saturation: 100 },
  { name: 'Yellow', hue: 52, saturation: 90 },
  { name: 'Green', hue: 120, saturation: 100 },
  { name: 'Turquoise', hue: 175, saturation: 100 },
  { name: 'Blue', hue: 225, saturation: 100 },
  { name: 'Purple', hue: 275, saturation: 100 },
  { name: 'Pink', hue: 325, saturation: 75 },
];
/** The closest everyday name for a hue and saturation. */
export function colorName(hue: number, saturation: number): string {
  if (saturation < 15) return 'White';
  const distance = (first: number, second: number) => Math.min(Math.abs(first - second), 360 - Math.abs(first - second));
  return [...colorPresets].sort((first, second) => distance(first.hue, hue) - distance(second.hue, hue))[0]?.name ?? 'Colour';
}
