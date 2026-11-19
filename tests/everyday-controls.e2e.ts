import { expect, test, type Page } from '@playwright/test';

async function controls(page: Page) {
  await page.goto('/');
  await page.locator('nav:visible').first().waitFor();
  const mobile = page.getByRole('navigation', { name: 'Mobile navigation' });
  const main = await mobile.isVisible() ? mobile : page.getByRole('navigation', { name: 'Main navigation' });
  await main.getByRole('button', { name: 'Controls', exact: true }).click();
  return main;
}
const tabs = (page: Page) => page.getByRole('tablist', { name: 'Home controls' });

test('Controls opens on lights, grouped by room, with room and whole-home switches', async ({ page }) => {
  await controls(page);
  await expect(tabs(page).getByRole('tab')).toHaveText([/^Lights\s*2 on$/, /^Moods\s*4$/, /^Automations\s*2 on$/, 'All devices']);
  await expect(tabs(page).getByRole('tab', { name: /Lights/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('2 of 4 lights on')).toBeVisible();

  // Each light is one short line, so a home's lights fit on a tablet without scrolling.
  const row = await page.getByRole('region', { name: 'Living room', exact: true }).getByRole('listitem').first().boundingBox();
  expect(row?.height).toBeLessThanOrEqual(48);
  expect(await page.evaluate(() => innerWidth < 900 || document.documentElement.scrollHeight <= innerHeight)).toBe(true);

  // Only lights are here: no thermostat, speaker, or sensor.
  const living = page.getByRole('region', { name: 'Living room', exact: true });
  await expect(living.getByRole('listitem')).toHaveCount(2);
  await expect(page.getByText('Living room climate')).toHaveCount(0);
  await expect(page.getByText('Coffee machine')).toHaveCount(0);

  const kitchen = page.getByRole('region', { name: 'Kitchen', exact: true });
  await expect(kitchen.locator('.controls-room-heading')).toContainText('Off');
  await kitchen.getByRole('button', { name: 'Turn on the lights in Kitchen' }).click();
  await expect(kitchen.locator('.controls-room-heading')).toContainText('1 on');
  await expect(page.getByText('3 of 4 lights on')).toBeVisible();

  await living.getByRole('button', { name: 'Turn off the lights in Living room' }).click();
  await expect(living.locator('.controls-room-heading')).toContainText('Off');
  await expect(tabs(page).getByRole('tab', { name: /Lights/ })).toContainText('1 on');

  await page.getByRole('button', { name: 'All lights off' }).click();
  await expect(page.getByText('All lights are off')).toBeVisible();
  await expect(page.getByRole('button', { name: 'All lights off' })).toBeDisabled();
  await expect(kitchen.getByRole('button', { name: 'Turn on the lights in Kitchen' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('a single light is switched and dimmed from its card', async ({ page }) => {
  await controls(page);
  const bedroom = page.getByRole('region', { name: 'Bedroom', exact: true });
  await bedroom.getByRole('switch').click();
  await expect(bedroom.locator('.controls-room-heading')).toContainText('1 on');
  await expect(tabs(page).getByRole('tab', { name: /Lights/ })).toContainText('3 on');
});

test('moods are set from their own tab', async ({ page }) => {
  await controls(page);
  await tabs(page).getByRole('tab', { name: /Moods/ }).click();
  const moods = page.getByRole('region', { name: 'Moods', exact: true });
  await expect(moods.getByRole('button', { name: /Good morning|Cosy evening|Heading out|Good night/ })).toHaveCount(4);
  await moods.getByRole('button', { name: 'Good night' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Good night' })).toBeVisible();
  await expect(tabs(page).getByRole('tab', { name: /Lights/ })).toContainText('0 on');
});

test('automations are switched on and off, and say what they do', async ({ page }) => {
  await controls(page);
  await tabs(page).getByRole('tab', { name: /Automations/ }).click();
  const welcome = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Welcome home light' }) });
  await expect(welcome).toContainText('Lights the reading lamp when the front door opens after dark.');
  await expect(page.getByRole('listitem').filter({ hasText: 'Dimmer switch turns on the bedside lamp' })).toContainText('Dimmer switch: on → Turn on Bedside lamp (40%)');

  const wakeUp = page.getByRole('switch', { name: 'Wake up gently' });
  await expect(wakeUp).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByRole('listitem').filter({ hasText: 'Wake up gently' })).toContainText('Paused');
  await wakeUp.click();
  await expect(wakeUp).toHaveAttribute('aria-checked', 'true');
  await expect(tabs(page).getByRole('tab', { name: /Automations/ })).toContainText('3 on');

  const welcomeSwitch = page.getByRole('switch', { name: 'Welcome home light' });
  await welcomeSwitch.focus();
  await page.keyboard.press('Space');
  await expect(welcomeSwitch).toHaveAttribute('aria-checked', 'false');
  await expect(welcome).toContainText('Paused');

  // The same automations, as Home setup sees them.
  await page.getByRole('button', { name: 'Add or change automations' }).click();
  await expect(page.getByRole('heading', { name: 'Home setup.' })).toBeVisible();
});

test('everything else stays under All devices, and the chosen tab is kept', async ({ page }) => {
  const main = await controls(page);
  await tabs(page).getByRole('tab', { name: 'All devices' }).click();
  await expect(page.getByText('Living room climate')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Organize rooms' })).toBeVisible();
  await main.getByRole('button', { name: 'Overview', exact: true }).click();
  await main.getByRole('button', { name: 'Controls', exact: true }).click();
  await expect(tabs(page).getByRole('tab', { name: 'All devices' })).toHaveAttribute('aria-selected', 'true');
});

test('a colour light changes colour and white from its row', async ({ page }) => {
  await controls(page);
  const kitchen = page.getByRole('region', { name: 'Kitchen', exact: true });
  const living = page.getByRole('region', { name: 'Living room', exact: true });
  // Only lights that can change colour or white offer it.
  await expect(living.getByRole('button', { name: /Pendant lights colour/ })).toHaveCount(0);
  const colour = kitchen.getByRole('button', { name: /Kitchen lights colour/ });
  await expect(colour).toHaveAttribute('aria-expanded', 'false');
  await colour.click();
  const palette = kitchen.getByRole('group', { name: 'Kitchen lights colour' });
  await expect(palette.getByRole('button')).toHaveCount(8);

  // Choosing a colour turns the light on in that colour.
  await palette.getByRole('button', { name: 'Blue' }).click();
  await expect(kitchen.locator('.controls-room-heading')).toContainText('1 on');
  await expect(palette.getByRole('button', { name: 'Blue' })).toHaveAttribute('aria-pressed', 'true');
  await expect(colour).toHaveAccessibleName('Kitchen lights colour, blue');
  await expect(colour.locator('i')).toHaveCSS('background-color', 'rgb(0, 64, 255)');

  // Back to white, warmer or cooler.
  const white = palette.getByRole('slider', { name: 'Kitchen lights white, warm to cool' });
  await white.focus();
  await page.keyboard.press('End');
  await expect(white).toHaveValue('6500');
  await expect(colour).toHaveAccessibleName('Kitchen lights colour, white');
  await expect(palette.getByRole('button', { name: 'Blue' })).toHaveAttribute('aria-pressed', 'false');

  // A light with only warm-to-cool white has the slider and no colours; one palette shows at a time.
  await living.getByRole('button', { name: /Reading lamp colour/ }).click();
  await expect(palette).toHaveCount(0);
  const reading = living.getByRole('group', { name: 'Reading lamp colour' });
  await expect(reading.getByRole('slider')).toHaveCount(1);
  await expect(reading.getByRole('button')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
