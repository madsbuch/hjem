import { describe, expect, it, vi } from 'vitest';
import {
  createConciergeExecutor,
  toolsFor,
  type ConciergeContext,
} from './concierge-tools';
import type { HassEntity, HassSnapshot } from './home-assistant';
import type { HomeSetup } from './home-setup-types';
import { demoSnapshot } from './demo';

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const entity = (
  entity_id: string,
  state: string,
  attributes: Record<string, unknown> = {},
): HassEntity => ({
  entity_id,
  state,
  attributes: { friendly_name: entity_id.split('.')[1], ...attributes },
});

function setup() {
  const snapshot: HassSnapshot = {
    locationName: 'Test home',
    unitSystem: { temperature: '°C' },
    areas: [{ area_id: 'lounge', name: 'Lounge' }],
    devices: [],
    registry: [
      { entity_id: 'light.dimmer', area_id: 'lounge', device_id: null },
      {
        entity_id: 'light.hidden',
        area_id: null,
        device_id: null,
        hidden_by: 'user',
      },
      {
        entity_id: 'light.disabled',
        area_id: null,
        device_id: null,
        disabled_by: 'integration',
      },
    ],
    entities: [
      entity('light.dimmer', 'on', {
        supported_color_modes: ['brightness'],
        brightness: 128,
        private_token: 'never-share-this',
      }),
      entity('light.basic', 'on', { supported_color_modes: ['onoff'] }),
      entity('light.hidden', 'on'),
      entity('light.disabled', 'on'),
      entity('switch.coffee', 'off'),
      entity('climate.lounge', 'heat', {
        temperature: 21,
        min_temp: 16,
        max_temp: 28,
        supported_features: 1,
      }),
      entity('media_player.sonos', 'playing', {
        volume_level: 0.32,
        supported_features: 1 | 4 | 8 | 16 | 32 | 16384,
      }),
      entity('media_player.basic', 'playing', { supported_features: 1 }),
      entity('cover.blinds', 'open', {
        current_position: 50,
        device_class: 'blind',
        supported_features: 4,
      }),
      entity('cover.garage', 'closed', {
        current_position: 0,
        device_class: 'garage',
        supported_features: 4,
      }),
      entity('lock.front_door', 'locked'),
      entity('alarm_control_panel.home', 'armed_away'),
      entity('sensor.temperature', '20'),
      entity('scene.evening', 'unknown'),
      entity('scene.unavailable', 'unavailable'),
    ],
  };
  const action = vi.fn<ConciergeContext['action']>().mockResolvedValue(true);
  const launch = vi
    .fn<ConciergeContext['launch']>()
    .mockResolvedValue(undefined);
  const context: ConciergeContext = {
    sessionId: 'home-session-1',
    snapshot,
    demo: true,
    connected: false,
    apps: [
      {
        packageName: 'com.sonos.acr2',
        name: 'Sonos',
        icon: 'private-icon-data',
      },
      { packageName: 'com.spotify.music', name: 'Spotify' },
    ],
    appsPreview: true,
    action,
    launch,
  };
  const controller = new AbortController();
  const execute = createConciergeExecutor(() => context);
  const run = (name: string, args: Record<string, unknown> = {}) =>
    execute(name, args, controller.signal);
  return { snapshot, context, controller, execute, run, action, launch };
}

describe('Home Concierge tool guardrails', () => {
  it('requires an explicit state read before device or scene actions', async () => {
    const { run, action } = setup();
    await expect(
      run('control_device', { entity_id: 'light.dimmer', action: 'turn_off' }),
    ).rejects.toThrow('Read get_home_state first');
    await expect(
      run('activate_scene', { entity_id: 'scene.evening' }),
    ).rejects.toThrow('Read get_home_state first');
    expect(action).not.toHaveBeenCalled();
    await run('get_home_state');
    await expect(
      run('control_device', { entity_id: 'light.dimmer', action: 'turn_off' }),
    ).resolves.toMatchObject({ accepted: true, demo: true });
    await expect(
      run('activate_scene', { entity_id: 'scene.evening' }),
    ).resolves.toMatchObject({ service: 'turn_on', accepted: true });
  });

  it('observes only returned devices and excludes hidden, disabled, or private data', async () => {
    const { run, action } = setup();
    const result = await run('get_home_state', { query: 'dimmer' });
    expect(result).toMatchObject({ devices: [expect.objectContaining({ entity_id: 'light.dimmer' })] });
    expect(JSON.stringify(result)).not.toContain('never-share-this');
    await expect(
      run('control_device', { entity_id: 'switch.coffee', action: 'turn_on' }),
    ).rejects.toThrow('Read get_home_state first');
    const all = await run('get_home_state');
    expect(JSON.stringify(all)).not.toContain('light.hidden');
    expect(JSON.stringify(all)).not.toContain('light.disabled');
    await expect(
      run('control_device', { entity_id: 'light.hidden', action: 'turn_off' }),
    ).rejects.toThrow('Read get_home_state first');
    expect(action).not.toHaveBeenCalled();
  });

  it('does not permit guessed identifiers or a device that was not returned due to the result limit', async () => {
    const { run, snapshot, action } = setup();
    snapshot.entities = Array.from({ length: 101 }, (_, index) =>
      entity(`light.lamp_${index}`, 'on'),
    );
    const result = await run('get_home_state');
    expect(result).toMatchObject({ truncated: true });
    if (!record(result)) throw new Error('Expected a home state object.');
    expect(result.devices).toHaveLength(100);
    await expect(
      run('control_device', {
        entity_id: 'light.lamp_100',
        action: 'turn_off',
      }),
    ).rejects.toThrow('Read get_home_state first');
    await expect(
      run('control_device', { entity_id: 'light.made_up', action: 'turn_off' }),
    ).rejects.toThrow('Read get_home_state first');
    expect(action).not.toHaveBeenCalled();
  });

  it.each([
    ['lock.front_door', 'turn_on'],
    ['alarm_control_panel.home', 'turn_off'],
    ['light.dimmer', 'unlock'],
    ['light.dimmer', 'homeassistant.restart'],
    ['sensor.temperature', 'turn_on'],
    ['cover.garage', 'set_blinds_position'],
    ['scene.evening', 'turn_on'],
  ])('rejects unsupported action %s → %s', async (entity_id, actionName) => {
    const { run, action } = setup();
    await run('get_home_state');
    await expect(
      run('control_device', { entity_id, action: actionName, value: 100 }),
    ).rejects.toThrow();
    expect(action).not.toHaveBeenCalled();
  });

  it('rejects arbitrary service tools and unsupported argument keys', async () => {
    const { run, action } = setup();
    await run('get_home_state');
    await expect(
      run('call_service', { domain: 'lock', service: 'unlock' }),
    ).rejects.toThrow('not available');
    await expect(
      run('control_device', {
        entity_id: 'light.dimmer',
        action: 'turn_off',
        service: 'unlock',
      }),
    ).rejects.toThrow('unsupported arguments');
    expect(action).not.toHaveBeenCalled();
  });

  it('checks capability flags before volume, dimming, and playback actions', async () => {
    const { run, action } = setup();
    await run('get_home_state');
    await expect(
      run('control_device', {
        entity_id: 'light.basic',
        action: 'set_brightness',
        value: 50,
      }),
    ).rejects.toThrow('not supported');
    for (const actionName of [
      'set_volume',
      'mute',
      'play',
      'next_track',
      'previous_track',
    ]) {
      await expect(
        run('control_device', {
          entity_id: 'media_player.basic',
          action: actionName,
          value: 50,
        }),
      ).rejects.toThrow('not supported');
    }
    expect(action).not.toHaveBeenCalled();
  });

  it.each([-1, 101, NaN, Infinity, '32', null])(
    'rejects invalid volume %s before dispatch',
    async (value) => {
      const { run, action } = setup();
      await run('get_home_state');
      await expect(
        run('control_device', {
          entity_id: 'media_player.sonos',
          action: 'set_volume',
          value,
        }),
      ).rejects.toThrow('number between 0 and 100');
      expect(action).not.toHaveBeenCalled();
    },
  );

  it('maps volume percentages to Home Assistant fractions and mute to booleans', async () => {
    const { run, action } = setup();
    await run('get_home_state');
    for (const value of [0, 32, 100])
      await run('control_device', {
        entity_id: 'media_player.sonos',
        action: 'set_volume',
        value,
      });
    await run('control_device', {
      entity_id: 'media_player.sonos',
      action: 'mute',
    });
    await run('control_device', {
      entity_id: 'media_player.sonos',
      action: 'unmute',
    });
    expect(
      action.mock.calls.map(([, service, data]) => [service, data]),
    ).toEqual([
      ['volume_set', { volume_level: 0 }],
      ['volume_set', { volume_level: 0.32 }],
      ['volume_set', { volume_level: 1 }],
      ['volume_mute', { is_volume_muted: true }],
      ['volume_mute', { is_volume_muted: false }],
    ]);
  });

  it('maps zero brightness to off and positive brightness to turn_on', async () => {
    const { run, action } = setup();
    await run('get_home_state');
    for (const value of [0, 1, 100])
      await run('control_device', {
        entity_id: 'light.dimmer',
        action: 'set_brightness',
        value,
      });
    expect(
      action.mock.calls.map(([, service, data]) => [service, data]),
    ).toEqual([
      ['turn_off', {}],
      ['turn_on', { brightness_pct: 1 }],
      ['turn_on', { brightness_pct: 100 }],
    ]);
  });

  it('honors thermostat bounds and only adjusts blind-like covers', async () => {
    const { run, action } = setup();
    await run('get_home_state');
    await expect(
      run('control_device', {
        entity_id: 'climate.lounge',
        action: 'set_temperature',
        value: 15,
      }),
    ).rejects.toThrow('between 16 and 28');
    await expect(
      run('control_device', {
        entity_id: 'climate.lounge',
        action: 'set_temperature',
        value: 29,
      }),
    ).rejects.toThrow('between 16 and 28');
    await run('control_device', {
      entity_id: 'climate.lounge',
      action: 'set_temperature',
      value: 21.5,
    });
    await run('control_device', {
      entity_id: 'cover.blinds',
      action: 'set_blinds_position',
      value: 40,
    });
    expect(
      action.mock.calls.map(([, service, data]) => [service, data]),
    ).toEqual([
      ['set_temperature', { temperature: 21.5 }],
      ['set_cover_position', { position: 40 }],
    ]);
  });

  it('rejects real home actions while offline but allows clearly labeled demo actions', async () => {
    const { run, context, action } = setup();
    context.demo = false;
    await expect(run('get_home_state')).resolves.toMatchObject({
      demo: false,
      connected: false,
    });
    await expect(
      run('control_device', { entity_id: 'light.dimmer', action: 'turn_off' }),
    ).rejects.toThrow('offline');
    expect(action).not.toHaveBeenCalled();
    context.demo = true;
    await expect(
      run('control_device', { entity_id: 'light.dimmer', action: 'turn_off' }),
    ).resolves.toMatchObject({ accepted: true, demo: true });
  });

  it('uses current availability and refuses unavailable scenes', async () => {
    const { run, snapshot, action } = setup();
    await run('get_home_state');
    const dimmer = snapshot.entities.find((item) => item.entity_id === 'light.dimmer');
    if (!dimmer) throw new Error('Missing dimmer fixture.');
    dimmer.state = 'unavailable';
    await expect(
      run('control_device', { entity_id: 'light.dimmer', action: 'turn_off' }),
    ).rejects.toThrow('unavailable');
    await expect(
      run('activate_scene', { entity_id: 'scene.unavailable' }),
    ).rejects.toThrow('available scene');
    await expect(
      run('activate_scene', { entity_id: 'light.basic' }),
    ).rejects.toThrow('available scene');
    expect(action).not.toHaveBeenCalled();
  });

  it('rejects every tool when the home session changes', async () => {
    const { run, context, action, launch } = setup();
    await run('get_home_state');
    await run('list_apps');
    context.sessionId = 'different-home';
    await expect(
      run('control_device', { entity_id: 'light.dimmer', action: 'turn_off' }),
    ).rejects.toThrow('connection changed');
    await expect(
      run('open_app', { package_name: 'com.sonos.acr2' }),
    ).rejects.toThrow('connection changed');
    await expect(run('get_home_state')).rejects.toThrow('connection changed');
    expect(action).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it('does not dispatch an action or open an app after cancellation', async () => {
    const { run, context, controller, action, launch } = setup();
    context.appsPreview = false;
    await run('get_home_state');
    await run('list_apps');
    controller.abort();
    await expect(
      run('control_device', { entity_id: 'light.dimmer', action: 'turn_off' }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await expect(
      run('open_app', { package_name: 'com.sonos.acr2' }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(action).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it('reuses identical confirmed actions even when argument key order changes', async () => {
    const { run, action } = setup();
    await run('get_home_state');
    await run('control_device', {
      entity_id: 'media_player.sonos',
      action: 'next_track',
    });
    await expect(
      run('control_device', {
        action: 'next_track',
        entity_id: 'media_player.sonos',
      }),
    ).resolves.toMatchObject({ already_completed: true });
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('never repeats a dispatched action whose result was rejected or unconfirmed', async () => {
    const { run, action } = setup();
    await run('get_home_state');
    action.mockResolvedValueOnce(false);
    const args = { entity_id: 'media_player.sonos', action: 'next_track' };
    await expect(run('control_device', args)).rejects.toThrow(
      'did not confirm',
    );
    await expect(run('control_device', args)).resolves.toMatchObject({
      already_attempted: true,
      accepted: false,
      status: 'unconfirmed',
    });
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('blocks a duplicate while the first action is still in flight', async () => {
    const { run, action } = setup();
    await run('get_home_state');
    let finish: (accepted: boolean) => void = () => { throw new Error('Missing pending action.'); };
    action.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const args = { entity_id: 'media_player.sonos', action: 'next_track' };
    const first = run('control_device', args);
    await expect(run('control_device', args)).resolves.toMatchObject({
      already_attempted: true,
      accepted: false,
      status: 'unconfirmed',
    });
    finish(true);
    await expect(first).resolves.toMatchObject({ accepted: true });
    expect(action).toHaveBeenCalledTimes(1);
  });
});

describe('Home Concierge app launching', () => {
  it('requires app discovery and clearly labels preview actions without opening anything', async () => {
    const { run, launch } = setup();
    await expect(
      run('open_app', { package_name: 'com.sonos.acr2' }),
    ).rejects.toThrow('list_apps');
    const apps = await run('list_apps', { query: 'sonos' });
    expect(apps).toEqual({
      preview: true,
      apps: [{ package_name: 'com.sonos.acr2', name: 'Sonos' }],
    });
    await expect(
      run('open_app', { package_name: 'com.spotify.music' }),
    ).rejects.toThrow('list_apps');
    await expect(
      run('open_app', { package_name: 'com.sonos.acr2' }),
    ).resolves.toMatchObject({ opened: false, preview: true });
    expect(launch).not.toHaveBeenCalled();
  });

  it('opens exactly the discovered package once', async () => {
    const { run, context, launch } = setup();
    context.appsPreview = false;
    await run('list_apps');
    const args = { package_name: 'com.sonos.acr2' };
    await expect(run('open_app', args)).resolves.toEqual({
      opened: true,
      name: 'Sonos',
    });
    await expect(run('open_app', args)).resolves.toMatchObject({
      already_completed: true,
    });
    expect(launch).toHaveBeenCalledExactlyOnceWith('com.sonos.acr2');
  });

  it('does not repeat an app launch after an ambiguous failure', async () => {
    const { run, context, launch } = setup();
    context.appsPreview = false;
    await run('list_apps');
    launch.mockRejectedValueOnce(new Error('Launcher response lost'));
    const args = { package_name: 'com.sonos.acr2' };
    await expect(run('open_app', args)).rejects.toThrow(
      'Launcher response lost',
    );
    await expect(run('open_app', args)).resolves.toMatchObject({
      already_attempted: true,
      opened: false,
      status: 'unconfirmed',
    });
    expect(launch).toHaveBeenCalledTimes(1);
  });
});

function setupHome() {
  const fixture = setup();
  const structure = {
    areas: [{ area_id: 'lounge', name: 'Lounge' }],
    devices: [{ id: 'speaker-device', name: 'Sonos', area_id: 'lounge' }],
    entities: [
      { entity_id: 'light.dimmer', name: 'Dimmer' },
      { entity_id: 'media_player.sonos', name: 'Sonos' },
    ],
    scenes: [{ entity_id: 'scene.evening', name: 'Evening' }],
  };
  const inspect = vi.fn<HomeSetup['inspect']>().mockResolvedValue(structure);
  const createRoom = vi.fn<HomeSetup['createRoom']>().mockResolvedValue({
    changed: true, demo: true, area: { area_id: 'office', name: 'Office' },
  });
  const renameRoom = vi.fn<HomeSetup['renameRoom']>().mockResolvedValue({ changed: true });
  const assignDevice = vi.fn<HomeSetup['assignDevice']>().mockResolvedValue({ changed: true });
  const assignEntity = vi.fn<HomeSetup['assignEntity']>().mockResolvedValue({ changed: true });
  const inspectMood = vi.fn<HomeSetup['inspectMood']>().mockResolvedValue({
    entity_id: 'scene.evening', editable: true,
    targets: [{ entity_id: 'light.dimmer', state: 'on', brightness_pct: 30 }],
  });
  const saveMood = vi.fn<HomeSetup['saveMood']>().mockResolvedValue({
    changed: true, entity_id: 'scene.hjem_cosyy', verification: 'saved',
  });
  const activateMood = vi.fn<HomeSetup['activateMood']>().mockResolvedValue({
    accepted: true, verified: false, status: 'partial', issues: ['One light did not respond.'],
  });
  const changes = vi.fn<HomeSetup['changes']>().mockReturnValue([
    { id: 'change-1', description: 'Created Office', createdAt: '2026-11-15T12:00:00Z' },
  ]);
  const undo = vi.fn<HomeSetup['undo']>().mockResolvedValue({ changed: true });
  const renameDevice = vi.fn<HomeSetup['renameDevice']>().mockResolvedValue({ changed: true });
  const renameEntity = vi.fn<HomeSetup['renameEntity']>().mockResolvedValue({ changed: true });
  const routines = {
    listRoutines: vi.fn<HomeSetup['listRoutines']>().mockResolvedValue({
      automations: [{ entity_id: 'automation.door_light', name: 'Door light', enabled: true }],
      scripts: [{ entity_id: 'script.movie_time', name: 'Movie time' }],
    }),
    inspectRoutine: vi.fn<HomeSetup['inspectRoutine']>().mockImplementation(async (entityId) => ({ entity_id: entityId, editable: true, config: {} })),
    describeRoutine: vi.fn<HomeSetup['describeRoutine']>().mockResolvedValue({ kind: 'automation', editable: true, when: [], conditions: [], then: [], problems: [] }),
    describeMood: vi.fn<HomeSetup['describeMood']>().mockResolvedValue([]),
    deviceTriggers: vi.fn<HomeSetup['deviceTriggers']>().mockResolvedValue({ triggers: [] }),
    saveAutomation: vi.fn<HomeSetup['saveAutomation']>().mockResolvedValue({ changed: true, entity_id: 'automation.new_one' }),
    saveScript: vi.fn<HomeSetup['saveScript']>().mockResolvedValue({ changed: true, entity_id: 'script.new_one' }),
    deleteRoutine: vi.fn<HomeSetup['deleteRoutine']>().mockResolvedValue({ changed: true }),
    setAutomationEnabled: vi.fn<HomeSetup['setAutomationEnabled']>().mockResolvedValue({ changed: true }),
    runRoutine: vi.fn<HomeSetup['runRoutine']>().mockResolvedValue({ accepted: true }),
    routineRuns: vi.fn<HomeSetup['routineRuns']>().mockResolvedValue({ runs: [] }),
    listHelpers: vi.fn<HomeSetup['listHelpers']>().mockResolvedValue({ helpers: [{ domain: 'input_boolean', helper_id: 'guest_mode', name: 'Guest mode' }] }),
    saveHelper: vi.fn<HomeSetup['saveHelper']>().mockResolvedValue({ changed: true, helper_id: 'new_helper' }),
    deleteHelper: vi.fn<HomeSetup['deleteHelper']>().mockResolvedValue({ changed: true }),
    deleteRoom: vi.fn<HomeSetup['deleteRoom']>().mockResolvedValue({ changed: true }),
    setEntityHidden: vi.fn<HomeSetup['setEntityHidden']>().mockResolvedValue({ changed: true }),
  };
  fixture.context.setup = {
    inspect, createRoom, renameRoom, assignDevice, assignEntity,
    renameDevice, renameEntity, inspectMood, saveMood, activateMood, changes, undo,
    ...routines,
  };
  return {
    ...fixture, structure, inspect, createRoom, renameRoom, assignDevice,
    assignEntity, inspectMood, saveMood, activateMood, changes, undo,
    renameDevice, renameEntity, ...routines,
  };
}

describe('Home Concierge room and mood setup', () => {
  it('requires structural discovery, then permits a new room to be used in the same turn', async () => {
    const { run, createRoom, assignDevice, controller } = setupHome();
    await expect(run('create_room', { name: 'Office' })).rejects.toThrow('list_home_structure');
    await run('get_home_state');
    await expect(run('create_room', { name: 'Office' })).rejects.toThrow('list_home_structure');
    expect(createRoom).not.toHaveBeenCalled();
    await run('list_home_structure');
    await run('create_room', { name: ' Office ' });
    await run('assign_device_to_room', { device_id: 'speaker-device', area_id: 'office' });
    expect(createRoom).toHaveBeenCalledExactlyOnceWith('Office', controller.signal);
    expect(assignDevice).toHaveBeenCalledExactlyOnceWith('speaker-device', 'office', controller.signal);
  });

  it('rejects guessed rooms and devices while allowing explicit unassignment and entity override removal', async () => {
    const { run, renameRoom, assignDevice, assignEntity, controller } = setupHome();
    await run('list_home_structure');
    await expect(run('rename_room', { area_id: 'guessed', name: 'Office' })).rejects.toThrow('Choose a room');
    await expect(run('assign_device_to_room', { device_id: 'speaker-device', area_id: 'guessed' })).rejects.toThrow('Choose a room');
    await expect(run('assign_device_to_room', { device_id: 'guessed', area_id: 'lounge' })).rejects.toThrow('Choose a device');
    await expect(run('assign_entity_to_room', { entity_id: 'light.guessed', area_id: 'lounge' })).rejects.toThrow('Choose an entity');
    expect(renameRoom).not.toHaveBeenCalled();
    expect(assignDevice).not.toHaveBeenCalled();
    expect(assignEntity).not.toHaveBeenCalled();
    await run('rename_room', { area_id: 'lounge', name: 'Living room' });
    await run('assign_device_to_room', { device_id: 'speaker-device', area_id: null });
    await run('assign_entity_to_room', { entity_id: 'light.dimmer', area_id: null });
    expect(renameRoom).toHaveBeenCalledExactlyOnceWith('lounge', 'Living room', controller.signal);
    expect(assignDevice).toHaveBeenCalledExactlyOnceWith('speaker-device', null, controller.signal);
    expect(assignEntity).toHaveBeenCalledExactlyOnceWith('light.dimmer', null, controller.signal);
  });

  it('does not authorize setup from malformed or failed discovery', async () => {
    const { run, inspect, createRoom, structure } = setupHome();
    inspect.mockResolvedValueOnce({ ...structure, entities: null });
    await expect(run('list_home_structure')).rejects.toThrow('structure could not be read');
    await expect(run('create_room', { name: 'Office' })).rejects.toThrow('list_home_structure');
    inspect.mockRejectedValueOnce(new Error('Registry permission denied'));
    await expect(run('list_home_structure')).rejects.toThrow('permission denied');
    await expect(run('create_room', { name: 'Office' })).rejects.toThrow('list_home_structure');
    expect(createRoom).not.toHaveBeenCalled();
  });

  it('only saves discovered mood targets and requires a fresh editable inspection for updates', async () => {
    const { run, saveMood, inspectMood, controller } = setupHome();
    const args = {
      name: 'Evening', entity_id: 'scene.evening',
      targets: [{ entity_id: 'light.dimmer', state: 'on', brightness_pct: 40 }],
    };
    await run('list_home_structure');
    await expect(run('save_mood', args)).rejects.toThrow('inspect_mood');
    await expect(run('inspect_mood', { entity_id: 'scene.guessed' })).rejects.toThrow('find the scene first');
    inspectMood.mockResolvedValueOnce({ entity_id: 'scene.evening', editable: false, issues: ['External scene'] });
    await run('inspect_mood', { entity_id: 'scene.evening' });
    await expect(run('save_mood', args)).rejects.toThrow('inspect_mood');
    await run('inspect_mood', { entity_id: 'scene.evening' });
    await run('save_mood', args);
    expect(saveMood).toHaveBeenCalledExactlyOnceWith(args, controller.signal);
    await expect(run('save_mood', { ...args, name: 'Evening revised' })).rejects.toThrow('inspect_mood');
    await expect(run('save_mood', {
      name: 'New mood', targets: [{ entity_id: 'light.guessed', state: 'off' }],
    })).rejects.toThrow('discover every mood target');
  });

  it.each([
    { entity_id: 'light.dimmer', state: 'on', brightness_pct: 101 },
    { entity_id: 'light.dimmer', state: 'on', brightness_pct: '40' },
    { entity_id: 'light.dimmer', state: 'on', color_temp_kelvin: Infinity },
    { entity_id: 'light.dimmer', state: 'on', temperature: null },
    { entity_id: 'light.dimmer', state: 'on', is_volume_muted: 1 },
    { entity_id: 'light.dimmer', state: 'on', service: 'homeassistant.restart' },
    { entity_id: 'light.dimmer', attributes: { brightness: 100 } },
  ])('rejects malformed mood settings before dispatch: %j', async (target) => {
    const { run, saveMood } = setupHome();
    await run('list_home_structure');
    await expect(run('save_mood', { name: 'Evening', targets: [target] })).rejects.toThrow();
    expect(saveMood).not.toHaveBeenCalled();
  });

  it('bounds mood size and rejects duplicate targets and empty names', async () => {
    const { run, saveMood, createRoom } = setupHome();
    await run('list_home_structure');
    const target = { entity_id: 'light.dimmer', state: 'off' };
    for (const targets of [[], Array.from({ length: 51 }, () => target), [target, target]])
      await expect(run('save_mood', { name: 'Evening', targets })).rejects.toThrow();
    await expect(run('save_mood', { name: ' ', targets: [target] })).rejects.toThrow('name');
    await expect(run('create_room', { name: ' ' })).rejects.toThrow('name');
    expect(saveMood).not.toHaveBeenCalled();
    expect(createRoom).not.toHaveBeenCalled();
  });

  it('never replays setup after ambiguous failure, including reordered nested mood settings', async () => {
    const { run, saveMood } = setupHome();
    await run('list_home_structure');
    saveMood.mockRejectedValueOnce(new Error('Response lost after saving'));
    await expect(run('save_mood', {
      name: 'Cosy', targets: [{ entity_id: 'light.dimmer', state: 'on', brightness_pct: 30 }],
    })).rejects.toThrow('Response lost');
    await expect(run('save_mood', {
      targets: [{ brightness_pct: 30, state: 'on', entity_id: 'light.dimmer' }], name: 'Cosy',
    })).resolves.toMatchObject({ already_attempted: true, status: 'unconfirmed' });
    expect(saveMood).toHaveBeenCalledTimes(1);
  });

  it('preserves partial verification results and can activate a scene created in this turn', async () => {
    const { run, activateMood, action, controller } = setupHome();
    await run('list_home_structure');
    await run('save_mood', { name: 'Cosy', targets: [{ entity_id: 'light.dimmer', state: 'on' }] });
    await expect(run('activate_scene', { entity_id: 'scene.hjem_cosyy' })).resolves.toMatchObject({
      accepted: true, verified: false, status: 'partial', issues: ['One light did not respond.'],
    });
    expect(activateMood).toHaveBeenCalledExactlyOnceWith('scene.hjem_cosyy', controller.signal);
    expect(action).not.toHaveBeenCalled();
  });

  it('requires listing undo history and rejects guessed change IDs', async () => {
    const { run, undo, controller } = setupHome();
    await expect(run('undo_setup_change', { change_id: 'change-1' })).rejects.toThrow('list_setup_changes');
    await run('list_setup_changes');
    await expect(run('undo_setup_change', { change_id: 'guessed' })).rejects.toThrow('list_setup_changes');
    expect(undo).not.toHaveBeenCalled();
    await run('undo_setup_change', { change_id: 'change-1' });
    expect(undo).toHaveBeenCalledExactlyOnceWith('change-1', controller.signal);
  });

  it('blocks writes while offline, after cancellation, and after home changes', async () => {
    const { run, context, controller, createRoom, inspect } = setupHome();
    context.demo = false;
    await expect(run('list_home_structure')).rejects.toThrow('offline');
    expect(inspect).not.toHaveBeenCalled();
    context.connected = true;
    await run('list_home_structure');
    controller.abort();
    await expect(run('create_room', { name: 'Office' })).rejects.toMatchObject({ name: 'AbortError' });
    expect(createRoom).not.toHaveBeenCalled();
    const other = setupHome();
    await other.run('list_home_structure');
    other.context.sessionId = 'different-home';
    await expect(other.run('create_room', { name: 'Office' })).rejects.toThrow('connection changed');
    expect(other.createRoom).not.toHaveBeenCalled();
  });

  it('does not accept a late discovery result after switching homes', async () => {
    const { run, inspect, structure, context } = setupHome();
    let finish: (value: unknown) => void = () => { throw new Error('Missing pending discovery.'); };
    inspect.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = run('list_home_structure');
    context.sessionId = 'different-home';
    finish(structure);
    await expect(pending).rejects.toThrow('connection changed');
  });
});

describe('Home Concierge automations, scripts, and helpers', () => {
  const automation = {
    name: 'Door light',
    triggers: [{ trigger: 'state', entity_id: 'binary_sensor.door', to: 'on' }],
    actions: [{ action: 'light.turn_on', target: { entity_id: 'light.desk' } }],
  };

  it('creates a routine directly but updates only one it has just inspected', async () => {
    const { run, saveAutomation, saveScript, controller } = setupHome();
    await run('save_automation', automation);
    expect(saveAutomation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: 'Door light', triggers: automation.triggers, actions: automation.actions }), controller.signal);
    // A routine created this turn is known, but still needs a read before it is replaced.
    await expect(run('save_automation', { ...automation, entity_id: 'automation.new_one', name: 'Door light 2' })).rejects.toThrow('inspect_routine');
    await expect(run('inspect_routine', { entity_id: 'automation.door_light' })).rejects.toThrow('list_routines');
    await run('list_routines');
    await run('inspect_routine', { entity_id: 'automation.door_light' });
    await run('save_automation', { ...automation, entity_id: 'automation.door_light', enabled: false });
    expect(saveAutomation).toHaveBeenLastCalledWith(expect.objectContaining({ entity_id: 'automation.door_light', enabled: false }), controller.signal);
    // Each update starts from a fresh read.
    await expect(run('save_automation', { ...automation, entity_id: 'automation.door_light', description: 'Again' })).rejects.toThrow('inspect_routine');
    await run('inspect_routine', { entity_id: 'script.movie_time' });
    await expect(run('save_automation', { ...automation, entity_id: 'script.movie_time' })).rejects.toThrow('inspect_routine');
    await run('save_script', { name: 'Movie time', entity_id: 'script.movie_time', sequence: automation.actions });
    expect(saveScript).toHaveBeenCalledOnce();
  });

  it('rejects malformed routine arguments before anything is sent', async () => {
    const { run, saveAutomation, saveHelper } = setupHome();
    await expect(run('save_automation', { ...automation, triggers: 'when the door opens' })).rejects.toThrow('triggers must be a list');
    await expect(run('save_automation', { ...automation, actions: ['turn on'] })).rejects.toThrow('actions must be a list');
    await expect(run('save_automation', { ...automation, enabled: 'yes' })).rejects.toThrow('enabled');
    await expect(run('save_automation', { ...automation, yaml: 'alias: x' })).rejects.toThrow('unsupported arguments');
    await expect(run('save_helper', { domain: 'shell_command', name: 'Run' })).rejects.toThrow('domain must be one of');
    await expect(run('save_helper', { domain: 'input_boolean', name: 'Guest mode', settings: 'on' })).rejects.toThrow('settings must be an object');
    expect(saveAutomation).not.toHaveBeenCalled();
    expect(saveHelper).not.toHaveBeenCalled();
  });

  it('deletes, pauses, and runs only listed routines, and deletes only after inspection', async () => {
    const { run, deleteRoutine, setAutomationEnabled, runRoutine, routineRuns, controller } = setupHome();
    for (const [name, args] of [
      ['delete_routine', { entity_id: 'automation.door_light' }],
      ['set_automation_enabled', { entity_id: 'automation.door_light', enabled: false }],
      ['run_routine', { entity_id: 'script.movie_time' }],
      ['get_routine_runs', { entity_id: 'automation.door_light' }],
    ] as const) await expect(run(name, args)).rejects.toThrow('list_routines');
    await run('list_routines');
    await expect(run('delete_routine', { entity_id: 'automation.door_light' })).rejects.toThrow('inspect_routine');
    await run('set_automation_enabled', { entity_id: 'automation.door_light', enabled: false });
    await run('run_routine', { entity_id: 'script.movie_time' });
    await run('get_routine_runs', { entity_id: 'automation.door_light' });
    await run('inspect_routine', { entity_id: 'automation.door_light' });
    await run('delete_routine', { entity_id: 'automation.door_light' });
    expect(setAutomationEnabled).toHaveBeenCalledExactlyOnceWith('automation.door_light', false, controller.signal);
    expect(runRoutine).toHaveBeenCalledExactlyOnceWith('script.movie_time', controller.signal);
    expect(routineRuns).toHaveBeenCalledOnce();
    expect(deleteRoutine).toHaveBeenCalledExactlyOnceWith('automation.door_light', controller.signal);
    await expect(run('run_routine', { entity_id: 'automation.door_light' })).rejects.toThrow('list_routines');
  });

  it('keeps helper, device, and room changes to discovered identifiers', async () => {
    const { run, saveHelper, deleteHelper, deviceTriggers, renameDevice, setEntityHidden, deleteRoom, controller } = setupHome();
    await expect(run('list_device_triggers', { device_id: 'speaker-device' })).rejects.toThrow('list_home_structure');
    await expect(run('rename_device', { device_id: 'speaker-device', name: 'Radio' })).rejects.toThrow('list_home_structure');
    await expect(run('delete_helper', { domain: 'input_boolean', helper_id: 'guest_mode' })).rejects.toThrow('list_helpers');
    await run('save_helper', { domain: 'input_number', name: 'Bedtime brightness', settings: { min: 1, max: 100 } });
    expect(saveHelper).toHaveBeenCalledExactlyOnceWith({ domain: 'input_number', name: 'Bedtime brightness', settings: { min: 1, max: 100 } }, controller.signal);
    await run('list_helpers');
    await run('delete_helper', { domain: 'input_boolean', helper_id: 'guest_mode' });
    expect(deleteHelper).toHaveBeenCalledExactlyOnceWith('input_boolean', 'guest_mode', controller.signal);
    await run('list_home_structure');
    await run('list_device_triggers', { device_id: 'speaker-device' });
    await run('rename_device', { device_id: 'speaker-device', name: ' Radio ' });
    await expect(run('set_entity_hidden', { entity_id: 'light.guessed', hidden: true })).rejects.toThrow('Choose an entity');
    await expect(run('delete_room', { area_id: 'guessed' })).rejects.toThrow('Choose a room');
    expect(deviceTriggers).toHaveBeenCalledOnce();
    expect(renameDevice).toHaveBeenCalledExactlyOnceWith('speaker-device', 'Radio', controller.signal);
    expect(setEntityHidden).not.toHaveBeenCalled();
    expect(deleteRoom).not.toHaveBeenCalled();
  });
});

describe('Home Concierge where Hjem is not the home screen', () => {
  it('has no app tools, and refuses them if asked anyway', async () => {
    const { run, context, launch } = setup();
    expect(toolsFor(context).map((definition) => definition.function.name)).toEqual(expect.arrayContaining(['list_apps', 'open_app']));
    context.appsAvailable = false;
    const names = toolsFor(context).map((definition) => definition.function.name);
    expect(names).not.toContain('list_apps');
    expect(names).not.toContain('open_app');
    expect(names).toEqual(expect.arrayContaining(['get_home_state', 'control_device', 'save_automation']));
    await expect(run('list_apps')).rejects.toThrow('not this device’s home screen');
    await expect(run('open_app', { package_name: 'com.sonos.acr2' })).rejects.toThrow('not this device’s home screen');
    expect(launch).not.toHaveBeenCalled();
    await expect(run('get_home_state')).resolves.toMatchObject({ devices: expect.any(Array) });
  });
});

describe('Home Concierge light colour', () => {
  it('sets colour and white only on lights that have them, within their range', async () => {
    const { run, context, action } = setup();
    context.snapshot = structuredClone(demoSnapshot);
    await run('get_home_state');
    await expect(run('control_device', { entity_id: 'light.kitchen', action: 'set_color', hue: 225, saturation: 100 })).resolves.toMatchObject({ accepted: true, hs_color: [225, 100] });
    expect(action).toHaveBeenLastCalledWith(expect.objectContaining({ entity_id: 'light.kitchen' }), 'turn_on', { hs_color: [225, 100] });
    await run('control_device', { entity_id: 'light.reading_lamp', action: 'set_color_temperature', value: 4000 });
    expect(action).toHaveBeenLastCalledWith(expect.objectContaining({ entity_id: 'light.reading_lamp' }), 'turn_on', { color_temp_kelvin: 4000 });
    // The reading lamp has white only, the pendant neither, and values stay in range.
    await expect(run('control_device', { entity_id: 'light.reading_lamp', action: 'set_color', hue: 0, saturation: 100 })).rejects.toThrow('not supported');
    await expect(run('control_device', { entity_id: 'light.living_pendant', action: 'set_color_temperature', value: 3000 })).rejects.toThrow('not supported');
    await expect(run('control_device', { entity_id: 'light.kitchen', action: 'set_color', hue: 400, saturation: 100 })).rejects.toThrow('hue must be');
    await expect(run('control_device', { entity_id: 'light.kitchen', action: 'set_color', hue: 10 })).rejects.toThrow('saturation must be');
    await expect(run('control_device', { entity_id: 'light.reading_lamp', action: 'set_color_temperature', value: 9000 })).rejects.toThrow('between 2200 and 6500');
    expect(action).toHaveBeenCalledTimes(2);
  });
});
