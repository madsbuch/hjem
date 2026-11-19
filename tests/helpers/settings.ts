import type { Page } from '@playwright/test';

export type SettingsCategory =
  | 'Home Assistant' | 'Home setup' | 'Concierge' | 'Calendars' | 'Electricity'
  | 'Backup and restore' | 'Home screen' | 'Appearance' | 'About Hjem';

/** Open Settings from the main menu, then one of its categories. */
export async function openSettings(page: Page, category: SettingsCategory) {
  await page.locator('nav:visible').first().waitFor();
  const mobile = page.getByRole('navigation', { name: 'Mobile navigation' });
  const main = await mobile.isVisible() ? mobile : page.getByRole('navigation', { name: 'Main navigation' });
  await main.getByRole('button', { name: 'Settings', exact: true }).click();
  // Each entry's name starts with its title, followed by its current state.
  await page.getByRole('navigation', { name: 'Settings', exact: true }).getByRole('button', { name: new RegExp(`^${category}`) }).click();
}
