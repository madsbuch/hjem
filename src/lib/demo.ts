import type { HassEntity, HassSnapshot } from './home-assistant';
import type { SceneConfig } from './home-setup-types';
import { numberAttribute } from './entities';

const actionNumber = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('A finite number is required.');
  return value;
};
const actionBoolean = (value: unknown): boolean => {
  if (typeof value !== 'boolean') throw new Error('A boolean is required.');
  return value;
};

const entity = (
  id: string,
  name: string,
  state: string,
  attributes: Record<string, unknown> = {},
): HassEntity => ({
  entity_id: id,
  state,
  attributes: { friendly_name: name, ...attributes },
});

const demoResources = [
  ['light.living_pendant', 'Pendant lights', 'living'],
  ['light.reading_lamp', 'Reading lamp', 'living'],
  ['climate.living_room', 'Living room climate', 'living'],
  ['media_player.speaker', 'Living room speaker', 'living'],
  ['media_player.kitchen_sonos', 'Kitchen Sonos', 'kitchen'],
  ['media_player.bedroom_sonos', 'Bedroom Sonos', 'bedroom'],
  ['light.kitchen', 'Kitchen lights', 'kitchen'],
  ['switch.coffee', 'Coffee machine', 'kitchen'],
  ['light.bedside', 'Bedside lamp', 'bedroom'],
  ['cover.bedroom', 'Bedroom blinds', 'bedroom'],
  ['sensor.hallway_temperature', 'Hallway temperature', 'hallway'],
  ['binary_sensor.front_door', 'Front door', 'hallway'],
];

/** Battery-powered remotes; their helper entities stay out of Controls like diagnostics. */
export const demoRemotes: { deviceId: string; name: string; model: string; area: string | null; actions: string[] }[] = [
  { deviceId: 'demo_remote_wireless', name: 'Wireless remote', model: 'Five-button remote', area: null, actions: ['toggle', 'brightness up', 'brightness down', 'arrow left', 'arrow right'] },
  { deviceId: 'demo_remote_dimmer', name: 'Dimmer switch', model: 'Four-button dimmer', area: 'bedroom', actions: ['on', 'off', 'up', 'down'] },
  { deviceId: 'demo_remote_scene', name: 'Scene button', model: 'Single button', area: null, actions: ['single', 'double', 'hold'] },
];
const remoteSlug = (deviceId: string) => deviceId.replace('demo_remote_', 'remote_');
const demoRemoteEntities: { deviceId: string; entity: HassEntity }[] = demoRemotes.flatMap((remote, index) => [
  entity(`event.${remoteSlug(remote.deviceId)}_action`, `${remote.name} action`, 'unknown', {
    device_class: 'button',
    event_types: remote.actions.map((action) => action.replaceAll(' ', '_')),
  }),
  entity(`sensor.${remoteSlug(remote.deviceId)}_battery`, `${remote.name} battery`, String([87, 42, 12][index] ?? 100), {
    device_class: 'battery',
    unit_of_measurement: '%',
  }),
].map((item) => ({ deviceId: remote.deviceId, entity: item })));

export const demoSceneConfigs: Record<string, SceneConfig> = Object.fromEntries(
  [
    ['good_morning', 'Good morning'],
    ['cosy_evening', 'Cosy evening'],
    ['away', 'Heading out'],
    ['good_night', 'Good night'],
  ].map(([id, name]) => {
    const off = id === 'away' || id === 'good_night';
    return [id, {
      id,
      name,
      entities: Object.fromEntries(demoResources
        .filter(([entityId]) => entityId.startsWith('light.') || (off && entityId.startsWith('media_player.')))
        .map(([entityId]) => [entityId, entityId.startsWith('light.')
          ? { state: off ? 'off' : 'on', ...(off ? {} : { brightness: id === 'cosy_evening' ? 90 : 210 }) }
          : { state: 'paused' }])),
    }];
  }),
);

export const demoSnapshot: HassSnapshot = {
  locationName: 'Our home',
  structureStatus: 'ready',
  unitSystem: { temperature: '°C' },
  areas: [
    { area_id: 'living', name: 'Living room' },
    { area_id: 'kitchen', name: 'Kitchen' },
    { area_id: 'bedroom', name: 'Bedroom' },
    { area_id: 'hallway', name: 'Hallway' },
  ],
  devices: [
    ...demoResources.map(([id, name, area_id]) => ({ id: `demo_${id.replace('.', '_')}`, name, area_id })),
    ...demoRemotes.map((remote) => ({ id: remote.deviceId, name: remote.name, area_id: remote.area, manufacturer: 'Demo', model: remote.model })),
  ],
  registry: [
    ...demoResources.map(([entity_id]) => ({
      entity_id,
      area_id: null,
      device_id: `demo_${entity_id.replace('.', '_')}`,
      ...(entity_id.startsWith('media_player.') ? { platform: 'sonos' } : {}),
    })),
    ...demoRemoteEntities.map(({ deviceId, entity: item }) => ({
      entity_id: item.entity_id,
      area_id: null,
      device_id: deviceId,
      ...(item.entity_id.startsWith('sensor.') ? { hidden_by: 'integration' } : {}),
    })),
  ],
  entities: [
    entity('light.living_pendant', 'Pendant lights', 'on', {
      brightness: 178,
      supported_color_modes: ['brightness'],
    }),
    entity('climate.living_room', 'Living room climate', 'heat', {
      temperature: 21,
      current_temperature: 20.5,
      min_temp: 16,
      max_temp: 28,
      target_temp_step: 0.5,
      supported_features: 1,
      hvac_action: 'heating',
    }),
    entity('light.reading_lamp', 'Reading lamp', 'on', {
      brightness: 115,
      supported_color_modes: ['color_temp'],
      color_temp_kelvin: 3000,
      min_color_temp_kelvin: 2200,
      max_color_temp_kelvin: 6500,
    }),
    entity('media_player.speaker', 'Living room speaker', 'playing', {
      media_title: 'A slower kind of Sunday',
      media_artist: 'Your favourite playlist',
      supported_features: 1 | 4 | 8 | 16 | 32 | 16384,
      volume_level: 0.32,
      is_volume_muted: false,
      demo_track: 0,
    }),
    entity('media_player.kitchen_sonos', 'Kitchen Sonos', 'paused', {
      media_title: 'Light through the window',
      media_artist: 'Kitchen playlist',
      supported_features: 1 | 4 | 8 | 16 | 32 | 16384,
      volume_level: 0.22,
      is_volume_muted: false,
      demo_track: 1,
    }),
    entity('media_player.bedroom_sonos', 'Bedroom Sonos', 'idle', {
      media_title: 'Somewhere to stay',
      media_artist: 'Bedroom playlist',
      supported_features: 1 | 4 | 8 | 16 | 32 | 16384,
      volume_level: 0.15,
      is_volume_muted: false,
      demo_track: 2,
    }),
    entity('light.kitchen', 'Kitchen lights', 'off', {
      brightness: 204,
      supported_color_modes: ['brightness'],
    }),
    entity('switch.coffee', 'Coffee machine', 'off'),
    entity('light.bedside', 'Bedside lamp', 'off', {
      brightness: 89,
      supported_color_modes: ['brightness'],
    }),
    entity('cover.bedroom', 'Bedroom blinds', 'open', {
      device_class: 'blind',
      current_position: 70,
      supported_features: 15,
    }),
    entity('sensor.hallway_temperature', 'Hallway temperature', '20.2', {
      unit_of_measurement: '°C',
      device_class: 'temperature',
    }),
    entity('binary_sensor.front_door', 'Front door', 'off', {
      device_class: 'door',
    }),
    entity('weather.home', 'Home weather', 'partlycloudy', {
      temperature: 14,
      temperature_unit: '°C',
    }),
    ...demoRemoteEntities.map((item) => item.entity),
    entity('scene.good_morning', 'Good morning', 'unknown', { id: 'good_morning' }),
    entity('scene.cosy_evening', 'Cosy evening', 'unknown', { id: 'cosy_evening' }),
    entity('scene.away', 'Heading out', 'unknown', { id: 'away' }),
    entity('scene.good_night', 'Good night', 'unknown', { id: 'good_night' }),
  ],
};

export function applyDemoService(
  snapshot: HassSnapshot,
  domain: string,
  service: string,
  id: string,
  data: Record<string, unknown>,
): HassSnapshot {
  const offScene = id === 'scene.away' || id === 'scene.good_night';
  return {
    ...snapshot,
    entities: snapshot.entities.map((e) => {
      if (domain === 'scene') {
        if (e.entity_id.startsWith('light.'))
          return {
            ...e,
            state: offScene ? 'off' : 'on',
            attributes: {
              ...e.attributes,
              brightness: id === 'scene.cosy_evening' ? 90 : 210,
            },
          };
        if (e.entity_id.startsWith('media_player.'))
          return { ...e, state: offScene ? 'paused' : e.state };
        return e;
      }
      if (e.entity_id !== id) return e;
      if (service === 'set_temperature')
        return {
          ...e,
          attributes: { ...e.attributes, temperature: actionNumber(data.temperature) },
        };
      if (service === 'set_cover_position')
        return {
          ...e,
          state: actionNumber(data.position) > 0 ? 'open' : 'closed',
          attributes: { ...e.attributes, current_position: actionNumber(data.position) },
        };
      if (service === 'open_cover' || service === 'close_cover')
        return {
          ...e,
          state: service === 'open_cover' ? 'open' : 'closed',
          attributes: {
            ...e.attributes,
            current_position: service === 'open_cover' ? 100 : 0,
          },
        };
      if (service === 'stop_cover') return e;
      if (service === 'media_play_pause')
        return { ...e, state: e.state === 'playing' ? 'paused' : 'playing' };
      if (service === 'media_play') return { ...e, state: 'playing' };
      if (service === 'media_pause') return { ...e, state: 'paused' };
      if (service === 'volume_set')
        return {
          ...e,
          attributes: {
            ...e.attributes,
            volume_level: Math.max(0, Math.min(1, actionNumber(data.volume_level))),
          },
        };
      if (service === 'volume_mute')
        return {
          ...e,
          attributes: {
            ...e.attributes,
            is_volume_muted: actionBoolean(data.is_volume_muted),
          },
        };
      if (
        service === 'media_next_track' ||
        service === 'media_previous_track'
      ) {
        const tracks = [
          'A slower kind of Sunday',
          'Light through the window',
          'Somewhere to stay',
        ];
        const index =
          (numberAttribute(e, 'demo_track') +
            (service === 'media_next_track' ? 1 : -1) +
            tracks.length) %
          tracks.length;
        return {
          ...e,
          attributes: {
            ...e.attributes,
            media_title: tracks[index],
            demo_track: index,
          },
        };
      }
      return {
        ...e,
        state:
          service === 'turn_on'
            ? 'on'
            : service === 'turn_off'
              ? 'off'
              : e.state === 'on'
                ? 'off'
                : 'on',
        attributes: {
          ...e.attributes,
          ...(data.brightness_pct !== undefined
            ? { brightness: Math.round(actionNumber(data.brightness_pct) * 2.55) }
            : {}),
        },
      };
    }),
  };
}

/** Appliances that "join" the demo home while pairing is open, in order. */
const demoAppliances = [
  { slug: 'new_bulb', name: 'LED bulb E27 806lm', model: 'LED bulb E27 806lm', kind: 'light' },
  { slug: 'new_remote', name: 'Remote control N2', model: 'Remote control N2', kind: 'remote' },
  { slug: 'new_spot', name: 'LED bulb GU10 345lm', model: 'LED bulb GU10 345lm', kind: 'light' },
];

/** Add the next demo appliance, as Home Assistant would after a Zigbee device joins. */
export function joinDemoAppliance(snapshot: HassSnapshot): HassSnapshot {
  const next = demoAppliances.find((item) => !snapshot.devices.some((device) => device.id === `demo_${item.slug}`));
  if (!next) return snapshot;
  const deviceId = `demo_${next.slug}`;
  const entityId = next.kind === 'light' ? `light.${next.slug}` : `event.${next.slug}_action`;
  const joined = next.kind === 'light'
    ? entity(entityId, next.name, 'on', { brightness: 254, supported_color_modes: ['color_temp'], color_temp_kelvin: 2700, min_color_temp_kelvin: 2200, max_color_temp_kelvin: 4000 })
    : entity(entityId, `${next.name} action`, 'unknown', { device_class: 'button', event_types: ['on', 'off', 'brightness_move_up', 'brightness_move_down'] });
  return {
    ...snapshot,
    devices: [...snapshot.devices, { id: deviceId, name: next.name, area_id: null, manufacturer: 'IKEA of Sweden', model: next.model }],
    registry: [...snapshot.registry, { entity_id: entityId, area_id: null, device_id: deviceId, platform: 'zha' }],
    entities: [...snapshot.entities, joined],
  };
}
