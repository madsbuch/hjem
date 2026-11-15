import { describe, expect, it, vi } from 'vitest';
import {
  createConciergeExecutor,
  type ConciergeContext,
} from './concierge-tools';
import type { HassEntity, HassSnapshot } from './home-assistant';

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
    const result = (await run('get_home_state', { query: 'dimmer' })) as {
      devices: unknown[];
      scenes: unknown[];
    };
    expect(result.devices).toHaveLength(1);
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
    const result = (await run('get_home_state')) as {
      truncated: boolean;
      devices: unknown[];
    };
    expect(result.truncated).toBe(true);
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
    snapshot.entities.find((item) => item.entity_id === 'light.dimmer')!.state =
      'unavailable';
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
    let finish!: (accepted: boolean) => void;
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
