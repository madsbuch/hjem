import { expect, test } from '@playwright/test';
import { localHomeAssistant } from './helpers/home-assistant-server';
import { nativeStorage } from './helpers/native-storage';

test('navigation and content stay clear of system bars in connected layouts', async ({ page }, testInfo) => {
  const server = await localHomeAssistant();
  try {
    await nativeStorage(page, {
      serverUrl: server.url,
      connection: { serverUrl: server.url, token: 'local-fixture-token' },
      theme: 'dark',
    });
    await page.goto('/');
    await expect(page.locator('.home-section-empty')).toBeVisible();
    await expect(page.locator('.connection-notice')).toHaveCount(0);
    await expect(page.getByText('A connected home.', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Connection settings', exact: true })).toHaveCount(0);

    // Android consumes these insets in its native host. Exercise the browser/iOS
    // fallback with status, navigation and side cutout areas of unequal sizes.
    await page.addStyleTag({ content: ':root { --safe-area-top: 28px; --safe-area-bottom: 48px; --safe-area-left: 12px; --safe-area-right: 16px; }' });
    const sizes = testInfo.project.name === 'phone'
      ? [{ width: 390, height: 844 }, { width: 320, height: 568 }]
      : [{ width: 1280, height: 800 }, { width: 1024, height: 1000 }, { width: 800, height: 600 }, { width: 1000, height: 420 }];

    for (const size of sizes) {
      await page.setViewportSize(size);
      const phone = size.width <= 700;
      const navigation = page.getByRole('navigation', { name: phone ? 'Mobile navigation' : 'Main navigation' });
      const settings = navigation.getByRole('button', { name: 'Settings', exact: true });
      await expect(settings).toBeInViewport();
      const settingsBox = await settings.boundingBox();
      expect(settingsBox!.y + settingsBox!.height).toBeLessThanOrEqual(size.height - 48);
      expect(settingsBox!.y + settingsBox!.height).toBeGreaterThan(size.height - 90);
      const intro = await page.locator('.page-intro').boundingBox();
      expect(intro!.y).toBeGreaterThan(28);
      expect(intro!.x).toBeGreaterThanOrEqual(12);
      expect(intro!.x + intro!.width).toBeLessThanOrEqual(size.width - 16);
      if (!phone) {
        const brand = await page.getByRole('button', { name: 'Hjem overview', exact: true }).boundingBox();
        expect(brand!.y).toBeGreaterThan(28);
        const links = await page.locator('.sidebar-links').boundingBox();
        expect(settingsBox!.y).toBeGreaterThanOrEqual(links!.y + links!.height + 7);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(size.width);
      await page.screenshot({ path: testInfo.outputPath(`connected-${size.width}.png`), scale: 'css' });

      await settings.click();
      await expect(page.getByRole('button', { name: 'Manage connection', exact: true })).toBeVisible();
      await page.locator('.about-card').scrollIntoViewIfNeeded();
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      const lastCard = await page.locator('.about-card').boundingBox();
      const bottomLimit = phone ? (await page.locator('.mobile-navigation').boundingBox())!.y : size.height - 48;
      expect(lastCard!.y + lastCard!.height).toBeLessThanOrEqual(bottomLimit);
      await navigation.getByRole('button', { name: 'Overview', exact: true }).click();
      await expect.poll(async () => page.evaluate(() => window.scrollY)).toBe(0);
    }
    expect(server.failure).toBeUndefined();
  } finally {
    await server.close();
  }
});
