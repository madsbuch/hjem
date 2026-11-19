import { randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { isRecord, REMOTE_EVENT_TYPES } from '../src/lib/home-assistant-protocol';
import { helperDomains } from '../src/lib/home-setup-types';
import { HomeDocumentService, type HomeRecord } from './home-document';

export interface HubOptions {
  /** Home Assistant's address as the hub reaches it, e.g. http://supervisor/core. */
  haUrl: string;
  haToken: string;
  dataDir: string;
  port: number;
  host?: string;
  version: string;
  log?: (line: string) => void;
  settle?: number;
}
export interface Hub {
  port: number;
  hubId: string;
  pairingCode: string;
  home: HomeDocumentService;
  close(): Promise<void>;
}

const MAX_MESSAGE = 1024 * 1024;
const MAX_CONFIG = 256 * 1024;
/** Requests from Home Assistant's own sidebar arrive from the Supervisor, and only from there. */
const INGRESS_ADDRESS = '172.30.32.2';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
};

/**
 * What a paired device may ask Home Assistant, through the hub: exactly the
 * commands Hjem itself uses. Anything else is answered by the hub with a refusal.
 */
const commands = new Set([
  'ping', 'get_states', 'get_config', 'unsubscribe_events', 'call_service', 'search/related',
  'config/area_registry/list', 'config/area_registry/create', 'config/area_registry/update', 'config/area_registry/delete',
  'config/device_registry/list', 'config/device_registry/update',
  'config/entity_registry/list', 'config/entity_registry/update',
  'validate_config', 'device_automation/trigger/list', 'trace/list', 'zha/devices/permit',
  ...helperDomains.flatMap((domain) => ['list', 'create', 'update', 'delete'].map((action) => `${domain}/${action}`)),
]);
const events = new Set<string>(['state_changed', 'area_registry_updated', 'device_registry_updated', 'entity_registry_updated', ...REMOTE_EVENT_TYPES]);
const allowed = (message: Record<string, unknown>) =>
  message.type === 'subscribe_events' ? typeof message.event_type === 'string' && events.has(message.event_type)
    : typeof message.type === 'string' && commands.has(message.type);

const normalizeCode = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, '');
function newPairingCode(): string {
  const letters = Array.from({ length: 20 }, () => ALPHABET[randomInt(ALPHABET.length)] ?? 'A').join('');
  return letters.replace(/(.{5})(?=.)/g, '$1-');
}
const text = (data: RawData): string =>
  Buffer.isBuffer(data) ? data.toString('utf8') : Array.isArray(data) ? Buffer.concat(data).toString('utf8') : Buffer.from(data).toString('utf8');
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

async function identity(dataDir: string): Promise<{ hub_id: string; pairing_code: string }> {
  const file = join(dataDir, 'hub.json');
  try {
    const saved: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (isRecord(saved) && typeof saved.hub_id === 'string' && typeof saved.pairing_code === 'string' && normalizeCode(saved.pairing_code).length >= 20)
      return { hub_id: saved.hub_id, pairing_code: saved.pairing_code };
  } catch {
    // First start: a new hub gets its own identity and pairing code.
  }
  const created = { hub_id: randomUUID(), pairing_code: newPairingCode() };
  await mkdir(dataDir, { recursive: true });
  await writeFile(file, JSON.stringify(created), { mode: 0o600 });
  return created;
}

export async function startHub(options: HubOptions): Promise<Hub> {
  const log = options.log ?? (() => undefined);
  const { hub_id: hubId, pairing_code: pairingCode } = await identity(options.dataDir);
  const expected = Buffer.from(normalizeCode(pairingCode));
  const home = new HomeDocumentService({
    haUrl: options.haUrl, haToken: options.haToken, file: join(options.dataDir, 'home.json'), log, settle: options.settle,
  });

  // A wrong code costs the caller time; many wrong codes lock that address out for a while.
  const failures = new Map<string, { count: number; until: number }>();
  const locked = (address: string) => (failures.get(address)?.until ?? 0) > Date.now();
  const paired = (candidate: unknown, address: string): boolean => {
    if (locked(address)) return false;
    const given = Buffer.from(typeof candidate === 'string' ? normalizeCode(candidate.slice(0, 200)) : '');
    if (given.length === expected.length && timingSafeEqual(given, expected)) {
      failures.delete(address);
      return true;
    }
    const entry = failures.get(address) ?? { count: 0, until: 0 };
    entry.count++;
    if (entry.count >= 10) {
      entry.count = 0;
      entry.until = Date.now() + 10 * 60_000;
      log(`Pairing is paused for ${address} after repeated wrong codes.`);
    }
    failures.set(address, entry);
    return false;
  };
  const describe = (record: HomeRecord | null) => ({
    hub_id: hubId, version: options.version, revision: record?.revision ?? 0,
    updated_at: record?.updated_at ?? null, document: record?.document ?? null,
  });

  const upstreamUrl = new URL(`${options.haUrl}/api/websocket`);
  upstreamUrl.protocol = upstreamUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });
  const subscribers = new Map<WebSocket, Set<number>>();
  home.onChange((record) => {
    for (const [socket, ids] of subscribers)
      for (const id of ids) socket.send(JSON.stringify({ id, type: 'event', event: { event_type: 'hjem_home', data: describe(record) } }));
  });

  sockets.on('connection', (client: WebSocket, request: IncomingMessage) => {
    const address = request.socket.remoteAddress ?? 'unknown';
    let upstream: WebSocket | undefined;
    let ready = false;
    const waiting: string[] = [];
    const reply = (id: unknown, result: unknown) => client.send(JSON.stringify({ id, type: 'result', success: true, result }));
    const refuse = (id: unknown, message: string) =>
      client.send(JSON.stringify({ id, type: 'result', success: false, error: { code: 'not_allowed', message } }));
    client.send(JSON.stringify({ type: 'auth_required', ha_version: `hjem-hub-${options.version}` }));

    const connectUpstream = () => {
      const socket = new WebSocket(upstreamUrl, { maxPayload: 64 * 1024 * 1024 });
      upstream = socket;
      socket.on('message', (data, binary) => {
        if (binary) return;
        const raw = text(data);
        if (ready) {
          client.send(raw);
          return;
        }
        let message: unknown;
        try { message = JSON.parse(raw); } catch { message = null; }
        if (!isRecord(message)) return;
        if (message.type === 'auth_required') socket.send(JSON.stringify({ type: 'auth', access_token: options.haToken }));
        else if (message.type === 'auth_ok') {
          ready = true;
          client.send(JSON.stringify({ type: 'auth_ok', ha_version: message.ha_version }));
          for (const queued of waiting.splice(0)) socket.send(queued);
        } else if (message.type === 'auth_invalid') {
          log('Home Assistant refused the hub’s own access. Check that the add-on may use the Home Assistant API.');
          client.close(1011, 'Home Assistant refused the hub.');
        }
      });
      // The app reconnects by itself; closing tells it Home Assistant went away.
      socket.on('close', () => client.close(1012, 'Home Assistant is not available.'));
      socket.on('error', () => client.close(1012, 'Home Assistant is not available.'));
    };

    client.on('message', (data, binary) => {
      let message: unknown;
      const raw = binary ? '' : text(data);
      try { message = JSON.parse(raw); } catch { message = null; }
      if (!isRecord(message) || typeof message.type !== 'string') {
        client.close(1007, 'Expected one JSON command.');
        return;
      }
      if (!upstream) {
        if (message.type === 'auth' && paired(message.access_token, address)) connectUpstream();
        else {
          client.send(JSON.stringify({ type: 'auth_invalid', message: 'This pairing code is not valid for this Hjem hub.' }));
          client.close(1008, 'Not paired.');
        }
        return;
      }
      const { id, type } = message;
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) {
        client.close(1007, 'Commands need an id.');
        return;
      }
      if (type === 'hjem/info') reply(id, { ...describe(home.current()), document: undefined });
      else if (type === 'hjem/home/subscribe') {
        subscribers.set(client, (subscribers.get(client) ?? new Set()).add(id));
        reply(id, describe(home.current()));
      } else if (type === 'hjem/home/refresh') {
        home.schedule(500);
        reply(id, null);
      } else if (type.startsWith('hjem/')) refuse(id, 'This Hjem hub does not know that command.');
      else if (!allowed(message)) refuse(id, 'Hjem does not use this Home Assistant command.');
      else if (ready && upstream.readyState === WebSocket.OPEN) upstream.send(raw);
      else waiting.push(raw);
    });
    const end = () => {
      subscribers.delete(client);
      upstream?.removeAllListeners();
      upstream?.on('error', () => undefined);
      upstream?.close();
    };
    client.on('close', end);
    client.on('error', end);
  });

  const json = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify(body));
  };
  /** The three editor endpoints Hjem saves moods, automations, and scripts through; nothing else is relayed. */
  async function relay(request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
    const method = request.method ?? 'GET';
    if (method === 'OPTIONS') {
      response.writeHead(204, cors);
      response.end();
      return;
    }
    const address = request.socket.remoteAddress ?? 'unknown';
    const bearer = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1];
    if (!paired(bearer, address)) return json(response, 401, { message: 'This device is not paired with this Hjem hub.' });
    if (!['GET', 'POST', 'DELETE'].includes(method)) return json(response, 405, { message: 'Method not allowed' });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const part: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += part.length;
      if (size > MAX_CONFIG) return json(response, 413, { message: 'This configuration is too large.' });
      chunks.push(part);
    }
    try {
      const upstream = await fetch(`${options.haUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${options.haToken}`, 'Content-Type': 'application/json' },
        body: method === 'POST' ? Buffer.concat(chunks).toString('utf8') : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      const body = await upstream.text();
      response.writeHead(upstream.status, { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(body.length > 4 * MAX_CONFIG ? '{}' : body);
      if (upstream.ok && method !== 'GET') home.schedule();
    } catch {
      json(response, 502, { message: 'Home Assistant did not answer the hub.' });
    }
  }

  const page = (ingress: boolean) => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hjem hub</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1.25rem;color:#29323c;background:#f5f7f9}
code{display:block;font:600 1.5rem/1.4 ui-monospace,monospace;letter-spacing:.06em;padding:1rem;border-radius:.75rem;background:#fff;border:1px solid #dfe4e9;text-align:center;overflow-wrap:anywhere}
small{color:#66717d}@media(prefers-color-scheme:dark){body{background:#14181d;color:#e2e7ed}code{background:#20262c;border-color:#343b44}small{color:#a7aeb6}}</style>
<h1>Hjem hub</h1><p>${home.connected ? 'Running and connected to Home Assistant.' : 'Running. Waiting for Home Assistant.'}</p>
${ingress
    ? `<p>To connect a tablet, phone, or computer, open Hjem → Settings → Home Assistant and enter this hub’s address, port <strong>${options.port}</strong> on this Home Assistant’s address, with this pairing code:</p><code>${escapeHtml(pairingCode)}</code>
<p><small>Anyone with this code can control your home from your network. It is shown only here, inside Home Assistant.</small></p>`
    : '<p>The pairing code is shown when this page is opened from Home Assistant’s sidebar, and in the hub’s log.</p>'}
<p><small>Hub ${escapeHtml(hubId.slice(0, 8))} · version ${escapeHtml(options.version)} · home copy ${home.current()?.revision ?? 0}</small></p></html>`;

  const server: Server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    if (/^\/api\/config\/(scene|automation|script)\/config\/[A-Za-z0-9_-]{1,128}$/.test(path)) {
      void relay(request, response, path).catch(() => { if (!response.headersSent) json(response, 500, { message: 'The hub could not relay this request.' }); });
    } else if (path === '/api/hjem') {
      json(response, 200, { hjem_hub: true, hub_id: hubId, version: options.version });
    } else if (path === '/' && request.method === 'GET') {
      const from = (request.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(page(from === INGRESS_ADDRESS));
    } else json(response, 404, { message: 'Not found' });
  });
  server.on('upgrade', (request, socket, head) => {
    if ((request.url ?? '').split('?')[0] !== '/api/websocket') {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (client) => sockets.emit('connection', client, request));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host ?? '0.0.0.0', resolve);
  });
  const address = server.address();
  const port = address && typeof address !== 'string' ? address.port : options.port;
  await home.start();
  log(`Hjem hub ${options.version} is listening on port ${port}.`);
  log(`Pairing code: ${pairingCode}`);

  return {
    port, hubId, pairingCode, home,
    async close() {
      await home.stop();
      for (const client of sockets.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
