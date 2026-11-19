import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { startHub, type Hub } from '../hub/server';
import { fakeHomeAssistant } from '../hub/testing/fake-home-assistant';

// A real hub in front of a simulated Home Assistant; the app only ever talks to the hub.
let ha: Awaited<ReturnType<typeof fakeHomeAssistant>>;
let hub: Hub;
let dataDir: string;
test.beforeEach(async () => {
  ha = await fakeHomeAssistant();
  dataDir = await mkdtemp(join(tmpdir(), 'hjem-hub-e2e-'));
  hub = await startHub({ haUrl: ha.url, haToken: ha.token, dataDir, port: 0, host: '127.0.0.1', version: '0.0.0-test', settle: 50 });
  await expect.poll(() => hub.home.current()?.revision).toBe(1);
});
test.afterEach(async () => {
  await hub.close();
  await ha.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function navigate(page: Page, name: string) {
  const mobile = page.getByRole('navigation', { name: 'Mobile navigation' });
  const nav = await mobile.isVisible() ? mobile : page.getByRole('navigation', { name: 'Main navigation' });
  await nav.getByRole('button', { name, exact: true }).click();
}
async function connect(page: Page, code: string) {
  await page.goto('/');
  await navigate(page, 'Settings');
  await page.getByRole('button', { name: 'Connect your home' }).click();
  await page.getByLabel('Home Assistant address').fill(`http://127.0.0.1:${hub.port}`);
  await page.getByLabel('Long-lived access token').fill(code);
  await page.getByRole('button', { name: 'Connect Home Assistant' }).click();
}

test('a device pairs with the hub, controls the home through it, and keeps a full copy', async ({ page }) => {
  await connect(page, hub.pairingCode);
  await expect(page.getByText('Home Assistant connected.')).toBeVisible();
  await expect(page.locator('.setting-row', { hasText: 'Through' })).toContainText('Hjem hub 0.0.0-test');

  const card = page.getByRole('region', { name: 'Move or back up your home' });
  await expect(card.getByText('This device keeps a full copy of your home from the Hjem hub')).toBeVisible();
  await card.getByRole('button', { name: 'Restore from this device' }).click();
  await expect(card.getByRole('listitem')).toHaveCount(1);
  await expect(card.getByRole('listitem')).toContainText('Test home');
  await expect(card.getByRole('listitem')).toContainText('1 room, 1 device, 1 mood, 1 automation or script');
  // This home already matches its own copy.
  await card.getByRole('listitem').getByRole('button').click();
  await expect(card.getByText('1 of 1 devices found on this server')).toBeVisible();
  await expect(card.getByText('Rooms, names, moods, and automations already match this copy.')).toBeVisible();

  // Live control goes through the hub to Home Assistant.
  await navigate(page, 'Controls');
  await page.getByRole('switch', { name: /Desk lamp/ }).first().click();
  await expect.poll(() => ha.commands).toContain('call_service');
});

test('the copy on a device brings the home back onto a new hub', async ({ page }) => {
  await connect(page, hub.pairingCode);
  const card = page.getByRole('region', { name: 'Move or back up your home' });
  await expect(card.getByText('This device keeps a full copy of your home from the Hjem hub')).toBeVisible();

  // The Raspberry Pi is replaced: a new Home Assistant with the same lamp paired, and nothing set up.
  await hub.close();
  await ha.close();
  ha = await fakeHomeAssistant();
  ha.configs.scene?.clear();
  ha.configs.automation?.clear();
  ha.state.areas = [];
  ha.state.deskArea = null;
  ha.state.doorArea = null;
  await rm(dataDir, { recursive: true, force: true });
  dataDir = await mkdtemp(join(tmpdir(), 'hjem-hub-e2e-'));
  hub = await startHub({ haUrl: ha.url, haToken: ha.token, dataDir, port: 0, host: '127.0.0.1', version: '0.0.0-test', settle: 50 });
  await expect.poll(() => hub.home.current()?.revision).toBe(1);

  await page.getByRole('button', { name: 'Manage connection' }).click();
  await page.getByLabel('Home Assistant address').fill(`http://127.0.0.1:${hub.port}`);
  await page.getByLabel('Long-lived access token').fill(hub.pairingCode);
  await page.getByRole('button', { name: 'Connect Home Assistant' }).click();
  await expect(page.getByText('Home Assistant connected.')).toBeVisible();

  await card.getByRole('button', { name: 'Restore from this device' }).click();
  const old = card.getByRole('listitem').filter({ hasText: 'from another hub' });
  await expect(old).toContainText('1 room, 1 device, 1 mood, 1 automation or script');
  await old.getByRole('button').click();
  await expect(card.getByText('1 mood to create: Evening')).toBeVisible();
  await expect(card.getByText('1 automation or script to create: Door light')).toBeVisible();
  await card.getByRole('button', { name: /^Import \d+ changes$/ }).click();
  await expect(card.getByText('Import finished')).toBeVisible({ timeout: 20_000 });
  await expect(card.locator('.configuration-failures')).toHaveCount(0);

  expect(ha.state).toMatchObject({ areas: [{ area_id: 'office', name: 'Office' }], deskArea: 'office', doorArea: 'office' });
  expect([...ha.configs.scene?.values() ?? []]).toEqual([expect.objectContaining({ name: 'Evening', entities: { 'light.desk': expect.objectContaining({ state: 'on' }) } })]);
  expect([...ha.configs.automation?.values() ?? []]).toEqual([expect.objectContaining({ alias: 'Door light', actions: [{ action: 'light.turn_on', target: { entity_id: 'light.desk' } }] })]);
  // The new hub's own copy catches up, so every other device receives the restored home.
  await expect.poll(() => hub.home.current()?.document.routines.map((routine) => routine.name), { timeout: 15_000 }).toEqual(['Door light']);
});

test('a wrong pairing code is refused', async ({ page }) => {
  await connect(page, 'WRONG-WRONG-WRONG-WRONG');
  await expect(page.getByRole('alert').filter({ hasText: 'rejected this token' })).toBeVisible();
});
