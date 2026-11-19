import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { HomeAssistantClient, type HassSnapshot } from '../src/lib/home-assistant';
import { HomeSetupManager } from '../src/lib/home-setup';
import { isRecord } from '../src/lib/home-assistant-protocol';
import { startHub, type Hub } from './server';
import { fakeHomeAssistant } from './testing/fake-home-assistant';

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function until<T>(read: () => T | undefined | null | false, label = 'condition'): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function fixture() {
  const ha = await fakeHomeAssistant();
  const dataDir = await mkdtemp(join(tmpdir(), 'hjem-hub-'));
  const logs: string[] = [];
  const start = () => startHub({ haUrl: ha.url, haToken: ha.token, dataDir, port: 0, host: '127.0.0.1', version: '0.0.0-test', settle: 20, log: (line) => logs.push(line) });
  let hub = await start();
  cleanup.push(() => ha.close(), () => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }), () => hub.close());
  const url = () => `http://127.0.0.1:${hub.port}`;
  /** The app's own client, connected to the hub as it would connect to Home Assistant. */
  const app = async (code = hub.pairingCode) => {
    const snapshots: HassSnapshot[] = [];
    const client = new HomeAssistantClient({ onSnapshot: (snapshot) => snapshots.push(snapshot), onStatus: () => undefined });
    cleanup.push(() => client.disconnect());
    await client.connect(url(), code);
    return { client, snapshots };
  };
  /** A device speaking the protocol by hand, to try what the app never sends. */
  const raw = async (code = hub.pairingCode) => {
    const socket = new WebSocket(`ws://127.0.0.1:${hub.port}/api/websocket`);
    const received: Record<string, unknown>[] = [];
    socket.on('message', (data) => {
      const message: unknown = JSON.parse(String(data));
      if (isRecord(message)) received.push(message);
    });
    cleanup.push(() => socket.terminate());
    await until(() => received.some((message) => message.type === 'auth_required'), 'auth_required');
    socket.send(JSON.stringify({ type: 'auth', access_token: code }));
    const answer = (id: number) => until(() => received.find((message) => message.id === id && message.type !== 'event'), `answer ${id}`);
    return { socket, received, answer, send: (message: Record<string, unknown>) => socket.send(JSON.stringify(message)) };
  };
  return { ha, logs, url, app, raw, hub: () => hub, restart: async () => { await hub.close(); hub = await start(); return hub; } };
}
const home = (hub: Hub) => hub.home.current();

describe('Hjem hub', () => {
  it('lets the app connect with a pairing code in place of a Home Assistant token', async () => {
    const { app, ha, hub } = await fixture();
    expect(hub().pairingCode).toMatch(/^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/);
    const { client } = await app(hub().pairingCode.toLowerCase().replaceAll('-', ''));
    const snapshot = client.getSnapshot();
    expect(snapshot.locationName).toBe('Test home');
    expect(snapshot.areas).toEqual([{ area_id: 'office', name: 'Office' }]);
    expect(snapshot.entities.map((entity) => entity.entity_id)).toContain('automation.door_light');
    await client.callService('light', 'turn_on', 'light.desk', { brightness_pct: 40 });
    expect(ha.commands).toContain('call_service');
    // The Home Assistant token never leaves the hub, and the pairing code never reaches Home Assistant.
    expect(JSON.stringify(snapshot)).not.toContain(ha.token);
  });

  it('refuses a wrong pairing code, and pauses an address that keeps guessing', async () => {
    const { app, raw, logs } = await fixture();
    await expect(app('WRONG-WRONG-WRONG-WRONG')).rejects.toThrow('rejected this token');
    for (let attempt = 0; attempt < 9; attempt++) {
      const { received } = await raw('AAAAA-AAAAA-AAAAA-AAAAA');
      await until(() => received.some((message) => message.type === 'auth_invalid'), 'auth_invalid');
    }
    expect(logs.join('\n')).toContain('Pairing is paused');
    await expect(app()).rejects.toThrow('rejected this token');
  });

  it('relays only the commands Hjem uses', async () => {
    const { raw, ha } = await fixture();
    const device = await raw();
    await until(() => device.received.some((message) => message.type === 'auth_ok'), 'auth_ok');
    device.send({ id: 1, type: 'auth/long_lived_access_token', client_name: 'x', lifespan: 3650 });
    device.send({ id: 2, type: 'hassio/host/shutdown' });
    device.send({ id: 3, type: 'subscribe_events' });
    device.send({ id: 4, type: 'config/core/update', location_name: 'x' });
    device.send({ id: 5, type: 'get_config' });
    for (const id of [1, 2, 3, 4]) expect(await device.answer(id)).toMatchObject({ success: false, error: { code: 'not_allowed' } });
    expect(await device.answer(5)).toMatchObject({ success: true, result: { location_name: 'Test home' } });
    expect(ha.commands.filter((type) => !['get_config', 'get_states', 'subscribe_events', 'ping'].includes(type) && !type.startsWith('config/') && !type.includes('/list'))).toEqual([]);
    expect(ha.commands).not.toContain('config/core/update');
  });

  it('relays the three editor endpoints for paired devices and nothing else', async () => {
    const { url, hub, ha } = await fixture();
    const request = (path: string, init: RequestInit = {}, code = hub().pairingCode) =>
      fetch(`${url()}${path}`, { ...init, headers: { Authorization: `Bearer ${code}`, 'Content-Type': 'application/json' } });
    expect((await request('/api/config/scene/config/evening', {}, 'nope')).status).toBe(401);
    expect(await (await request('/api/config/scene/config/evening')).json()).toMatchObject({ name: 'Evening' });
    expect((await request('/api/config/script/config/film', { method: 'POST', body: JSON.stringify({ alias: 'Film', sequence: [] }) })).status).toBe(200);
    expect(ha.configs.script?.get('film')).toEqual({ alias: 'Film', sequence: [] });
    expect((await request('/api/config/script/config/film', { method: 'DELETE' })).status).toBe(200);
    expect((await request('/api/config/script/config/film')).status).toBe(404);
    for (const path of ['/api/states', '/api/config/core/check_config', '/api/config/scene/config/../../states', '/api/services/shell_command/x'])
      expect((await request(path, { method: 'POST', body: '{}' })).status, path).toBe(404);
    expect(ha.rest.some((line) => line.includes('/api/states') || line.includes('shell_command'))).toBe(false);
    expect(await (await fetch(`${url()}/api/hjem`)).json()).toMatchObject({ hjem_hub: true, hub_id: hub().hubId });
    // The pairing code is only shown inside Home Assistant, never on the open port.
    expect(await (await fetch(`${url()}/`)).text()).not.toContain(hub().pairingCode);
  });

  it('keeps a numbered copy of the whole home and sends each new one to every device', async () => {
    const { app, hub, raw } = await fixture();
    const first = await until(() => home(hub()), 'first home copy');
    expect(first.revision).toBe(1);
    expect(first.document).toMatchObject({
      home_name: 'Test home', rooms: ['Office'],
      devices: [{ key: 'zigbee:0011223344556677', name: 'Desk lamp', room: 'Office' }],
      moods: [{ name: 'Evening', targets: [expect.objectContaining({ entity_id: 'light.desk', device: 'zigbee:0011223344556677' })] }],
      routines: [expect.objectContaining({ kind: 'automation', name: 'Door light', enabled: true, entities: expect.arrayContaining([{ device: 'zigbee:0011223344556677', entity_id: 'light.desk' }]) })],
    });
    const device = await raw();
    device.send({ id: 7, type: 'hjem/home/subscribe' });
    expect(await device.answer(7)).toMatchObject({ success: true, result: { hub_id: hub().hubId, revision: 1, document: { home_name: 'Test home' } } });

    // Another device adds a script through the hub; every subscriber gets the new copy.
    const { client } = await app();
    const setup = new HomeSetupManager({ transport: client, demo: false, isCurrent: () => true });
    await setup.saveScript({ name: 'Lights out', sequence: [{ action: 'light.turn_off', target: { entity_id: 'light.desk' } }] });
    const pushed = await until(() => device.received.find((message) => message.type === 'event' && message.id === 7), 'pushed home copy');
    expect(pushed).toMatchObject({ event: { event_type: 'hjem_home', data: { revision: 2 } } });
    expect(home(hub())?.document.routines.map((routine) => routine.name).sort()).toEqual(['Door light', 'Lights out']);
  });

  it('keeps its identity, pairing code, and home copy across restarts', async () => {
    const { hub, restart } = await fixture();
    const before = await until(() => home(hub()), 'home copy');
    const { hubId, pairingCode } = hub();
    const again = await restart();
    expect(again).toMatchObject({ hubId, pairingCode });
    expect(home(again)).toEqual(before);
    // Reading an unchanged home again does not make a new copy.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(home(again)?.revision).toBe(before.revision);
  });

  it('never replaces a complete copy with a partial one', async () => {
    const { hub, ha, logs, raw } = await fixture();
    await until(() => home(hub()), 'home copy');
    ha.state.failScenes = true;
    ha.state.areas = [...ha.state.areas, { area_id: 'hall', name: 'Hall' }];
    const device = await raw();
    device.send({ id: 1, type: 'hjem/home/refresh' });
    await until(() => logs.some((line) => line.includes('keeping the previous copy')), 'failed read');
    expect(home(hub())).toMatchObject({ revision: 1, document: { rooms: ['Office'] } });
    ha.state.failScenes = false;
    device.send({ id: 2, type: 'hjem/home/refresh' });
    await until(() => home(hub())?.revision === 2, 'recovered copy');
    expect(home(hub())?.document).toMatchObject({ rooms: ['Office', 'Hall'], moods: [{ name: 'Evening' }] });
  });
});
