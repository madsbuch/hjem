import type {
  HassArea,
  HassDevice,
  HassEntity,
  HassEntityRegistryEntry,
} from './home-assistant';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isList(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

export const isEntityId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z0-9_]+\.[a-z0-9_]+$/.test(value);

export class HomeAssistantProtocolError extends Error {}

function invalid(detail: string): never {
  throw new HomeAssistantProtocolError(
    `Home Assistant returned an invalid ${detail}.`,
  );
}

function string(value: unknown, detail: string): string {
  if (typeof value !== 'string') invalid(detail);
  return value;
}

function optionalString(value: unknown, detail: string): string | undefined {
  return value === undefined ? undefined : string(value, detail);
}

function nullableString(value: unknown, detail: string): string | null {
  return value === undefined || value === null ? null : string(value, detail);
}

function timestamp(value: unknown, detail: string): string | undefined {
  const text = optionalString(value, detail);
  if (text !== undefined && !Number.isFinite(Date.parse(text))) invalid(detail);
  return text;
}

function entityId(value: unknown): string {
  if (!isEntityId(value)) invalid('entity identifier');
  return value;
}

function commandId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    invalid('message identifier');
  return value;
}

export function parseEntity(value: unknown): HassEntity {
  if (!isRecord(value) || !isRecord(value.attributes)) invalid('device state');
  return {
    entity_id: entityId(value.entity_id),
    state: string(value.state, 'device state'),
    attributes: { ...value.attributes },
    last_changed: timestamp(value.last_changed, 'state timestamp'),
    last_updated: timestamp(value.last_updated, 'state timestamp'),
  };
}

function list<T>(
  value: unknown,
  detail: string,
  parse: (entry: unknown) => T,
): T[] {
  if (!isList(value)) invalid(detail);
  return value.map(parse);
}

export function parseEntities(value: unknown): HassEntity[] {
  const entities = list(value, 'device list', parseEntity);
  const ids = new Set(entities.map((entity) => entity.entity_id));
  if (ids.size !== entities.length)
    invalid('device list with duplicate identifiers');
  return entities;
}

export function parseAreas(value: unknown): HassArea[] {
  return list(value, 'area list', (entry) => {
    if (!isRecord(entry)) invalid('area');
    return {
      area_id: string(entry.area_id, 'area identifier'),
      name: string(entry.name, 'area name'),
    };
  });
}

export function parseDevices(value: unknown): HassDevice[] {
  return list(value, 'device registry', (entry) => {
    if (!isRecord(entry)) invalid('registered device');
    return {
      id: string(entry.id, 'device identifier'),
      area_id: nullableString(entry.area_id, 'device area'),
    };
  });
}

export function parseRegistry(value: unknown): HassEntityRegistryEntry[] {
  return list(value, 'entity registry', (entry) => {
    if (!isRecord(entry)) invalid('registered entity');
    return {
      entity_id: entityId(entry.entity_id),
      platform: optionalString(entry.platform, 'entity platform'),
      area_id: nullableString(entry.area_id, 'entity area'),
      device_id: nullableString(entry.device_id, 'entity device'),
      hidden_by: nullableString(entry.hidden_by, 'entity visibility'),
      disabled_by: nullableString(entry.disabled_by, 'entity availability'),
    };
  });
}

export function parseConfig(value: unknown): {
  locationName: string;
  unitSystem?: { temperature: string };
} {
  if (!isRecord(value)) invalid('home configuration');
  const locationName =
    optionalString(value.location_name, 'home name') || 'My home';
  if (value.unit_system === undefined) return { locationName };
  if (!isRecord(value.unit_system)) invalid('unit system');
  return {
    locationName,
    unitSystem: {
      temperature: string(value.unit_system.temperature, 'temperature unit'),
    },
  };
}

export interface StateChange {
  entity_id: string;
  new_state: HassEntity | null;
  time_fired?: string;
}

export type ServerMessage =
  | { type: 'auth_required' | 'auth_ok' | 'auth_invalid' }
  | { type: 'pong'; id: number }
  | { type: 'result'; id: number; success: true; result: unknown }
  | { type: 'result'; id: number; success: false; error: string }
  | { type: 'state_changed'; id: number; change: StateChange }
  | { type: 'other_event'; id: number };

function parseMessage(value: unknown): ServerMessage {
  if (!isRecord(value)) invalid('WebSocket message');
  switch (value.type) {
    case 'auth_required':
    case 'auth_ok':
    case 'auth_invalid':
      return { type: value.type };
    case 'pong':
      return { type: 'pong', id: commandId(value.id) };
    case 'result': {
      const id = commandId(value.id);
      if (value.success === true && Object.hasOwn(value, 'result'))
        return { type: 'result', id, success: true, result: value.result };
      if (value.success === false && isRecord(value.error))
        return {
          type: 'result',
          id,
          success: false,
          error: string(value.error.message, 'command error'),
        };
      invalid('command result');
    }
    case 'event': {
      const id = commandId(value.id);
      if (!isRecord(value.event) || typeof value.event.event_type !== 'string')
        invalid('event');
      if (value.event.event_type !== 'state_changed')
        return { type: 'other_event', id };
      const data = value.event.data;
      if (!isRecord(data)) invalid('state change');
      const entity_id = entityId(data.entity_id);
      const new_state =
        data.new_state === null ? null : parseEntity(data.new_state);
      if (new_state && new_state.entity_id !== entity_id)
        invalid('state change with mismatched identifiers');
      return {
        type: 'state_changed',
        id,
        change: {
          entity_id,
          new_state,
          time_fired: timestamp(value.event.time_fired, 'event timestamp'),
        },
      };
    }
    default:
      invalid('WebSocket message type');
  }
}

/** Validate the complete coalesced frame before publishing any contained state. */
export function parseServerMessages(raw: unknown): ServerMessage[] {
  if (typeof raw !== 'string') invalid('WebSocket text frame');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    invalid('JSON response');
  }
  return isList(value) ? value.map(parseMessage) : [parseMessage(value)];
}

export type ClientCommand =
  | { type: 'subscribe_events'; event_type: 'state_changed' }
  | {
      type:
        | 'get_states'
        | 'get_config'
        | 'config/area_registry/list'
        | 'config/device_registry/list'
        | 'config/entity_registry/list'
        | 'ping';
    }
  | {
      type: 'call_service';
      domain: string;
      service: string;
      target: { entity_id: string | string[] };
      service_data: Record<string, unknown>;
      return_response?: true;
    };
