import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

async function navigate(page: Page, name: string) {
  // Decide between phone and tablet navigation only once the app has rendered.
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const mobile = page.getByRole('navigation', { name: 'Mobile navigation' });
  const navigation = await mobile.isVisible() ? mobile : page.getByRole('navigation', { name: 'Main navigation' });
  await navigation.getByRole('button', { name: name === 'Planner' ? 'Settings' : name, exact: true }).click();
  if (name === 'Planner') await page.getByRole('button', { name: 'Open home planner' }).click();
}
async function rename(page: Page, from: string, to: string) {
  await navigate(page, 'Planner');
  const field = page.getByLabel(`Name for ${from}`);
  await field.fill(to);
  await field.press('Enter');
  await expect(page.getByText(`${from} is now ${to}.`)).toBeVisible();
}

test('exports the home to a file and restores it from that file', async ({ page }) => {
  await page.goto('/');
  await rename(page, 'Reading lamp', 'Desk lamp');

  await navigate(page, 'Settings');
  const card = page.getByRole('region', { name: 'Move or back up your home' });
  const downloading = page.waitForEvent('download');
  await card.getByRole('button', { name: 'Export configuration' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^hjem-configuration-\d{4}-\d{2}-\d{2}\.json$/);
  const path = await download.path();
  const text = await readFile(path, 'utf8');
  const exported: unknown = JSON.parse(text);
  expect(exported).toMatchObject({ format: 'hjem-configuration', version: 1, home_name: 'Our home' });
  expect(text).toContain('Desk lamp');
  await expect(page.getByText('Configuration saved.')).toBeVisible();

  await rename(page, 'Desk lamp', 'Somewhere else');
  await navigate(page, 'Settings');
  const choosing = page.waitForEvent('filechooser');
  await card.getByRole('button', { name: 'Import configuration' }).click();
  await (await choosing).setFiles({ name: 'hjem.json', mimeType: 'application/json', buffer: Buffer.from(text) });
  await expect(card.getByRole('heading', { name: /Our home/ })).toBeVisible();
  await expect(card.getByText('1 name to restore')).toBeVisible();
  await expect(card.getByText(/4 moods already here/)).toBeVisible();
  await card.getByRole('button', { name: 'Import 1 change' }).click();
  await expect(card.getByRole('heading', { name: 'Import finished' })).toBeVisible();
  await expect(card.getByText(/1 change applied/)).toBeVisible();
  await card.getByRole('button', { name: 'Done' }).click();

  await navigate(page, 'Planner');
  await expect(page.getByRole('article', { name: 'Desk lamp' })).toBeVisible();
});

test('explains a file that is not a Hjem configuration', async ({ page }) => {
  await page.goto('/');
  await navigate(page, 'Settings');
  const card = page.getByRole('region', { name: 'Move or back up your home' });
  const choosing = page.waitForEvent('filechooser');
  await card.getByRole('button', { name: 'Import configuration' }).click();
  await (await choosing).setFiles({ name: 'other.json', mimeType: 'application/json', buffer: Buffer.from('{"hello":"world"}') });
  await expect(page.getByText('This file is not a Hjem configuration. Choose a file exported from Hjem.')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Import configuration' })).toBeEnabled();
});
