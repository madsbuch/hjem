import { expect, it } from 'vitest';
import { HomeAssistantClient, type HassSnapshot } from './home-assistant';
import { localHomeAssistant } from '../../tests/helpers/home-assistant-server';

it('connects over real local HTTP/WebSocket, receives state, and reports an unreachable address', async () => {
  const home = await localHomeAssistant();
  const snapshots: HassSnapshot[] = [];
  const statuses: string[] = [];
  const client = new HomeAssistantClient({
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onStatus: (status) => statuses.push(status),
  });
  try {
    expect((await fetch(home.url)).status).toBe(200);
    await client.connect(home.url, 'local-fixture-token');
    expect(statuses.at(-1)).toBe('connected');
    expect(snapshots.at(-1)?.locationName).toBe('Local fixture');
    await client.callService('light', 'turn_on', 'light.mock');
    await expect.poll(() => snapshots.at(-1)?.entities[0]?.state).toBe('on');
    expect(
      home.commands.filter((command) => command.type === 'call_service'),
    ).toEqual([
      expect.objectContaining({
        domain: 'light',
        service: 'turn_on',
        target: { entity_id: 'light.mock' },
        service_data: {},
      }),
    ]);
    expect(home.failure).toBeUndefined();
    client.disconnect();
    await home.close();
    await expect(
      client.connect(home.url, 'local-fixture-token'),
    ).rejects.toThrow(`Unable to reach Home Assistant at ${home.url}`);
    expect(statuses.at(-1)).toBe('error');
  } finally {
    client.disconnect();
    await home.close();
  }
});
