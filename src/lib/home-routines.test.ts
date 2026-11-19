import { describe, expect, it } from 'vitest';
import { demoRoutineConfigs, demoSnapshot } from './demo';
import {
  compileAutomation,
  compileHelper,
  compileScript,
  describeParts,
  normalizeRoutine,
  routineProblems,
  slugify,
} from './home-routines';

const snapshot = structuredClone(demoSnapshot);
const doorOpens = { trigger: 'state', entity_id: 'binary_sensor.front_door', to: 'on' };
const lampOn = { action: 'light.turn_on', target: { entity_id: 'light.reading_lamp' }, data: { brightness_pct: 60 } };
const automation = (actions: unknown, triggers: unknown = [doorOpens], conditions?: unknown) =>
  compileAutomation({ name: 'Test', triggers, conditions, actions }, 'Test', snapshot);

describe('compiling routines', () => {
  it('stores an automation in Home Assistant’s current format', () => {
    expect(automation([lampOn], doorOpens, [{ condition: 'sun', after: 'sunset' }])).toEqual({
      alias: 'Test', description: '', mode: 'single',
      triggers: [doorOpens], conditions: [{ condition: 'sun', after: 'sunset' }], actions: [lampOn],
    });
  });

  it('keeps settings it does not author and drops the older key names when updating', () => {
    const previous = { id: 'abc', alias: 'Old', description: 'Kept', mode: 'restart', trigger: [doorOpens], action: [lampOn], max: 3, variables: { level: 40 } };
    expect(compileAutomation({ name: 'New', triggers: [doorOpens], actions: [lampOn] }, 'New', snapshot, previous)).toEqual({
      alias: 'New', description: 'Kept', mode: 'restart', max: 3, variables: { level: 40 },
      triggers: [doorOpens], conditions: [], actions: [lampOn],
    });
    expect(normalizeRoutine('automation', previous)).toMatchObject({ triggers: [doorOpens], actions: [lampOn] });
    expect(normalizeRoutine('automation', previous)).not.toHaveProperty('trigger');
  });

  it('refuses devices, rooms, and entities that are not in the home', () => {
    expect(() => automation([{ action: 'light.turn_on', target: { entity_id: 'light.guessed' } }])).toThrow('light.guessed');
    expect(() => automation([lampOn], [{ trigger: 'state', entity_id: ['binary_sensor.front_door', 'binary_sensor.back_door'] }])).toThrow('binary_sensor.back_door');
    expect(() => automation([{ action: 'light.turn_off', target: { area_id: 'attic' } }])).toThrow('attic');
    expect(() => automation([lampOn], [{ trigger: 'device', device_id: 'unknown-device', domain: 'zha', type: 'remote_button_short_press' }])).toThrow('unknown-device');
    expect(() => automation([{ choose: [{ conditions: [], sequence: [{ action: 'switch.turn_on', entity_id: 'switch.guessed' }] }] }])).toThrow('switch.guessed');
  });

  it('accepts device triggers, templates, and nested steps that Home Assistant will check', () => {
    const config = automation(
      [{ if: [{ condition: 'template', value_template: "{{ is_state('light.kitchen', 'off') }}" }], then: [lampOn], else: [{ delay: { minutes: 5 } }, { action: 'scene.turn_on', target: { entity_id: 'scene.cosy_evening' } }] }],
      [{ trigger: 'device', device_id: 'demo_remote_dimmer', domain: 'zha', type: 'remote_button_short_press', subtype: 'turn_on', entity_id: '0f3a9c2b7d1e4f6a8b5c0d9e2f1a3b4c' }],
    );
    expect(config.actions).toHaveLength(1);
    expect(automation([{ action: 'light.turn_off', target: { entity_id: 'all' } }, { action: 'notify.mobile_app_phone', data: { message: 'Door', action: 'lock.unlock' } }]).actions).toHaveLength(2);
  });

  it('keeps locks, alarms, and system services out of unattended routines', () => {
    for (const action of [
      { action: 'shell_command.restart_router' },
      { service: 'hassio.host_shutdown' },
      { action: 'homeassistant.restart' },
      { action: 'mqtt.publish', data: { topic: 'zigbee2mqtt/bridge/request/permit_join', payload: 'true' } },
      { action: 'lock.unlock', target: { entity_id: 'lock.front_door' } },
      { repeat: { count: 2, sequence: [{ action: 'python_script.run' }] } },
      { parallel: [{ action: 'alarm_control_panel.alarm_disarm' }] },
    ]) expect(() => automation([action]), JSON.stringify(action)).toThrow(/does not set up routines/);
    expect(() => automation([{ action: '{{ states("input_text.service") }}' }])).toThrow('templated service');
    expect(() => automation([{ service_template: 'light.turn_{{ mode }}' }])).toThrow('templated service');
    expect(() => automation([{ device_id: 'demo_light_kitchen', domain: 'lock', type: 'unlock' }])).toThrow('locks or alarms');
    const withLock = { ...snapshot, entities: [...snapshot.entities, { entity_id: 'lock.front_door', state: 'locked', attributes: {} }] };
    expect(() => compileAutomation({ name: 'x', triggers: [doorOpens], actions: [{ action: 'homeassistant.turn_off', target: { entity_id: 'lock.front_door' } }] }, 'x', withLock)).toThrow('locks or alarms');
    // Reading a lock is fine: a light may follow the door being unlocked.
    expect(compileAutomation({ name: 'x', triggers: [{ trigger: 'state', entity_id: 'lock.front_door', to: 'unlocked' }], actions: [lampOn] }, 'x', withLock).triggers).toHaveLength(1);
    expect(automation([{ action: 'homeassistant.turn_off', target: { entity_id: 'light.kitchen' } }]).actions).toHaveLength(1);
  });

  it('bounds the shape and size of what it saves', () => {
    expect(() => automation([])).toThrow('at least one');
    expect(() => automation([lampOn], [])).toThrow('at least one');
    expect(() => automation(['turn on the lamp'])).toThrow('Actions must be a list');
    expect(() => automation(Array.from({ length: 61 }, () => lampOn))).toThrow('up to 60');
    expect(() => automation([{ action: 'notify.notify', data: { message: 'x'.repeat(70_000) } }])).toThrow('too large');
    let nested: Record<string, unknown> = lampOn;
    for (let depth = 0; depth < 30; depth++) nested = { sequence: [nested] };
    expect(() => automation([nested])).toThrow('nested too deeply');
    expect(() => compileAutomation({ name: 'x', triggers: [doorOpens], actions: [lampOn], mode: 'forever' }, 'x', snapshot)).toThrow('mode must be');
    expect(() => compileScript({ name: 'x', sequence: [lampOn], icon: '<script>' }, 'x', snapshot)).toThrow('icon');
    expect(compileScript({ name: 'Film', sequence: lampOn, icon: 'mdi:movie' }, 'Film', snapshot)).toEqual({ alias: 'Film', description: '', mode: 'single', icon: 'mdi:movie', sequence: [lampOn] });
  });
});

describe('describing routines in plain language', () => {
  it('summarises the sample routines', () => {
    expect(describeParts('automation', demoRoutineConfigs.automation.demo_welcome_light ?? {}, snapshot)).toEqual({
      when: ['Front door opens'], conditions: ['It is after sunset'], then: ['Turn on Reading lamp (60%)'],
    });
    expect(describeParts('automation', demoRoutineConfigs.automation.demo_bedside_dimmer ?? {}, snapshot).when).toEqual(['Dimmer switch: on']);
    expect(describeParts('automation', demoRoutineConfigs.automation.demo_wake_up ?? {}, snapshot)).toEqual({
      when: ['At Wake-up time'], conditions: ['It is a weekday'],
      then: ['Set position of Bedroom blinds (100%)', 'Turn on Bedside lamp (30%)'],
    });
    expect(describeParts('script', demoRoutineConfigs.script.movie_time ?? {}, snapshot)).toEqual({
      when: [], conditions: [], then: ['Activate Cosy evening', 'Pause Kitchen Sonos'],
    });
  });

  it('describes older key names and unfamiliar steps without failing', () => {
    const parts = describeParts('automation', {
      trigger: [{ platform: 'numeric_state', entity_id: 'sensor.hallway_temperature', below: 18 }, { platform: 'sun', event: 'sunset', offset: '-00:30:00' }, { platform: 'tag', tag_id: 'x' }],
      condition: { condition: 'or', conditions: [{ condition: 'state', entity_id: 'light.kitchen', state: 'off' }, { condition: 'time', after: '22:00:00', weekday: ['sat', 'sun'] }] },
      action: [{ delay: { minutes: 5, seconds: 30 } }, { service: 'climate.set_temperature', entity_id: 'climate.living_room', data: { temperature: 21 } }, { something_new: true }],
    }, snapshot);
    expect(parts.when).toEqual(['Hallway temperature drops below 18', 'At sunset (00:30:00 before)', 'Tag trigger']);
    expect(parts.conditions).toEqual(['Any of: Kitchen lights is off; It is the weekend, after 22:00:00']);
    expect(parts.then).toEqual(['Wait 5 minutes 30 seconds', 'Set temperature of Living room climate (21°)', 'A custom step']);
  });

  it('reports devices a routine can no longer reach', () => {
    const gone = { ...snapshot, entities: snapshot.entities.filter((entity) => entity.entity_id !== 'light.reading_lamp').map((entity) => entity.entity_id === 'binary_sensor.front_door' ? { ...entity, state: 'unavailable' } : entity) };
    expect(routineProblems('automation', demoRoutineConfigs.automation.demo_welcome_light ?? {}, gone)).toEqual(['Front door is unavailable.', 'light.reading_lamp is missing.']);
    expect(routineProblems('automation', demoRoutineConfigs.automation.demo_welcome_light ?? {}, snapshot)).toEqual([]);
  });

  it('makes script ids Home Assistant accepts', () => {
    expect(slugify('  Godnat, børn & blæsevejr! ')).toBe('godnat_born_blaesevejr');
    expect(slugify('Café №5')).toBe('cafe_no5');
    expect(slugify('!!!')).toBe('');
  });
});

describe('helper settings', () => {
  it('keeps the settings each kind has', () => {
    expect(compileHelper('input_number', { min: 1, max: 100, step: 5, unit_of_measurement: '%' }, true)).toEqual({ min: 1, max: 100, step: 5, unit_of_measurement: '%' });
    expect(compileHelper('input_select', { options: ['Home', 'Away'] }, true)).toEqual({ options: ['Home', 'Away'] });
    expect(compileHelper('input_boolean', { icon: 'mdi:account' }, true)).toEqual({ icon: 'mdi:account' });
    expect(compileHelper('input_number', { max: 50 }, false)).toEqual({ max: 50 });
  });

  it('refuses unknown settings, wrong types, and incomplete new helpers', () => {
    expect(() => compileHelper('input_boolean', { initial: true }, true)).toThrow('no initial setting');
    expect(() => compileHelper('input_boolean', { constructor: 'x' }, true)).toThrow('no constructor setting');
    expect(() => compileHelper('input_number', { min: '1', max: 5 }, true)).toThrow('min must be a number');
    expect(() => compileHelper('input_number', { min: 5, max: 5 }, true)).toThrow('min below max');
    expect(() => compileHelper('input_select', {}, true)).toThrow('options list');
    expect(() => compileHelper('input_select', { options: [] }, true)).toThrow('options must be');
    expect(() => compileHelper('input_datetime', { has_date: false }, true)).toThrow('has_date or has_time');
  });
});
