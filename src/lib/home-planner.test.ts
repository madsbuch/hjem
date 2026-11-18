import { afterEach, describe, expect, it, vi } from 'vitest';
import { demoSnapshot, joinDemoAppliance } from './demo';
import type { HassSnapshot } from './home-assistant';
import { parseServerMessages } from './home-assistant-protocol';
import {
  identifyLight,
  identifySteps,
  plannerLights,
  plannerRemotes,
  pressFromActivity,
  zigbeeStacks,
  type LightStep,
} from './home-planner';
import { HomeSetupManager } from './home-setup';
import { DemoHomeSetupTransport } from './demo-home-setup';

afterEach(() => vi.useRealTimers());

const home = (): HassSnapshot => structuredClone(demoSnapshot);

describe('planner lights', () => {
  it('names single-light devices by their device and keeps rooms', () => {
    const lights = plannerLights(home());
    expect(lights.map((light) => light.name)).toEqual(['Bedside lamp', 'Kitchen lights', 'Pendant lights', 'Reading lamp']);
    expect(lights.find((light) => light.name === 'Reading lamp')).toMatchObject({
      target: { kind: 'device', id: 'demo_light_reading_lamp' },
      areaId: 'living',
    });
  });

  it('targets the entity when a device has several lights or the entity has its own room', () => {
    const snapshot = home();
    snapshot.registry = snapshot.registry.map((entry) => entry.entity_id === 'light.kitchen'
      ? { ...entry, device_id: 'demo_light_living_pendant' }
      : entry.entity_id === 'light.bedside' ? { ...entry, area_id: 'living' } : entry);
    const lights = plannerLights(snapshot);
    expect(lights.find((light) => light.entity.entity_id === 'light.kitchen')?.target).toEqual({ kind: 'entity', id: 'light.kitchen' });
    expect(lights.find((light) => light.entity.entity_id === 'light.bedside')).toMatchObject({
      target: { kind: 'entity', id: 'light.bedside' }, areaId: 'living',
    });
  });

  it('skips groups and hidden lights, and cannot rename unregistered lights', () => {
    const snapshot = home();
    snapshot.entities.push(
      { entity_id: 'light.group', state: 'on', attributes: { entity_id: ['light.kitchen'] } },
      { entity_id: 'light.yaml', state: 'off', attributes: { friendly_name: 'Yaml lamp' } },
    );
    snapshot.registry = snapshot.registry.map((entry) => entry.entity_id === 'light.bedside' ? { ...entry, hidden_by: 'user' } : entry);
    const ids = plannerLights(snapshot).map((light) => [light.entity.entity_id, light.target]);
    expect(ids).toContainEqual(['light.yaml', null]);
    expect(ids.map(([id]) => id)).not.toContain('light.group');
    expect(ids.map(([id]) => id)).not.toContain('light.bedside');
  });
});

describe('planner remotes', () => {
  it('finds remotes from event entities and reports battery and declared buttons', () => {
    const remotes = plannerRemotes(home());
    expect(remotes.map((remote) => remote.name)).toEqual(['Dimmer switch', 'Scene button', 'Wireless remote']);
    expect(remotes.find((remote) => remote.name === 'Scene button')).toMatchObject({ battery: 12, areaId: null, actions: ['single', 'double', 'hold'] });
  });

  it('recognises action sensors and model names but not controllable devices', () => {
    const snapshot = home();
    snapshot.devices.push(
      { id: 'z2m', name: '0x00158d', area_id: null },
      { id: 'zha', name: 'Office dimmer', model: 'Smart dimmer remote', area_id: null },
      { id: 'bulb', name: 'Bulb', model: 'Wireless bulb', area_id: null },
    );
    snapshot.registry.push(
      { entity_id: 'sensor.z2m_action', device_id: 'z2m', area_id: null },
      { entity_id: 'light.bulb', device_id: 'bulb', area_id: null },
    );
    const ids = plannerRemotes(snapshot).map((remote) => remote.device.id);
    expect(ids).toContain('z2m');
    expect(ids).toContain('zha');
    expect(ids).not.toContain('bulb');
    expect(plannerRemotes(snapshot, new Set(['bulb'])).map((remote) => remote.device.id)).toContain('bulb');
  });
});

describe('remote presses', () => {
  const now = Date.parse('2026-11-18T12:00:00Z');

  it('reads integration button events from the WebSocket', () => {
    const [message] = parseServerMessages(JSON.stringify({
      id: 9, type: 'event',
      event: { event_type: 'zha_event', time_fired: '2026-11-18T11:59:59Z', data: { device_id: 'remote-1', command: 'move_with_on_off', args: [0, 83] } },
    }));
    expect(message).toEqual({
      type: 'device_event', id: 9,
      event: { event_type: 'zha_event', device_id: 'remote-1', action: 'move with on off', time_fired: '2026-11-18T11:59:59Z' },
    });
    if (message?.type !== 'device_event') throw new Error('Expected a device event.');
    expect(pressFromActivity({ kind: 'device_event', event: message.event }, home(), now)).toEqual({
      deviceId: 'remote-1', action: 'move with on off', at: now - 1000,
    });
    const [hue] = parseServerMessages(JSON.stringify({ id: 9, type: 'event', event: { event_type: 'hue_event', data: { device_id: 'hue', type: 'short_release', subtype: 1 } } }));
    expect(hue).toMatchObject({ event: { action: 'short release · button 1' } });
    const [unknown] = parseServerMessages(JSON.stringify({ id: 9, type: 'event', event: { event_type: 'deconz_event', data: { id: 'no-device' } } }));
    expect(unknown).toEqual({ type: 'other_event', id: 9 });
  });

  it('reads fresh event entities and action sensors, ignoring stale or empty states', () => {
    const snapshot = home();
    const change = (entity_id: string, state: string, attributes: Record<string, unknown> = {}) =>
      ({ kind: 'state_changed' as const, change: { entity_id, new_state: { entity_id, state, attributes } } });
    expect(pressFromActivity(change('event.remote_dimmer_action', new Date(now - 500).toISOString(), { event_type: 'brightness_up' }), snapshot, now))
      .toEqual({ deviceId: 'demo_remote_dimmer', action: 'brightness up', at: now });
    expect(pressFromActivity(change('event.remote_dimmer_action', new Date(now - 60_000).toISOString()), snapshot, now)).toBeNull();
    expect(pressFromActivity(change('event.remote_dimmer_action', 'unavailable'), snapshot, now)).toBeNull();
    snapshot.registry.push({ entity_id: 'sensor.hall_action', device_id: 'hall', area_id: null });
    expect(pressFromActivity(change('sensor.hall_action', 'double_click'), snapshot, now)).toMatchObject({ deviceId: 'hall', action: 'double click' });
    expect(pressFromActivity(change('sensor.hall_action', ''), snapshot, now)).toBeNull();
    expect(pressFromActivity(change('light.kitchen', 'on'), snapshot, now)).toBeNull();
  });
});

describe('identifying a light', () => {
  it('blinks three times and restores an on light at its brightness', () => {
    const lamp = { entity_id: 'light.a', state: 'on', attributes: { brightness: 115, supported_color_modes: ['brightness'] } };
    const steps = identifySteps(lamp);
    expect(steps.map((step) => step.service)).toEqual(['turn_off', 'turn_on', 'turn_off', 'turn_on', 'turn_off', 'turn_on', 'turn_on']);
    expect(steps.at(-1)).toEqual({ service: 'turn_on', data: { brightness_pct: 45 } });
    expect(identifySteps({ entity_id: 'light.b', state: 'off', attributes: {} }).map((step) => step.service))
      .toEqual(['turn_on', 'turn_off', 'turn_on', 'turn_off', 'turn_on', 'turn_off']);
  });

  it('restores the original state when stopped part-way', async () => {
    vi.useFakeTimers();
    const sent: LightStep[] = [];
    const controller = new AbortController();
    const running = identifyLight({ entity_id: 'light.b', state: 'off', attributes: {} }, async (step) => { sent.push(step); }, { signal: controller.signal, interval: 100 });
    await vi.advanceTimersByTimeAsync(150);
    controller.abort();
    await expect(running).rejects.toThrow('Stopped.');
    expect(sent.map((step) => step.service)).toEqual(['turn_on', 'turn_off', 'turn_off']);
  });
});

describe('renaming devices and entities', () => {
  function manager() {
    let snapshot = home();
    const transport = new DemoHomeSetupTransport({ getSnapshot: () => snapshot, setSnapshot: (value) => { snapshot = value; } });
    return { setup: new HomeSetupManager({ transport, demo: true, isCurrent: () => true }), snapshot: () => snapshot };
  }

  it('renames a device, updates its entities, and undoes the change', async () => {
    const { setup, snapshot } = manager();
    const result = await setup.renameDevice('demo_light_reading_lamp', ' Desk lamp ');
    expect(result).toMatchObject({ changed: true, message: 'Reading lamp is now Desk lamp.' });
    expect(snapshot().devices.find((device) => device.id === 'demo_light_reading_lamp')?.name_by_user).toBe('Desk lamp');
    expect(snapshot().entities.find((entity) => entity.entity_id === 'light.reading_lamp')?.attributes.friendly_name).toBe('Desk lamp');
    await expect(setup.renameDevice('demo_light_reading_lamp', 'Desk lamp')).resolves.toMatchObject({ changed: false });
    const [change] = setup.changes();
    if (!change) throw new Error('Expected a change.');
    expect(change.description).toBe('Renamed Reading lamp to Desk lamp');
    await setup.undo(change.id);
    expect(snapshot().devices.find((device) => device.id === 'demo_light_reading_lamp')?.name_by_user).toBeNull();
    expect(snapshot().entities.find((entity) => entity.entity_id === 'light.reading_lamp')?.attributes.friendly_name).toBe('Reading lamp');
  });

  it('renames remotes while keeping entity suffixes, and refuses to undo over a later edit', async () => {
    const { setup, snapshot } = manager();
    await setup.renameDevice('demo_remote_scene', 'Hall button');
    expect(snapshot().entities.find((entity) => entity.entity_id === 'sensor.remote_scene_battery')?.attributes.friendly_name).toBe('Hall button battery');
    const [first] = setup.changes();
    await setup.renameDevice('demo_remote_scene', 'Front door button');
    if (!first) throw new Error('Expected a change.');
    await expect(setup.undo(first.id)).rejects.toThrow('changed elsewhere');
  });

  it('renames an entity on its own', async () => {
    const { setup, snapshot } = manager();
    await setup.renameEntity('light.kitchen', 'Island pendants');
    expect(snapshot().registry.find((entry) => entry.entity_id === 'light.kitchen')?.name).toBe('Island pendants');
    expect(plannerLights(snapshot()).map((light) => light.name)).toContain('Island pendants');
    await expect(setup.renameEntity('light.kitchen', '')).rejects.toThrow('between 1 and 80');
  });
});

describe('adding appliances', () => {
  it('detects ZHA and Zigbee2MQTT from what Home Assistant registered', () => {
    const snapshot = home();
    expect(zigbeeStacks(snapshot)).toEqual([]);
    snapshot.registry.push({ entity_id: 'light.zha_bulb', platform: 'zha', area_id: null, device_id: null });
    expect(zigbeeStacks(snapshot)).toEqual(['zha']);
    snapshot.devices.push({ id: 'bridge', name: 'Zigbee2MQTT Bridge', manufacturer: 'Zigbee2MQTT', area_id: null });
    expect(zigbeeStacks(snapshot)).toEqual(['zha', 'zigbee2mqtt']);
  });

  it('joins demo appliances one at a time and recognises what they are', () => {
    let snapshot = home();
    snapshot = joinDemoAppliance(snapshot);
    expect(plannerLights(snapshot).map((light) => light.entity.entity_id)).toContain('light.new_bulb');
    snapshot = joinDemoAppliance(snapshot);
    expect(plannerRemotes(snapshot).map((remote) => remote.device.id)).toContain('demo_new_remote');
    expect(plannerLights(snapshot).find((light) => light.entity.entity_id === 'light.new_bulb')?.areaId).toBeNull();
    snapshot = joinDemoAppliance(joinDemoAppliance(snapshot));
    expect(snapshot.devices.filter((device) => device.id.startsWith('demo_new_'))).toHaveLength(3);
  });
});
