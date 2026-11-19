import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { isRecord } from '../../src/lib/home-assistant-protocol.ts';

// A real loopback WebSocket peer, separate from the fake-socket protocol tests.
// Only this fixture's dummy credential is accepted; no real home is contacted.
export async function localHomeAssistant() {
  const sockets = new Set<Duplex>();
  const commands: Record<string, unknown>[] = [];
  let failure: Error | undefined;
  const light = {
    entity_id: 'light.mock',
    state: 'off',
    attributes: { friendly_name: 'Mock light' },
  };
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.end('Local Home Assistant test server');
  });

  const send = (socket: Duplex, value: unknown) => {
    const body = Buffer.from(JSON.stringify(value));
    const header = Buffer.alloc(body.length < 126 ? 2 : 4);
    header[0] = 0x81;
    if (body.length < 126) header[1] = body.length;
    else {
      header[1] = 126;
      header.writeUInt16BE(body.length, 2);
    }
    socket.write(Buffer.concat([header, body]));
  };

  server.on('upgrade', (request, socket, head) => {
    const key = request.headers['sec-websocket-key'];
    if (request.url !== '/api/websocket' || typeof key !== 'string') {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    const accept = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    send(socket, { type: 'auth_required', ha_version: 'test' });
    let buffer = head;
    let subscriptionId: number | undefined;
    let authenticated = false;

    const handle = (value: unknown) => {
      if (!isRecord(value) || typeof value.type !== 'string')
        throw new Error('Malformed client command');
      commands.push(value);
      if (value.type === 'auth') {
        authenticated = value.access_token === 'local-fixture-token';
        send(socket, { type: authenticated ? 'auth_ok' : 'auth_invalid' });
        return;
      }
      if (!authenticated || typeof value.id !== 'number')
        throw new Error('Unauthenticated client command');
      if (value.type === 'ping') {
        send(socket, { id: value.id, type: 'pong' });
        return;
      }
      let result: unknown = null;
      switch (value.type) {
        case 'subscribe_events':
          if (value.event_type === 'state_changed') subscriptionId = value.id;
          break;
        case 'get_states':
          result = [light];
          break;
        case 'get_config':
          result = {
            location_name: 'Local fixture',
            unit_system: { temperature: '°C' },
          };
          break;
        case 'config/area_registry/list':
        case 'config/device_registry/list':
        case 'config/entity_registry/list':
          result = [];
          break;
        case 'call_service':
          result = { context: { id: 'fixture-action' } };
          break;
        default:
          // Like Home Assistant, answer a command it does not have; Hjem asks whether it is talking to a hub.
          if (value.type === 'hjem/home/subscribe') {
            send(socket, { id: value.id, type: 'result', success: false, error: { code: 'unknown_command', message: 'Unknown command.' } });
            return;
          }
          throw new Error(`Unexpected fixture command: ${value.type}`);
      }
      send(socket, { id: value.id, type: 'result', success: true, result });
      if (value.type === 'call_service' && subscriptionId !== undefined) {
        send(socket, {
          id: subscriptionId,
          type: 'event',
          event: {
            event_type: 'state_changed',
            data: {
              entity_id: light.entity_id,
              new_state: { ...light, state: 'on' },
            },
          },
        });
      }
    };

    socket.on('data', (chunk: Buffer) => {
      try {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 2) {
          const opcode = buffer[0] & 0x0f;
          const masked = (buffer[1] & 0x80) !== 0;
          let length = buffer[1] & 0x7f;
          let offset = 2;
          if (length === 127)
            throw new Error('Fixture received an oversized frame');
          if (length === 126) {
            if (buffer.length < 4) return;
            length = buffer.readUInt16BE(2);
            offset = 4;
          }
          if (!masked)
            throw new Error('Client WebSocket frames must be masked');
          if (buffer.length < offset + 4 + length) return;
          const mask = buffer.subarray(offset, offset + 4);
          offset += 4;
          const payload = Buffer.from(buffer.subarray(offset, offset + length));
          for (let index = 0; index < payload.length; index++)
            payload[index] ^= mask[index % 4];
          buffer = buffer.subarray(offset + length);
          if (opcode === 8) {
            socket.end(Buffer.from([0x88, 0]));
            return;
          }
          if (opcode !== 1) throw new Error('Fixture expected a text frame');
          const value: unknown = JSON.parse(payload.toString('utf8'));
          handle(value);
        }
      } catch (cause) {
        failure = cause instanceof Error ? cause : new Error('Fixture failed');
        socket.destroy();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Fixture did not bind a TCP port');
  return {
    url: `http://127.0.0.1:${address.port}`,
    commands,
    get failure() {
      return failure;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
