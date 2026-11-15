import type { HassEntity, HassSnapshot } from './home-assistant';

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

export const demoSnapshot: HassSnapshot = {
  locationName: 'Our home',
  unitSystem: { temperature: '°C' },
  areas: [
    { area_id: 'living', name: 'Living room' },
    { area_id: 'kitchen', name: 'Kitchen' },
    { area_id: 'bedroom', name: 'Bedroom' },
    { area_id: 'hallway', name: 'Hallway' },
  ],
  devices: [],
  registry: [
    ['light.living_pendant', 'living'],
    ['light.reading_lamp', 'living'],
    ['climate.living_room', 'living'],
    ['media_player.speaker', 'living'],
    ['light.kitchen', 'kitchen'],
    ['switch.coffee', 'kitchen'],
    ['light.bedside', 'bedroom'],
    ['cover.bedroom', 'bedroom'],
    ['sensor.hallway_temperature', 'hallway'],
    ['binary_sensor.front_door', 'hallway'],
  ].map(([entity_id, area_id]) => ({
    entity_id,
    area_id,
    device_id: null,
    ...(entity_id === 'media_player.speaker' ? { platform: 'sonos' } : {}),
  })),
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
      supported_color_modes: ['brightness'],
    }),
    entity('media_player.speaker', 'Living room speaker', 'playing', {
      media_title: 'A slower kind of Sunday',
      media_artist: 'Your favourite playlist',
      supported_features: 1 | 4 | 8 | 16 | 32 | 16384,
      volume_level: 0.32,
      is_volume_muted: false,
      demo_track: 0,
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
    entity('scene.good_morning', 'Good morning', 'scening'),
    entity('scene.cosy_evening', 'Cosy evening', 'scening'),
    entity('scene.away', 'Heading out', 'scening'),
    entity('scene.good_night', 'Good night', 'scening'),
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
          attributes: { ...e.attributes, temperature: data.temperature },
        };
      if (service === 'set_cover_position')
        return {
          ...e,
          state: Number(data.position) > 0 ? 'open' : 'closed',
          attributes: { ...e.attributes, current_position: data.position },
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
      if (service === 'volume_set')
        return {
          ...e,
          attributes: {
            ...e.attributes,
            volume_level: Math.max(0, Math.min(1, Number(data.volume_level))),
          },
        };
      if (service === 'volume_mute')
        return {
          ...e,
          attributes: {
            ...e.attributes,
            is_volume_muted: Boolean(data.is_volume_muted),
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
          (Number(e.attributes.demo_track || 0) +
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
            ? { brightness: Math.round(Number(data.brightness_pct) * 2.55) }
            : {}),
        },
      };
    }),
  };
}
