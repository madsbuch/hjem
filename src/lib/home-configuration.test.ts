import { describe, expect, it } from 'vitest';
import { demoSnapshot } from './demo';
import { DemoHomeSetupTransport } from './demo-home-setup';
import type { HassSnapshot } from './home-assistant';
import { HomeSetupManager } from './home-setup';
import {
  applyImport,
  buildConfiguration,
  deviceKey,
  exportMoods,
  parseConfiguration,
  planImport,
  resolveReferences,
  type ExportedSettings,
} from './home-configuration';

/** The demo reading lamp's IEEE address. */
const lampKey = 'zigbee:001788010b114e9a';
const settings: ExportedSettings = {
  theme: 'dark',
  calendars: [{ name: 'Family', url: 'https://calendar.example.test/family.ics' }],
  favourites: [{ device: lampKey, entity_id: 'light.reading_lamp' }],
  selected_speaker: null,
  hidden_apps: ['com.example.unused'],
  pinned_apps: [],
  concierge_model: 'fixture/model',
};
const home = (): HassSnapshot => structuredClone(demoSnapshot);
function manager(initial: HassSnapshot) {
  let snapshot = initial;
  const transport = new DemoHomeSetupTransport({ getSnapshot: () => snapshot, setSnapshot: (value) => { snapshot = value; } });
  return { setup: new HomeSetupManager({ transport, demo: true, isCurrent: () => true }), snapshot: () => snapshot };
}

/** The same hardware on a fresh Home Assistant: new internal IDs, default names, no rooms. */
function freshServer(previous: HassSnapshot): HassSnapshot {
  const devices = previous.devices.map((device, index) => ({ ...device, id: `new-${index}`, area_id: null, name_by_user: null }));
  const deviceId = (old: string | null) => devices[previous.devices.findIndex((device) => device.id === old)]?.id ?? null;
  return {
    ...previous,
    areas: [{ area_id: 'kitchen_new', name: 'Kitchen' }],
    devices,
    // The reading lamp's entity ID changes, as it can when re-paired.
    registry: previous.registry.map((entry) => ({ ...entry, entity_id: entry.entity_id === 'light.reading_lamp' ? 'light.lamp_2' : entry.entity_id, device_id: deviceId(entry.device_id), area_id: null, name: null })),
    entities: previous.entities
      .filter((entity) => !entity.entity_id.startsWith('scene.'))
      .map((entity) => entity.entity_id === 'light.reading_lamp' ? { ...entity, entity_id: 'light.lamp_2' } : entity),
  };
}

describe('device identity', () => {
  it('prefers the Zigbee IEEE address from ZHA, Zigbee2MQTT, or the connection', () => {
    const base = { id: 'x', area_id: null };
    expect(deviceKey({ ...base, connections: [['zigbee', '00:17:88:01:0B:10:4E:9A']] })).toBe('zigbee:001788010b104e9a');
    expect(deviceKey({ ...base, identifiers: [['zha', '00:17:88:01:0b:10:4e:9a']] })).toBe('zigbee:001788010b104e9a');
    expect(deviceKey({ ...base, identifiers: [['mqtt', 'zigbee2mqtt_0x001788010b104e9a']] })).toBe('zigbee:001788010b104e9a');
    expect(deviceKey({ ...base, identifiers: [['sonos', 'RINCON_1']] })).toBe('sonos:RINCON_1');
    expect(deviceKey({ ...base, name: 'Kettle' })).toBe('name:kettle');
  });
});

describe('exporting and importing', () => {
  it('round-trips through a file without credentials and rejects foreign files', async () => {
    const { setup, snapshot } = manager(home());
    await setup.renameDevice('demo_light_reading_lamp', 'Desk lamp');
    const { moods, skipped } = await exportMoods(setup, snapshot());
    expect(skipped).toEqual([]);
    expect(moods.map((mood) => mood.name)).toEqual(['Good morning', 'Cosy evening', 'Heading out', 'Good night']);
    const configuration = buildConfiguration(snapshot(), moods, settings, new Date('2026-11-18T12:00:00Z'));
    const text = JSON.stringify(configuration);
    expect(text).not.toMatch(/token|api_key|apiKey/i);
    expect(parseConfiguration(text)).toEqual(configuration);
    expect(configuration.devices.find((device) => device.key === lampKey)).toMatchObject({ name: 'Desk lamp', room: 'Living room' });

    expect(() => parseConfiguration('{"hello":1}')).toThrow('not a Hjem configuration');
    expect(() => parseConfiguration('not json')).toThrow('not a Hjem configuration');
    expect(() => parseConfiguration(JSON.stringify({ ...configuration, version: 2 }))).toThrow('newer version');
    const tampered = parseConfiguration(JSON.stringify({ ...configuration, rooms: ['Ok', 42, 'Bad\u0000'], devices: [{ key: 7 }, ...configuration.devices] }));
    expect(tampered.rooms).toEqual(['Ok']);
    expect(tampered.devices).toHaveLength(configuration.devices.length);
  });

  it('restores names, rooms, and moods on a new server by hardware identity', async () => {
    const before = manager(home());
    await before.setup.renameDevice('demo_light_reading_lamp', 'Desk lamp');
    await before.setup.renameEntity('light.kitchen', 'Island pendants');
    const { moods } = await exportMoods(before.setup, before.snapshot());
    const configuration = parseConfiguration(JSON.stringify(buildConfiguration(before.snapshot(), moods, settings)));

    const fresh = freshServer(before.snapshot());
    // One remote has not been paired on the new server yet.
    fresh.devices = fresh.devices.filter((device) => device.name !== 'Dimmer switch');
    const plan = planImport(configuration, fresh);
    expect(plan.roomsToCreate).toEqual(['Living room', 'Bedroom', 'Hallway']);
    expect(plan.unmatched.map((device) => device.default_name)).toEqual(['Dimmer switch']);
    expect(plan.renames).toContainEqual(expect.objectContaining({ kind: 'device', name: 'Desk lamp' }));
    expect(plan.renames).toContainEqual(expect.objectContaining({ kind: 'entity', id: 'light.kitchen', name: 'Island pendants' }));
    const cosy = plan.moods.find((mood) => mood.name === 'Cosy evening');
    expect(cosy?.targets.map((target) => target.entity_id)).toContain('light.lamp_2');
    expect(resolveReferences(settings.favourites, fresh)).toEqual(['light.lamp_2']);

    const after = manager(fresh);
    const progress: number[] = [];
    const result = await applyImport(plan, after.setup, after.snapshot, (step) => progress.push(step.done));
    expect(result.failures).toEqual([]);
    expect(progress.at(-1)).toBe(result.applied);
    const restored = after.snapshot();
    const lamp = restored.devices.find((device) => deviceKey(device) === lampKey);
    expect(lamp).toMatchObject({ name_by_user: 'Desk lamp' });
    expect(restored.areas.find((area) => area.area_id === lamp?.area_id)?.name).toBe('Living room');
    expect(restored.entities.filter((entity) => entity.entity_id.startsWith('scene.')).map((entity) => entity.attributes.friendly_name))
      .toEqual(['Good morning', 'Cosy evening', 'Heading out', 'Good night']);

    // Importing again is safe: everything already matches.
    const again = planImport(configuration, restored);
    expect([again.roomsToCreate, again.renames, again.rooms, again.moods]).toEqual([[], [], [], []]);
    expect(again.existingMoods).toHaveLength(4);
  });
});
