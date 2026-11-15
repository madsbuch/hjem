import { expect, test, type Page } from '@playwright/test';
import { nativeStorage } from './helpers/native-storage';

async function navigate(
  page: Page,
  name: 'Overview' | 'Controls' | 'Apps' | 'Settings',
) {
  await page.locator('nav:visible').first().waitFor();
  const mobile = page.getByRole('navigation', { name: 'Mobile navigation' });
  const nav = (await mobile.isVisible())
    ? mobile
    : page.getByRole('navigation', { name: 'Main navigation' });
  await nav.getByRole('button', { name, exact: true }).click();
}

async function openConnection(page: Page) {
  await navigate(page, 'Settings');
  await page
    .locator('main')
    .getByRole('button', { name: /^(Connect your home|Manage connection)$/ })
    .click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

async function mockHomeAssistant(page: Page, includeMedia = false) {
  await page.addInitScript((includeMedia) => {
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
    if (includeMedia)
      states.push(
        {
          entity_id: 'media_player.speaker',
          state: 'playing',
          attributes: {
            friendly_name: 'Office Sonos',
            media_title: 'A quiet morning',
            media_artist: 'Home playlist',
            volume_level: 0.32,
            is_volume_muted: false,
            supported_features: 1 | 4 | 8 | 16 | 32 | 16384,
          },
        },
        {
          entity_id: 'media_player.basic',
          state: 'playing',
          attributes: {
            friendly_name: 'Basic player',
            media_title: 'A radio station',
            supported_features: 1 | 16384,
          },
        },
      );
    const server = {
      commands: [] as Record<string, any>[],
      sockets: [] as MockWebSocket[],
      offline: false,
      rejectActions: false,
      changeState(
        entityId: string,
        state: string,
        attributes: Record<string, unknown> = {},
      ) {
        const entity = states.find((item) => item.entity_id === entityId);
        if (!entity) throw new Error(`Unknown fixture entity: ${entityId}`);
        Object.assign(entity, {
          state,
          attributes: { ...entity.attributes, ...attributes },
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
      addCalendar() {
        states.push({
          entity_id: 'calendar.family',
          state: 'off',
          attributes: { friendly_name: 'Family' },
        });
      },
      addDevice(entityId: string, state: string, attributes: Record<string, unknown>) {
        states.push({ entity_id: entityId, state, attributes });
        server.changeState(entityId, state);
      },
      addScene(entityId: string, name: string) {
        states.push({
          entity_id: entityId,
          state: 'unknown',
          attributes: { friendly_name: name },
        });
        server.changeState(entityId, 'unknown');
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
          if (
            command.type === 'call_service' &&
            command.domain === 'calendar'
          ) {
            const from = new Date(command.service_data.start_date_time);
            const to = new Date(command.service_data.end_date_time);
            const dateOnly = (date: Date) =>
              `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
            const at = (hour: number) => {
              const date = new Date(from);
              date.setHours(hour);
              return date.toISOString();
            };
            result = {
              response: {
                'calendar.family': {
                  events: [
                    {
                      summary: 'Family day',
                      start: dateOnly(from),
                      end: dateOnly(to),
                    },
                    {
                      summary: 'Lunch at home',
                      start: at(12),
                      end: at(13),
                      location: 'Kitchen',
                    },
                    {
                      summary: 'Tomorrow appointment',
                      start: to.toISOString(),
                      end: at(26),
                    },
                  ],
                },
              },
            };
          }
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
  }, includeMedia);
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
  await expect(
    page.locator('main .setting-row').filter({ hasText: 'Connection' }),
  ).toContainText('Home connected');
  await navigate(page, 'Overview');
}

test('demo lights, keyboard brightness, and temperature controls update their state', async ({
  page,
}) => {
  await page.goto('/');
  await navigate(page, 'Controls');
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

test('controls, room search, pins, and persistent preferences work together', async ({
  page,
}) => {
  await nativeStorage(page);
  await page.goto('/');
  await navigate(page, 'Controls');
  await page
    .getByRole('button', { name: 'Kitchen 3 devices · 0 active' })
    .click();
  await expect(page.getByRole('article')).toHaveCount(3);
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
  await navigate(page, 'Controls');
  await page.getByRole('button', { name: 'Pinned', exact: true }).click();
  await expect(page.getByRole('article')).toHaveCount(5);
});

test('overview keeps moods and music together and device controls on their own page', async ({
  page,
}) => {
  await page.goto('/');
  await expect(
    page.locator('.home-selector, .connection-pill, .nav-label'),
  ).toHaveCount(0);
  await expect(page.getByText('YOUR SPACE', { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('region', { name: 'Today’s calendar' }),
  ).toBeVisible();
  await expect(page.locator('.main-shell > header, .topbar')).toHaveCount(0);
  await expect(page.locator('.device-card:not(.media_player)')).toHaveCount(0);
  await expect(
    page.getByRole('textbox', { name: 'Find a device' }),
  ).toHaveCount(0);
  await expect(page.locator('.app-launcher')).toHaveCount(0);
  await expect(page.getByText(/sample (app )?previews/i)).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'A whole mood', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('navigation').getByRole('button', {
      name: 'Scenes',
      exact: true,
      includeHidden: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: /Home feels\s*better together/i }),
  ).toHaveCount(0);
  await expect(page.locator('.breadcrumb')).toHaveCount(0);
  await expect(
    page.getByRole('button', {
      name: /Switch to (dark|light) mode/,
      includeHidden: true,
    }),
  ).toHaveCount(0);
  for (const name of [
    'Good morning',
    'Cosy evening',
    'Heading out',
    'Good night',
  ]) {
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Good night', exact: true }).click();
  await expect(page.getByRole('status')).toContainText(
    'Good night activated in your demo home',
  );
  await expect(
    page.getByRole('button', { name: 'Play Living room speaker' }),
  ).toBeVisible();
  await navigate(page, 'Controls');
  await expect(
    page.getByRole('switch', { name: 'Toggle Pendant lights' }),
  ).not.toBeChecked();
  await expect(
    page.getByRole('switch', { name: 'Toggle Reading lamp' }),
  ).not.toBeChecked();
  await expect(
    page.getByRole('textbox', { name: 'Find a device' }),
  ).toBeVisible();
});

test('all live scenes remain accessible from overview beyond the first four', async ({
  page,
}) => {
  await mockHomeAssistant(page);
  await page.goto('/');
  await connectMock(page);
  await page.evaluate(() => {
    for (const [id, name] of [
      ['movie', 'Movie time'],
      ['dinner', 'Dinner'],
      ['reading', 'Reading'],
      ['weekend', 'Weekend'],
    ]) {
      (window as any).__ha.addScene(`scene.${id}`, name);
    }
  });
  await expect(
    page.getByRole('heading', { name: 'A whole mood', exact: true }),
  ).toBeVisible();
  for (const name of [
    'Focus time',
    'Movie time',
    'Dinner',
    'Reading',
    'Weekend',
  ]) {
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Weekend', exact: true }).click();
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
        domain: 'scene',
        service: 'turn_on',
        target: { entity_id: 'scene.weekend' },
      }),
    ]);
  await expect(page.getByRole('status')).toContainText('Weekend activated.');
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
  await navigate(page, 'Controls');
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
  await expect(page.locator('.offline-banner')).toBeVisible();
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
  expect(stored).not.toContain('https://ha.example');
  expect(stored).not.toContain('private-test-access-token');
});

test('live service failures stay visible and editing connection settings keeps the app usable', async ({
  page,
}) => {
  await mockHomeAssistant(page);
  await page.goto('/');
  await connectMock(page);
  await navigate(page, 'Controls');
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
  ).toHaveValue('private-test-access-token');
  await page.getByLabel('Home Assistant address', { exact: true }).fill('');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Close connection settings' }).click();
  await navigate(page, 'Controls');
  await expect(
    page.getByRole('switch', { name: 'Toggle Office light' }),
  ).toBeEnabled();
});

test('overview, controls, apps, settings, and connection dialog fit the viewport', async ({
  page,
}) => {
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  await page.goto('/');
  for (const destination of [
    'Overview',
    'Controls',
    'Apps',
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
  await nativeStorage(page);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  const lightSurface = await page
    .locator('.device-card')
    .first()
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  await navigate(page, 'Settings');
  const appearance = page.getByRole('group', {
    name: 'Appearance',
    exact: true,
  });
  await appearance.getByRole('button', { name: 'Dark', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(
    appearance.getByRole('button', { name: 'Dark', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await navigate(page, 'Overview');
  const darkSurface = await page
    .locator('.device-card')
    .first()
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(darkSurface).not.toBe(lightSurface);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await navigate(page, 'Settings');
  await expect(
    appearance.getByRole('button', { name: 'Dark', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await appearance.getByRole('button', { name: 'Light', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(
    appearance.getByRole('button', { name: 'Light', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await navigate(page, 'Settings');
  await expect(
    appearance.getByRole('button', { name: 'Light', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
});

test('system appearance follows live device changes and manual choices override them', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await navigate(page, 'Settings');
  const appearance = page.getByRole('group', {
    name: 'Appearance',
    exact: true,
  });
  await expect(
    appearance.getByRole('button', { name: 'System', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await appearance.getByRole('button', { name: 'Dark', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(
    appearance.getByRole('button', { name: 'Dark', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await appearance.getByRole('button', { name: 'System', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(
    appearance.getByRole('button', { name: 'System', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('demo speaker supports volume, mute, tracks, and playback', async ({
  page,
}) => {
  await page.goto('/');
  const speaker = page.getByRole('article', {
    name: 'Living room speaker',
    exact: true,
  });
  const volume = speaker.getByRole('slider', {
    name: 'Living room speaker volume',
  });
  await expect(volume).toHaveValue('32');
  await volume.focus();
  await page.keyboard.press('End');
  await expect(volume).toHaveValue('100');
  await volume.focus();
  await page.keyboard.press('Home');
  await expect(volume).toHaveValue('0');
  await volume.focus();
  await page.keyboard.press('ArrowRight');
  await expect(volume).toHaveValue('1');
  await speaker
    .getByRole('button', { name: 'Mute Living room speaker', exact: true })
    .click();
  await expect(
    speaker.getByRole('button', {
      name: 'Unmute Living room speaker',
      exact: true,
    }),
  ).toBeVisible();
  await speaker
    .getByRole('button', { name: 'Unmute Living room speaker', exact: true })
    .click();
  await expect(
    speaker.getByRole('button', {
      name: 'Mute Living room speaker',
      exact: true,
    }),
  ).toBeVisible();
  const title = speaker.locator('.track-title');
  const originalTitle = await title.textContent();
  await speaker
    .getByRole('button', { name: 'Next track on Living room speaker' })
    .click();
  await expect(title).not.toHaveText(originalTitle!);
  await speaker
    .getByRole('button', { name: 'Previous track on Living room speaker' })
    .click();
  await expect(title).toHaveText(originalTitle!);
  await speaker
    .getByRole('button', { name: 'Pause Living room speaker', exact: true })
    .click();
  await expect(
    speaker.getByRole('button', {
      name: 'Play Living room speaker',
      exact: true,
    }),
  ).toBeVisible();
  await speaker
    .getByRole('button', { name: 'Play Living room speaker', exact: true })
    .click();
  await expect(
    speaker.getByRole('button', {
      name: 'Pause Living room speaker',
      exact: true,
    }),
  ).toBeVisible();
});

test('live speaker sends Home Assistant volume, mute, track, and playback service payloads', async ({
  page,
}) => {
  await mockHomeAssistant(page, true);
  await page.goto('/');
  await connectMock(page);
  const speaker = page.getByRole('article', {
    name: 'Office Sonos',
    exact: true,
  });
  const volume = speaker.getByRole('slider', { name: 'Office Sonos volume' });
  await expect(volume).toHaveValue('32');
  await volume.focus();
  await page.keyboard.press('End');
  await expect(volume).toBeEnabled();
  await volume.focus();
  await page.keyboard.press('Home');
  await expect(volume).toBeEnabled();
  await volume.focus();
  await page.keyboard.press('ArrowRight');
  await expect(volume).toBeEnabled();
  await speaker
    .getByRole('button', { name: 'Mute Office Sonos', exact: true })
    .click();
  await expect(
    speaker.getByRole('button', { name: 'Mute Office Sonos', exact: true }),
  ).toBeEnabled();
  await page.evaluate(() =>
    (window as any).__ha.changeState('media_player.speaker', 'playing', {
      is_volume_muted: true,
      volume_level: 0.01,
    }),
  );
  await speaker
    .getByRole('button', { name: 'Unmute Office Sonos', exact: true })
    .click();
  await expect(
    speaker.getByRole('button', { name: 'Next track on Office Sonos' }),
  ).toBeEnabled();
  await speaker
    .getByRole('button', { name: 'Next track on Office Sonos' })
    .click();
  await expect(
    speaker.getByRole('button', { name: 'Previous track on Office Sonos' }),
  ).toBeEnabled();
  await speaker
    .getByRole('button', { name: 'Previous track on Office Sonos' })
    .click();
  await expect(
    speaker.getByRole('button', { name: 'Pause Office Sonos', exact: true }),
  ).toBeEnabled();
  await speaker
    .getByRole('button', { name: 'Pause Office Sonos', exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__ha.commands
          .filter((command: any) => command.type === 'call_service')
          .map(({ domain, service, service_data, target }: any) => ({
            domain,
            service,
            service_data,
            target,
          })),
      ),
    )
    .toEqual([
      {
        domain: 'media_player',
        service: 'volume_set',
        service_data: { volume_level: 1 },
        target: { entity_id: 'media_player.speaker' },
      },
      {
        domain: 'media_player',
        service: 'volume_set',
        service_data: { volume_level: 0 },
        target: { entity_id: 'media_player.speaker' },
      },
      {
        domain: 'media_player',
        service: 'volume_set',
        service_data: { volume_level: 0.01 },
        target: { entity_id: 'media_player.speaker' },
      },
      {
        domain: 'media_player',
        service: 'volume_mute',
        service_data: { is_volume_muted: true },
        target: { entity_id: 'media_player.speaker' },
      },
      {
        domain: 'media_player',
        service: 'volume_mute',
        service_data: { is_volume_muted: false },
        target: { entity_id: 'media_player.speaker' },
      },
      {
        domain: 'media_player',
        service: 'media_next_track',
        service_data: {},
        target: { entity_id: 'media_player.speaker' },
      },
      {
        domain: 'media_player',
        service: 'media_previous_track',
        service_data: {},
        target: { entity_id: 'media_player.speaker' },
      },
      {
        domain: 'media_player',
        service: 'media_play_pause',
        service_data: {},
        target: { entity_id: 'media_player.speaker' },
      },
    ]);
  await page.evaluate(() =>
    (window as any).__ha.changeState('media_player.speaker', 'paused', {
      volume_level: 0.44,
    }),
  );
  await expect(volume).toHaveValue('44');
  await expect(
    speaker.getByRole('button', { name: 'Play Office Sonos', exact: true }),
  ).toBeVisible();
});

test('speaker controls respect capabilities, service failures, and offline state', async ({
  page,
}) => {
  await mockHomeAssistant(page, true);
  await page.goto('/');
  await connectMock(page);
  await page.getByRole('tab', { name: 'Basic player', exact: true }).click();
  const basic = page.getByRole('article', {
    name: 'Basic player',
    exact: true,
  });
  for (const control of [
    basic.getByRole('slider', { name: 'Basic player volume' }),
    basic.getByRole('button', { name: 'Mute Basic player', exact: true }),
    basic.getByRole('button', { name: 'Previous track on Basic player' }),
    basic.getByRole('button', { name: 'Next track on Basic player' }),
  ]) {
    if (await control.count()) await expect(control).toBeDisabled();
  }
  await expect(
    basic.getByRole('button', { name: 'Pause Basic player', exact: true }),
  ).toBeEnabled();
  await page.getByRole('tab', { name: 'Office Sonos', exact: true }).click();
  const speaker = page.getByRole('article', {
    name: 'Office Sonos',
    exact: true,
  });
  const volume = speaker.getByRole('slider', { name: 'Office Sonos volume' });
  await page.evaluate(() => {
    (window as any).__ha.rejectActions = true;
  });
  await volume.focus();
  await page.keyboard.press('End');
  await expect(page.getByRole('alert')).toContainText(
    'Device rejected the action',
  );
  await expect(volume).toHaveValue('32');
  await page.evaluate(() => (window as any).__ha.disconnect());
  await expect(volume).toBeDisabled();
  await expect(
    speaker.getByRole('button', { name: 'Mute Office Sonos', exact: true }),
  ).toBeDisabled();
  await expect(
    speaker.getByRole('button', { name: 'Next track on Office Sonos' }),
  ).toBeDisabled();
  await expect(
    speaker.getByRole('button', { name: 'Pause Office Sonos', exact: true }),
  ).toBeDisabled();
});

test('missing live readings stay unknown until Home Assistant reports valid values', async ({ page }) => {
  await mockHomeAssistant(page, true);
  await page.goto('/');
  await connectMock(page);
  await page.evaluate(() => {
    const fixture: unknown = Reflect.get(window, '__ha');
    if (!fixture || typeof fixture !== 'object') throw new Error('Missing Home Assistant fixture');
    const changeState: unknown = Reflect.get(fixture, 'changeState');
    const addDevice: unknown = Reflect.get(fixture, 'addDevice');
    if (typeof changeState !== 'function' || typeof addDevice !== 'function') throw new Error('Missing fixture controls');
    changeState('light.office', 'on', { brightness: null });
    changeState('media_player.speaker', 'playing', { volume_level: null, is_volume_muted: 'false', media_title: null });
    addDevice('cover.office', 'open', { friendly_name: 'Office blinds', current_position: 'unknown', supported_features: 15 });
  });
  await navigate(page, 'Controls');
  const light = page.getByRole('article', { name: 'Office light', exact: true });
  const brightness = light.getByRole('slider', { name: 'Office light brightness' });
  await expect(brightness).toBeDisabled();
  await expect(brightness).toHaveAttribute('aria-valuetext', 'Brightness unavailable');
  await expect(light.locator('.brightness-control')).toContainText('—');
  await expect(light.locator('.device-status')).toHaveText('On');
  const cover = page.getByRole('article', { name: 'Office blinds', exact: true });
  const position = cover.getByRole('slider', { name: 'Office blinds position' });
  await expect(position).toBeDisabled();
  await expect(position).toHaveAttribute('aria-valuetext', 'Position unavailable');
  await expect(cover.locator('.cover-value')).toHaveText('open');
  await expect(cover.getByRole('button', { name: 'Close Office blinds' })).toBeEnabled();
  const speaker = page.getByRole('article', { name: 'Office Sonos', exact: true });
  const volume = speaker.getByRole('slider', { name: 'Office Sonos volume' });
  const mute = speaker.getByRole('button', { name: 'Mute Office Sonos', exact: true });
  await expect(volume).toBeDisabled();
  await expect(volume).toHaveAttribute('aria-valuetext', 'Volume unavailable');
  await expect(speaker.locator('.volume-caption')).toContainText('—');
  await expect(mute).toBeDisabled();
  expect(await mute.getAttribute('aria-pressed')).toBeNull();
  await expect(speaker.locator('.track-title')).toHaveText('No track information');

  await page.evaluate(() => {
    const fixture: unknown = Reflect.get(window, '__ha');
    if (!fixture || typeof fixture !== 'object') throw new Error('Missing Home Assistant fixture');
    const changeState: unknown = Reflect.get(fixture, 'changeState');
    if (typeof changeState !== 'function') throw new Error('Missing fixture controls');
    changeState('light.office', 'on', { brightness: 64 });
    changeState('cover.office', 'closed', { current_position: 0 });
    changeState('media_player.speaker', 'playing', { volume_level: 0, is_volume_muted: false, media_title: 'A reported track' });
  });
  await expect(brightness).toBeEnabled();
  await expect(brightness).toHaveValue('25');
  await expect(position).toBeEnabled();
  await expect(cover.locator('.cover-value')).toHaveText('0%open');
  await expect(volume).toBeEnabled();
  await expect(volume).toHaveValue('0');
  await expect(mute).toBeEnabled();
  await expect(mute).toHaveAttribute('aria-pressed', 'false');
  await expect(speaker.locator('.track-title')).toHaveText('A reported track');
});

test('app search and pinned app preferences persist across refresh', async ({
  page,
}) => {
  await nativeStorage(page);
  await page.goto('/');
  await navigate(page, 'Apps');
  const search = page.getByRole('textbox', {
    name: 'Find an app',
    exact: true,
  });
  await search.fill('spotify');
  await expect(
    page.getByRole('button', { name: 'Open Spotify', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Open YouTube', exact: true }),
  ).not.toBeVisible();
  await search.fill('');
  const unpin = page.getByRole('button', { name: 'Unpin Photos', exact: true });
  if (await unpin.isVisible()) await unpin.click();
  await page.getByRole('button', { name: 'Pin Photos', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Unpin Photos', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Unpin YouTube', exact: true })
    .click();
  const pinnedFilter = page
    .getByRole('group', { name: 'Show apps' })
    .getByRole('button', { name: 'Pinned', exact: true });
  await pinnedFilter.click();
  await expect(
    page.getByRole('button', { name: 'Open Photos', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Open YouTube', exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await navigate(page, 'Apps');
  await pinnedFilter.click();
  await expect(
    page.getByRole('button', { name: 'Open Photos', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Open YouTube', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Unpin Photos', exact: true }),
  ).toBeVisible();
});

test('browser app launches and Android home settings give honest preview feedback', async ({
  page,
}) => {
  await page.goto('/');
  await navigate(page, 'Apps');
  await page.getByRole('button', { name: 'Open Sonos', exact: true }).click();
  await expect(page.getByRole('status')).toContainText(/preview shortcut/i);
  await expect(page.getByRole('status')).toContainText(
    /apps open in Hjem for Android/i,
  );
  await expect(page).toHaveURL(/\/$/);
  await navigate(page, 'Settings');
  await expect(
    page.getByRole('heading', { name: 'A home for your tablet', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/^Install Hjem on your Android tablet/),
  ).toBeVisible();
  const defaultHome = page.getByRole('button', {
    name: 'Choose default home app',
    exact: true,
  });
  await expect(defaultHome).toBeDisabled();
});

test('dark mode apps and overview fit the phone and tablet viewport', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('.app-launcher')).toHaveCount(0);
  for (const destination of ['Apps', 'Overview'] as const) {
    await navigate(page, destination);
    if (destination === 'Apps') {
      await expect(
        page.getByRole('textbox', { name: 'Find an app', exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Open Sonos', exact: true }),
      ).toBeVisible();
    }
    const sizes = await page.evaluate(() => ({
      body: document.body.scrollWidth,
      root: document.documentElement.clientWidth,
    }));
    expect(sizes.body).toBeLessThanOrEqual(sizes.root + 1);
  }
  if (page.viewportSize()!.width === 390) {
    await page.setViewportSize({ width: 320, height: 844 });
    await navigate(page, 'Apps');
    const buttons = page
      .getByRole('navigation', { name: 'Mobile navigation' })
      .getByRole('button');
    for (const button of await buttons.all()) {
      const bounds = await button.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
    }
  }
});

test('today’s calendar reads real Home Assistant events and recovers from refresh failures', async ({
  page,
}) => {
  await mockHomeAssistant(page);
  await page.goto('/');
  await page.evaluate(() => (window as any).__ha.addCalendar());
  await connectMock(page);
  const calendar = page.getByRole('region', { name: 'Today’s calendar' });
  await expect(calendar.getByText('Family day', { exact: true })).toBeVisible();
  await expect(calendar.getByText('All day', { exact: true })).toBeVisible();
  await expect(
    calendar.getByText('Lunch at home', { exact: true }),
  ).toBeVisible();
  await expect(
    calendar.getByRole('article', { name: /Lunch at home.*Kitchen/ }),
  ).toBeVisible();
  await expect(calendar.getByText('Tomorrow appointment')).toHaveCount(0);
  await expect(calendar.getByText('Sample events')).toHaveCount(0);
  const command = await page.evaluate(() =>
    (window as any).__ha.commands.find(
      (item: any) => item.domain === 'calendar',
    ),
  );
  expect(command).toMatchObject({
    domain: 'calendar',
    service: 'get_events',
    return_response: true,
    target: { entity_id: ['calendar.family'] },
  });
  await page.evaluate(() => {
    (window as any).__ha.rejectActions = true;
  });
  await page.getByRole('button', { name: 'Refresh calendar' }).click();
  await expect(calendar.getByRole('alert')).toContainText('Could not refresh');
  await page.evaluate(() => {
    (window as any).__ha.rejectActions = false;
  });
  await page.getByRole('button', { name: 'Refresh calendar' }).click();
  await expect(
    calendar.getByText('Lunch at home', { exact: true }),
  ).toBeVisible();
  await expect(calendar.getByRole('alert')).toHaveCount(0);
  await page.evaluate(() => (window as any).__ha.disconnect());
  await expect(calendar.getByRole('alert')).toContainText(
    'Calendar is offline',
  );
  await expect(
    calendar.getByText('Lunch at home', { exact: true }),
  ).toHaveCount(0);
});

test('three demo Sonos systems keep playback, volume, and tracks independent', async ({
  page,
}) => {
  await page.goto('/');
  const music = page.getByRole('region', { name: 'Music controls' });
  await expect(music.getByRole('tab')).toHaveText([
    'Living room',
    'Kitchen',
    'Bedroom',
  ]);
  await expect(music.getByRole('article')).toHaveCount(1);
  await expect(
    music.getByRole('button', { name: /^(Pin|Unpin) / }),
  ).toHaveCount(0);
  await expect(
    music.getByRole('tab', { name: 'Living room', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  await music.getByRole('tab', { name: 'Kitchen', exact: true }).click();
  await music
    .getByRole('button', { name: 'Play Kitchen Sonos', exact: true })
    .click();
  await expect(
    music.getByRole('button', { name: 'Pause Kitchen Sonos', exact: true }),
  ).toBeVisible();
  const kitchenVolume = music.getByRole('slider', {
    name: 'Kitchen Sonos volume',
    exact: true,
  });
  await kitchenVolume.focus();
  await kitchenVolume.press('End');
  await expect(kitchenVolume).toHaveValue('100');
  await music.getByRole('tab', { name: 'Living room', exact: true }).click();
  await expect(
    music.getByRole('button', {
      name: 'Pause Living room speaker',
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    music.getByRole('slider', {
      name: 'Living room speaker volume',
      exact: true,
    }),
  ).toHaveValue('32');
  await music.getByRole('tab', { name: 'Bedroom', exact: true }).click();
  await expect(
    music.getByRole('button', { name: 'Play Bedroom Sonos', exact: true }),
  ).toBeVisible();
  await expect(
    music.getByRole('slider', { name: 'Bedroom Sonos volume', exact: true }),
  ).toHaveValue('15');
  await music
    .getByRole('button', { name: 'Next track on Bedroom Sonos', exact: true })
    .click();
  await expect(
    music.getByRole('article', { name: 'Bedroom Sonos', exact: true }),
  ).toContainText('A slower kind of Sunday');
  await music
    .getByRole('tab', { name: 'Bedroom', exact: true })
    .press('ArrowLeft');
  await expect(
    music.getByRole('tab', { name: 'Kitchen', exact: true }),
  ).toBeFocused();
  await expect(
    music.getByRole('tab', { name: 'Kitchen', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  await expect(kitchenVolume).toHaveValue('100');
  await expect(
    music.getByRole('article', { name: 'Kitchen Sonos', exact: true }),
  ).toContainText('Light through the window');
  await navigate(page, 'Controls');
  await navigate(page, 'Overview');
  await expect(
    music.getByRole('tab', { name: 'Kitchen', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
});

test('saved Home Assistant connection and selected speaker restore after reload and can be forgotten', async ({ page }) => {
  const storage = await nativeStorage(page);
  await mockHomeAssistant(page, true);
  await page.goto('/');
  await connectMock(page);
  expect(storage.snapshot.connection).toEqual({ serverUrl: 'https://ha.example', token: 'private-test-access-token' });
  await page.getByRole('tab', { name: 'Basic player', exact: true }).click();
  await expect.poll(() => storage.snapshot.selectedSpeakers).toEqual([
    { scope: 'https://ha.example', entityId: 'media_player.basic' },
  ]);
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Basic player', exact: true })).toHaveAttribute('aria-selected', 'true');
  await navigate(page, 'Settings');
  await expect(page.locator('main .setting-row').filter({ hasText: 'Connection' })).toContainText('Home connected');
  expect(await page.evaluate(() => Object.values(localStorage).join(''))).not.toContain('private-test-access-token');
  await page.getByRole('button', { name: 'Forget connection', exact: true }).click();
  await expect.poll(() => storage.snapshot.connection).toBeNull();
  await page.reload();
  await navigate(page, 'Settings');
  await expect(page.locator('main .setting-row').filter({ hasText: 'Connection' })).toContainText('Demo home');
  await expect(page.getByRole('button', { name: 'Forget connection', exact: true })).toHaveCount(0);
});

test('a failed credential write stays visible and does not create a saved connection', async ({ page }) => {
  const storage = await nativeStorage(page);
  storage.fail('storage_save_connection');
  await mockHomeAssistant(page);
  await page.goto('/');
  await openConnection(page);
  await page.getByLabel('Home Assistant address', { exact: true }).fill('http://192.168.1.105:8123');
  await page.getByLabel('Long-lived access token', { exact: true }).fill('synthetic-failure-test');
  await page.getByRole('button', { name: 'Connect Home Assistant', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Could not save settings');
  expect(storage.snapshot.connection).toBeNull();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Close connection settings', exact: true }).click();
  await navigate(page, 'Controls');
  await expect(page.getByRole('article', { name: 'Office light', exact: true })).toHaveCount(0);
  await expect(page.getByRole('article', { name: 'Pendant lights', exact: true })).toBeVisible();
});

test('legacy preferences migrate once before rendering and are removed only after commit', async ({ page }) => {
  const storage = await nativeStorage(page, { legacyImportComplete: false });
  await page.addInitScript(() => {
    localStorage.setItem('hjem.theme', JSON.stringify('dark'));
    localStorage.setItem('hjem.server', JSON.stringify('http://homeassistant.local:8123'));
  });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(storage.snapshot.serverUrl).toBe('http://homeassistant.local:8123');
  expect(storage.snapshot.connection).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem('hjem.theme'))).toBeNull();
  expect(storage.commands.filter((command) => command === 'storage_import_legacy')).toHaveLength(1);
});
