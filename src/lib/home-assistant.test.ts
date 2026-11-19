import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HomeAssistantClient,
  normalizeServerUrl,
  type HassEntity,
  type HassSnapshot,
} from './home-assistant';
import { isRecord } from './home-assistant-protocol';

function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('Expected a test value.');
  return value;
}

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 1;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: Record<string, unknown>[] = [];
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    const value: unknown = JSON.parse(data);
    if (!isRecord(value)) throw new Error('Expected an outgoing command object.');
    this.sent.push(value);
  }
  close() {
    this.readyState = 3;
  }
  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  answer(type: string, result: unknown, success = true) {
    const request = [...this.sent]
      .reverse()
      .find((message) => message.type === type);
    if (!request) throw new Error(`No ${type} command sent`);
    this.receive({
      id: request.id,
      type: 'result',
      success,
      result,
      error: success ? undefined : { message: String(result) },
    });
  }
  state(entityId: string, entity: HassEntity | null, time?: string) {
    this.receive({
      id: this.sent.find((message) => message.type === 'subscribe_events')?.id,
      type: 'event',
      event: {
        event_type: 'state_changed',
        data: { entity_id: entityId, new_state: entity },
        time_fired: time,
      },
    });
  }
  loseConnection() {
    this.readyState = 3;
    this.onclose?.();
  }
}

const entity = (
  state = 'off',
  timestamp = '2026-11-15T09:00:00Z',
): HassEntity => ({
  entity_id: 'light.kitchen',
  state,
  attributes: { friendly_name: 'Kitchen' },
  last_updated: timestamp,
});
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
const clients: HomeAssistantClient[] = [];

function setup(options: { retryInitial?: boolean } = {}) {
  const snapshots: HassSnapshot[] = [];
  const onStatus = vi.fn();
  const client = new HomeAssistantClient({
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onStatus,
  });
  clients.push(client);
  const connection = client.connect(
    'http://homeassistant.local:8123',
    'secret-test-token',
    options,
  );
  const socket = required(FakeSocket.instances.at(-1));
  return { client, connection, socket, snapshots, onStatus };
}

async function authenticate(socket: FakeSocket) {
  socket.receive({ type: 'auth_required' });
  socket.receive({ type: 'auth_ok' });
  socket.answer('subscribe_events', null);
  await flush();
}

async function initialSnapshot(
  socket: FakeSocket,
  entities: HassEntity[] = [entity()],
) {
  socket.answer('get_states', entities);
  socket.answer('config/area_registry/list', [
    { area_id: 'kitchen', name: 'Kitchen' },
  ]);
  socket.answer('config/device_registry/list', [
    { id: 'device1', area_id: 'kitchen' },
  ]);
  socket.answer('config/entity_registry/list', [
    { entity_id: 'light.kitchen', area_id: null, device_id: 'device1' },
  ]);
  socket.answer('get_config', {
    location_name: 'Our home',
    unit_system: { temperature: '°C' },
  });
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket);
});
afterEach(() => {
  clients.splice(0).forEach((client) => client.disconnect());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Home Assistant setup transport', () => {
  it('retains registry data and marks a failed refresh unavailable instead of inventing an empty home', async () => {
    const { client, connection, socket } = setup();
    await authenticate(socket);
    await initialSnapshot(socket);
    await connection;
    expect(client.getSnapshot().structureStatus).toBe('ready');
    const refresh = client.refreshStructure();
    const rejected = expect(refresh).rejects.toThrow('permissions');
    socket.answer('config/area_registry/list', 'Permission denied', false);
    socket.answer('config/device_registry/list', []);
    socket.answer('config/entity_registry/list', []);
    await rejected;
    expect(client.getSnapshot().structureStatus).toBe('unavailable');
    expect(client.getSnapshot().areas).toEqual([{ area_id: 'kitchen', name: 'Kitchen' }]);
  });

  it('uses fixed registry commands and refreshes rooms when Home Assistant publishes a registry event', async () => {
    const { client, connection, socket } = setup();
    await authenticate(socket);
    await initialSnapshot(socket);
    await connection;
    const creation = client.createArea('Office');
    socket.answer('config/area_registry/create', { area_id: 'office', name: 'Office' });
    expect(await creation).toEqual({ area_id: 'office', name: 'Office' });
    const move = client.assignDeviceArea('device1', 'office');
    expect(socket.sent.at(-1)).toMatchObject({ type: 'config/device_registry/update', device_id: 'device1', area_id: 'office' });
    socket.answer('config/device_registry/update', { id: 'device1', area_id: 'office' });
    await move;
    const subscription = required(socket.sent.find((request) => request.event_type === 'device_registry_updated'));
    socket.receive({ type: 'event', id: subscription.id, event: { event_type: 'device_registry_updated', data: { action: 'update', device_id: 'device1' } } });
    await vi.advanceTimersByTimeAsync(100);
    socket.answer('config/area_registry/list', [{ area_id: 'office', name: 'Office' }]);
    socket.answer('config/device_registry/list', [{ id: 'device1', name: 'Desk lamp', area_id: 'office' }]);
    socket.answer('config/entity_registry/list', [{ entity_id: 'light.kitchen', area_id: null, device_id: 'device1' }]);
    await flush();
    expect(client.getSnapshot().devices).toContainEqual({ id: 'device1', name: 'Desk lamp', area_id: 'office' });
    expect(client.getSnapshot().areas).toEqual([{ area_id: 'office', name: 'Office' }]);
  });

  it('does not publish refreshes from a replaced connection', async () => {
    const { client, connection, socket, snapshots } = setup();
    await authenticate(socket);
    await initialSnapshot(socket);
    await connection;
    const refresh = client.refreshStructure();
    const rejection = expect(refresh).rejects.toThrow('connection changed');
    client.disconnect();
    const count = snapshots.length;
    await rejection;
    expect(snapshots).toHaveLength(count);
  });

  it('replays state events arriving during a state refresh', async () => {
    const { client, connection, socket } = setup();
    await authenticate(socket);
    await initialSnapshot(socket);
    await connection;
    const refresh = client.refreshStates();
    socket.state('light.kitchen', entity('on', '2026-11-15T09:00:02Z'));
    socket.answer('get_states', [entity('off', '2026-11-15T09:00:01Z')]);
    expect((await refresh).entities[0].state).toBe('on');
  });
});

describe('Home planner transport', () => {
  async function connected() {
    const context = setup();
    await authenticate(context.socket);
    await initialSnapshot(context.socket);
    await context.connection;
    return context;
  }

  it('opens and closes ZHA pairing, tolerating its streamed log entries', async () => {
    const { client, socket, onStatus } = await connected();
    const opening = client.permitJoin('zha', 254);
    const request = required(socket.sent.at(-1));
    expect(request).toMatchObject({ type: 'zha/devices/permit', duration: 254 });
    socket.answer('zha/devices/permit', null);
    await opening;
    socket.receive({ id: request.id, type: 'event', event: { type: 'log_output', log_entry: { message: 'Device joined' } } });
    expect(onStatus).not.toHaveBeenCalledWith('error', expect.anything());
    const closing = client.permitJoin('zha', 0);
    expect(socket.sent.at(-2)).toEqual({ id: expect.any(Number), type: 'unsubscribe_events', subscription: request.id });
    expect(socket.sent.at(-1)).toMatchObject({ type: 'zha/devices/permit', duration: 0 });
    socket.answer('zha/devices/permit', null);
    await closing;
    expect(socket.sent.at(-1)).toMatchObject({ type: 'unsubscribe_events' });
    await expect(client.permitJoin('zha', 255)).rejects.toThrow('254 seconds');
  });

  it('opens Zigbee2MQTT pairing through its MQTT bridge topic', async () => {
    const { client, socket } = await connected();
    const opening = client.permitJoin('zigbee2mqtt', 254);
    expect(socket.sent.at(-1)).toMatchObject({
      type: 'call_service', domain: 'mqtt', service: 'publish',
      service_data: { topic: 'zigbee2mqtt/bridge/request/permit_join', payload: '{"value":true,"time":254}' },
    });
    expect(socket.sent.at(-1)).not.toHaveProperty('target');
    socket.answer('call_service', null);
    await opening;
  });

  it('subscribes to button events, forwards them to listeners, and renames devices', async () => {
    const { client, socket } = await connected();
    const zha = required(socket.sent.find((request) => request.event_type === 'zha_event'));
    const activity = vi.fn();
    const stop = client.onActivity(activity);
    socket.receive({ id: zha.id, type: 'event', event: { event_type: 'zha_event', data: { device_id: 'remote', command: 'toggle' } } });
    expect(activity).toHaveBeenCalledWith({ kind: 'device_event', event: { event_type: 'zha_event', device_id: 'remote', action: 'toggle' } });
    stop();
    socket.receive({ id: zha.id, type: 'event', event: { event_type: 'zha_event', data: { device_id: 'remote', command: 'off' } } });
    expect(activity).toHaveBeenCalledTimes(1);
    const renaming = client.renameDevice('device1', 'Desk lamp');
    expect(socket.sent.at(-1)).toMatchObject({ type: 'config/device_registry/update', device_id: 'device1', name_by_user: 'Desk lamp' });
    socket.answer('config/device_registry/update', { id: 'device1', area_id: 'kitchen' });
    await renaming;
  });
});

describe('Home Assistant connection', () => {
  it('retries an offline saved session until its first successful connection', async () => {
    const { connection, socket, onStatus } = setup({ retryInitial: true });
    const resolved = vi.fn();
    void connection.then(resolved);
    socket.onerror?.();
    expect(onStatus).toHaveBeenLastCalledWith('reconnecting', expect.stringContaining('homeassistant.local:8123'));
    await vi.advanceTimersByTimeAsync(1_000);
    const next = required(FakeSocket.instances.at(-1));
    expect(next).not.toBe(socket);
    expect(onStatus).toHaveBeenLastCalledWith('reconnecting');
    expect(resolved).not.toHaveBeenCalled();
    await authenticate(next);
    await initialSnapshot(next);
    await connection;
    expect(resolved).toHaveBeenCalledOnce();
    expect(onStatus).toHaveBeenLastCalledWith('connected');
  });

  it('stops saved-session retries on disconnect and on rejected credentials', async () => {
    const first = setup({ retryInitial: true });
    first.socket.loseConnection();
    const cancelled = expect(first.connection).rejects.toThrow('Disconnected');
    first.client.disconnect();
    await cancelled;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
    const second = setup({ retryInitial: true });
    second.socket.receive({ type: 'auth_invalid' });
    await expect(second.connection).rejects.toThrow('rejected this token');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it('fails a manual offline connection promptly with its address and no token', async () => {
    const { connection, socket } = setup();
    socket.onerror?.();
    await expect(connection).rejects.toThrow('Unable to reach Home Assistant at http://homeassistant.local:8123');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('rejects HTTP from an HTTPS preview before creating a socket', async () => {
    vi.stubGlobal('location', { protocol: 'https:' });
    const client = new HomeAssistantClient({ onSnapshot: vi.fn(), onStatus: vi.fn() });
    await expect(client.connect('http://192.168.1.105:8123', 'test-token')).rejects.toThrow('HTTPS page cannot connect');
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it('rejects malformed initial states even when saved-session network retries are enabled', async () => {
    const { connection, socket, snapshots } = setup({ retryInitial: true });
    const rejected = expect(connection).rejects.toThrow('invalid device state');
    await authenticate(socket);
    socket.answer('get_states', [{ entity_id: 'light.kitchen', state: 'on', attributes: [] }]);
    socket.answer('config/area_registry/list', []);
    socket.answer('config/device_registry/list', []);
    socket.answer('config/entity_registry/list', []);
    socket.answer('get_config', {});
    await rejected;
    expect(snapshots).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('rejects malformed registry data instead of publishing an unchecked snapshot', async () => {
    const { connection, socket, snapshots } = setup();
    const rejected = expect(connection).rejects.toThrow('invalid entity visibility');
    await authenticate(socket);
    socket.answer('get_states', [entity()]);
    socket.answer('config/area_registry/list', []);
    socket.answer('config/device_registry/list', []);
    socket.answer('config/entity_registry/list', [{ entity_id: 'light.kitchen', hidden_by: true }]);
    socket.answer('get_config', {});
    await rejected;
    expect(snapshots).toEqual([]);
  });

  it('validates coalesced state changes atomically and rejects pending actions on protocol failure', async () => {
    const { client, connection, socket, snapshots, onStatus } = setup();
    await authenticate(socket);
    await initialSnapshot(socket);
    await connection;
    const action = client.callService('light', 'turn_on', 'light.kitchen');
    const rejected = expect(action).rejects.toThrow('invalid state change');
    const subscription = required(socket.sent.find((command) => command.type === 'subscribe_events'));
    socket.receive([
      { type: 'event', id: subscription.id, event: { event_type: 'state_changed', data: { entity_id: 'light.kitchen', new_state: entity('on') } } },
      { type: 'event', id: subscription.id, event: { event_type: 'state_changed', data: { entity_id: 'light.kitchen', new_state: { ...entity(), entity_id: 'lock.front' } } } },
    ]);
    await rejected;
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].entities[0].state).toBe('off');
    expect(onStatus).toHaveBeenLastCalledWith('error', expect.stringContaining('mismatched identifiers'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('authenticates, subscribes before loading, and only resolves once the home is ready', async () => {
    const { client, connection, socket, snapshots, onStatus } = setup();
    const resolved = vi.fn();
    void connection.then(resolved);
    expect(socket.url).toBe('ws://homeassistant.local:8123/api/websocket');
    await authenticate(socket);
    expect(socket.sent[0]).toEqual({
      type: 'auth',
      access_token: 'secret-test-token',
    });
    expect(socket.sent[1].type).toBe('subscribe_events');
    expect(resolved).not.toHaveBeenCalled();
    await initialSnapshot(socket);
    await connection;
    expect(onStatus).toHaveBeenLastCalledWith('connected');
    expect(snapshots.at(-1)).toMatchObject({
      locationName: 'Our home',
      entities: [entity()],
      unitSystem: { temperature: '°C' },
    });
    client.disconnect();
    expect(socket.readyState).toBe(3);
  });

  it('sends service targets and surfaces the server error without changing state', async () => {
    const { client, connection, socket, snapshots } = setup();
    await authenticate(socket);
    await initialSnapshot(socket);
    await connection;
    const request = client.callService('light', 'turn_on', 'light.kitchen', {
      brightness: 180,
    });
    expect(socket.sent.at(-1)).toMatchObject({
      type: 'call_service',
      domain: 'light',
      service: 'turn_on',
      target: { entity_id: 'light.kitchen' },
      service_data: { brightness: 180 },
    });
    socket.answer('call_service', 'The device is unavailable', false);
    await expect(request).rejects.toThrow('The device is unavailable');
    expect(snapshots.at(-1)?.entities[0].state).toBe('off');
  });

  it('streams changed and deleted entities', async () => {
    const { connection, socket, snapshots } = setup();
    await authenticate(socket);
    await initialSnapshot(socket);
    await connection;
    socket.state('light.kitchen', entity('on', '2026-11-15T09:01:00Z'));
    expect(snapshots.at(-1)?.entities[0].state).toBe('on');
    socket.state('light.kitchen', null, '2026-11-15T09:02:00Z');
    expect(snapshots.at(-1)?.entities).toEqual([]);
  });

  it('keeps live changes received during the initial request and ignores older buffered values', async () => {
    const { connection, socket, snapshots } = setup();
    await authenticate(socket);
    socket.state('light.kitchen', entity('on', '2026-11-15T09:02:00Z'));
    socket.state('light.hall', {
      ...entity('off', '2026-11-15T09:00:00Z'),
      entity_id: 'light.hall',
    });
    await initialSnapshot(socket, [
      entity(),
      { ...entity('on', '2026-11-15T09:01:00Z'), entity_id: 'light.hall' },
    ]);
    await connection;
    expect(
      snapshots
        .at(-1)
        ?.entities.find((item) => item.entity_id === 'light.kitchen')?.state,
    ).toBe('on');
    expect(
      snapshots.at(-1)?.entities.find((item) => item.entity_id === 'light.hall')
        ?.state,
    ).toBe('on');
  });

  it('supports accounts without permission to read registries', async () => {
    const { connection, socket, snapshots, onStatus } = setup();
    await authenticate(socket);
    socket.answer('get_states', [entity()]);
    for (const type of [
      'config/area_registry/list',
      'config/device_registry/list',
      'config/entity_registry/list',
      'get_config',
    ]) {
      socket.answer(type, 'Unauthorized', false);
    }
    await connection;
    expect(onStatus).toHaveBeenLastCalledWith('connected');
    expect(snapshots.at(-1)).toMatchObject({
      entities: [entity()],
      areas: [],
      devices: [],
      registry: [],
      locationName: 'My home',
    });
  });

  it('does not retry an invalid token or include it in the error', async () => {
    const { connection, socket, onStatus } = setup();
    socket.receive({ type: 'auth_invalid', message: 'bad token' });
    await expect(connection).rejects.toThrow('rejected this token');
    expect(onStatus).toHaveBeenLastCalledWith(
      'error',
      expect.not.stringContaining('secret-test-token'),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('times out a server which never authenticates', async () => {
    const { connection, socket, onStatus } = setup();
    const rejection = expect(connection).rejects.toThrow('did not respond');
    await vi.advanceTimersByTimeAsync(15_000);
    await rejection;
    expect(socket.readyState).toBe(3);
    expect(onStatus).toHaveBeenLastCalledWith('error', expect.any(String));
  });

  it('reconnects after network loss, rejects pending actions, and never replays them', async () => {
    const { client, connection, socket, onStatus } = setup();
    await authenticate(socket);
    await initialSnapshot(socket);
    await connection;
    const action = client.callService('light', 'turn_on', 'light.kitchen');
    const rejection = expect(action).rejects.toThrow(
      'Connection to Home Assistant was lost',
    );
    socket.loseConnection();
    await rejection;
    expect(onStatus).toHaveBeenLastCalledWith(
      'reconnecting',
      expect.any(String),
    );
    await expect(
      client.callService('light', 'turn_on', 'light.kitchen'),
    ).rejects.toThrow('not connected');
    await vi.advanceTimersByTimeAsync(1_000);
    const next = required(FakeSocket.instances.at(-1));
    expect(next).not.toBe(socket);
    await authenticate(next);
    await initialSnapshot(next);
    expect(onStatus).toHaveBeenLastCalledWith('connected');
    expect(next.sent.some((message) => message.type === 'call_service')).toBe(
      false,
    );
  });

  it('rejects replaced connects and ignores stale socket events', async () => {
    const { client, connection, socket, snapshots } = setup();
    const staleHandler = required(socket.onmessage);
    const cancelled = expect(connection).rejects.toThrow('Connection replaced');
    const nextConnection = client.connect(
      'https://home.example.com',
      'new-token',
    );
    await cancelled;
    const next = required(FakeSocket.instances.at(-1));
    expect(next.url).toBe('wss://home.example.com/api/websocket');
    staleHandler({ data: JSON.stringify({ type: 'auth_ok' }) });
    expect(snapshots).toHaveLength(0);
    expect(next.sent).toHaveLength(0);
    await authenticate(next);
    await initialSnapshot(next);
    await nextConnection;
  });

  it('stops scheduled reconnection and rejects an unfinished connect on disconnect', async () => {
    const first = setup();
    const cancelled = expect(first.connection).rejects.toThrow('Disconnected');
    first.client.disconnect();
    await cancelled;
    const { client, connection, socket } = setup();
    await authenticate(socket);
    await initialSnapshot(socket);
    await connection;
    socket.loseConnection();
    client.disconnect();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it('detects a silent dead connection with a heartbeat', async () => {
    const { connection, socket, onStatus } = setup();
    await authenticate(socket);
    await initialSnapshot(socket);
    await connection;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(socket.sent.at(-1)?.type).toBe('ping');
    await vi.advanceTimersByTimeAsync(12_000);
    expect(onStatus).toHaveBeenLastCalledWith(
      'reconnecting',
      expect.any(String),
    );
    expect(socket.readyState).toBe(3);
  });
});

describe('automations, scripts, and helpers', () => {
  async function connected() {
    const { client, connection, socket } = setup();
    await authenticate(socket);
    await initialSnapshot(socket);
    await connection;
    return { client, socket };
  }
  const sent = (socket: FakeSocket, type: string) => required([...socket.sent].reverse().find((message) => message.type === type));

  it('asks Home Assistant to check a routine and reports what it rejects', async () => {
    const { client, socket } = await connected();
    const triggers = [{ trigger: 'state', entity_id: 'light.kitchen' }];
    const actions = [{ action: 'light.turn_on' }];
    const checking = client.validateRoutine({ triggers, actions });
    expect(sent(socket, 'validate_config')).toMatchObject({ triggers, actions });
    socket.answer('validate_config', { triggers: { valid: true, error: null }, actions: { valid: false, error: 'Unknown action light.turn_onn' } });
    await expect(checking).resolves.toEqual({ checked: true, errors: ['actions: Unknown action light.turn_onn'] });
    // An older server that cannot check is not an obstacle; saving still validates.
    const unsupported = client.validateRoutine({ actions });
    socket.answer('validate_config', 'Unknown command.', false);
    await expect(unsupported).resolves.toEqual({ checked: false, errors: [] });
  });

  it('reads routine and automation editor configurations through their fixed paths', async () => {
    const { client } = await connected();
    const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ result: 'ok', alias: 'Door light' }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await client.saveRoutine('automation', 'hjem_1', { alias: 'Door light', triggers: [], actions: [] });
    await client.readRoutine('script', 'movie_time');
    await client.deleteRoutine('automation', 'hjem_1');
    expect(fetch.mock.calls.map(([url, init]) => [init.method, url])).toEqual([
      ['POST', 'http://homeassistant.local:8123/api/config/automation/config/hjem_1'],
      ['GET', 'http://homeassistant.local:8123/api/config/script/config/movie_time'],
      ['DELETE', 'http://homeassistant.local:8123/api/config/automation/config/hjem_1'],
    ]);
    await expect(client.readRoutine('automation', '../../auth')).rejects.toThrow('identifier');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('lists a remote’s triggers and a routine’s recent runs', async () => {
    const { client, socket } = await connected();
    const triggers = client.deviceTriggers('device1');
    expect(sent(socket, 'device_automation/trigger/list')).toMatchObject({ device_id: 'device1' });
    socket.answer('device_automation/trigger/list', [{ platform: 'device', domain: 'zha', type: 'remote_button_short_press', subtype: 'turn_on' }, 'junk']);
    await expect(triggers).resolves.toEqual([{ platform: 'device', domain: 'zha', type: 'remote_button_short_press', subtype: 'turn_on' }]);
    const runs = client.routineTraces('automation', 'hjem_1');
    expect(sent(socket, 'trace/list')).toMatchObject({ domain: 'automation', item_id: 'hjem_1' });
    socket.answer('trace/list', [
      { run_id: 'a', state: 'stopped', script_execution: 'failed_conditions', trigger: 'state of binary_sensor.door', timestamp: { start: '2026-11-19T07:00:00Z', finish: '2026-11-19T07:00:01Z' }, last_step: 'condition/0' },
      { state: 'stopped' },
    ]);
    await expect(runs).resolves.toEqual([{ run_id: 'a', started: '2026-11-19T07:00:00Z', finished: '2026-11-19T07:00:01Z', result: 'failed_conditions', trigger: 'state of binary_sensor.door', error: undefined, last_step: 'condition/0' }]);
  });

  it('manages helpers and routine switches with fixed commands', async () => {
    const { client, socket } = await connected();
    const listing = client.listHelpers('input_boolean');
    socket.answer('input_boolean/list', [{ id: 'guest_mode', name: 'Guest mode' }]);
    await expect(listing).resolves.toEqual([{ id: 'guest_mode', name: 'Guest mode' }]);
    const missing = client.listHelpers('timer');
    socket.answer('timer/list', 'Unknown command.', false);
    await expect(missing).resolves.toEqual([]);

    const creating = client.createHelper('input_number', { name: 'Level', min: 1, max: 10, type: 'call_service' });
    expect(sent(socket, 'input_number/create')).toMatchObject({ name: 'Level', min: 1, max: 10 });
    socket.answer('input_number/create', { id: 'level', name: 'Level', min: 1, max: 10 });
    await expect(creating).resolves.toMatchObject({ id: 'level' });
    const updating = client.updateHelper('input_number', 'level', { max: 20 });
    expect(sent(socket, 'input_number/update')).toMatchObject({ input_number_id: 'level', max: 20 });
    socket.answer('input_number/update', { id: 'level', name: 'Level', min: 1, max: 20 });
    await updating;
    const deleting = client.deleteHelper('input_number', 'level');
    expect(sent(socket, 'input_number/delete')).toMatchObject({ input_number_id: 'level' });
    socket.answer('input_number/delete', null);
    await deleting;

    const hiding = client.setEntityHidden('light.kitchen', true);
    expect(sent(socket, 'config/entity_registry/update')).toMatchObject({ entity_id: 'light.kitchen', hidden_by: 'user' });
    socket.answer('config/entity_registry/update', {});
    await hiding;

    const pausing = client.routineService('automation', 'turn_off', 'automation.door_light');
    expect(sent(socket, 'call_service')).toMatchObject({ domain: 'automation', service: 'turn_off', target: { entity_id: 'automation.door_light' } });
    socket.answer('call_service', {});
    await pausing;
    await expect(client.routineService('script', 'trigger', 'script.movie_time')).rejects.toThrow('cannot be used this way');
    await expect(client.routineService('automation', 'turn_on', 'lock.front_door')).rejects.toThrow('cannot be used this way');
  });
});

describe('a Hjem hub in place of Home Assistant', () => {
  const document = { format: 'hjem-configuration', version: 1, exported_at: '2026-11-19T10:00:00Z', home_name: 'Our home', rooms: ['Kitchen'], devices: [], entities: [], moods: [], routines: [], helpers: [], settings: {} };
  async function connected(onHub?: (hub: unknown) => void) {
    const client = new HomeAssistantClient({ onSnapshot: () => undefined, onStatus: () => undefined, ...(onHub ? { onHub } : {}) });
    clients.push(client);
    const connection = client.connect('http://homeassistant.local:8099', 'ABCDE-FGHJK-LMNPQ-RSTUV');
    const socket = required(FakeSocket.instances.at(-1));
    await authenticate(socket);
    await initialSnapshot(socket);
    await connection;
    return { client, socket };
  }

  it('receives the hub’s copy of the home, and each newer one', async () => {
    const hubs: unknown[] = [];
    const { socket } = await connected((hub) => hubs.push(hub));
    const request = required(socket.sent.find((message) => message.type === 'hjem/home/subscribe'));
    socket.answer('hjem/home/subscribe', { hub_id: 'hub-1', version: '0.1.0', revision: 3, updated_at: '2026-11-19T10:00:00Z', document });
    await flush();
    socket.receive({ id: request.id, type: 'event', event: { event_type: 'hjem_home', data: { hub_id: 'hub-1', version: '0.1.0', revision: 4, updated_at: '2026-11-19T11:00:00Z', document: { ...document, rooms: ['Kitchen', 'Hall'] } } } });
    // The same event on another subscription, or an unreadable copy, changes nothing.
    socket.receive({ id: 9999, type: 'event', event: { event_type: 'hjem_home', data: { hub_id: 'hub-2', revision: 9, document } } });
    socket.receive({ id: request.id, type: 'event', event: { event_type: 'hjem_home', data: { hub_id: 'hub-1', revision: 5, document: { format: 'something-else' } } } });
    expect(hubs).toEqual([
      expect.objectContaining({ hubId: 'hub-1', version: '0.1.0', revision: 3, document: expect.objectContaining({ rooms: ['Kitchen'] }) }),
      expect.objectContaining({ hubId: 'hub-1', revision: 4, updatedAt: '2026-11-19T11:00:00Z', document: expect.objectContaining({ rooms: ['Kitchen', 'Hall'] }) }),
    ]);
  });

  it('stays an ordinary connection when Home Assistant answers that it is not a hub', async () => {
    const hubs: unknown[] = [];
    const { client, socket } = await connected((hub) => hubs.push(hub));
    socket.answer('hjem/home/subscribe', 'Unknown command.', false);
    await flush();
    expect(hubs).toEqual([]);
    expect(client.getSnapshot().locationName).toBe('Our home');
    // A connection nobody asked about hubs on does not ask Home Assistant either.
    const plain = await connected();
    expect(plain.socket.sent.some((message) => message.type === 'hjem/home/subscribe')).toBe(false);
  });
});

describe('server addresses', () => {
  it('normalizes local addresses, TLS, and reverse proxy paths', () => {
    expect(normalizeServerUrl(' homeassistant.local:8123/ ')).toBe(
      'http://homeassistant.local:8123',
    );
    expect(normalizeServerUrl('192.168.1.105:8123')).toBe('http://192.168.1.105:8123');
    expect(normalizeServerUrl('http://[fd00::12]:8123')).toBe('http://[fd00::12]:8123');
    expect(normalizeServerUrl('https://home.example/assistant/')).toBe(
      'https://home.example/assistant',
    );
    expect(normalizeServerUrl('wss://home.example/api/websocket')).toBe(
      'https://home.example',
    );
  });
  it('rejects credentials, unsupported protocols, and token-like query parameters', () => {
    for (const address of [
      '',
      'file:///tmp/ha',
      'https://user:pass@home.example',
      'https://home.example/?token=secret',
    ]) {
      expect(() => normalizeServerUrl(address)).toThrow();
    }
  });
});

it('reads calendar events through a response-returning service without mutating devices', async () => {
  const { client, connection, socket, snapshots } = setup();
  await authenticate(socket);
  await initialSnapshot(socket);
  await connection;
  const start = '2026-11-15T00:00:00Z';
  const end = '2026-11-16T00:00:00Z';
  const request = client.getCalendarEvents(['calendar.family'], start, end);
  expect(socket.sent.at(-1)).toMatchObject({
    type: 'call_service',
    domain: 'calendar',
    service: 'get_events',
    target: { entity_id: ['calendar.family'] },
    service_data: { start_date_time: start, end_date_time: end },
    return_response: true,
  });
  socket.answer('call_service', {
    response: {
      'calendar.family': {
        events: [
          {
            summary: 'Dinner',
            start: '2026-11-15T18:00:00Z',
            end: '2026-11-15T19:00:00Z',
          },
        ],
      },
    },
  });
  expect(await request).toEqual([
    expect.objectContaining({
      summary: 'Dinner',
      entityId: 'calendar.family',
      allDay: false,
    }),
  ]);
  expect(snapshots.at(-1)?.entities[0].state).toBe('off');
  const failed = client.getCalendarEvents(['calendar.family'], start, end);
  socket.answer('call_service', 'Calendar unavailable', false);
  await expect(failed).rejects.toThrow('Calendar unavailable');
  await expect(
    client.getCalendarEvents(['light.kitchen'], start, end),
  ).rejects.toThrow('calendar entity');
  client.disconnect();
  await expect(
    client.getCalendarEvents(['calendar.family'], start, end),
  ).rejects.toThrow('Reconnect');
});
