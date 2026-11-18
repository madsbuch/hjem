import { expect, test, type Page } from '@playwright/test';
import { nativeStorage } from './helpers/native-storage';

async function openPlanner(page: Page) {
  const mobile = page.getByRole('navigation', { name: 'Mobile navigation' });
  const navigation = await mobile.isVisible() ? mobile : page.getByRole('navigation', { name: 'Main navigation' });
  await navigation.getByRole('button', { name: 'Planner', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Find, name, and place.' })).toBeVisible();
}

test('names lights, places them in rooms, and blinks a lamp in the demo home', async ({ page }) => {
  await page.goto('/');
  await openPlanner(page);
  const lamp = page.getByRole('article', { name: 'Reading lamp' });
  await expect(lamp).toHaveClass(/is-on/);

  await lamp.getByRole('button', { name: 'Blink Reading lamp' }).click();
  await expect(lamp.getByRole('button', { name: 'Stop blinking Reading lamp' })).toBeVisible();
  await expect(lamp).not.toHaveClass(/is-on/);
  await expect(lamp.getByRole('button', { name: 'Blink Reading lamp' })).toBeVisible({ timeout: 8_000 });
  await expect(lamp).toHaveClass(/is-on/);

  const name = lamp.getByLabel('Name for Reading lamp');
  await name.fill('Desk lamp');
  await name.press('Enter');
  await expect(page.getByText('Reading lamp is now Desk lamp.')).toBeVisible();
  const desk = page.getByRole('article', { name: 'Desk lamp' });
  await desk.getByLabel('Room for Desk lamp').selectOption({ label: 'Bedroom' });
  await expect(page.getByText('Desk lamp assigned to Bedroom.')).toBeVisible();

  await page.getByLabel('New room name').fill('Office');
  await page.getByRole('button', { name: 'Add room' }).click();
  await expect(page.getByText('Office created in the demo home.')).toBeVisible();
  await desk.getByLabel('Room for Desk lamp').selectOption({ label: 'Office' });
  await expect(desk.getByLabel('Room for Desk lamp')).toHaveValue(/room_/);
});

test('highlights the remote that was just pressed in the demo home', async ({ page }) => {
  await page.goto('/');
  await openPlanner(page);
  await page.getByRole('tab', { name: /Remotes/ }).click();
  await expect(page.getByRole('article')).toHaveCount(3);
  await page.getByRole('button', { name: 'Needs a room (2)' }).click();
  await expect(page.getByRole('article')).toHaveCount(2);
  await page.getByRole('button', { name: 'Everything' }).click();

  await page.getByRole('button', { name: 'Simulate a press' }).click();
  const pressed = page.locator('.remote-plan.is-pressed');
  await expect(pressed).toHaveCount(1);
  await expect(page.getByRole('status').filter({ hasText: 'just now' })).toBeVisible();
});

test('lights up a live remote from a Home Assistant button event and renames it', async ({ page }) => {
  await nativeStorage(page, {
    serverUrl: 'http://planner.test',
    connection: { serverUrl: 'http://planner.test', token: 'fixture-only-token' },
  });
  const commands: Record<string, unknown>[] = [];
  let pushEvent: ((value: unknown) => void) | undefined;
  let zhaSubscription = 0;
  let remoteName: string | null = null;
  await page.routeWebSocket('ws://planner.test/api/websocket', (socket) => {
    const send = (value: unknown) => socket.send(JSON.stringify(value));
    pushEvent = send;
    socket.onMessage((raw) => {
      const command: Record<string, unknown> = JSON.parse(String(raw));
      commands.push(command);
      if (command.type === 'auth') { send({ type: 'auth_ok' }); return; }
      if (command.type === 'ping') { send({ id: command.id, type: 'pong' }); return; }
      if (command.type === 'subscribe_events' && command.event_type === 'zha_event' && typeof command.id === 'number') zhaSubscription = command.id;
      if (command.type === 'config/device_registry/update' && typeof command.name_by_user === 'string') remoteName = command.name_by_user;
      let result: unknown = null;
      if (command.type === 'get_states') result = [
        { entity_id: 'light.hall', state: 'off', attributes: { friendly_name: 'Hall light' } },
      ];
      else if (command.type === 'get_config') result = { location_name: 'Planner home' };
      else if (command.type === 'config/area_registry/list') result = [{ area_id: 'hall', name: 'Hall' }];
      else if (command.type === 'config/device_registry/list') result = [
        { id: 'zha-remote', area_id: null, name: 'TS0044', name_by_user: remoteName, manufacturer: 'Fixture', model: 'Four-key scene switch' },
        { id: 'hall-light', area_id: 'hall', name: 'Hall light' },
      ];
      else if (command.type === 'config/entity_registry/list') result = [
        { entity_id: 'light.hall', area_id: null, device_id: 'hall-light' },
      ];
      send({ id: command.id, type: 'result', success: true, result });
    });
    send({ type: 'auth_required' });
  });
  await page.goto('/');
  await openPlanner(page);
  await page.getByRole('tab', { name: /Remotes/ }).click();
  const remote = page.getByRole('article', { name: 'TS0044' });
  await expect(remote).toBeVisible();
  await expect.poll(() => zhaSubscription).toBeGreaterThan(0);

  pushEvent?.({ id: zhaSubscription, type: 'event', event: { event_type: 'zha_event', time_fired: new Date().toISOString(), data: { device_id: 'zha-remote', command: 'remote_button_short_press' } } });
  await expect(remote).toHaveClass(/is-pressed/);
  await expect(remote.getByText('remote button short press')).toBeVisible();

  const name = remote.getByLabel('Name for TS0044');
  await name.fill('Hallway remote');
  await name.press('Enter');
  await expect(page.getByText('TS0044 is now Hallway remote.')).toBeVisible();
  expect(commands).toContainEqual(expect.objectContaining({ type: 'config/device_registry/update', device_id: 'zha-remote', name_by_user: 'Hallway remote' }));
});
