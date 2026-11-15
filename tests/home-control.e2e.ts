import { expect, test, type Page } from '@playwright/test';

async function navigate(
  page: Page,
  name: 'Overview' | 'Rooms' | 'Scenes' | 'Settings',
) {
  const mobile = page.getByRole('navigation', { name: 'Mobile navigation' });
  const nav = (await mobile.isVisible())
    ? mobile
    : page.getByRole('navigation', { name: 'Main navigation' });
  await nav.getByRole('button', { name, exact: true }).click();
}

async function openConnection(page: Page) {
  await page.locator('.connection-pill').click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

async function mockHomeAssistant(page: Page) {
  await page.addInitScript(() => {
    type Entity = {
      entity_id: string;
      state: string;
      attributes: Record<string, unknown>;
      last_updated?: string;
    };
    const states: Entity[] = [
      {
        entity_id: 'light.office',
        state: 'on',
        attributes: {
          friendly_name: 'Office light',
          brightness: 128,
          supported_color_modes: ['brightness'],
        },
        last_updated: '2020-01-01T00:00:00Z',
      },
      {
        entity_id: 'switch.garden',
        state: 'unavailable',
        attributes: { friendly_name: 'Garden pump' },
      },
      {
        entity_id: 'scene.focus',
        state: 'unknown',
        attributes: { friendly_name: 'Focus time' },
      },
    ];
    const server = {
      commands: [] as Record<string, any>[],
      sockets: [] as MockWebSocket[],
      offline: false,
      rejectActions: false,
      changeState(entityId: string, state: string) {
        const entity = states.find((item) => item.entity_id === entityId)!;
        Object.assign(entity, {
          state,
          last_updated: new Date().toISOString(),
        });
        for (const socket of server.sockets.filter(
          (item) => item.readyState === 1,
        ))
          socket.deliver({
            id: socket.subscriptionId,
            type: 'event',
            event: {
              event_type: 'state_changed',
              data: { entity_id: entityId, new_state: entity },
            },
          });
      },
      disconnect() {
        server.offline = true;
        for (const socket of server.sockets) {
          socket.readyState = 3;
          socket.onclose?.();
        }
      },
    };
    class MockWebSocket {
      static OPEN = 1;
      readyState = 1;
      subscriptionId?: number;
      onmessage: ((event: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;
      constructor() {
        server.sockets.push(this);
        if (!server.offline)
          setTimeout(() => this.deliver({ type: 'auth_required' }), 0);
      }
      close() {
        this.readyState = 3;
      }
      deliver(message: unknown) {
        if (this.readyState === 1)
          this.onmessage?.({ data: JSON.stringify(message) });
      }
      send(text: string) {
        const command = JSON.parse(text);
        server.commands.push(command);
        setTimeout(() => {
          if (command.type === 'auth') {
            this.deliver({ type: 'auth_ok' });
            return;
          }
          if (command.type === 'ping') {
            this.deliver({ type: 'pong', id: command.id });
            return;
          }
          let result: unknown = null;
          if (command.type === 'subscribe_events')
            this.subscriptionId = command.id;
          if (command.type === 'get_states') result = states;
          if (command.type === 'config/area_registry/list')
            result = [{ area_id: 'office', name: 'Office' }];
          if (command.type === 'config/device_registry/list') result = [];
          if (command.type === 'config/entity_registry/list')
            result = states.map((item) => ({
              entity_id: item.entity_id,
              area_id: 'office',
              device_id: null,
            }));
          if (command.type === 'get_config')
            result = {
              location_name: 'Test home',
              unit_system: { temperature: '°C' },
            };
          const success = !(
            server.rejectActions && command.type === 'call_service'
          );
          this.deliver({
            id: command.id,
            type: 'result',
            success,
            result,
            error: success
              ? undefined
              : { message: 'Device rejected the action' },
          });
        }, 0);
      }
    }
    Object.assign(window, { WebSocket: MockWebSocket, __ha: server });
  });
}

async function connectMock(page: Page) {
  await openConnection(page);
  await page
    .getByLabel('Home Assistant address', { exact: true })
    .fill('https://ha.example');
  await page
    .getByLabel('Long-lived access token', { exact: true })
    .fill('private-test-access-token');
  await page
    .getByRole('button', { name: 'Connect Home Assistant', exact: true })
    .click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.locator('.connection-pill')).toHaveText('Home connected');
}

test('demo lights, keyboard brightness, and temperature controls update their state', async ({
  page,
}) => {
  await page.goto('/');
  const pendant = page.getByRole('article', {
    name: 'Pendant lights',
    exact: true,
  });
  const power = pendant.getByRole('switch', { name: 'Toggle Pendant lights' });
  await expect(power).toBeChecked();
  await power.click();
  await expect(power).not.toBeChecked();
  await expect(pendant.getByRole('slider')).toBeDisabled();
  await power.click();
  const brightness = pendant.getByRole('slider', {
    name: 'Pendant lights brightness',
  });
  await brightness.focus();
  await page.keyboard.press('End');
  await expect(brightness).toHaveValue('100');
  await expect(pendant.getByText('On · 100%', { exact: true })).toBeVisible();
  const climate = page.getByRole('article', {
    name: 'Living room climate',
    exact: true,
  });
  await climate
    .getByRole('button', { name: 'Raise Living room climate temperature' })
    .click();
  await expect(climate.locator('.temperature-display')).toHaveText('21.5°C');
  await climate
    .getByRole('button', { name: 'Lower Living room climate temperature' })
    .click();
  await expect(climate.locator('.temperature-display')).toHaveText('21°C');
});

test('rooms, search, pins, and persistent preferences work together', async ({
  page,
}) => {
  await page.goto('/');
  await navigate(page, 'Rooms');
  await page
    .getByRole('button', { name: 'Kitchen 2 devices · 0 active' })
    .click();
  await expect(page.getByRole('article')).toHaveCount(2);
  await page.getByRole('textbox', { name: 'Find a device' }).fill('coffee');
  await expect(page.getByRole('article')).toHaveCount(1);
  await page
    .getByRole('button', { name: 'Pin Coffee machine', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Unpin Coffee machine', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Clear search' }).click();
  await page.getByRole('button', { name: 'All rooms', exact: true }).click();
  await page.getByRole('button', { name: 'Pinned', exact: true }).click();
  await expect(page.getByRole('article')).toHaveCount(5);
  await expect(
    page.getByRole('article', { name: 'Coffee machine', exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Pinned', exact: true }).click();
  await expect(page.getByRole('article')).toHaveCount(5);
});

test('scenes change the demo home and show confirmation', async ({ page }) => {
  await page.goto('/');
  await navigate(page, 'Scenes');
  await page.getByRole('button', { name: 'Good night', exact: true }).click();
  await expect(page.getByRole('status')).toContainText(
    'Good night activated in your demo home',
  );
  await navigate(page, 'Overview');
  await expect(
    page.getByRole('switch', { name: 'Toggle Pendant lights' }),
  ).not.toBeChecked();
  await expect(
    page.getByRole('switch', { name: 'Toggle Reading lamp' }),
  ).not.toBeChecked();
  await expect(
    page.getByRole('button', { name: 'Play Living room speaker' }),
  ).toBeVisible();
});

test('connection dialog validates addresses and never persists an access token', async ({
  page,
}) => {
  await page.goto('/');
  await openConnection(page);
  await page
    .getByLabel('Home Assistant address', { exact: true })
    .fill('file:///not-a-server');
  await page
    .getByLabel('Long-lived access token', { exact: true })
    .fill('private-test-access-token');
  await page
    .getByRole('button', { name: 'Connect Home Assistant', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText('http:// or https://');
  const stored = await page.evaluate(() =>
    JSON.stringify({
      local: { ...localStorage },
      session: { ...sessionStorage },
    }),
  );
  expect(stored).not.toContain('private-test-access-token');
  await page.getByRole('button', { name: 'Close connection settings' }).click();
  await page.reload();
  await openConnection(page);
  await expect(
    page.getByLabel('Long-lived access token', { exact: true }),
  ).toHaveValue('');
});

test('live Home Assistant service calls, events, and offline controls work end to end', async ({
  page,
}) => {
  await mockHomeAssistant(page);
  await page.goto('/');
  await connectMock(page);
  await expect(page.getByRole('article')).toHaveCount(2);
  const office = page.getByRole('switch', { name: 'Toggle Office light' });
  await expect(office).toBeChecked();
  await expect(
    page.getByRole('switch', { name: 'Toggle Garden pump' }),
  ).toBeDisabled();
  await office.click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__ha.commands.filter(
          (command: any) => command.type === 'call_service',
        ),
      ),
    )
    .toEqual([
      expect.objectContaining({
        domain: 'light',
        service: 'turn_off',
        target: { entity_id: 'light.office' },
        service_data: {},
      }),
    ]);
  // An acknowledgement alone does not invent a new device state.
  await expect(office).toBeChecked();
  await page.evaluate(() =>
    (window as any).__ha.changeState('light.office', 'off'),
  );
  await expect(office).not.toBeChecked();
  await page.evaluate(() => (window as any).__ha.disconnect());
  await expect(page.locator('.connection-pill')).toHaveText('Reconnecting…');
  await expect(office).toBeDisabled();
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: 'Connection to Home Assistant was lost' }),
  ).toBeVisible();
  const stored = await page.evaluate(() =>
    JSON.stringify({
      local: { ...localStorage },
      session: { ...sessionStorage },
    }),
  );
  expect(stored).toContain('https://ha.example');
  expect(stored).not.toContain('private-test-access-token');
});

test('live service failures stay visible and editing connection settings keeps the app usable', async ({
  page,
}) => {
  await mockHomeAssistant(page);
  await page.goto('/');
  await connectMock(page);
  await page.evaluate(() => {
    (window as any).__ha.rejectActions = true;
  });
  await page.getByRole('switch', { name: 'Toggle Office light' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Device rejected the action',
  );
  const brightness = page.getByRole('slider', {
    name: 'Office light brightness',
  });
  await brightness.focus();
  await page.keyboard.press('End');
  await expect(brightness).toHaveValue('50');
  await openConnection(page);
  await expect(
    page.getByLabel('Long-lived access token', { exact: true }),
  ).toHaveValue('');
  await page.getByLabel('Home Assistant address', { exact: true }).fill('');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Close connection settings' }).click();
  await expect(
    page.getByRole('switch', { name: 'Toggle Office light' }),
  ).toBeEnabled();
});

test('overview, rooms, scenes, settings, and connection dialog fit the viewport', async ({
  page,
}) => {
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  await page.goto('/');
  for (const destination of [
    'Overview',
    'Rooms',
    'Scenes',
    'Settings',
  ] as const) {
    await navigate(page, destination);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const sizes = await page.evaluate(() => ({
      body: document.body.scrollWidth,
      root: document.documentElement.clientWidth,
    }));
    expect(sizes.body).toBeLessThanOrEqual(sizes.root + 1);
  }
  await openConnection(page);
  const bounds = await page.getByRole('dialog').boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(
    page.viewportSize()!.width + 1,
  );
  expect(browserErrors).toEqual([]);
});

test('manual dark and light appearance changes persist across refresh', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  const lightSurface = await page
    .locator('.device-card')
    .first()
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  await page
    .getByRole('button', { name: 'Switch to dark mode', exact: true })
    .click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const darkSurface = await page
    .locator('.device-card')
    .first()
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(darkSurface).not.toBe(lightSurface);
  await expect(
    page.getByRole('button', { name: 'Switch to light mode', exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await navigate(page, 'Settings');
  await expect(
    page.getByRole('button', { name: 'Dark', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Light', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(
    page.getByRole('button', { name: 'Light', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(
    page.getByRole('button', { name: 'Switch to dark mode', exact: true }),
  ).toBeVisible();
});

test('system appearance follows live device changes and manual choices override them', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await navigate(page, 'Settings');
  await expect(
    page.getByRole('button', { name: 'System', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(
    page.getByRole('button', { name: 'Dark', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'System', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(
    page.getByRole('button', { name: 'System', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});
