import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { isRecord } from '../../src/lib/home-assistant-protocol';

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/** A small Home Assistant for hub tests: registries, states, and the three editor endpoints. */
export async function fakeHomeAssistant(token = 'ha-secret') {
  const configs: Record<string, Map<string, Record<string, unknown>>> = {
    scene: new Map([['evening', { id: 'evening', name: 'Evening', entities: { 'light.desk': { state: 'on', brightness: 128 } } }]]),
    automation: new Map([['door', { id: 'door', alias: 'Door light', triggers: [{ trigger: 'state', entity_id: 'binary_sensor.door', to: 'on' }], conditions: [], actions: [{ action: 'light.turn_on', target: { entity_id: 'light.desk' } }] }]]),
    script: new Map(),
  };
  const commands: string[] = [];
  const rest: string[] = [];
  const state: { failScenes: boolean; areas: { area_id: string; name: string }[]; deskArea: string | null; doorArea: string | null } =
    { failScenes: false, areas: [{ area_id: 'office', name: 'Office' }], deskArea: 'office', doorArea: 'office' };
  const entities = () => [
    { entity_id: 'light.desk', state: 'off', attributes: { friendly_name: 'Desk lamp', supported_color_modes: ['brightness'] } },
    { entity_id: 'binary_sensor.door', state: 'off', attributes: { friendly_name: 'Door', device_class: 'door' } },
    ...[...configs.scene?.values() ?? []].map((config) => ({ entity_id: `scene.${slug(String(config.name))}`, state: 'unknown', attributes: { friendly_name: config.name, id: config.id } })),
    ...[...configs.automation?.values() ?? []].map((config) => ({ entity_id: `automation.${slug(String(config.alias))}`, state: 'on', attributes: { friendly_name: config.alias, id: config.id, last_triggered: null } })),
    ...[...configs.script?.entries() ?? []].map(([key, config]) => ({ entity_id: `script.${key}`, state: 'off', attributes: { friendly_name: config.alias } })),
  ];

  const server = createServer((request, response) => {
    const match = /^\/api\/config\/(scene|automation|script)\/config\/([A-Za-z0-9_-]+)$/.exec(request.url ?? '');
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    rest.push(`${request.method} ${request.url}`);
    if (request.headers.authorization !== `Bearer ${token}`) return send(401, { message: 'Unauthorized' });
    const store = match ? configs[match[1] ?? ''] : undefined;
    const id = match?.[2] ?? '';
    if (!store) return send(404, { message: 'unknown endpoint' });
    if (match?.[1] === 'scene' && state.failScenes) return send(500, { message: 'broken' });
    if (request.method === 'GET') return store.has(id) ? send(200, store.get(id)) : send(404, { message: 'Resource not found' });
    if (request.method === 'DELETE') {
      store.delete(id);
      return send(200, { result: 'ok' });
    }
    let body = '';
    request.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    request.on('end', () => {
      const value: unknown = JSON.parse(body);
      if (isRecord(value)) store.set(id, match?.[1] === 'script' ? value : { ...value, id });
      send(200, { result: 'ok' });
    });
  });
  const sockets = new WebSocketServer({ server, path: '/api/websocket' });
  sockets.on('connection', (socket) => {
    let authenticated = false;
    socket.send(JSON.stringify({ type: 'auth_required', ha_version: 'fake' }));
    socket.on('message', (data) => {
      const message: unknown = JSON.parse(String(data));
      if (!isRecord(message) || typeof message.type !== 'string') return;
      if (message.type === 'auth') {
        authenticated = message.access_token === token;
        socket.send(JSON.stringify({ type: authenticated ? 'auth_ok' : 'auth_invalid', ha_version: 'fake' }));
        return;
      }
      if (!authenticated) return;
      commands.push(message.type);
      const result = (value: unknown) => socket.send(JSON.stringify({ id: message.id, type: 'result', success: true, result: value }));
      if (message.type === 'ping') socket.send(JSON.stringify({ id: message.id, type: 'pong' }));
      else if (message.type === 'get_states') result(entities());
      else if (message.type === 'get_config') result({ location_name: 'Test home', unit_system: { temperature: '°C' } });
      else if (message.type === 'config/area_registry/list') result(state.areas);
      else if (message.type === 'config/device_registry/list') result([{ id: 'desk-device', area_id: state.deskArea, name: 'TRADFRI bulb', name_by_user: 'Desk lamp', connections: [['zigbee', '00:11:22:33:44:55:66:77']] }]);
      else if (message.type === 'config/entity_registry/list') result([{ entity_id: 'light.desk', area_id: null, device_id: 'desk-device' }, { entity_id: 'binary_sensor.door', area_id: state.doorArea, device_id: null, name: 'Door' }]);
      else if (message.type === 'config/area_registry/create' && typeof message.name === 'string') {
        const area = { area_id: slug(message.name), name: message.name };
        state.areas = [...state.areas, area];
        result(area);
      } else if (message.type === 'config/device_registry/update' && (typeof message.area_id === 'string' || message.area_id === null)) {
        state.deskArea = message.area_id;
        result({});
      } else if (message.type === 'config/entity_registry/update' && (typeof message.area_id === 'string' || message.area_id === null)) {
        state.doorArea = message.area_id;
        result({});
      } else if (message.type === 'search/related') result({});
      else if (message.type === 'validate_config') result({ triggers: { valid: true, error: null }, actions: { valid: true, error: null } });
      else if (['subscribe_events', 'call_service'].includes(message.type)) result(null);
      else socket.send(JSON.stringify({ id: message.id, type: 'result', success: false, error: { code: 'unknown_command', message: 'Unknown command.' } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  return {
    url: `http://127.0.0.1:${address.port}`, token, configs, commands, rest, state,
    async close() {
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
