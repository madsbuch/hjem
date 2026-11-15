import { parseCalendarEvents, type HassCalendarEvent } from './calendar';
import { parseSceneConfig, requestSceneConfig, SceneRequestError } from './home-assistant-scenes';
import type { HomeSetupTransport, SceneConfig } from './home-setup-types';
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
  type ClientCommand,
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
export type ConnectionStatus =
  'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';

interface Callbacks {
  onSnapshot: (snapshot: HassSnapshot) => void;
  onStatus: (status: ConnectionStatus, message?: string) => void;
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

  private validateRegistryId(id: string): void {
    if (!id.trim() || id.length > 250 || /[\u0000-\u001f]/.test(id)) throw new Error('A valid room or device identifier is required.');
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
    this.registrySubscriptions.clear();
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
      }
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
