import { expect, test, type Locator, type Page } from '@playwright/test';

interface LauncherFixture {
  calls: { command: string; packageName: string }[];
  apps: { name: string; packageName: string }[];
  uninstallError: string;
}
declare global {
  interface Window {
    launcherOptionsFixture: LauncherFixture;
  }
}

async function appsPage(page: Page) {
  await page.goto('/');
  await page.locator('nav:visible').first().waitFor();
  const mobile = page.getByRole('navigation', { name: 'Mobile navigation' });
  const navigation = await mobile.isVisible() ? mobile : page.getByRole('navigation', { name: 'Main navigation' });
  await navigation.getByRole('button', { name: 'Apps', exact: true }).click();
}

async function mockAndroid(page: Page) {
  await page.addInitScript(() => {
    const fixture: LauncherFixture = {
      calls: [],
      apps: [{ name: 'Sonos', packageName: 'com.sonos.acr2' }, { name: 'Music', packageName: 'com.example.music' }],
      uninstallError: '',
    };
    window.launcherOptionsFixture = fixture;
    Object.defineProperty(window, 'isTauri', { value: true });
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {
      transformCallback: () => 1,
      async invoke(command: string, args: Record<string, unknown> = {}) {
        if (command === 'storage_load') return {
          serverUrl: '', connection: null, theme: 'system', pinnedApps: [],
          favourites: [], selectedSpeakers: [], calendarFeeds: [], hiddenApps: [], legacyImportComplete: true,
        };
        if (command === 'plugin:launcher|get_status') return { supported: true, isDefaultHome: true };
        if (command === 'plugin:launcher|list_apps') return fixture.apps;
        if (command === 'concierge_get_settings') return { hasApiKey: false, model: '' };
        if (command === 'plugin:launcher|register_listener' || command === 'plugin:launcher|remove_listener') return;
        if (['plugin:launcher|launch_app', 'plugin:launcher|open_app_info', 'plugin:launcher|uninstall_app'].includes(command)) {
          if (typeof args.packageName !== 'string') throw new Error('Missing package name.');
          fixture.calls.push({ command, packageName: args.packageName });
          if (command === 'plugin:launcher|uninstall_app' && fixture.uninstallError) throw new Error(fixture.uninstallError);
          return;
        }
        throw new Error(`Unexpected native call: ${command}`);
      },
    } });
  });
}

async function hold(page: Page, button: Locator) {
  await button.scrollIntoViewIfNeeded();
  const bounds = await button.boundingBox();
  if (!bounds) throw new Error('App button is missing.');
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await expect(page.getByRole('dialog', { name: 'Sonos', exact: true })).toBeVisible();
  await page.mouse.up();
}

test('holding an Android app opens options without launching; Android screens use the exact package', async ({ page }) => {
  await mockAndroid(page);
  await appsPage(page);
  const app = page.getByRole('button', { name: 'Open Sonos', exact: true });
  await hold(page, app);
  const dialog = page.getByRole('dialog', { name: 'Sonos', exact: true });
  expect(await page.evaluate(() => window.launcherOptionsFixture.calls)).toEqual([]);
  await dialog.getByRole('button', { name: 'App info', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(await page.evaluate(() => window.launcherOptionsFixture.calls)).toEqual([
    { command: 'plugin:launcher|open_app_info', packageName: 'com.sonos.acr2' },
  ]);
  await app.click({ button: 'right' });
  await expect(dialog).toContainText('Android will ask you to confirm');
  await dialog.getByRole('button', { name: 'Uninstall app', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(app).toBeVisible();
  expect(await page.evaluate(() => window.launcherOptionsFixture.calls)).toEqual([
    { command: 'plugin:launcher|open_app_info', packageName: 'com.sonos.acr2' },
    { command: 'plugin:launcher|uninstall_app', packageName: 'com.sonos.acr2' },
  ]);
  // Dispatching the Android confirmation does not imply an uninstall. Discovery
  // changes only after the system removes the app and Hjem returns foreground.
  await page.evaluate(() => {
    window.launcherOptionsFixture.apps = window.launcherOptionsFixture.apps.filter((item) => item.packageName !== 'com.sonos.acr2');
    window.dispatchEvent(new Event('focus'));
  });
  await expect(app).toHaveCount(0);
});

test('movement, scrolling and pointer cancellation stop a pending long press', async ({ page }) => {
  await mockAndroid(page);
  await appsPage(page);
  await page.clock.install();
  const app = page.getByRole('button', { name: 'Open Sonos', exact: true });
  const down = { pointerId: 1, isPrimary: true, button: 0, clientX: 50, clientY: 50, pointerType: 'touch' };
  for (const cancel of ['move', 'scroll', 'cancel']) {
    await app.dispatchEvent('pointerdown', down);
    if (cancel === 'move') await app.dispatchEvent('pointermove', { ...down, clientX: 90 });
    if (cancel === 'scroll') await page.evaluate(() => document.dispatchEvent(new Event('scroll')));
    if (cancel === 'cancel') await app.dispatchEvent('pointercancel', down);
    await page.clock.runFor(600);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await app.dispatchEvent('pointerup', down);
  }
  expect(await page.evaluate(() => window.launcherOptionsFixture.calls)).toEqual([]);
  await app.click();
  expect(await page.evaluate(() => window.launcherOptionsFixture.calls)).toEqual([
    { command: 'plugin:launcher|launch_app', packageName: 'com.sonos.acr2' },
  ]);
});

test('keyboard app options return focus and show native failures without claiming success', async ({ page }) => {
  await mockAndroid(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await appsPage(page);
  const app = page.getByRole('button', { name: 'Open Sonos', exact: true });
  await app.focus();
  await app.press('Shift+F10');
  const dialog = page.getByRole('dialog', { name: 'Sonos', exact: true });
  await expect(dialog).toBeVisible();
  await page.evaluate(() => { window.launcherOptionsFixture.uninstallError = 'Android could not open the uninstall confirmation.'; });
  await dialog.getByRole('button', { name: 'Uninstall app', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Android could not open the uninstall confirmation.');
  await expect(dialog.getByRole('button', { name: 'Uninstall app', exact: true })).toBeEnabled();
  const bounds = await dialog.boundingBox();
  const viewport = page.viewportSize();
  if (!bounds || !viewport) throw new Error('Missing viewport.');
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(app).toBeFocused();
});

test('sample app options are clearly unavailable and opening apps still works', async ({ page }) => {
  await appsPage(page);
  const app = page.getByRole('button', { name: 'Open Sonos', exact: true });
  await app.click({ button: 'right' });
  const dialog = page.getByRole('dialog', { name: 'Sonos', exact: true });
  await expect(dialog).toContainText('This is a sample app. App management is available on Android.');
  await expect(dialog.getByRole('button', { name: 'App info', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Uninstall app', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('region', { name: 'Apps', exact: true }).getByRole('button', { name: /^(Pin|Unpin) / })).toHaveCount(0);
  await app.click();
  await expect(page.getByRole('status')).toContainText('preview shortcut');
});
