import { expect, test, type Page } from '@playwright/test';

declare global {
  interface Window {
    appModeFixture: { defaultHome: boolean; calls: string[] };
  }
}

/** Hjem on Android, either chosen as the home screen or installed as one app among others. */
async function android(page: Page, defaultHome: boolean) {
  await page.addInitScript((isDefault) => {
    const fixture = { defaultHome: isDefault, calls: [] as string[] };
    window.appModeFixture = fixture;
    Object.defineProperty(window, 'isTauri', { value: true });
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {
      transformCallback: () => 1,
      async invoke(command: string) {
        fixture.calls.push(command);
        if (command === 'storage_load') return {
          serverUrl: '', connection: null, theme: 'system', pinnedApps: [],
          favourites: [], selectedSpeakers: [], calendarFeeds: [], hiddenApps: [], legacyImportComplete: true,
        };
        if (command === 'plugin:launcher|get_status') return { supported: true, isDefaultHome: fixture.defaultHome };
        if (command === 'plugin:launcher|list_apps') return [{ name: 'Sonos', packageName: 'com.sonos.acr2' }];
        if (command === 'concierge_get_settings') return { hasApiKey: false, model: '' };
        if (command === 'electricity_get_settings') return { hasApiKey: false, locationId: null, locations: [] };
        if (command === 'concierge_list_chats') return [];
        return null;
      },
    } });
  }, defaultHome);
  await page.goto('/');
  await page.locator('nav:visible').first().waitFor();
}
async function menu(page: Page) {
  const mobile = page.getByRole('navigation', { name: 'Mobile navigation' });
  return await mobile.isVisible() ? mobile : page.getByRole('navigation', { name: 'Main navigation' });
}

test('as the home screen, Hjem shows the device’s apps', async ({ page }) => {
  await android(page, true);
  const navigation = await menu(page);
  await navigation.getByRole('button', { name: 'Apps', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open Sonos', exact: true })).toBeVisible();
  await navigation.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('navigation', { name: 'Settings', exact: true }).getByRole('button', { name: /^Home screen/ }).click();
  await expect(page.getByRole('heading', { name: 'App visibility' })).toBeVisible();
  await expect(page.getByText('Hjem is your default')).toBeVisible();
});

test('as an ordinary app, Hjem leaves apps to the phone and offers to become the home screen', async ({ page }) => {
  await android(page, false);
  const navigation = await menu(page);
  await expect(navigation.getByRole('button', { name: 'Controls', exact: true })).toBeVisible();
  await expect(navigation.getByRole('button', { name: 'Apps', exact: true })).toHaveCount(0);
  await navigation.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('navigation', { name: 'Settings', exact: true }).getByRole('button', { name: /^Home screen/ }).click();
  await expect(page.getByRole('heading', { name: 'App visibility' })).toHaveCount(0);
  await expect(page.getByText('Hjem is an app on this device.')).toBeVisible();
  await page.getByRole('button', { name: 'Use Hjem as the home screen' }).click();
  expect(await page.evaluate(() => window.appModeFixture.calls)).toContain('plugin:launcher|open_home_settings');

  // Chosen as the home screen in Android's settings: the apps appear when Hjem comes back into view.
  await page.evaluate(() => {
    window.appModeFixture.defaultHome = true;
    window.dispatchEvent(new Event('focus'));
  });
  await expect(navigation.getByRole('button', { name: 'Apps', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'App visibility' })).toBeVisible();

});
