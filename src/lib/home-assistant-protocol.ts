import type { HelperDomain, RoutineKind } from './home-setup-types';
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
      ...(entry.aliases === undefined ? {} : { aliases: list(entry.aliases, 'area aliases', (alias) => string(alias, 'area alias')).sort() }),
      ...(entry.labels === undefined ? {} : { labels: list(entry.labels, 'area labels', (label) => string(label, 'area label')).sort() }),
      ...(entry.floor_id === undefined ? {} : { floor_id: nullableString(entry.floor_id, 'area floor') }),
      ...(entry.icon === undefined ? {} : { icon: nullableString(entry.icon, 'area icon') }),
      ...(entry.picture === undefined ? {} : { picture: nullableString(entry.picture, 'area picture') }),
      ...(entry.temperature_entity_id === undefined ? {} : { temperature_entity_id: nullableString(entry.temperature_entity_id, 'area temperature sensor') }),
      ...(entry.humidity_entity_id === undefined ? {} : { humidity_entity_id: nullableString(entry.humidity_entity_id, 'area humidity sensor') }),
    };
  });
}

/** Keep only well-formed [type, id] pairs; other integrations' extras are ignored. */
function pairs(value: unknown): [string, string][] | undefined {
  if (!isList(value)) return undefined;
  const result: [string, string][] = [];
  for (const item of value) {
    if (isList(item) && item.length === 2 && typeof item[0] === 'string' && typeof item[1] === 'string')
      result.push([item[0], item[1]]);
  }
  return result.length ? result : undefined;
}

export function parseDevices(value: unknown): HassDevice[] {
  return list(value, 'device registry', (entry) => {
    if (!isRecord(entry)) invalid('registered device');
    return {
      id: string(entry.id, 'device identifier'),
      area_id: nullableString(entry.area_id, 'device area'),
      ...(entry.name === undefined ? {} : { name: nullableString(entry.name, 'device name') }),
      ...(entry.name_by_user === undefined ? {} : { name_by_user: nullableString(entry.name_by_user, 'device name') }),
      ...(entry.manufacturer === undefined ? {} : { manufacturer: nullableString(entry.manufacturer, 'device manufacturer') }),
      ...(entry.model === undefined ? {} : { model: nullableString(entry.model, 'device model') }),
      ...(pairs(entry.identifiers) ? { identifiers: pairs(entry.identifiers) } : {}),
      ...(pairs(entry.connections) ? { connections: pairs(entry.connections) } : {}),
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
      ...(entry.name === undefined ? {} : { name: nullableString(entry.name, 'entity name') }),
      ...(entry.original_name === undefined ? {} : { original_name: nullableString(entry.original_name, 'original entity name') }),
      // Integrations may use numbers here; only text ids tie helpers and scripts to their entities.
      ...(typeof entry.unique_id === 'string' ? { unique_id: entry.unique_id } : {}),
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

/** Integrations that report physical button presses as bus events carrying a device id. */
export type RemoteEventType =
  | 'zha_event'
  | 'deconz_event'
  | 'hue_event'
  | 'zwave_js_value_notification'
  | 'lutron_caseta_button_event';
export const REMOTE_EVENT_TYPES: readonly RemoteEventType[] = [
  'zha_event',
  'deconz_event',
  'hue_event',
  'zwave_js_value_notification',
  'lutron_caseta_button_event',
];
const isRemoteEventType = (value: string): value is RemoteEventType =>
  REMOTE_EVENT_TYPES.some((type) => type === value);

export interface DeviceEvent {
  event_type: RemoteEventType;
  device_id: string;
  /** A short, human-readable description of what was pressed. */
  action: string;
  time_fired?: string;
}

function eventPart(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 60);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/** Each integration names its button payload differently; keep only display text. */
export function deviceEventAction(data: Record<string, unknown>): string {
  const command = eventPart(data.command) ?? eventPart(data.action);
  if (command) return command.replaceAll('_', ' ');
  const type = eventPart(data.type);
  const subtype = eventPart(data.subtype);
  if (type) return [type.replaceAll('_', ' '), subtype && `button ${subtype}`].filter(Boolean).join(' · ');
  const button = eventPart(data.button_number) ?? eventPart(data.button) ?? eventPart(data.label) ?? eventPart(data.property_key_name);
  const event = eventPart(data.event) ?? eventPart(data.value);
  if (button || event) return [button && `button ${button}`, event].filter(Boolean).join(' · ');
  return 'pressed';
}

export type ServerMessage =
  | { type: 'auth_required' | 'auth_ok' | 'auth_invalid' }
  | { type: 'pong'; id: number }
  | { type: 'result'; id: number; success: true; result: unknown }
  | { type: 'result'; id: number; success: false; error: string }
  | { type: 'state_changed'; id: number; change: StateChange }
  | { type: 'registry_updated'; id: number }
  | { type: 'device_event'; id: number; event: DeviceEvent }
  /** A Hjem hub's copy of the home; the connection parses it. */
  | { type: 'home_document'; id: number; data: unknown }
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
      if (!isRecord(value.event)) invalid('event');
      // Subscriptions such as ZHA pairing stream log entries rather than bus events.
      if (typeof value.event.event_type !== 'string') return { type: 'other_event', id };
      if (value.event.event_type === 'hjem_home') return { type: 'home_document', id, data: value.event.data };
      if (['area_registry_updated', 'device_registry_updated', 'entity_registry_updated'].includes(value.event.event_type))
        return { type: 'registry_updated', id };
      const eventType = value.event.event_type;
      if (isRemoteEventType(eventType)) {
        const data = value.event.data;
        // Unrecognised payloads are ignored rather than closing the connection.
        if (!isRecord(data) || typeof data.device_id !== 'string' || !data.device_id)
          return { type: 'other_event', id };
        return {
          type: 'device_event',
          id,
          event: {
            event_type: eventType,
            device_id: data.device_id,
            action: deviceEventAction(data),
            time_fired: timestamp(value.event.time_fired, 'event timestamp'),
          },
        };
      }
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
  | { type: 'subscribe_events'; event_type: 'state_changed' | 'area_registry_updated' | 'device_registry_updated' | 'entity_registry_updated' | RemoteEventType }
  | { type: 'config/area_registry/create'; name: string }
  | { type: 'config/area_registry/update'; area_id: string; name: string }
  | { type: 'config/area_registry/delete'; area_id: string }
  | { type: 'config/device_registry/update'; device_id: string; area_id: string | null }
  | { type: 'config/device_registry/update'; device_id: string; name_by_user: string | null }
  | { type: 'config/entity_registry/update'; entity_id: string; area_id: string | null }
  | { type: 'config/entity_registry/update'; entity_id: string; name: string | null }
  | { type: 'config/entity_registry/update'; entity_id: string; hidden_by: 'user' | null }
  | { type: 'search/related'; item_type: 'area'; item_id: string }
  | { type: 'hjem/home/subscribe' }
  | { type: 'validate_config'; triggers?: Record<string, unknown>[]; conditions?: Record<string, unknown>[]; actions?: Record<string, unknown>[] }
  | { type: 'device_automation/trigger/list'; device_id: string }
  | { type: 'trace/list'; domain: RoutineKind; item_id: string }
  | { type: `${HelperDomain}/list` }
  | ({ type: `${HelperDomain}/create` | `${HelperDomain}/update` | `${HelperDomain}/delete` } & Record<string, unknown>)
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
      target?: { entity_id: string | string[] };
      service_data: Record<string, unknown>;
      return_response?: true;
    }
  | { type: 'zha/devices/permit'; duration: number }
  | { type: 'unsubscribe_events'; subscription: number };
