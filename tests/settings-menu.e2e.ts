import { expect, test, type Page } from '@playwright/test';

async function mainMenu(page: Page) {
  await page.locator('nav:visible').first().waitFor();
  const mobile = page.getByRole('navigation', { name: 'Mobile navigation' });
  return await mobile.isVisible() ? mobile : page.getByRole('navigation', { name: 'Main navigation' });
}

test('Settings is a menu of categories, each opening its own page', async ({ page }) => {
  await page.goto('/');
  const main = await mainMenu(page);
  await main.getByRole('button', { name: 'Settings', exact: true }).click();
  const menu = page.getByRole('navigation', { name: 'Settings', exact: true });
  await expect(menu.getByRole('button')).toHaveText([
    /^Home Assistant.*Demo home/, /^Home setup/, /^Concierge.*Not set up yet/, /^Calendars.*None linked yet/,
    /^Electricity.*Not connected/, /^Backup and restore/, /^Home screen and apps/, /^Appearance.*System/, /^About Hjem/,
  ]);
  // Only the menu is shown: no settings card until a category is opened.
  await expect(page.locator('.settings-card')).toHaveCount(0);

  await menu.getByRole('button', { name: /^Appearance/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Appearance' })).toBeVisible();
  await expect(menu).toHaveCount(0);
  await expect(page.locator('.settings-card')).toHaveCount(1);
  await page.getByRole('group', { name: 'Appearance', exact: true }).getByRole('button', { name: 'Dark', exact: true }).click();

  // Back returns to the menu, which shows the new state.
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await expect(menu.getByRole('button', { name: /^Appearance/ })).toContainText('Dark');

  await menu.getByRole('button', { name: /^Home setup/ }).click();
  await expect(page.getByRole('button', { name: 'Open home setup' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open home planner' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'See pinned devices' })).toBeVisible();

  // The main menu's Settings always returns to the list of categories.
  await main.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(menu).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('links from elsewhere open the matching settings category', async ({ page }) => {
  await page.goto('/');
  const main = await mainMenu(page);
  await main.getByRole('button', { name: 'Concierge', exact: true }).click();
  await page.getByRole('button', { name: 'Set up Concierge' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Concierge' })).toBeVisible();
  await expect(page.getByLabel('OpenRouter API key', { exact: true })).toBeVisible();
});
