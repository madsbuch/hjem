import { expect, test, type Page } from '@playwright/test';
import { openSettings } from './helpers/settings';
import { nativeStorage } from './helpers/native-storage';

const installedApps = [
  { name: 'Sonos', packageName: 'com.sonos.acr2' },
  { name: 'Music', packageName: 'com.example.music' },
  { name: 'Calendar', packageName: 'com.android.calendar' },
];

async function navigate(page: Page, name: 'Settings' | 'Apps') {
  await page.locator('nav:visible').first().waitFor();
  const mobile = page.getByRole('navigation', { name: 'Mobile navigation' });
  const nav = await mobile.isVisible()
    ? mobile
    : page.getByRole('navigation', { name: 'Main navigation' });
  await nav.getByRole('button', { name, exact: true }).click();
}

const visibility = (page: Page) => page.getByRole('region', { name: 'App visibility', exact: true });
const apps = (page: Page) => page.getByRole('region', { name: 'Apps', exact: true });
const sonosSwitch = (page: Page) => visibility(page).getByRole('switch', { name: 'Show Sonos in launcher', exact: true });

test('hidden installed apps stay out of search, persist, and return when shown again', async ({ page }) => {
  const savedPins = ['com.sonos.acr2', 'com.example.music'];
  const storage = await nativeStorage(page, { pinnedApps: [{ scope: 'android', packageNames: savedPins }] });
  storage.setAndroidApps(installedApps);
  await page.goto('/');
  await navigate(page, 'Apps');
  await expect(apps(page).getByRole('button', { name: 'Open Sonos', exact: true })).toBeVisible();
  await expect(apps(page).getByRole('button', { name: /^(Pin|Unpin) / })).toHaveCount(0);

  await openSettings(page, 'Home screen');
  await expect(sonosSwitch(page)).toBeChecked();
  await visibility(page).getByRole('textbox', { name: 'Find installed apps', exact: true }).fill('com.sonos');
  await expect(sonosSwitch(page)).toBeVisible();
  await expect(visibility(page).getByRole('switch', { name: 'Show Music in launcher', exact: true })).toHaveCount(0);
  await sonosSwitch(page).click();
  await expect(sonosSwitch(page)).not.toBeChecked();
  await expect.poll(() => storage.snapshot.hiddenApps).toEqual([{ scope: 'android', packageNames: ['com.sonos.acr2'] }]);
  expect(storage.snapshot.pinnedApps).toEqual([{ scope: 'android', packageNames: savedPins }]);

  await navigate(page, 'Apps');
  await expect(apps(page).getByRole('button', { name: 'Open Sonos', exact: true })).toHaveCount(0);
  await expect(apps(page).getByRole('button', { name: 'Open Music', exact: true })).toBeVisible();
  await apps(page).getByRole('textbox', { name: 'Find an app', exact: true }).fill('Sonos');
  await expect(apps(page).getByRole('button', { name: /^Open / })).toHaveCount(0);
  await apps(page).getByRole('textbox', { name: 'Find an app', exact: true }).fill('');
  await expect(apps(page).getByRole('button', { name: 'Open Sonos', exact: true })).toHaveCount(0);
  await expect(apps(page).getByRole('button', { name: 'Open Music', exact: true })).toBeVisible();

  await page.reload();
  await navigate(page, 'Apps');
  await expect(apps(page).getByRole('button', { name: 'Open Sonos', exact: true })).toHaveCount(0);
  await openSettings(page, 'Home screen');
  await visibility(page).getByRole('button', { name: 'Hidden', exact: true }).click();
  await expect(sonosSwitch(page)).toBeVisible();
  await expect(sonosSwitch(page)).not.toBeChecked();
  await sonosSwitch(page).click();
  await expect(sonosSwitch(page)).toHaveCount(0);
  await expect.poll(() => storage.snapshot.hiddenApps).toEqual([{ scope: 'android', packageNames: [] }]);
  await visibility(page).getByRole('button', { name: 'All apps', exact: true }).click();
  await expect(sonosSwitch(page)).toBeChecked();

  await page.reload();
  await navigate(page, 'Apps');
  await expect(apps(page).getByRole('button', { name: 'Open Sonos', exact: true })).toBeVisible();
  await expect(apps(page).getByRole('button', { name: /^(Pin|Unpin) / })).toHaveCount(0);
  expect(storage.snapshot.pinnedApps).toEqual([{ scope: 'android', packageNames: savedPins }]);
  expect(storage.commands).not.toContain('plugin:launcher|uninstall_app');
  expect(storage.commands).not.toContain('plugin:launcher|launch_app');
  expect(await page.evaluate(() => JSON.stringify(Object.entries(localStorage)))).not.toContain('com.sonos.acr2');
});

test('failed visibility saves show an error and leave the installed app visible', async ({ page }) => {
  const storage = await nativeStorage(page);
  storage.setAndroidApps(installedApps);
  storage.fail('storage_set_app_hidden');
  await page.goto('/');
  await openSettings(page, 'Home screen');
  await sonosSwitch(page).click();
  await expect(visibility(page).getByRole('alert')).toContainText('Could not save settings. Please try again.');
  await expect(sonosSwitch(page)).toBeChecked();
  await expect(sonosSwitch(page)).toBeEnabled();
  expect(storage.snapshot.hiddenApps).toEqual([]);
  await navigate(page, 'Apps');
  await expect(apps(page).getByRole('button', { name: 'Open Sonos', exact: true })).toBeVisible();
  await expect(apps(page).getByRole('button', { name: 'Open Sonos', exact: true })).toBeVisible();

  await page.reload();
  await navigate(page, 'Apps');
  await expect(apps(page).getByRole('button', { name: 'Open Sonos', exact: true })).toBeVisible();
  storage.fail('');
  await openSettings(page, 'Home screen');
  await sonosSwitch(page).click();
  await expect(sonosSwitch(page)).not.toBeChecked();
  await expect(visibility(page).getByRole('alert')).toHaveCount(0);
  await navigate(page, 'Apps');
  await expect(apps(page).getByRole('button', { name: 'Open Sonos', exact: true })).toHaveCount(0);
});

test('demo and Android visibility stay separate even for matching package names', async ({ page }) => {
  // Deliberately use the same package ID in both scopes to catch cross-scope filtering.
  const storage = await nativeStorage(page, {
    hiddenApps: [{ scope: 'android', packageNames: ['preview.sonos'] }],
  });
  await page.goto('/');
  await navigate(page, 'Apps');
  await expect(apps(page).getByRole('button', { name: 'Open Sonos', exact: true })).toBeVisible();
  await openSettings(page, 'Home screen');
  await sonosSwitch(page).click();
  await expect(sonosSwitch(page)).not.toBeChecked();
  expect(storage.snapshot.hiddenApps).toEqual([
    { scope: 'android', packageNames: ['preview.sonos'] },
    { scope: 'demo', packageNames: ['preview.sonos'] },
  ]);

  storage.setAndroidApps([{ name: 'Sonos', packageName: 'preview.sonos' }, installedApps[1]]);
  await page.reload();
  await navigate(page, 'Apps');
  await expect(apps(page).getByRole('button', { name: 'Open Music', exact: true })).toBeVisible();
  await expect(apps(page).getByRole('button', { name: 'Open Sonos', exact: true })).toHaveCount(0);
  await openSettings(page, 'Home screen');
  await expect(sonosSwitch(page)).not.toBeChecked();
  await sonosSwitch(page).click();
  await expect(sonosSwitch(page)).toBeChecked();
  await navigate(page, 'Apps');
  await expect(apps(page).getByRole('button', { name: 'Open Sonos', exact: true })).toBeVisible();
  expect(storage.snapshot.hiddenApps.find((item) => item.scope === 'demo')?.packageNames).toEqual(['preview.sonos']);

  storage.setPreviewLauncher();
  await page.reload();
  await navigate(page, 'Apps');
  await expect(apps(page).getByRole('button', { name: 'Open Spotify', exact: true })).toBeVisible();
  await expect(apps(page).getByRole('button', { name: 'Open Sonos', exact: true })).toHaveCount(0);
  await openSettings(page, 'Home screen');
  await expect(sonosSwitch(page)).not.toBeChecked();
  await sonosSwitch(page).click();
  await expect(sonosSwitch(page)).toBeChecked();
  await navigate(page, 'Apps');
  await expect(apps(page).getByRole('button', { name: 'Open Sonos', exact: true })).toBeVisible();
});

test('keyboard switches can hide every installed app and restore the empty launcher', async ({ page }) => {
  const storage = await nativeStorage(page);
  storage.setAndroidApps([{ name: 'Sonos', packageName: 'com.sonos.acr2' }]);
  await page.goto('/');
  await openSettings(page, 'Home screen');
  await expect(sonosSwitch(page)).toBeChecked();
  await sonosSwitch(page).focus();
  await sonosSwitch(page).press('Space');
  await expect(sonosSwitch(page)).not.toBeChecked();
  await expect(sonosSwitch(page)).toBeFocused();
  await navigate(page, 'Apps');
  await expect(apps(page).getByRole('heading', { name: 'All apps are hidden.', exact: true })).toBeVisible();
  await expect(apps(page).getByRole('button', { name: /^Open / })).toHaveCount(0);
  await expect(apps(page).getByRole('button', { name: 'Refresh apps', exact: true })).toBeEnabled();
  await expect(apps(page).getByRole('button', { name: /^Open / })).toHaveCount(0);

  await openSettings(page, 'Home screen');
  await visibility(page).getByRole('button', { name: 'Hidden', exact: true }).click();
  await expect(sonosSwitch(page)).not.toBeChecked();
  await sonosSwitch(page).focus();
  await sonosSwitch(page).press('Enter');
  await expect(sonosSwitch(page)).toHaveCount(0);
  await expect(visibility(page).getByText('No apps are hidden.', { exact: true })).toBeVisible();
  await navigate(page, 'Apps');
  await expect(apps(page).getByRole('button', { name: 'Open Sonos', exact: true })).toBeVisible();
  await expect(apps(page).getByRole('button', { name: /^(Pin|Unpin) / })).toHaveCount(0);
});
