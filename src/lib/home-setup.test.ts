import { afterEach, describe, expect, it, vi } from 'vitest';
import { HomeSetupManager, compileMoodTargets } from './home-setup';
import { DemoHomeSetupTransport } from './demo-home-setup';
import { demoSnapshot } from './demo';
import { roomFor } from './entities';
import type { HassSnapshot } from './home-assistant';
import type { SceneConfig } from './home-setup-types';
import { SceneRequestError } from './home-assistant-scenes';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Expected test data.');
  return value;
}
function fixture() {
  let snapshot: HassSnapshot = structuredClone(demoSnapshot);
  let current = true;
  const onChange = vi.fn();
  const transport = new DemoHomeSetupTransport({
    getSnapshot: () => snapshot,
    setSnapshot: (value) => { snapshot = value; },
    isCurrent: () => current,
  });
  const manager = new HomeSetupManager({ transport, demo: true, isCurrent: () => current, onChange });
  return {
    manager, transport, onChange,
    snapshot: () => snapshot,
    replace: (value: HassSnapshot) => { snapshot = value; },
    invalidate: () => { current = false; },
  };
}
const readingLamp = 'light.reading_lamp';
const readingDevice = 'demo_light_reading_lamp';
const basicMood = { name: 'Reading', targets: [{ entity_id: readingLamp, state: 'on', brightness_pct: 30 }] };
afterEach(() => vi.useRealTimers());

describe('home organization and undo', () => {
  it('creates a room, moves whole devices, preserves explicit entity assignments, and restores inheritance', async () => {
    const home = fixture();
    const room = await home.manager.createRoom('Office');
    expect(room.area.name).toBe('Office');
    await home.manager.assignEntity(readingLamp, 'bedroom');
    await home.manager.assignDevice(readingDevice, room.area.area_id);
    const entity = required(home.snapshot().entities.find((item) => item.entity_id === readingLamp));
    expect(roomFor(entity, home.snapshot())).toBe('bedroom');
    const related = vi.spyOn(home.transport, 'relatedToArea');
    await home.manager.assignEntity(readingLamp, null);
    expect(roomFor(entity, home.snapshot())).toBe(room.area.area_id);
    expect(related.mock.calls.map(([id]) => id)).toEqual(['bedroom', room.area.area_id]);
    const structure = await home.manager.inspect();
    expect(structure.devices).toContainEqual(expect.objectContaining({ id: readingDevice, area_id: room.area.area_id }));
    expect(structure.entities).toContainEqual(expect.objectContaining({ entity_id: readingLamp, area_source: 'device', effective_area_id: room.area.area_id }));
    expect(structure.areas).toContainEqual(room.area);
    const clearing = required(home.manager.changes()[0]);
    await home.manager.undo(clearing.id);
    expect(roomFor(entity, home.snapshot())).toBe('bedroom');
  });

  it('avoids duplicate rooms and can undo an unchanged empty room', async () => {
    const home = fixture();
    const existing = await home.manager.createRoom(' living ROOM ');
    expect(existing.changed).toBe(false);
    expect(home.manager.changes()).toHaveLength(0);
    const created = await home.manager.createRoom('Office');
    await home.manager.undo(required(home.manager.changes()[0]).id);
    expect(home.snapshot().areas.some((area) => area.area_id === created.area.area_id)).toBe(false);
    expect(home.manager.changes()).toHaveLength(0);
  });

  it('refuses to undo a room that acquired devices or external references', async () => {
    const home = fixture();
    const created = await home.manager.createRoom('Office');
    const creation = required(home.manager.changes()[0]);
    await home.manager.assignDevice(readingDevice, created.area.area_id);
    await expect(home.manager.undo(creation.id)).rejects.toThrow('contains devices');
    await home.manager.undo(required(home.manager.changes()[0]).id);
    vi.spyOn(home.transport, 'relatedToArea').mockResolvedValue({ automation: ['automation.office_evening'] });
    await expect(home.manager.undo(creation.id)).rejects.toThrow('referenced elsewhere');
    expect(home.snapshot().areas.some((area) => area.area_id === created.area.area_id)).toBe(true);
  });

  it('does not overwrite an assignment or room name changed elsewhere', async () => {
    const home = fixture();
    await home.manager.assignDevice(readingDevice, 'bedroom');
    const change = required(home.manager.changes()[0]);
    await home.transport.assignDeviceArea(readingDevice, 'kitchen');
    await expect(home.manager.undo(change.id)).rejects.toThrow('changed elsewhere');
    expect(home.manager.changes()).toContainEqual(change);
    await home.manager.renameRoom('living', 'Lounge');
    const rename = required(home.manager.changes()[0]);
    await home.transport.renameArea('living', 'Sitting room');
    await expect(home.manager.undo(rename.id)).rejects.toThrow('changed since');
    expect(home.snapshot().areas.find((area) => area.area_id === 'living')?.name).toBe('Sitting room');
  });

  it('marks unavailable impact checks as unknown and still carries out a requested move', async () => {
    const home = fixture();
    vi.spyOn(home.transport, 'relatedToArea').mockRejectedValue(new Error('Unsupported command'));
    const result = await home.manager.assignDevice(readingDevice, 'bedroom');
    expect(result).toMatchObject({ changed: true, related_routines: { checked: false, note: expect.stringContaining('could not all be inspected') } });
  });

  it('never treats failed registry reads as an empty home', async () => {
    const home = fixture();
    home.replace({ ...home.snapshot(), structureStatus: 'unavailable', structureError: 'Registry permission denied' });
    const create = vi.spyOn(home.transport, 'createArea');
    await expect(home.manager.createRoom('Office')).rejects.toThrow('permission denied');
    expect(create).not.toHaveBeenCalled();
  });

  it('does not send changes after cancellation during discovery or after a session change', async () => {
    const home = fixture();
    const controller = new AbortController();
    const snapshot = home.snapshot();
    vi.spyOn(home.transport, 'refreshStructure').mockImplementation(async () => { controller.abort(); return snapshot; });
    const create = vi.spyOn(home.transport, 'createArea');
    await expect(home.manager.createRoom('Office', controller.signal)).rejects.toThrow('Stopped');
    expect(create).not.toHaveBeenCalled();
    home.invalidate();
    await expect(home.manager.renameRoom('living', 'Lounge')).rejects.toThrow('connection changed');
  });

  it('keeps undo for a write accepted just before Stop and blocks concurrent mutations', async () => {
    const home = fixture();
    const controller = new AbortController();
    const write = home.transport.renameArea.bind(home.transport);
    vi.spyOn(home.transport, 'renameArea').mockImplementation(async (area, name) => {
      const result = await write(area, name);
      controller.abort();
      await expect(home.manager.assignDevice(readingDevice, 'bedroom')).rejects.toThrow('still running');
      return result;
    });
    await expect(home.manager.renameRoom('living', 'Lounge', controller.signal)).rejects.toThrow('Stopped');
    expect(home.manager.changes()).toHaveLength(1);
    expect(home.snapshot().areas.find((area) => area.area_id === 'living')?.name).toBe('Lounge');
  });

  it('withholds unrelated entity states and malformed capability attributes from model data', async () => {
    const home = fixture();
    const snapshot = home.snapshot();
    home.replace({ ...snapshot, entities: [
      ...snapshot.entities,
      { entity_id: 'input_text.private', state: 'private-helper-value', attributes: { friendly_name: 'Private helper' } },
      { entity_id: 'light.strange', state: 'on', attributes: { supported_features: { secret: 'private-attribute' }, supported_color_modes: ['brightness', { secret: 'private-array-value' }] } },
    ] });
    const result = JSON.stringify(await home.manager.inspect());
    expect(result).not.toContain('private-helper-value');
    expect(result).not.toContain('private-attribute');
    expect(result).not.toContain('private-array-value');
    expect(result).toContain('Private helper');
  });
});

describe('persistent moods', () => {
  it('keeps hidden and disabled scenes out of discovery, editing and activation', async () => {
    const home = fixture();
    const snapshot = home.snapshot();
    home.replace({ ...snapshot, registry: [...snapshot.registry,
      { entity_id: 'scene.cosy_evening', area_id: null, device_id: null, hidden_by: 'user' },
      { entity_id: 'scene.good_morning', area_id: null, device_id: null, disabled_by: 'integration' },
    ] });
    const structure = await home.manager.inspect();
    expect(structure.scenes.map((scene) => scene.entity_id)).not.toContain('scene.cosy_evening');
    expect(structure.scenes.map((scene) => scene.entity_id)).not.toContain('scene.good_morning');
    await expect(home.manager.inspectMood('scene.cosy_evening')).rejects.toThrow('no longer exists');
    const activate = vi.spyOn(home.transport, 'activateScene');
    await expect(home.manager.activateMood('scene.good_morning')).rejects.toThrow('available mood');
    expect(activate).not.toHaveBeenCalled();
  });

  it('saves a discoverable scene, applies only its targets, verifies states and supports undo', async () => {
    const home = fixture();
    const unchanged = structuredClone(required(home.snapshot().entities.find((item) => item.entity_id === 'light.kitchen')));
    const result = await home.manager.saveMood(basicMood);
    const entityId = required(result.entity_id);
    const config = await home.transport.readScene(result.config_id);
    expect(config.entities).toEqual({ [readingLamp]: { state: 'on', brightness: 77 } });
    const activation = await home.manager.activateMood(entityId);
    expect(activation).toMatchObject({ accepted: true, verified: true, status: 'verified', demo: true });
    expect(home.snapshot().entities.find((item) => item.entity_id === 'light.kitchen')).toEqual(unchanged);
    await home.manager.undo(required(home.manager.changes()[0]).id);
    expect(home.snapshot().entities.some((item) => item.entity_id === entityId)).toBe(false);
  });

  it('requires inspection before editing and preserves a previous definition for undo', async () => {
    const home = fixture();
    const original = await home.transport.readScene('cosy_evening');
    original.icon = 'mdi:weather-night';
    original.metadata = { 'light.reading_lamp': { entity_only: true } };
    await home.transport.saveScene('cosy_evening', original);
    const request = { ...basicMood, name: 'Cosy evening', entity_id: 'scene.cosy_evening' };
    await expect(home.manager.saveMood(request)).rejects.toThrow('Inspect');
    const inspected = await home.manager.inspectMood('scene.cosy_evening');
    expect(inspected.editable).toBe(true);
    await home.manager.saveMood(request);
    expect(await home.transport.readScene('cosy_evening')).toMatchObject({ icon: original.icon, metadata: original.metadata });
    await home.manager.undo(required(home.manager.changes()[0]).id);
    expect(await home.transport.readScene('cosy_evening')).toEqual(original);
  });

  it('refuses a concurrent scene edit and never overwrites a later change during undo', async () => {
    const home = fixture();
    await home.manager.inspectMood('scene.cosy_evening');
    const concurrent = await home.transport.readScene('cosy_evening');
    concurrent.name = 'Updated elsewhere';
    await home.transport.saveScene('cosy_evening', concurrent);
    await expect(home.manager.saveMood({ ...basicMood, entity_id: 'scene.cosy_evening' })).rejects.toThrow('changed since');
    await home.manager.inspectMood('scene.cosy_evening');
    await home.manager.saveMood({ ...basicMood, entity_id: 'scene.cosy_evening' });
    const change = required(home.manager.changes()[0]);
    concurrent.name = 'A later independent edit';
    await home.transport.saveScene('cosy_evening', concurrent);
    await expect(home.manager.undo(change.id)).rejects.toThrow('edited elsewhere');
    expect(await home.transport.readScene('cosy_evening')).toEqual(concurrent);
  });

  it('reports missing devices and unsupported settings rather than replacing them silently', async () => {
    const home = fixture();
    const config: SceneConfig = { id: 'cosy_evening', name: 'Cosy evening', entities: { 'light.missing': { state: 'on', rgb_color: [1, 2, 3] } } };
    await home.transport.saveScene('cosy_evening', config);
    const inspected = await home.manager.inspectMood('scene.cosy_evening');
    expect(inspected).toMatchObject({ editable: false, issues: ['light.missing is missing.'], unsupported_settings: ['light.missing: rgb_color'] });
    await expect(home.manager.saveMood({ ...basicMood, entity_id: 'scene.cosy_evening' })).rejects.toThrow('cannot preserve');
  });

  it('retains undo after a saved mood fails read-back without replaying the write', async () => {
    const home = fixture();
    vi.spyOn(home.transport, 'readScene').mockRejectedValueOnce(new Error('Read-back connection lost'));
    const save = vi.spyOn(home.transport, 'saveScene');
    await expect(home.manager.saveMood(basicMood)).rejects.toThrow('connection lost');
    expect(save).toHaveBeenCalledTimes(1);
    expect(home.manager.changes()).toHaveLength(1);
    await home.manager.undo(required(home.manager.changes()[0]).id);
    expect(save).toHaveBeenCalledTimes(1);
    expect(home.snapshot().entities.some((entity) => entity.attributes.friendly_name === 'Reading')).toBe(false);
  });

  it('removes rejected changes from history, and completes undo when a scene was already deleted', async () => {
    const home = fixture();
    vi.spyOn(home.transport, 'saveScene').mockRejectedValueOnce(new SceneRequestError('Administrator required', true));
    await expect(home.manager.saveMood(basicMood)).rejects.toThrow('Administrator');
    expect(home.manager.changes()).toHaveLength(0);
    const created = await home.manager.saveMood(basicMood);
    const change = required(home.manager.changes()[0]);
    await home.transport.deleteScene(created.config_id);
    await home.manager.undo(change.id);
    expect(home.manager.changes()).toHaveLength(0);
  });

  it('can retry the read-back of a completed delete without repeating the delete', async () => {
    const home = fixture();
    await home.manager.saveMood(basicMood);
    const change = required(home.manager.changes()[0]);
    const remove = vi.spyOn(home.transport, 'deleteScene');
    vi.spyOn(home.transport, 'refreshStates').mockRejectedValueOnce(new Error('Offline after deleting'));
    await expect(home.manager.undo(change.id)).rejects.toThrow('Offline');
    expect(home.manager.changes()).toHaveLength(1);
    await home.manager.undo(change.id);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(home.manager.changes()).toHaveLength(0);
  });

  it('does not confuse command acceptance with the device state being applied', async () => {
    vi.useFakeTimers();
    const home = fixture();
    const saved = await home.manager.saveMood(basicMood);
    vi.spyOn(home.transport, 'activateScene').mockResolvedValue(undefined);
    const running = home.manager.activateMood(required(saved.entity_id));
    await vi.advanceTimersByTimeAsync(1700);
    const result = await running;
    expect(result).toMatchObject({ accepted: true, verified: false, status: 'partial' });
    expect(result.issues.some((issue) => issue.includes('brightness'))).toBe(true);
  });

  it('verifies percentage-based brightness in existing scenes too', async () => {
    vi.useFakeTimers();
    const home = fixture();
    await home.transport.saveScene('cosy_evening', { name: 'Cosy evening', entities: { [readingLamp]: { state: 'on', brightness_pct: 10 } } });
    vi.spyOn(home.transport, 'activateScene').mockResolvedValue(undefined);
    const running = home.manager.activateMood('scene.cosy_evening');
    await vi.advanceTimersByTimeAsync(1700);
    expect(await running).toMatchObject({ verified: false, status: 'partial' });
  });
});

describe('mood capability validation', () => {
  it('validates supported bounds and excludes unsupported domains and data', () => {
    const snapshot = structuredClone(demoSnapshot);
    expect(() => compileMoodTargets([{ entity_id: readingLamp, state: 'on', brightness_pct: 101 }], snapshot)).toThrow('Brightness');
    expect(() => compileMoodTargets([{ entity_id: 'light.living_pendant', state: 'on', color_temp_kelvin: 3000 }], snapshot)).toThrow('does not support colour');
    expect(() => compileMoodTargets([{ entity_id: readingLamp, state: 'off', brightness_pct: 20 }], snapshot)).toThrow('off light');
    expect(() => compileMoodTargets([{ entity_id: 'climate.living_room', state: 'heat', temperature: 35 }], snapshot)).toThrow('Temperature');
    expect(() => compileMoodTargets([{ entity_id: 'cover.bedroom', state: 'closed', position: 50 }], snapshot)).toThrow('match its position');
    expect(() => compileMoodTargets([{ entity_id: 'sensor.hallway_temperature', state: '30' }], snapshot)).toThrow('cannot be authored');
    expect(() => compileMoodTargets([...basicMood.targets, ...basicMood.targets], snapshot)).toThrow('same entity twice');
    expect(compileMoodTargets([{ entity_id: readingLamp, state: 'on', color_temp_kelvin: 2500 }], snapshot)).toEqual({ [readingLamp]: { state: 'on', color_temp_kelvin: 2500 } });
  });

  it('rejects unavailable, hidden, and disabled entities', () => {
    const snapshot = structuredClone(demoSnapshot);
    const entity = required(snapshot.entities.find((item) => item.entity_id === readingLamp));
    entity.state = 'unavailable';
    expect(() => compileMoodTargets(basicMood.targets, snapshot)).toThrow('unavailable');
    entity.state = 'on';
    const entry = required(snapshot.registry.find((item) => item.entity_id === readingLamp));
    entry.disabled_by = 'integration';
    expect(() => compileMoodTargets(basicMood.targets, snapshot)).toThrow('hidden or disabled');
  });
});
