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

/** Press and hold the dot, slide to a point relative to the wheel's centre (or the white bar), and let go. */
async function slide(page: Page, dot: ReturnType<Page['getByRole']>, target: (wheel: { cx: number; cy: number; radius: number }) => { x: number; y: number }, release = true) {
  await dot.scrollIntoViewIfNeeded();
  const box = await dot.boundingBox();
  if (!box) throw new Error('No colour dot');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.locator('.color-wheel').waitFor();
  // A light without colours has no wheel, only the white bar.
  const part = async (selector: string) => await page.locator(selector).count() ? page.locator(selector).boundingBox() : null;
  const disc = await part('.color-wheel-disc');
  const bar = await part('.color-wheel-white');
  const wheel = disc ? { cx: disc.x + disc.width / 2, cy: disc.y + disc.height / 2, radius: disc.width / 2 }
    : bar ? { cx: bar.x + bar.width / 2, cy: bar.y + bar.height / 2, radius: bar.width / 2 } : null;
  if (!wheel) throw new Error('The wheel did not open');
  const point = target(wheel);
  await page.mouse.move(point.x, point.y, { steps: 5 });
  if (release) await page.mouse.up();
}

test('holding a colour light’s dot opens a colour wheel; sliding and letting go sets the colour', async ({ page }) => {
  await controls(page);
  const kitchen = page.getByRole('region', { name: 'Kitchen', exact: true });
  const living = page.getByRole('region', { name: 'Living room', exact: true });
  const wheel = page.locator('.color-wheel');
  // Only lights that can change colour or white have a dot.
  await expect(living.getByRole('button', { name: /Pendant lights colour/ })).toHaveCount(0);
  const dot = kitchen.getByRole('button', { name: /Kitchen lights colour/ });
  await expect(wheel).toHaveCount(0);

  // While held, the wheel is open and names what letting go would choose.
  await slide(page, dot, ({ cx, cy, radius }) => ({ x: cx, y: cy + radius * 0.9 }), false);
  await expect(wheel).toBeVisible();
  await expect(wheel.getByRole('status')).toHaveText('Turquoise');
  await expect(kitchen.locator('.controls-room-heading')).toContainText('Off');
  await page.mouse.up();
  // Letting go sets it, turns the light on, and the wheel is gone.
  await expect(wheel).toHaveCount(0);
  await expect(kitchen.locator('.controls-room-heading')).toContainText('1 on');
  await expect(dot).toHaveAccessibleName(/^Kitchen lights colour, turquoise\./);
  // The dot shows the chosen colour: strongly green and blue, hardly any red.
  const shown = await dot.locator('i').evaluate((node) => getComputedStyle(node).backgroundColor.match(/\d+/g)?.map(Number) ?? []);
  expect(shown[0]).toBeLessThan(60);
  expect(shown[1]).toBeGreaterThan(235);
  expect(shown[2]).toBeGreaterThan(235);

  // Any colour on the wheel, not a fixed few: a pale pink towards the centre.
  await slide(page, dot, ({ cx, cy, radius }) => ({ x: cx - radius * 0.3, y: cy - radius * 0.3 }));
  await expect(dot).toHaveAccessibleName(/, pink\./);

  // A plain tap, or sliding off the wheel and letting go, changes nothing.
  await dot.click();
  await expect(wheel).toHaveCount(0);
  await slide(page, dot, ({ cx, cy, radius }) => ({ x: cx + radius * 1.6, y: cy - radius * 1.2 }));
  await expect(dot).toHaveAccessibleName(/, pink\./);

  // The bar under the wheel sets a white, warm to cool.
  await slide(page, dot, ({ cx, cy, radius }) => ({ x: cx + radius * 0.98, y: cy + radius + 27 }), false);
  await expect(wheel.getByRole('status')).toHaveText('Cool white');
  await page.mouse.up();
  await expect(dot).toHaveAccessibleName(/, white\./);

  // A light with only warm-to-cool white gets the bar without a wheel.
  const reading = living.getByRole('button', { name: /Reading lamp colour/ });
  await slide(page, reading, ({ cx, cy, radius }) => ({ x: cx - radius * 0.9, y: cy }), false);
  await expect(page.locator('.color-wheel-disc')).toHaveCount(0);
  await expect(wheel.getByRole('status')).toHaveText('Warm white');
  await page.mouse.up();
  await expect(wheel).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('the colour wheel works from the keyboard', async ({ page }) => {
  await controls(page);
  const kitchen = page.getByRole('region', { name: 'Kitchen', exact: true });
  const dot = kitchen.getByRole('button', { name: /Kitchen lights colour/ });
  const wheel = page.locator('.color-wheel');
  await dot.focus();
  await page.keyboard.press('Enter');
  await expect(wheel).toBeVisible();
  await expect(dot).toHaveAttribute('aria-expanded', 'true');
  // Escape leaves it as it was.
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Escape');
  await expect(wheel).toHaveCount(0);
  await expect(kitchen.locator('.controls-room-heading')).toContainText('Off');

  await page.keyboard.press('Enter');
  for (let step = 0; step < 12; step++) await page.keyboard.press('ArrowRight');
  await expect(wheel.getByRole('status')).toHaveText('Green');
  await page.keyboard.press('Enter');
  await expect(wheel).toHaveCount(0);
  await expect(dot).toHaveAccessibleName(/, green\./);

  await page.keyboard.press('Enter');
  await page.keyboard.press('PageUp');
  await expect(wheel.getByRole('status')).toHaveText(/white$/);
  await page.keyboard.press('Enter');
  await expect(dot).toHaveAccessibleName(/, white\./);
});
