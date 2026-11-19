import { parseCalendarEvents, type HassCalendarEvent } from './calendar';
import { parseSceneConfig, requestEditorConfig, requestSceneConfig, SceneRequestError } from './home-assistant-scenes';
import { parseConfiguration, type HjemConfiguration } from './home-configuration';
import {
  helperDomains,
  type HelperDomain,
  type HelperRecord,
  type HomeSetupTransport,
  type RoutineConfig,
  type RoutineKind,
  type RoutineParts,
  type RoutineService,
  type RoutineTrace,
  type RoutineValidation,
  type SceneConfig,
} from './home-setup-types';
import {
  HomeAssistantProtocolError,
  isEntityId,
  isRecord,
  parseAreas,
  parseConfig,
  parseDevices,
  parseEntities,
  parseRegistry,
  parseServerMessages,
  REMOTE_EVENT_TYPES,
  type ClientCommand,
  type DeviceEvent,
  type ServerMessage,
  type StateChange,
} from './home-assistant-protocol';

export interface HassEntity {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed?: string;
  last_updated?: string;
}

export interface HassArea {
  area_id: string;
  name: string;
  aliases?: string[];
  labels?: string[];
  floor_id?: string | null;
  icon?: string | null;
  picture?: string | null;
  temperature_entity_id?: string | null;
  humidity_entity_id?: string | null;
}
export interface HassDevice {
  id: string;
  area_id: string | null;
  name?: string | null;
  name_by_user?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  /** Integration identifiers, e.g. ['zha', '00:17:88:01:…']; stable across reinstalls. */
  identifiers?: [string, string][];
  /** Physical connections, e.g. ['zigbee', '00:17:88:01:…']. */
  connections?: [string, string][];
}
export interface HassEntityRegistryEntry {
  entity_id: string;
  platform?: string;
  area_id: string | null;
  device_id: string | null;
  hidden_by?: string | null;
  disabled_by?: string | null;
  name?: string | null;
  original_name?: string | null;
  /** The integration's own id for this entity; for helpers and scripts, their saved id. */
  unique_id?: string;
}
export interface HassSnapshot {
  entities: HassEntity[];
  areas: HassArea[];
  devices: HassDevice[];
  registry: HassEntityRegistryEntry[];
  locationName: string;
  unitSystem?: { temperature: string };
  structureStatus?: 'ready' | 'unavailable';
  structureError?: string;
}
/** Live activity that the Home planner uses to spot a pressed remote. */
export type HomeActivity =
  | { kind: 'device_event'; event: DeviceEvent }
  | { kind: 'state_changed'; change: StateChange };
export type ActivityListener = (activity: HomeActivity) => void;

/** How new Zigbee appliances join the network through Home Assistant. */
export type ZigbeeStack = 'zha' | 'zigbee2mqtt';
/** The longest pairing window both Zigbee stacks accept. */
export const MAX_PAIRING_SECONDS = 254;
export const ZIGBEE2MQTT_PERMIT_TOPIC = 'zigbee2mqtt/bridge/request/permit_join';

/** A Hjem hub between this device and the home, with its numbered copy of the home. */
export interface HubState {
  hubId: string;
  version: string;
  revision: number;
  updatedAt: string | null;
  /** Null until the hub has read the home for the first time. */
  document: HjemConfiguration | null;
}

export type ConnectionStatus =
  'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';

interface Callbacks {
  onSnapshot: (snapshot: HassSnapshot) => void;
  onStatus: (status: ConnectionStatus, message?: string) => void;
  /** Called when the connection turns out to be a Hjem hub, and for each new copy of the home. */
  onHub?: (hub: HubState) => void;
}
interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT = 12_000;
const CONNECTION_TIMEOUT = 15_000;
class ServerCommandError extends Error {}
const emptySnapshot = (): HassSnapshot => ({
  entities: [],
  areas: [],
  devices: [],
  registry: [],
  locationName: 'My home',
});

/** Accept a server address, never credentials or a token in a URL. */
export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Enter your Home Assistant address.');
  let url: URL;
  try {
    url = new URL(trimmed.includes('://') ? trimmed : `http://${trimmed}`);
  } catch {
    throw new Error(
      'Enter a valid Home Assistant address, such as http://homeassistant.local:8123.',
    );
  }
  if (
    !['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) ||
    !url.hostname
  ) {
    throw new Error('Use an http:// or https:// Home Assistant address.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      'Use only your server address, without credentials, query parameters, or a fragment.',
    );
  }
  url.protocol =
    url.protocol === 'https:' || url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = url.pathname
    .replace(/\/api\/websocket\/?$/, '')
    .replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

/**
 * Home Assistant's authenticated WebSocket protocol. This client keeps its
 * working credentials in memory; the app's storage layer handles persistence.
 * Service commands are never replayed after a disconnect.
 */
export class HomeAssistantClient implements HomeSetupTransport {
  private socket?: WebSocket;
  private serverUrl = '';
  private token = '';
  private generation = 0;
  private desired = false;
  private hasConnected = false;
  private retryInitial = false;
  private ready = false;
  private authenticated = false;
  private nextId = 1;
  private subscriptionId?: number;
  private registrySubscriptions = new Set<number>();
  private deviceEventSubscriptions = new Set<number>();
  private activityListeners = new Set<ActivityListener>();
  private pairingSubscriptions = new Set<number>();
  private homeSubscription?: number;
  private registryRefreshTimer?: ReturnType<typeof setTimeout>;
  private structureRevision = 0;
  private stateRefreshes = new Set<StateChange[]>();
  private httpRequests = new Set<AbortController>();
  private retryCount = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private connectionTimer?: ReturnType<typeof setTimeout>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private pending = new Map<number, PendingCommand>();
  private bufferedChanges: StateChange[] = [];
  private snapshot: HassSnapshot = emptySnapshot();
  private initialResolve?: () => void;
  private initialReject?: (error: Error) => void;

  constructor(private readonly callbacks: Callbacks) {}

  connect(
    url: string,
    token: string,
    options: { retryInitial?: boolean } = {},
  ): Promise<void> {
    let normalized: string;
    try {
      normalized = normalizeServerUrl(url);
      if (!token.trim())
        throw new Error('Enter a Home Assistant long-lived access token.');
      if (
        typeof location !== 'undefined' &&
        location.protocol === 'https:' &&
        normalized.startsWith('http:')
      )
        throw new Error(
          'This HTTPS page cannot connect to an HTTP Home Assistant server. Open Hjem on your tablet, or use an HTTPS Home Assistant address.',
        );
    } catch (error) {
      return Promise.reject(error);
    }
    this.stop(new Error('Connection replaced.'));
    this.serverUrl = normalized;
    this.token = token.trim();
    this.desired = true;
    this.hasConnected = false;
    this.retryInitial = options.retryInitial === true;
    this.retryCount = 0;
    this.snapshot = emptySnapshot();
    const promise = new Promise<void>((resolve, reject) => {
      this.initialResolve = resolve;
      this.initialReject = reject;
    });
    this.openSocket();
    return promise;
  }

  disconnect(): void {
    this.stop(new Error('Disconnected from Home Assistant.'));
    this.callbacks.onStatus('disconnected');
  }

  getSnapshot(): HassSnapshot {
    return this.snapshot;
  }

  /** Listen for button presses and state changes; returns an unsubscribe function. */
  onActivity(listener: ActivityListener): () => void {
    this.activityListeners.add(listener);
    return () => this.activityListeners.delete(listener);
  }

  private emitActivity(activity: HomeActivity): void {
    for (const listener of this.activityListeners) {
      try {
        listener(activity);
      } catch {
        // A view's listener must never break the connection.
      }
    }
  }

  private currentSession(): () => void {
    if (!this.ready) throw new Error('Home Assistant is offline. No setup change was sent.');
    const generation = this.generation;
    const socket = this.socket;
    return () => {
      if (!this.ready || generation !== this.generation || socket !== this.socket)
        throw new Error('The home connection changed. Check the current setup before continuing.');
    };
  }

  async refreshStructure(): Promise<HassSnapshot> {
    const check = this.currentSession();
    const revision = ++this.structureRevision;
    try {
      const [areas, devices, registry] = await Promise.all([
        this.command({ type: 'config/area_registry/list' }),
        this.command({ type: 'config/device_registry/list' }),
        this.command({ type: 'config/entity_registry/list' }),
      ]);
      check();
      const structure = { areas: parseAreas(areas), devices: parseDevices(devices), registry: parseRegistry(registry) };
      if (revision === this.structureRevision) {
        this.snapshot = { ...this.snapshot, ...structure, structureStatus: 'ready', structureError: undefined };
        this.callbacks.onSnapshot(this.snapshot);
      }
      return { ...this.snapshot, ...structure, structureStatus: 'ready', structureError: undefined };
    } catch (cause) {
      check();
      const error = new Error('Home Assistant’s room and device registry could not be read. Check this connection’s permissions before changing the setup.');
      if (revision === this.structureRevision) {
        this.snapshot = { ...this.snapshot, structureStatus: 'unavailable', structureError: error.message };
        this.callbacks.onSnapshot(this.snapshot);
      }
      if (cause instanceof HomeAssistantProtocolError) throw cause;
      throw error;
    }
  }

  async refreshStates(): Promise<HassSnapshot> {
    const check = this.currentSession();
    const changes: StateChange[] = [];
    this.stateRefreshes.add(changes);
    try {
      const entities = parseEntities(await this.command({ type: 'get_states' }));
      check();
      this.snapshot = { ...this.snapshot, entities };
      for (const change of changes) this.applyChange(change);
      this.callbacks.onSnapshot(this.snapshot);
      return this.snapshot;
    } finally {
      this.stateRefreshes.delete(changes);
    }
  }

  private async setupCommand(payload: ClientCommand): Promise<unknown> {
    const check = this.currentSession();
    try {
      const result = await this.command(payload);
      check();
      return result;
    } catch (error) {
      check();
      if (error instanceof ServerCommandError && /unauthori|permission|not allowed|admin/i.test(error.message))
        throw new SceneRequestError('Home Assistant administrator access is required to organize rooms and devices. Update the connection in Settings.', true);
      throw error;
    }
  }

  async createArea(name: string): Promise<HassArea> {
    this.validateRoomName(name);
    const areas = parseAreas([await this.setupCommand({ type: 'config/area_registry/create', name })]);
    const area = areas[0];
    if (!area) throw new Error('Home Assistant did not return the created room.');
    return area;
  }

  async renameArea(areaId: string, name: string): Promise<HassArea> {
    this.validateRegistryId(areaId);
    this.validateRoomName(name);
    const areas = parseAreas([await this.setupCommand({ type: 'config/area_registry/update', area_id: areaId, name })]);
    const area = areas[0];
    if (!area) throw new Error('Home Assistant did not return the updated room.');
    return area;
  }

  async deleteArea(areaId: string): Promise<void> {
    this.validateRegistryId(areaId);
    await this.setupCommand({ type: 'config/area_registry/delete', area_id: areaId });
  }

  async assignDeviceArea(deviceId: string, areaId: string | null): Promise<void> {
    this.validateRegistryId(deviceId);
    if (areaId !== null) this.validateRegistryId(areaId);
    await this.setupCommand({ type: 'config/device_registry/update', device_id: deviceId, area_id: areaId });
  }

  async assignEntityArea(entityId: string, areaId: string | null): Promise<void> {
    if (!isEntityId(entityId)) throw new Error('A registered entity is required.');
    if (areaId !== null) this.validateRegistryId(areaId);
    await this.setupCommand({ type: 'config/entity_registry/update', entity_id: entityId, area_id: areaId });
  }

  async renameDevice(deviceId: string, name: string | null): Promise<void> {
    this.validateRegistryId(deviceId);
    if (name !== null) this.validateDisplayName(name);
    await this.setupCommand({ type: 'config/device_registry/update', device_id: deviceId, name_by_user: name });
  }

  async renameEntity(entityId: string, name: string | null): Promise<void> {
    if (!isEntityId(entityId)) throw new Error('A registered entity is required.');
    if (name !== null) this.validateDisplayName(name);
    await this.setupCommand({ type: 'config/entity_registry/update', entity_id: entityId, name });
  }

  async relatedToArea(areaId: string): Promise<Record<string, string[]>> {
    this.validateRegistryId(areaId);
    const value = await this.setupCommand({ type: 'search/related', item_type: 'area', item_id: areaId });
    if (!isRecord(value)) throw new Error('Home Assistant returned invalid room dependencies.');
    const related: Record<string, string[]> = {};
    for (const [key, ids] of Object.entries(value)) {
      if (!Array.isArray(ids) || !ids.every((id): id is string => typeof id === 'string'))
        throw new Error('Home Assistant returned invalid room dependencies.');
      related[key] = ids;
    }
    return related;
  }

  /**
   * Open (or with 0 seconds, close) the Zigbee network so new appliances can join.
   * The network closes by itself when the time runs out.
   */
  async permitJoin(stack: ZigbeeStack, seconds: number): Promise<void> {
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > MAX_PAIRING_SECONDS)
      throw new Error(`Pairing can stay open for up to ${MAX_PAIRING_SECONDS} seconds.`);
    if (stack === 'zigbee2mqtt') {
      await this.setupCommand({
        type: 'call_service',
        domain: 'mqtt',
        service: 'publish',
        service_data: { topic: ZIGBEE2MQTT_PERMIT_TOPIC, payload: JSON.stringify({ value: seconds > 0, time: seconds }) },
      });
      return;
    }
    // ZHA answers with a subscription that streams pairing logs; keep only the latest.
    this.endPairingSubscriptions();
    const id = this.nextId;
    await this.setupCommand({ type: 'zha/devices/permit', duration: seconds });
    this.pairingSubscriptions.add(id);
    if (seconds === 0) this.endPairingSubscriptions();
  }

  private endPairingSubscriptions(): void {
    for (const subscription of this.pairingSubscriptions)
      void this.command({ type: 'unsubscribe_events', subscription }).catch(() => undefined);
    this.pairingSubscriptions.clear();
  }

  async readScene(configId: string): Promise<SceneConfig> {
    return parseSceneConfig(await this.sceneRequest('GET', configId));
  }

  async saveScene(configId: string, config: SceneConfig): Promise<void> {
    const value = await this.sceneRequest('POST', configId, parseSceneConfig(config));
    if (!isRecord(value) || value.result !== 'ok')
      throw new Error('Home Assistant did not confirm that the mood was saved. Read its configuration before retrying.');
  }

  async deleteScene(configId: string): Promise<void> {
    const value = await this.sceneRequest('DELETE', configId);
    if (!isRecord(value) || value.result !== 'ok')
      throw new Error('Home Assistant did not confirm that the mood was removed.');
  }

  async activateScene(entityId: string): Promise<void> {
    if (!/^scene\.[a-z0-9_]+$/.test(entityId)) throw new Error('A scene is required.');
    await this.callService('scene', 'turn_on', entityId);
  }

  private async sceneRequest(method: 'GET' | 'POST' | 'DELETE', configId: string, config?: SceneConfig): Promise<unknown> {
    const check = this.currentSession();
    const controller = new AbortController();
    this.httpRequests.add(controller);
    try {
      const value = await requestSceneConfig(this.serverUrl, this.token, method, configId, config, controller.signal);
      check();
      return value;
    } finally {
      this.httpRequests.delete(controller);
    }
  }

  async setEntityHidden(entityId: string, hidden: boolean): Promise<void> {
    if (!isEntityId(entityId)) throw new Error('A registered entity is required.');
    await this.setupCommand({ type: 'config/entity_registry/update', entity_id: entityId, hidden_by: hidden ? 'user' : null });
  }

  async readRoutine(kind: RoutineKind, configId: string): Promise<RoutineConfig> {
    const value = await this.routineRequest(kind, 'GET', configId);
    if (!isRecord(value)) throw new Error(`Home Assistant returned an invalid ${kind} configuration.`);
    return value;
  }

  async saveRoutine(kind: RoutineKind, configId: string, config: RoutineConfig): Promise<void> {
    const value = await this.routineRequest(kind, 'POST', configId, config);
    if (!isRecord(value) || value.result !== 'ok')
      throw new Error(`Home Assistant did not confirm that the ${kind} was saved. Read its configuration before retrying.`);
  }

  async deleteRoutine(kind: RoutineKind, configId: string): Promise<void> {
    const value = await this.routineRequest(kind, 'DELETE', configId);
    if (!isRecord(value) || value.result !== 'ok')
      throw new Error(`Home Assistant did not confirm that the ${kind} was removed.`);
  }

  private async routineRequest(kind: RoutineKind, method: 'GET' | 'POST' | 'DELETE', configId: string, config?: RoutineConfig): Promise<unknown> {
    const check = this.currentSession();
    const controller = new AbortController();
    this.httpRequests.add(controller);
    try {
      const value = await requestEditorConfig(kind, this.serverUrl, this.token, method, configId, config, controller.signal);
      check();
      return value;
    } finally {
      this.httpRequests.delete(controller);
    }
  }

  /** Home Assistant's own check of a routine; older servers that cannot check report `checked: false`. */
  async validateRoutine(parts: RoutineParts): Promise<RoutineValidation> {
    const check = this.currentSession();
    let value: unknown;
    try {
      value = await this.command({ type: 'validate_config', ...parts });
    } catch (error) {
      check();
      if (error instanceof ServerCommandError) return { checked: false, errors: [] };
      throw error;
    }
    check();
    if (!isRecord(value)) return { checked: false, errors: [] };
    const errors: string[] = [];
    for (const [part, result] of Object.entries(value)) {
      if (isRecord(result) && result.valid === false)
        errors.push(`${part}: ${typeof result.error === 'string' ? result.error.slice(0, 600) : 'not valid'}`);
    }
    return { checked: true, errors };
  }

  async deviceTriggers(deviceId: string): Promise<Record<string, unknown>[]> {
    this.validateRegistryId(deviceId);
    const value = await this.setupCommand({ type: 'device_automation/trigger/list', device_id: deviceId });
    return Array.isArray(value) ? value.filter(isRecord) : [];
  }

  async routineTraces(kind: RoutineKind, configId: string): Promise<RoutineTrace[]> {
    this.validateRegistryId(configId);
    const value = await this.setupCommand({ type: 'trace/list', domain: kind, item_id: configId });
    if (!Array.isArray(value)) return [];
    const short = (item: unknown) => typeof item === 'string' ? item.slice(0, 300) : undefined;
    return value.flatMap((entry: unknown): RoutineTrace[] => {
      if (!isRecord(entry) || typeof entry.run_id !== 'string') return [];
      const times = isRecord(entry.timestamp) ? entry.timestamp : {};
      return [{
        run_id: entry.run_id,
        started: short(times.start),
        finished: short(times.finish),
        result: short(entry.script_execution) ?? short(entry.state),
        trigger: short(entry.trigger),
        error: short(entry.error),
        last_step: short(entry.last_step),
      }];
    });
  }

  async routineService(kind: RoutineKind, service: RoutineService, entityId: string): Promise<void> {
    if (!entityId.startsWith(`${kind}.`) || (service === 'trigger' && kind !== 'automation'))
      throw new Error('That routine cannot be used this way.');
    await this.callService(kind, service, entityId);
  }

  private helperRecord(value: unknown): HelperRecord {
    if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string')
      throw new Error('Home Assistant returned an invalid helper.');
    return { ...value, id: value.id, name: value.name };
  }

  private validateHelper(domain: HelperDomain, helperId?: string): void {
    if (!helperDomains.includes(domain)) throw new Error('That kind of helper is not supported.');
    if (helperId !== undefined) this.validateRegistryId(helperId);
  }

  /** A helper type this Home Assistant has not loaded simply has no helpers. */
  async listHelpers(domain: HelperDomain): Promise<HelperRecord[]> {
    this.validateHelper(domain);
    const check = this.currentSession();
    try {
      const value = await this.command({ type: `${domain}/list` });
      check();
      return Array.isArray(value) ? value.map((entry: unknown) => this.helperRecord(entry)) : [];
    } catch (error) {
      check();
      if (error instanceof ServerCommandError) return [];
      throw error;
    }
  }

  async createHelper(domain: HelperDomain, fields: Record<string, unknown>): Promise<HelperRecord> {
    this.validateHelper(domain);
    const { id: _id, ...settings } = fields;
    return this.helperRecord(await this.setupCommand({ ...settings, type: `${domain}/create` }));
  }

  async updateHelper(domain: HelperDomain, helperId: string, fields: Record<string, unknown>): Promise<HelperRecord> {
    this.validateHelper(domain, helperId);
    // A setting named id would replace the command's own id.
    const { id: _id, ...settings } = fields;
    return this.helperRecord(await this.setupCommand({ ...settings, type: `${domain}/update`, [`${domain}_id`]: helperId }));
  }

  async deleteHelper(domain: HelperDomain, helperId: string): Promise<void> {
    this.validateHelper(domain, helperId);
    await this.setupCommand({ type: `${domain}/delete`, [`${domain}_id`]: helperId });
  }

  private validateRegistryId(id: string): void {
    if (!id.trim() || id.length > 250 || /[\u0000-\u001f]/.test(id)) throw new Error('A valid room or device identifier is required.');
  }

  private validateDisplayName(name: string): void {
    if (!name.trim() || name.length > 100 || /[\u0000-\u001f]/.test(name)) throw new Error('Choose a name between 1 and 100 characters.');
  }

  private validateRoomName(name: string): void {
    if (!name.trim() || name.length > 100 || /[\u0000-\u001f]/.test(name)) throw new Error('Choose a room name between 1 and 100 characters.');
  }

  async callService(
    domain: string,
    service: string,
    entityId: string,
    data: Record<string, unknown> = {},
  ): Promise<void> {
    if (!this.ready)
      throw new Error(
        'Home Assistant is not connected. Reconnect before controlling a device.',
      );
    if (
      !/^[a-z0-9_]+$/.test(domain) ||
      !/^[a-z0-9_]+$/.test(service) ||
      !isEntityId(entityId)
    )
      throw new Error('A service and target entity are required.');
    await this.command({
      type: 'call_service',
      domain,
      service,
      target: { entity_id: entityId },
      service_data: data,
    });
  }

  async getCalendarEvents(
    entityIds: string[],
    start: string,
    end: string,
  ): Promise<HassCalendarEvent[]> {
    if (!this.ready)
      throw new Error('Reconnect to Home Assistant to load your calendar.');
    const ids = [...new Set(entityIds)];
    if (!ids.length) return [];
    if (ids.some((id) => !/^calendar\.[a-z0-9_]+$/.test(id)))
      throw new Error('A calendar entity is required.');
    if (
      !Number.isFinite(Date.parse(start)) ||
      !Number.isFinite(Date.parse(end)) ||
      Date.parse(end) <= Date.parse(start)
    )
      throw new Error('A valid calendar date range is required.');
    const result = await this.command({
      type: 'call_service',
      domain: 'calendar',
      service: 'get_events',
      target: { entity_id: ids },
      service_data: { start_date_time: start, end_date_time: end },
      return_response: true,
    });
    return parseCalendarEvents(result, ids, start, end);
  }

  private openSocket(): void {
    if (!this.desired) return;
    this.callbacks.onStatus(
      this.hasConnected || this.retryCount > 0 ? 'reconnecting' : 'connecting',
    );
    this.ready = false;
    this.authenticated = false;
    this.nextId = 1;
    this.subscriptionId = undefined;
    this.homeSubscription = undefined;
    this.registrySubscriptions.clear();
    this.deviceEventSubscriptions.clear();
    this.bufferedChanges = [];
    const generation = this.generation;
    const url = new URL(`${this.serverUrl}/api/websocket`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    let socket: WebSocket;
    try {
      socket = new WebSocket(url.toString());
    } catch {
      this.fail(
        new Error(
          'Could not open a connection. Check the server address and network access.',
        ),
      );
      return;
    }
    this.socket = socket;
    const current = () =>
      this.socket === socket && this.generation === generation;
    this.connectionTimer = setTimeout(() => {
      if (current())
        this.fail(
          new Error(
            'Home Assistant did not respond. Check the address and that your device can reach the server.',
          ),
        );
    }, CONNECTION_TIMEOUT);
    socket.onmessage = (event) => {
      if (!current()) return;
      let messages: ServerMessage[];
      try {
        messages = parseServerMessages(event.data);
      } catch (error) {
        this.fail(
          error instanceof Error
            ? error
            : new Error('Home Assistant sent an invalid response.'),
          true,
        );
        return;
      }
      for (const item of messages) {
        if (current()) this.receive(item, generation, socket);
      }
    };
    socket.onerror = () => {
      if (current())
        this.fail(
          new Error(
            `Unable to reach Home Assistant at ${this.serverUrl}. Check that this device can open that address on the same Wi-Fi. For HTTPS, also check the server certificate.`,
          ),
        );
    };
    socket.onclose = () => {
      if (current())
        this.fail(new Error('Connection to Home Assistant was lost.'));
    };
  }

  private receive(
    message: ServerMessage,
    generation: number,
    socket: WebSocket,
  ): void {
    if (message.type === 'auth_required') {
      if (this.authenticated) return;
      try {
        socket.send(JSON.stringify({ type: 'auth', access_token: this.token }));
      } catch {
        this.fail(new Error('Could not authenticate with Home Assistant.'));
      }
    } else if (message.type === 'auth_invalid') {
      this.fail(
        new Error(
          'Home Assistant rejected this token. Create a new long-lived access token in your Home Assistant profile.',
        ),
        true,
      );
    } else if (message.type === 'auth_ok' && !this.authenticated) {
      this.authenticated = true;
      void this.loadInitialState(generation, socket);
    } else if (message.type === 'result' || message.type === 'pong') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.type === 'pong') pending.resolve(null);
      else if (message.success) pending.resolve(message.result);
      else pending.reject(new ServerCommandError(message.error));
    } else if (
      message.type === 'state_changed' &&
      message.id === this.subscriptionId
    ) {
      const change = message.change;
      for (const changes of this.stateRefreshes) changes.push(change);
      if (!this.ready) this.bufferedChanges.push(change);
      else {
        this.applyChange(change);
        this.callbacks.onSnapshot(this.snapshot);
        this.emitActivity({ kind: 'state_changed', change });
      }
    } else if (message.type === 'device_event' && this.deviceEventSubscriptions.has(message.id)) {
      this.emitActivity({ kind: 'device_event', event: message.event });
    } else if (message.type === 'home_document' && message.id === this.homeSubscription) {
      this.receiveHome(message.data);
    } else if (message.type === 'registry_updated' && this.registrySubscriptions.has(message.id)) {
      clearTimeout(this.registryRefreshTimer);
      this.registryRefreshTimer = setTimeout(() => {
        if (this.ready) void this.refreshStructure().catch(() => undefined);
      }, 100);
    }
  }

  private async loadInitialState(
    generation: number,
    socket: WebSocket,
  ): Promise<void> {
    const current = () =>
      generation === this.generation && this.socket === socket;
    try {
      // Subscribe first; preserve changes that arrive while fetching the initial snapshot.
      this.subscriptionId = this.nextId;
      await this.command({
        type: 'subscribe_events',
        event_type: 'state_changed',
      });
      if (!current()) return;
      const [entities, areas, devices, registry, config] = await Promise.all([
        this.command({ type: 'get_states' }),
        this.command({ type: 'config/area_registry/list' }).catch(
          () => undefined,
        ),
        this.command({
          type: 'config/device_registry/list',
        }).catch(() => undefined),
        this.command({
          type: 'config/entity_registry/list',
        }).catch(() => undefined),
        this.command({ type: 'get_config' }).catch(() => undefined),
      ]);
      if (!current()) return;
      this.snapshot = {
        entities: parseEntities(entities),
        areas: areas === undefined ? [] : parseAreas(areas),
        devices: devices === undefined ? [] : parseDevices(devices),
        registry: registry === undefined ? [] : parseRegistry(registry),
        structureStatus: areas === undefined || devices === undefined || registry === undefined ? 'unavailable' : 'ready',
        ...(areas === undefined || devices === undefined || registry === undefined ? {
          structureError: 'Home Assistant’s room and device registry could not be read. Check connection permissions before changing the setup.',
        } : {}),
        ...(config === undefined
          ? { locationName: 'My home' }
          : parseConfig(config)),
      };
      for (const change of this.bufferedChanges) this.applyChange(change);
      this.bufferedChanges = [];
      clearTimeout(this.connectionTimer);
      this.ready = true;
      this.hasConnected = true;
      this.retryCount = 0;
      this.callbacks.onSnapshot(this.snapshot);
      this.callbacks.onStatus('connected');
      this.initialResolve?.();
      this.initialResolve = undefined;
      this.initialReject = undefined;
      // These subscriptions must not delay ordinary controls for non-admin users.
      const registryEvents: Array<'area_registry_updated' | 'device_registry_updated' | 'entity_registry_updated'> = [
        'area_registry_updated', 'device_registry_updated', 'entity_registry_updated',
      ];
      for (const event_type of registryEvents) {
        const id = this.nextId;
        this.registrySubscriptions.add(id);
        void this.command({ type: 'subscribe_events', event_type }).catch(() => {
          if (current()) this.registrySubscriptions.delete(id);
        });
      }
      // Integrations that are not installed simply never send these events.
      for (const event_type of REMOTE_EVENT_TYPES) {
        const id = this.nextId;
        this.deviceEventSubscriptions.add(id);
        void this.command({ type: 'subscribe_events', event_type }).catch(() => {
          if (current()) this.deviceEventSubscriptions.delete(id);
        });
      }
      // Only a Hjem hub knows this command; Home Assistant itself answers that it does not.
      if (this.callbacks.onHub) {
        const homeId = this.nextId;
        this.homeSubscription = homeId;
        void this.command({ type: 'hjem/home/subscribe' })
          .then((value) => { if (current()) this.receiveHome(value); })
          .catch(() => { if (current() && this.homeSubscription === homeId) this.homeSubscription = undefined; });
      }
      this.heartbeatTimer = setInterval(() => {
        if (current())
          void this.command({ type: 'ping' }).catch(() => {
            if (current())
              this.fail(
                new Error('Home Assistant stopped responding. Reconnecting…'),
              );
          });
      }, 30_000);
    } catch (error) {
      if (current())
        this.fail(
          error instanceof Error
            ? error
            : new Error('Unable to load your Home Assistant devices.'),
          error instanceof HomeAssistantProtocolError ||
            error instanceof ServerCommandError,
        );
    }
  }

  private receiveHome(value: unknown): void {
    if (!isRecord(value) || typeof value.hub_id !== 'string' || !value.hub_id || value.hub_id.length > 100 ||
        typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0) return;
    let document: HjemConfiguration | null = null;
    try {
      if (value.document !== null && value.document !== undefined) document = parseConfiguration(JSON.stringify(value.document));
    } catch {
      // A copy this version cannot read is not kept; the connection itself is unaffected.
      return;
    }
    this.callbacks.onHub?.({
      hubId: value.hub_id,
      version: typeof value.version === 'string' ? value.version.slice(0, 40) : '',
      revision: value.revision,
      updatedAt: typeof value.updated_at === 'string' ? value.updated_at.slice(0, 40) : null,
      document,
    });
  }

  private applyChange(change: StateChange): void {
    const previous = this.snapshot.entities.find(
      (entity) => entity.entity_id === change.entity_id,
    );
    const previousTime = Date.parse(
      previous?.last_updated || previous?.last_changed || '',
    );
    const changedTime = Date.parse(
      change.new_state?.last_updated ||
        change.new_state?.last_changed ||
        change.time_fired ||
        '',
    );
    // A queued pre-snapshot event must not overwrite a newer get_states value.
    if (
      Number.isFinite(previousTime) &&
      Number.isFinite(changedTime) &&
      changedTime < previousTime
    )
      return;
    let entities: HassEntity[];
    if (change.new_state) {
      const next = change.new_state;
      entities = previous
        ? this.snapshot.entities.map((entity) =>
            entity.entity_id === change.entity_id ? next : entity,
          )
        : [...this.snapshot.entities, next];
    } else {
      entities = this.snapshot.entities.filter(
        (entity) => entity.entity_id !== change.entity_id,
      );
    }
    this.snapshot = { ...this.snapshot, entities };
  }

  private command(payload: ClientCommand): Promise<unknown> {
    const socket = this.socket;
    if (
      !socket ||
      socket.readyState !== WebSocket.OPEN ||
      !this.authenticated
    ) {
      return Promise.reject(new Error('Home Assistant is not connected.'));
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            'Home Assistant did not confirm the action. Check the device state before trying again.',
          ),
        );
      }, REQUEST_TIMEOUT);
      this.pending.set(id, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ id, ...payload }));
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('Could not send the action to Home Assistant.'));
      }
    });
  }

  private fail(error: Error, terminal = false): void {
    this.cleanSocket(error);
    if (!this.desired) return;
    if (!terminal && (this.hasConnected || this.retryInitial)) {
      this.callbacks.onStatus('reconnecting', error.message);
      const delay = Math.min(1_000 * 2 ** this.retryCount++, 30_000);
      this.reconnectTimer = setTimeout(() => this.openSocket(), delay);
    } else {
      this.desired = false;
      this.token = '';
      this.callbacks.onStatus('error', error.message);
      this.initialReject?.(error);
      this.initialResolve = undefined;
      this.initialReject = undefined;
    }
  }

  private cleanSocket(error: Error): void {
    this.ready = false;
    this.authenticated = false;
    clearTimeout(this.connectionTimer);
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.registryRefreshTimer);
    this.registrySubscriptions.clear();
    this.deviceEventSubscriptions.clear();
    this.pairingSubscriptions.clear();
    this.stateRefreshes.clear();
    for (const controller of this.httpRequests) controller.abort();
    this.httpRequests.clear();
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      socket.close();
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.bufferedChanges = [];
  }

  private stop(error: Error): void {
    this.generation++;
    this.desired = false;
    this.retryInitial = false;
    this.token = '';
    clearTimeout(this.reconnectTimer);
    this.cleanSocket(error);
    this.initialReject?.(error);
    this.initialResolve = undefined;
    this.initialReject = undefined;
  }
}
