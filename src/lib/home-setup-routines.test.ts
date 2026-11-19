import { describe, expect, it, vi } from 'vitest';
import { HomeSetupManager } from './home-setup';
import { DemoHomeSetupTransport } from './demo-home-setup';
import { demoSnapshot } from './demo';
import type { HassSnapshot } from './home-assistant';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Expected test data.');
  return value;
}
function fixture() {
  let snapshot: HassSnapshot = structuredClone(demoSnapshot);
  const transport = new DemoHomeSetupTransport({ getSnapshot: () => snapshot, setSnapshot: (value) => { snapshot = value; } });
  const manager = new HomeSetupManager({ transport, demo: true, isCurrent: () => true });
  const entity = (id: string) => snapshot.entities.find((item) => item.entity_id === id);
  return { manager, transport, snapshot: () => snapshot, entity, latest: () => required(manager.changes()[0]) };
}
const doorLight = {
  name: 'Kitchen light at the door',
  description: 'Turns on the kitchen lights when the front door opens.',
  triggers: [{ trigger: 'state', entity_id: 'binary_sensor.front_door', to: 'on' }],
  actions: [{ action: 'light.turn_on', target: { entity_id: 'light.kitchen' } }],
};

describe('automations and scripts', () => {
  it('lists routines and reads one in the current format', async () => {
    const home = fixture();
    const list = await home.manager.listRoutines();
    expect(list.automations.map((item) => [item.entity_id, item.enabled])).toEqual([
      ['automation.welcome_home_light', true],
      ['automation.dimmer_switch_turns_on_the_bedside_lamp', true],
      ['automation.wake_up_gently', false],
    ]);
    expect(list.scripts).toEqual([expect.objectContaining({ entity_id: 'script.movie_time', name: 'Movie time' })]);
    const read = await home.manager.inspectRoutine('automation.welcome_home_light');
    expect(read).toMatchObject({ kind: 'automation', config_id: 'demo_welcome_light', enabled: true, editable: true, issues: [] });
    expect(read.config.triggers).toEqual([{ trigger: 'state', entity_id: 'binary_sensor.front_door', to: 'on' }]);
    await expect(home.manager.describeRoutine('automation.welcome_home_light')).resolves.toMatchObject({ when: ['Front door opens'], then: ['Turn on Reading lamp (60%)'], editable: true });
    await expect(home.manager.describeMood('scene.cosy_evening')).resolves.toContain('Reading lamp: on, 35%');
  });

  it('creates an automation, points the change at it, and removes it again on undo', async () => {
    const home = fixture();
    const saved = await home.manager.saveAutomation(doorLight);
    const entityId = required(saved.entity_id);
    expect(saved).toMatchObject({ changed: true, checked_by_home_assistant: false });
    expect(home.entity(entityId)).toMatchObject({ state: 'on', attributes: { friendly_name: doorLight.name } });
    expect(home.latest()).toMatchObject({ description: `Created automation ${doorLight.name}`, target: { kind: 'automation', id: entityId } });
    await expect(home.transport.readRoutine('automation', required(saved.config_id))).resolves.toMatchObject({ alias: doorLight.name, mode: 'single', conditions: [] });
    await expect(home.manager.saveAutomation(doorLight)).rejects.toThrow('already uses that name');
    await home.manager.undo(home.latest().id);
    expect(home.entity(entityId)).toBeUndefined();
    expect(home.manager.changes()).toEqual([]);
  });

  it('saves nothing when Hjem or Home Assistant refuses the configuration', async () => {
    const home = fixture();
    const save = vi.spyOn(home.transport, 'saveRoutine');
    await expect(home.manager.saveAutomation({ ...doorLight, actions: [{ action: 'light.turn_on', target: { entity_id: 'light.attic' } }] })).rejects.toThrow('light.attic');
    vi.spyOn(home.transport, 'validateRoutine').mockResolvedValue({ checked: true, errors: ['triggers: Unknown trigger platform.'] });
    await expect(home.manager.saveAutomation(doorLight)).rejects.toThrow('nothing was saved. triggers: Unknown trigger platform.');
    expect(save).not.toHaveBeenCalled();
    expect(home.manager.changes()).toEqual([]);
  });

  it('updates only an inspected automation, keeps what it does not author, and restores it on undo', async () => {
    const home = fixture();
    const id = 'automation.welcome_home_light';
    const update = { entity_id: id, name: 'Welcome home light', triggers: doorLight.triggers, actions: doorLight.actions };
    await expect(home.manager.saveAutomation(update)).rejects.toThrow('Inspect the automation');
    const before = await home.transport.readRoutine('automation', 'demo_welcome_light');
    await home.manager.inspectRoutine(id);
    // Someone edits it in Home Assistant after it was read.
    await home.transport.saveRoutine('automation', 'demo_welcome_light', { ...before, mode: 'restart' });
    await expect(home.manager.saveAutomation(update)).rejects.toThrow('changed since it was inspected');
    await home.manager.inspectRoutine(id);
    const result = await home.manager.saveAutomation({ ...update, enabled: false });
    expect(result).toMatchObject({ changed: true, entity_id: id, enabled: false });
    expect(home.entity(id)?.state).toBe('off');
    const stored = await home.transport.readRoutine('automation', 'demo_welcome_light');
    expect(stored).toMatchObject({ id: 'demo_welcome_light', mode: 'restart', description: before.description, conditions: [], actions: doorLight.actions });
    await home.manager.inspectRoutine(id);
    await expect(home.manager.saveAutomation(update)).resolves.toMatchObject({ changed: false });
    await home.manager.undo(home.latest().id);
    await expect(home.transport.readRoutine('automation', 'demo_welcome_light')).resolves.toEqual({ ...before, mode: 'restart' });
  });

  it('will not undo over a later edit made elsewhere', async () => {
    const home = fixture();
    const saved = await home.manager.saveAutomation(doorLight);
    const configId = required(saved.config_id);
    await home.transport.saveRoutine('automation', configId, { ...await home.transport.readRoutine('automation', configId), mode: 'queued' });
    await expect(home.manager.undo(home.latest().id)).rejects.toThrow('edited elsewhere');
    expect(home.manager.changes()).toHaveLength(1);
  });

  it('deletes an inspected routine and restores it, paused as it was', async () => {
    const home = fixture();
    const id = 'automation.wake_up_gently';
    await expect(home.manager.deleteRoutine(id)).rejects.toThrow('Inspect');
    const before = await home.transport.readRoutine('automation', 'demo_wake_up');
    await home.manager.inspectRoutine(id);
    await expect(home.manager.deleteRoutine(id)).resolves.toMatchObject({ changed: true });
    expect(home.entity(id)).toBeUndefined();
    await expect(home.transport.readRoutine('automation', 'demo_wake_up')).rejects.toThrow('no longer has a saved');
    await home.manager.undo(home.latest().id);
    await expect(home.transport.readRoutine('automation', 'demo_wake_up')).resolves.toEqual(before);
    expect(home.entity(id)?.state).toBe('off');
  });

  it('creates, updates, and runs a script', async () => {
    const home = fixture();
    const saved = await home.manager.saveScript({ name: 'Bedtime', sequence: [{ action: 'light.turn_off', target: { entity_id: 'light.living_pendant' } }, { action: 'media_player.media_pause', target: { entity_id: 'media_player.speaker' } }] });
    expect(saved).toMatchObject({ changed: true, entity_id: 'script.bedtime', config_id: 'bedtime' });
    await expect(home.manager.saveScript({ name: 'Bed time', sequence: [{ action: 'lock.lock', target: { entity_id: 'lock.door' } }] })).rejects.toThrow('does not set up routines');
    expect(home.entity('light.living_pendant')?.state).toBe('on');
    await expect(home.manager.runRoutine('script.bedtime')).resolves.toMatchObject({ accepted: true, verified: false });
    expect(home.entity('light.living_pendant')?.state).toBe('off');
    expect(home.entity('media_player.speaker')?.state).toBe('paused');
    expect(home.entity('script.bedtime')?.attributes.last_triggered).toEqual(expect.any(String));
    await home.manager.inspectRoutine('script.bedtime');
    await expect(home.manager.saveAutomation({ ...doorLight, entity_id: 'script.bedtime' })).rejects.toThrow('not an automation');
    await home.manager.saveScript({ entity_id: 'script.bedtime', name: 'Bedtime', icon: 'mdi:bed', sequence: [{ action: 'light.turn_off', target: { entity_id: 'light.kitchen' } }] });
    await expect(home.transport.readRoutine('script', 'bedtime')).resolves.toMatchObject({ icon: 'mdi:bed', sequence: [{ action: 'light.turn_off', target: { entity_id: 'light.kitchen' } }] });
  });

  it('pauses and resumes an automation, with undo', async () => {
    const home = fixture();
    const id = 'automation.welcome_home_light';
    await expect(home.manager.setAutomationEnabled(id, true)).resolves.toMatchObject({ changed: false });
    await expect(home.manager.setAutomationEnabled(id, false)).resolves.toMatchObject({ changed: true, enabled: false });
    expect(home.entity(id)?.state).toBe('off');
    expect(home.latest().target).toEqual({ kind: 'automation', id });
    await home.manager.undo(home.latest().id);
    expect(home.entity(id)?.state).toBe('on');
    await expect(home.manager.setAutomationEnabled('script.movie_time', false)).rejects.toThrow('no longer exists');
    await expect(home.manager.routineRuns(id)).resolves.toMatchObject({ enabled: true, runs: [], last_triggered: null });
  });

  it('reports what a remote can trigger', async () => {
    const home = fixture();
    await expect(home.manager.deviceTriggers('demo_remote_dimmer')).resolves.toMatchObject({
      name: 'Dimmer switch', triggers: [],
      event_entities: [{ entity_id: 'event.remote_dimmer_action', event_types: ['on', 'off', 'up', 'down'] }],
    });
    vi.spyOn(home.transport, 'deviceTriggers').mockResolvedValue([{ platform: 'device', domain: 'zha', device_id: 'demo_remote_dimmer', type: 'remote_button_short_press', subtype: 'turn_on' }]);
    await expect(home.manager.deviceTriggers('demo_remote_dimmer')).resolves.toMatchObject({ triggers: [expect.objectContaining({ subtype: 'turn_on' })] });
    await expect(home.manager.deviceTriggers('guessed')).rejects.toThrow('not registered');
  });
});

describe('helpers, rooms, and visibility', () => {
  it('creates, updates, and deletes a helper, each with undo', async () => {
    const home = fixture();
    const listed = await home.manager.listHelpers();
    expect(listed.helpers).toEqual([expect.objectContaining({ domain: 'input_datetime', helper_id: 'wake_up_time', entity_id: 'input_datetime.wake_up_time', state: '06:45:00', kind: 'Date and time' })]);
    const created = await home.manager.saveHelper({ domain: 'input_number', name: 'Evening brightness', settings: { min: 1, max: 100, unit_of_measurement: '%' } });
    expect(created).toMatchObject({ changed: true, helper_id: 'evening_brightness', entity_id: 'input_number.evening_brightness' });
    expect(home.latest().target).toEqual({ kind: 'helper', id: 'input_number.evening_brightness' });
    await expect(home.manager.saveHelper({ domain: 'input_number', name: 'evening brightness', settings: { min: 1, max: 10 } })).rejects.toThrow('already uses that name');
    await expect(home.manager.saveHelper({ domain: 'input_number', name: 'No range' })).rejects.toThrow('min and max');

    await home.manager.saveHelper({ domain: 'input_number', helper_id: 'evening_brightness', name: 'Evening level', settings: { max: 80 } });
    expect(home.entity('input_number.evening_brightness')?.attributes.friendly_name).toBe('Evening level');
    await expect(home.manager.saveHelper({ domain: 'input_number', helper_id: 'evening_brightness', name: 'Evening level', settings: { max: 80 } })).resolves.toMatchObject({ changed: false });
    await home.manager.undo(home.latest().id);
    await expect(home.transport.listHelpers('input_number')).resolves.toEqual([{ id: 'evening_brightness', name: 'Evening brightness', min: 1, max: 100, unit_of_measurement: '%' }]);

    await home.manager.deleteHelper('input_number', 'evening_brightness');
    expect(home.entity('input_number.evening_brightness')).toBeUndefined();
    await home.manager.undo(home.latest().id);
    expect(home.entity('input_number.evening_brightness')).toBeDefined();
    // The recreated helper matches the one first created, so that creation can still be undone.
    await home.manager.undo(home.latest().id);
    expect(home.entity('input_number.evening_brightness')).toBeUndefined();
    await expect(home.manager.deleteHelper('input_number', 'evening_brightness')).rejects.toThrow('no longer exists');
  });

  it('deletes only an empty room and can bring it back', async () => {
    const home = fixture();
    await expect(home.manager.deleteRoom('kitchen')).rejects.toThrow('still has devices');
    const office = await home.manager.createRoom('Office');
    await expect(home.manager.deleteRoom(office.area.area_id)).resolves.toMatchObject({ changed: true });
    expect(home.snapshot().areas.map((area) => area.name)).not.toContain('Office');
    await home.manager.undo(home.latest().id);
    expect(home.snapshot().areas.map((area) => area.name)).toContain('Office');
    vi.spyOn(home.transport, 'relatedToArea').mockResolvedValue({ automation: ['automation.office_lights'] });
    const study = await home.manager.createRoom('Study');
    await expect(home.manager.deleteRoom(study.area.area_id)).rejects.toThrow('used by an automation');
  });

  it('hides an entity from Hjem and shows it again', async () => {
    const home = fixture();
    const hidden = () => home.snapshot().registry.find((entry) => entry.entity_id === 'switch.coffee')?.hidden_by;
    await expect(home.manager.setEntityHidden('switch.coffee', true)).resolves.toMatchObject({ changed: true, hidden: true });
    expect(hidden()).toBe('user');
    await expect(home.manager.setEntityHidden('switch.coffee', true)).resolves.toMatchObject({ changed: false });
    await home.manager.undo(home.latest().id);
    expect(hidden()).toBeNull();
    await expect(home.manager.setEntityHidden('switch.guessed', true)).rejects.toThrow('not registered');
  });
});
