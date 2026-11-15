export interface HassEntity {
  entity_id: string;
  state: string;
  attributes: Record<string, any>;
  last_changed?: string;
  last_updated?: string;
}

export interface HassArea { area_id: string; name: string }
export interface HassDevice { id: string; area_id: string | null }
export interface HassEntityRegistryEntry {
  entity_id: string;
  area_id: string | null;
  device_id: string | null;
  hidden_by?: string | null;
  disabled_by?: string | null;
}
export interface HassSnapshot {
  entities: HassEntity[];
  areas: HassArea[];
  devices: HassDevice[];
  registry: HassEntityRegistryEntry[];
  locationName: string;
  unitSystem?: { temperature: string };
}
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';

interface Callbacks {
  onSnapshot: (snapshot: HassSnapshot) => void;
  onStatus: (status: ConnectionStatus, message?: string) => void;
}
interface PendingCommand {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
interface StateChange {
  entity_id: string;
  new_state: HassEntity | null;
  time_fired?: string;
}

const REQUEST_TIMEOUT = 12_000;
const CONNECTION_TIMEOUT = 15_000;
const emptySnapshot = (): HassSnapshot => ({ entities: [], areas: [], devices: [], registry: [], locationName: 'My home' });

/** Accept a server address, never credentials or a token in a URL. */
export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Enter your Home Assistant address.');
  let url: URL;
  try { url = new URL(trimmed.includes('://') ? trimmed : `http://${trimmed}`); }
  catch { throw new Error('Enter a valid Home Assistant address, such as http://homeassistant.local:8123.'); }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || !url.hostname) {
    throw new Error('Use an http:// or https:// Home Assistant address.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Use only your server address, without credentials, query parameters, or a fragment.');
  }
  url.protocol = url.protocol === 'https:' || url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = url.pathname.replace(/\/api\/websocket\/?$/, '').replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

/**
 * Home Assistant's authenticated WebSocket protocol. Credentials are kept in
 * memory only. Service commands are never replayed after a disconnect.
 */
export class HomeAssistantClient {
  private socket?: WebSocket;
  private serverUrl = '';
  private token = '';
  private generation = 0;
  private desired = false;
  private hasConnected = false;
  private ready = false;
  private authenticated = false;
  private nextId = 1;
  private subscriptionId?: number;
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

  connect(url: string, token: string): Promise<void> {
    let normalized: string;
    try {
      normalized = normalizeServerUrl(url);
      if (!token.trim()) throw new Error('Enter a Home Assistant long-lived access token.');
    } catch (error) { return Promise.reject(error); }
    this.stop(new Error('Connection replaced.'));
    this.serverUrl = normalized;
    this.token = token.trim();
    this.desired = true;
    this.hasConnected = false;
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

  async callService(domain: string, service: string, entityId: string, data: Record<string, unknown> = {}): Promise<void> {
    if (!this.ready) throw new Error('Home Assistant is not connected. Reconnect before controlling a device.');
    if (!domain || !service || !entityId) throw new Error('A service and target entity are required.');
    await this.command({ type: 'call_service', domain, service, target: { entity_id: entityId }, service_data: data });
  }

  private openSocket(): void {
    if (!this.desired) return;
    this.callbacks.onStatus(this.hasConnected ? 'reconnecting' : 'connecting');
    this.ready = false;
    this.authenticated = false;
    this.nextId = 1;
    this.subscriptionId = undefined;
    this.bufferedChanges = [];
    const generation = this.generation;
    const url = new URL(`${this.serverUrl}/api/websocket`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    let socket: WebSocket;
    try { socket = new WebSocket(url.toString()); }
    catch { this.fail(new Error('Could not open a connection. Check the server address and network access.')); return; }
    this.socket = socket;
    const current = () => this.socket === socket && this.generation === generation;
    this.connectionTimer = setTimeout(() => {
      if (current()) this.fail(new Error('Home Assistant did not respond. Check the address and that your device can reach the server.'));
    }, CONNECTION_TIMEOUT);
    socket.onmessage = (event) => {
      if (!current()) return;
      let message: any;
      try { message = JSON.parse(String(event.data)); }
      catch { this.fail(new Error('Home Assistant sent an invalid response.')); return; }
      for (const item of Array.isArray(message) ? message : [message]) {
        if (current()) this.receive(item, generation, socket);
      }
    };
    socket.onerror = () => {
      if (current()) this.fail(new Error('Unable to reach Home Assistant. Check the address, connection, and server certificate.'));
    };
    socket.onclose = () => {
      if (current()) this.fail(new Error('Connection to Home Assistant was lost.'));
    };
  }

  private receive(message: any, generation: number, socket: WebSocket): void {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'auth_required') {
      if (this.authenticated) return;
      try { socket.send(JSON.stringify({ type: 'auth', access_token: this.token })); }
      catch { this.fail(new Error('Could not authenticate with Home Assistant.')); }
    } else if (message.type === 'auth_invalid') {
      this.fail(new Error('Home Assistant rejected this token. Create a new long-lived access token in your Home Assistant profile.'), true);
    } else if (message.type === 'auth_ok' && !this.authenticated) {
      this.authenticated = true;
      void this.loadInitialState(generation, socket);
    } else if (message.type === 'result' || message.type === 'pong') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.type === 'pong' || message.success === true) pending.resolve(message.result);
      else pending.reject(new Error(typeof message.error?.message === 'string' ? message.error.message : 'Home Assistant could not complete this action.'));
    } else if (message.type === 'event' && message.id === this.subscriptionId && message.event?.event_type === 'state_changed') {
      const data = message.event.data;
      if (!data || typeof data.entity_id !== 'string' || !('new_state' in data)) return;
      const change: StateChange = { entity_id: data.entity_id, new_state: data.new_state, time_fired: message.event.time_fired };
      if (!this.ready) this.bufferedChanges.push(change);
      else {
        this.applyChange(change);
        this.callbacks.onSnapshot(this.snapshot);
      }
    }
  }

  private async loadInitialState(generation: number, socket: WebSocket): Promise<void> {
    const current = () => generation === this.generation && this.socket === socket;
    try {
      // Subscribe first; preserve changes that arrive while fetching the initial snapshot.
      this.subscriptionId = this.nextId;
      await this.command({ type: 'subscribe_events', event_type: 'state_changed' });
      if (!current()) return;
      const [entities, areas, devices, registry, config] = await Promise.all([
        this.command<HassEntity[]>({ type: 'get_states' }),
        this.command<HassArea[]>({ type: 'config/area_registry/list' }).catch(() => []),
        this.command<HassDevice[]>({ type: 'config/device_registry/list' }).catch(() => []),
        this.command<HassEntityRegistryEntry[]>({ type: 'config/entity_registry/list' }).catch(() => []),
        this.command<{ location_name?: string; unit_system?: { temperature: string } }>({ type: 'get_config' }).catch(() => ({} as { location_name?: string; unit_system?: { temperature: string } })),
      ]);
      if (!current()) return;
      if (!Array.isArray(entities)) throw new Error('Home Assistant returned an invalid device list.');
      this.snapshot = {
        entities,
        areas: Array.isArray(areas) ? areas : [],
        devices: Array.isArray(devices) ? devices : [],
        registry: Array.isArray(registry) ? registry : [],
        locationName: config?.location_name || 'My home',
        unitSystem: config?.unit_system,
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
      this.heartbeatTimer = setInterval(() => {
        if (current()) void this.command({ type: 'ping' }).catch(() => {
          if (current()) this.fail(new Error('Home Assistant stopped responding. Reconnecting…'));
        });
      }, 30_000);
    } catch (error) {
      if (current()) this.fail(error instanceof Error ? error : new Error('Unable to load your Home Assistant devices.'));
    }
  }

  private applyChange(change: StateChange): void {
    const previous = this.snapshot.entities.find((entity) => entity.entity_id === change.entity_id);
    const previousTime = Date.parse(previous?.last_updated || previous?.last_changed || '');
    const changedTime = Date.parse(change.new_state?.last_updated || change.new_state?.last_changed || change.time_fired || '');
    // A queued pre-snapshot event must not overwrite a newer get_states value.
    if (Number.isFinite(previousTime) && Number.isFinite(changedTime) && changedTime < previousTime) return;
    let entities: HassEntity[];
    if (change.new_state && typeof change.new_state.state === 'string') {
      const next = change.new_state;
      entities = previous
        ? this.snapshot.entities.map((entity) => entity.entity_id === change.entity_id ? next : entity)
        : [...this.snapshot.entities, next];
    } else {
      entities = this.snapshot.entities.filter((entity) => entity.entity_id !== change.entity_id);
    }
    this.snapshot = { ...this.snapshot, entities };
  }

  private command<T = unknown>(payload: Record<string, unknown>): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || !this.authenticated) {
      return Promise.reject(new Error('Home Assistant is not connected.'));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Home Assistant did not confirm the action. Check the device state before trying again.'));
      }, REQUEST_TIMEOUT);
      this.pending.set(id, { resolve, reject, timer });
      try { socket.send(JSON.stringify({ id, ...payload })); }
      catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('Could not send the action to Home Assistant.'));
      }
    });
  }

  private fail(error: Error, terminal = false): void {
    this.cleanSocket(error);
    if (!this.desired) return;
    if (!terminal && this.hasConnected) {
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
    this.token = '';
    clearTimeout(this.reconnectTimer);
    this.cleanSocket(error);
    this.initialReject?.(error);
    this.initialResolve = undefined;
    this.initialReject = undefined;
  }
}
