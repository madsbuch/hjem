import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HomeAssistantClient,
  normalizeServerUrl,
  type HassEntity,
  type HassSnapshot,
} from './home-assistant';

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 1;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: any[] = [];
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
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

function setup() {
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
  );
  const socket = FakeSocket.instances.at(-1)!;
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

describe('Home Assistant connection', () => {
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
    const next = FakeSocket.instances.at(-1)!;
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
    const staleHandler = socket.onmessage!;
    const cancelled = expect(connection).rejects.toThrow('Connection replaced');
    const nextConnection = client.connect(
      'https://home.example.com',
      'new-token',
    );
    await cancelled;
    const next = FakeSocket.instances.at(-1)!;
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
    expect(socket.sent.at(-1).type).toBe('ping');
    await vi.advanceTimersByTimeAsync(12_000);
    expect(onStatus).toHaveBeenLastCalledWith(
      'reconnecting',
      expect.any(String),
    );
    expect(socket.readyState).toBe(3);
  });
});

describe('server addresses', () => {
  it('normalizes local addresses, TLS, and reverse proxy paths', () => {
    expect(normalizeServerUrl(' homeassistant.local:8123/ ')).toBe(
      'http://homeassistant.local:8123',
    );
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
