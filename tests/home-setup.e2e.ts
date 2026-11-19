import { expect, test, type Page, type Route } from '@playwright/test';
import { isRecord } from '../src/lib/home-assistant-protocol';
import type { HassEntity } from '../src/lib/home-assistant';
import type { SceneConfig } from '../src/lib/home-setup-types';

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
};
const tool = (name: string, args: Record<string, unknown> = {}) => ({
  id: name, type: 'function', function: { name, arguments: JSON.stringify(args) },
});
async function reply(route: Route, calls: ReturnType<typeof tool>[] = [], text: string | null = null) {
  await route.fulfill({
    contentType: 'application/json', headers: cors,
    body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: text, ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: calls.length ? 'tool_calls' : 'stop' }] }),
  });
}
function result(body: unknown, toolId: string): Record<string, unknown> {
  if (!isRecord(body) || !Array.isArray(body.messages)) throw new Error('Missing provider messages');
  const message = [...body.messages].reverse().find((entry: unknown) => isRecord(entry) && entry.role === 'tool' && entry.tool_call_id === toolId);
  if (!isRecord(message) || typeof message.content !== 'string') throw new Error(`Missing result for ${toolId}`);
  const value: unknown = JSON.parse(message.content);
  if (!isRecord(value)) throw new Error(`Malformed result for ${toolId}`);
  return value;
}
async function navigate(page: Page, name: string) {
  const mobile = page.getByRole('navigation', { name: 'Mobile navigation' });
  const nav = await mobile.isVisible() ? mobile : page.getByRole('navigation', { name: 'Main navigation' });
  await nav.getByRole('button', { name, exact: true }).click();
}
async function configure(page: Page) {
  await navigate(page, 'Settings');
  await page.getByLabel('OpenRouter API key', { exact: true }).fill('fixture-only-key');
  await page.getByRole('radio', { name: 'Use another model', exact: true }).check();
  await page.getByLabel('Custom model ID', { exact: true }).fill('fixture/setup-model');
  await page.getByRole('button', { name: 'Save concierge settings' }).click();
  await expect(page.getByText('Home Concierge settings saved.', { exact: true })).toBeVisible();
}
async function provider(page: Page, handler: (body: unknown, round: number, route: Route) => Promise<void>) {
  let round = 0;
  await page.route('https://openrouter.ai/**', async (route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: cors });
    } else if (route.request().url().endsWith('/chat/completions')) {
      await handler(route.request().postDataJSON(), round++, route);
    } else await route.abort('blockedbyclient');
  });
}

test('Concierge creates a room, moves a device, saves a working mood, and undoes each change', async ({ page }) => {
  let deviceId = '';
  let officeId = '';
  await provider(page, async (body, round, route) => {
    if (round === 0) return reply(route, [tool('list_home_structure')]);
    if (round === 1) {
      const structure = result(body, 'list_home_structure');
      expect(structure.demo).toBe(true);
      expect(Array.isArray(structure.devices)).toBe(true);
      if (!Array.isArray(structure.devices)) throw new Error('Missing devices');
      const device = structure.devices.find((entry: unknown) => isRecord(entry) && Array.isArray(entry.entity_ids) && entry.entity_ids.includes('light.reading_lamp'));
      if (!isRecord(device) || typeof device.id !== 'string') throw new Error('Missing reading lamp device');
      deviceId = device.id;
      return reply(route, [tool('create_room', { name: 'Office' })]);
    }
    if (round === 2) {
      const created = result(body, 'create_room');
      if (!isRecord(created.area) || typeof created.area.area_id !== 'string') throw new Error('Missing new room');
      officeId = created.area.area_id;
      return reply(route, [tool('assign_device_to_room', { device_id: deviceId, area_id: officeId })]);
    }
    if (round === 3) {
      expect(result(body, 'assign_device_to_room').changed).toBe(true);
      return reply(route, [tool('save_mood', { name: 'Reading time', targets: [{ entity_id: 'light.reading_lamp', state: 'on', brightness_pct: 30 }] })]);
    }
    expect(result(body, 'save_mood').verification).toBe('saved');
    return reply(route, [], 'Your demo office and Reading time mood are ready.');
  });
  await page.goto('/');
  await configure(page);
  await navigate(page, 'Controls');
  await page.getByRole('button', { name: 'Organize rooms', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Message Home Concierge' });
  await expect(input).toHaveValue('Help me organize my rooms and the devices assigned to them.');
  await input.fill('Create an office, move the reading lamp there, and save a Reading time mood at 30%.');
  await input.press('Enter');
  await expect(page.getByRole('log')).toContainText('Your demo office and Reading time mood are ready.');
  await navigate(page, 'Controls');
  await page.locator('.room-card').filter({ has: page.getByRole('heading', { name: 'Office', exact: true }) }).click();
  await expect(page.getByRole('switch', { name: 'Toggle Reading lamp', exact: true })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Toggle Pendant lights', exact: true })).toHaveCount(0);
  await navigate(page, 'Overview');
  await page.getByRole('button', { name: 'Reading time', exact: true }).click();
  await expect(page.getByRole('status')).toContainText(/Reading time/);
  await navigate(page, 'Controls');
  const lamp = page.locator('.device-card').filter({ has: page.getByRole('heading', { name: 'Reading lamp', exact: true }) });
  await expect(lamp.getByRole('slider')).toHaveValue('30');
  await navigate(page, 'Concierge');
  await page.locator('.setup-history summary').click();
  for (let index = 0; index < 3; index++) {
    await page.locator('.setup-history li').first().getByRole('button', { name: /^Undo / }).click();
    await expect(page.locator('.setup-history li')).toHaveCount(2 - index);
  }
  await navigate(page, 'Controls');
  await expect(page.getByRole('heading', { name: 'Office', exact: true })).toHaveCount(0);
  await page.locator('.room-card').filter({ has: page.getByRole('heading', { name: 'Living room', exact: true }) }).click();
  await expect(page.getByRole('switch', { name: 'Toggle Reading lamp', exact: true })).toBeVisible();
  await navigate(page, 'Overview');
  await expect(page.getByRole('button', { name: 'Reading time', exact: true })).toHaveCount(0);
  expect(officeId).not.toBe('');
});

test('new empty rooms stay visible and rename undo preserves their identity', async ({ page }) => {
  let roomId = '';
  await provider(page, async (body, round, route) => {
    if (round === 0) return reply(route, [tool('list_home_structure')]);
    if (round === 1) return reply(route, [tool('create_room', { name: 'Spare room' })]);
    if (round === 2) {
      const created = result(body, 'create_room');
      if (!isRecord(created.area) || typeof created.area.area_id !== 'string') throw new Error('Missing room');
      roomId = created.area.area_id;
      return reply(route, [tool('rename_room', { area_id: roomId, name: 'Nursery' })]);
    }
    expect(result(body, 'rename_room').changed).toBe(true);
    return reply(route, [], 'The empty Nursery is ready in your demo home.');
  });
  await page.goto('/');
  await configure(page);
  await navigate(page, 'Concierge');
  await page.getByRole('textbox', { name: 'Message Home Concierge' }).fill('Create a spare room, then rename it Nursery.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('log')).toContainText('The empty Nursery is ready');
  await navigate(page, 'Controls');
  await expect(page.locator('.room-card').filter({ hasText: 'Nursery' })).toContainText('0 devices');
  await navigate(page, 'Concierge');
  await page.locator('.setup-history summary').click();
  await page.locator('.setup-history li').first().getByRole('button').click();
  await expect(page.locator('.setup-history li')).toHaveCount(1);
  await navigate(page, 'Controls');
  await expect(page.getByRole('heading', { name: 'Spare room', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Nursery', exact: true })).toHaveCount(0);
  expect(roomId).not.toBe('');
});

test('mood setup entry point opens a draft without sending or changing devices', async ({ page }) => {
  let requests = 0;
  await provider(page, async (_body, _round, route) => { requests++; await reply(route, [], 'Unexpected'); });
  await page.goto('/');
  await configure(page);
  await navigate(page, 'Overview');
  await page.getByRole('button', { name: 'Set up a mood', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Message Home Concierge' })).toHaveValue('Help me set up a mood using the rooms and devices in my home.');
  expect(requests).toBe(0);
  await inputReturnCheck(page);
});

async function inputReturnCheck(page: Page) {
  await page.getByRole('textbox', { name: 'Message Home Concierge' }).fill('My revised mood request');
  await navigate(page, 'Controls');
  await navigate(page, 'Concierge');
  await expect(page.getByRole('textbox', { name: 'Message Home Concierge' })).not.toHaveValue('Help me set up a mood using the rooms and devices in my home.');
}

test('live room and mood changes persist at the HA endpoint and survive reconnecting', async ({ page }) => {
  const areas = [
    { area_id: 'living', name: 'Living room' },
    { area_id: 'all', name: 'All' },
    { area_id: 'unassigned', name: 'Storage' },
  ];
  const devices = [{ id: 'lamp1', name: 'Desk lamp', area_id: 'living' }];
  const states: HassEntity[] = [{ entity_id: 'light.desk', state: 'on', attributes: { friendly_name: 'Desk lamp', brightness: 200, supported_color_modes: ['brightness'] } }];
  const scenes = new Map<string, SceneConfig>();
  const writes: string[] = [];
  const commands: Record<string, unknown>[] = [];
  await page.routeWebSocket('ws://home-setup.test/api/websocket', (socket) => {
    socket.send(JSON.stringify({ type: 'auth_required' }));
    socket.onMessage((message) => {
      const command: unknown = JSON.parse(message.toString());
      if (!isRecord(command)) throw new Error('Invalid fixture command');
      commands.push(command);
      if (command.type === 'auth') {
        expect(command.access_token).toBe('fixture-home-token');
        socket.send(JSON.stringify({ type: 'auth_ok' }));
        return;
      }
      if (command.type === 'ping') { socket.send(JSON.stringify({ type: 'pong', id: command.id })); return; }
      let value: unknown = null;
      switch (command.type) {
        case 'subscribe_events': break;
        case 'get_states': value = states; break;
        case 'get_config': value = { location_name: 'Fixture home', unit_system: { temperature: '°C' } }; break;
        case 'config/area_registry/list': value = areas; break;
        case 'config/device_registry/list': value = devices; break;
        case 'config/entity_registry/list': value = [{ entity_id: 'light.desk', device_id: 'lamp1', area_id: null }]; break;
        case 'config/area_registry/create': {
          const area = { area_id: 'office', name: String(command.name) };
          areas.push(area); value = area; break;
        }
        case 'config/device_registry/update': {
          expect(command.device_id).toBe('lamp1');
          devices[0].area_id = String(command.area_id); value = devices[0]; break;
        }
        case 'search/related': value = { automation: ['automation.evening_lights'] }; break;
        case 'call_service': {
          expect(command.domain).toBe('scene');
          const scene = isRecord(command.target) ? states.find((entity) => entity.entity_id === command.target.entity_id) : undefined;
          const config = typeof scene?.attributes.id === 'string' ? scenes.get(scene.attributes.id) : undefined;
          if (!config) throw new Error('Unknown fixture scene');
          for (const state of states) {
            const target = config.entities[state.entity_id];
            if (typeof target === 'string') state.state = target;
            else if (target) { const { state: next, ...attributes } = target; state.state = next; state.attributes = { ...state.attributes, ...attributes }; }
          }
          value = { context: { id: 'test-call' } }; break;
        }
        case 'hjem/home/subscribe':
          // Home Assistant has no such command; only a Hjem hub does.
          socket.send(JSON.stringify({ id: command.id, type: 'result', success: false, error: { code: 'unknown_command', message: 'Unknown command.' } }));
          return;
        default: throw new Error(`Unexpected fixture command ${String(command.type)}`);
      }
      socket.send(JSON.stringify({ id: command.id, type: 'result', success: true, result: value }));
    });
  });
  await page.route('http://home-setup.test/api/config/scene/config/*', async (route) => {
    if (route.request().method() === 'OPTIONS') { await route.fulfill({ status: 204, headers: cors }); return; }
    expect(route.request().headers().authorization).toBe('Bearer fixture-home-token');
    const id = new URL(route.request().url()).pathname.split('/').at(-1);
    if (!id) throw new Error('Missing config ID');
    let value: unknown;
    if (route.request().method() === 'POST') {
      const config = route.request().postDataJSON() as SceneConfig;
      expect(config.entities).toEqual({ 'light.desk': { state: 'on', brightness: 77 } });
      scenes.set(id, config);
      writes.push(id);
      states.push({ entity_id: `scene.${id}`, state: 'unknown', attributes: { id, friendly_name: config.name } });
      value = { result: 'ok' };
    } else value = scenes.get(id);
    await route.fulfill({ contentType: 'application/json', headers: cors, body: JSON.stringify(value) });
  });
  await provider(page, async (body, round, route) => {
    expect(JSON.stringify(body)).not.toContain('fixture-home-token');
    if (round === 0) return reply(route, [tool('list_home_structure')]);
    if (round === 1) return reply(route, [tool('create_room', { name: 'Office' })]);
    if (round === 2) return reply(route, [tool('assign_device_to_room', { device_id: 'lamp1', area_id: 'office' })]);
    if (round === 3) {
      const moved = result(body, 'assign_device_to_room');
      expect(JSON.stringify(moved.related_routines)).toContain('automation.evening_lights');
      return reply(route, [tool('save_mood', { name: 'Desk reading', targets: [{ entity_id: 'light.desk', state: 'on', brightness_pct: 30 }] })]);
    }
    expect(result(body, 'save_mood').verification).toBe('saved');
    return reply(route, [], 'The office and Desk reading mood are saved in Home Assistant.');
  });
  const connect = async () => {
    await navigate(page, 'Settings');
    await page.locator('main').getByRole('button', { name: /^(Connect your home|Manage connection)$/ }).click();
    await page.getByLabel('Home Assistant address', { exact: true }).fill('http://home-setup.test');
    await page.getByLabel('Long-lived access token', { exact: true }).fill('fixture-home-token');
    await page.getByRole('button', { name: 'Connect Home Assistant', exact: true }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
  };
  await page.goto('/');
  await configure(page);
  await connect();
  await navigate(page, 'Concierge');
  await page.getByRole('textbox', { name: 'Message Home Concierge' }).fill('Create an office, move the desk lamp there, and save a reading mood at 30%.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('log')).toContainText('The office and Desk reading mood are saved');
  expect(writes).toHaveLength(1);
  await page.reload(); // Browser preferences disappear, while our HA peer retains its config.
  await connect();
  await navigate(page, 'Overview');
  await page.getByRole('button', { name: 'Desk reading', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('device states confirmed');
  await navigate(page, 'Controls');
  await expect(page.locator('.room-card').filter({ hasText: 'Office' })).toContainText('1 devices');
  await expect(page.getByRole('slider', { name: 'Desk lamp brightness' })).toHaveValue('30');
  // Real HA area IDs must not collide with Hjem's All rooms / Other devices filters.
  await page.locator('.room-card').filter({ has: page.getByRole('heading', { name: 'All', exact: true }) }).click();
  await expect(page.getByRole('slider', { name: 'Desk lamp brightness' })).toHaveCount(0);
  await page.locator('.room-card').filter({ has: page.getByRole('heading', { name: 'Storage', exact: true }) }).click();
  await expect(page.getByRole('slider', { name: 'Desk lamp brightness' })).toHaveCount(0);
  await page.getByRole('button', { name: 'All rooms', exact: true }).click();
  await expect(page.getByRole('slider', { name: 'Desk lamp brightness' })).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(commands.filter((command) => command.type === 'config/area_registry/create')).toHaveLength(1);
});
