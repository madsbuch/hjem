import { describe, expect, it } from 'vitest';
import {
  parseAreas, parseConfig, parseDevices, parseEntities, parseRegistry,
  parseServerMessages,
} from './home-assistant-protocol';

const entity = {
  entity_id: 'media_player.sonos', state: 'playing',
  attributes: { friendly_name: 'Living room', volume_level: 0.4, nested: { tracks: ['one', 2, null] } },
  last_updated: '2026-11-15T10:00:00+01:00',
};

describe('Home Assistant protocol decoding', () => {
  it('preserves opaque attributes without pretending they have a known type', () => {
    const decoded = parseEntities([entity]);
    expect(decoded[0].attributes).toEqual(entity.attributes);
    expect(decoded[0].attributes).not.toBe(entity.attributes);
    expect(parseAreas([{ area_id: 'living', name: 'Living room', extra: true }])).toEqual([{ area_id: 'living', name: 'Living room' }]);
    expect(parseDevices([{ id: 'speaker' }])).toEqual([{ id: 'speaker', area_id: null }]);
    expect(parseRegistry([{ entity_id: 'media_player.sonos', platform: 'sonos', hidden_by: 'user' }])).toMatchObject([{ device_id: null, area_id: null, platform: 'sonos', hidden_by: 'user' }]);
    expect(parseConfig({ location_name: 'Home', unit_system: { temperature: '°C', length: 'km' } })).toEqual({ locationName: 'Home', unitSystem: { temperature: '°C' } });
  });

  it.each([
    { label: 'non-array snapshot', value: {} },
    { label: 'missing attributes', value: [{ entity_id: 'light.a', state: 'on' }] },
    { label: 'array attributes', value: [{ ...entity, attributes: [] }] },
    { label: 'invalid state', value: [{ ...entity, state: { on: true } }] },
    { label: 'invalid identifier', value: [{ ...entity, entity_id: 'not an entity' }] },
    { label: 'invalid timestamp', value: [{ ...entity, last_updated: 'yesterday' }] },
    { label: 'duplicate identifier', value: [entity, entity] },
  ])('rejects $label', ({ value }) => {
    expect(() => parseEntities(value)).toThrow('Home Assistant returned an invalid');
  });

  it.each([
    { label: 'invalid JSON', raw: '{' },
    { label: 'nontext frame', raw: new Uint8Array([1]) },
    { label: 'nonobject frame', raw: 'null' },
    { label: 'unknown type', raw: '{"type":"unexpected"}' },
    { label: 'string command id', raw: '{"type":"pong","id":"1"}' },
    { label: 'missing result', raw: '{"type":"result","id":1,"success":true}' },
    { label: 'nonboolean success', raw: '{"type":"result","id":1,"success":"true","result":null}' },
    { label: 'nonstring error', raw: '{"type":"result","id":1,"success":false,"error":{"message":{}}}' },
    { label: 'missing new state', raw: '{"type":"event","id":1,"event":{"event_type":"state_changed","data":{"entity_id":"light.a"}}}' },
  ])('rejects $label before delivery', ({ raw }) => {
    expect(() => parseServerMessages(raw)).toThrow('Home Assistant returned an invalid');
  });

  it('decodes null deletions, errors, and heartbeat replies', () => {
    expect(parseServerMessages(JSON.stringify([
      { type: 'event', id: 1, event: { event_type: 'state_changed', data: { entity_id: 'light.a', new_state: null } } },
      { type: 'result', id: 2, success: false, error: { code: 'not_allowed', message: 'Permission denied' } },
      { type: 'pong', id: 3 },
    ]))).toEqual([
      { type: 'state_changed', id: 1, change: { entity_id: 'light.a', new_state: null } },
      { type: 'result', id: 2, success: false, error: 'Permission denied' },
      { type: 'pong', id: 3 },
    ]);
  });

  it('validates optional registry/configuration fields when present', () => {
    expect(() => parseAreas([{ area_id: 'room', name: 4 }])).toThrow('area name');
    expect(() => parseDevices([{ id: 'speaker', area_id: [] }])).toThrow('device area');
    expect(() => parseRegistry([{ entity_id: 'light.a', disabled_by: false }])).toThrow('entity availability');
    expect(() => parseConfig({ unit_system: { temperature: false } })).toThrow('temperature unit');
  });
});
