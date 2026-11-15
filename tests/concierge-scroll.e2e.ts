import { expect, test, type Page } from '@playwright/test';

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

const longReply = [
  '## Home report',
  ...Array.from({ length: 60 }, (_, index) =>
    `### Room ${index + 1}\n\nThe reading lamp is on. The ceiling light is off. All other devices in this room are available.`,
  ),
  'End of report.',
].join('\n\n');

async function navigate(page: Page, name: string) {
  const mobile = page.getByRole('navigation', { name: 'Mobile navigation' });
  const navigation = await mobile.isVisible() ? mobile : page.getByRole('navigation', { name: 'Main navigation' });
  await navigation.getByRole('button', { name, exact: true }).click();
}

async function openConcierge(page: Page, configured: boolean) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('https://openrouter.ai/**', async (route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: cors });
      return;
    }
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/models') {
      await route.fulfill({
        headers: cors, contentType: 'application/json',
        body: JSON.stringify({ data: [{
          id: 'fixture/scroll', name: 'Scroll fixture',
          supported_parameters: ['tools'],
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        }] }),
      });
    } else if (path === '/api/v1/chat/completions') {
      await route.fulfill({
        headers: cors, contentType: 'application/json',
        body: JSON.stringify({ choices: [{
          message: { role: 'assistant', content: longReply }, finish_reason: 'stop',
        }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, cost: 0.001 } }),
      });
    } else await route.abort('blockedbyclient');
  });
  await page.goto('/');
  if (configured) {
    await navigate(page, 'Settings');
    await page.getByLabel('OpenRouter API key', { exact: true }).fill('fixture-only-key');
    await page.getByRole('radio', { name: 'Use another model', exact: true }).check();
    await page.getByLabel('Custom model ID', { exact: true }).fill('fixture/scroll');
    await page.getByRole('button', { name: 'Save concierge settings' }).click();
    await expect(page.getByText('Home Concierge settings saved.', { exact: true })).toBeVisible();
  }
  await navigate(page, 'Concierge');
  await expect(page.getByRole('textbox', { name: 'Message Home Concierge' })).toBeVisible();
}

async function expectFixedPage(page: Page) {
  // Check actual geometry, including the area reserved for mobile navigation.
  // A visible element can still be below the viewport or behind a fixed bar.
  await expect.poll(() => page.evaluate(() => {
    const composer = document.querySelector('.concierge-compose')!.getBoundingClientRect();
    const viewport = window.visualViewport;
    const top = viewport?.offsetTop ?? 0;
    const bottom = top + (viewport?.height ?? window.innerHeight);
    const navigation = document.querySelector('.mobile-navigation')!.getBoundingClientRect();
    const availableBottom = navigation.height > 0 ? Math.min(bottom, navigation.top) : bottom;
    return composer.top >= top - 1 && composer.bottom <= availableBottom + 1;
  }), { message: 'The entire composer stays inside the available viewport' }).toBe(true);

  const geometry = await page.evaluate(() => {
    const main = document.querySelector('main')!;
    const root = document.documentElement;
    const transcript = document.querySelector('.concierge-scroll')!;
    return {
      documentTop: document.scrollingElement?.scrollTop ?? window.scrollY,
      documentOverflow: root.scrollHeight - root.clientHeight,
      mainTop: main.scrollTop,
      mainOverflow: main.scrollHeight - main.clientHeight,
      transcriptHeight: transcript.clientHeight,
    };
  });
  expect(geometry.documentTop, 'The document does not scroll').toBe(0);
  expect(geometry.documentOverflow, 'The document fits the viewport').toBeLessThanOrEqual(1);
  expect(geometry.mainTop, 'The main content does not scroll').toBe(0);
  expect(geometry.mainOverflow, 'The main content fits its fixed area').toBeLessThanOrEqual(1);
  expect(geometry.transcriptHeight, 'The conversation keeps a usable visible area').toBeGreaterThan(30);
}

async function sendLongReply(page: Page, count: number) {
  const input = page.getByRole('textbox', { name: 'Message Home Concierge' });
  await input.fill('Give me a detailed report of every room.');
  await input.press('Enter');
  const replies = page.getByRole('article', { name: 'Home Concierge response' });
  await expect(replies).toHaveCount(count);
  await expect(replies.last()).toContainText('End of report.');
  await expect.poll(() => page.locator('.concierge-scroll').evaluate((element) =>
    element.scrollHeight - element.clientHeight - element.scrollTop,
  ), { message: 'New replies scroll the conversation to the latest content' }).toBeLessThan(4);
}

test('long conversations scroll inside the transcript while the composer stays fixed', async ({ page }) => {
  await openConcierge(page, true);
  await expectFixedPage(page);
  const initialComposer = await page.locator('.concierge-compose').boundingBox();
  await sendLongReply(page, 1);
  await expectFixedPage(page);
  await sendLongReply(page, 2);
  await expectFixedPage(page);

  const transcript = page.locator('.concierge-scroll');
  expect(await transcript.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await transcript.evaluate((element) => { element.scrollTop = 0; });
  await transcript.hover();
  await page.mouse.wheel(0, 240);
  await expect.poll(() => transcript.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expectFixedPage(page);

  // Reaching the transcript boundary must not start scrolling the outer page.
  await transcript.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await page.mouse.wheel(0, 1200);
  await expectFixedPage(page);
  const finalComposer = await page.locator('.concierge-compose').boundingBox();
  expect(initialComposer).not.toBeNull();
  expect(finalComposer).not.toBeNull();
  expect(Math.abs(finalComposer!.y - initialComposer!.y)).toBeLessThanOrEqual(1);
});

test('focused multiline composer stays available when the viewport shrinks and rotates', async ({ page }) => {
  await openConcierge(page, true);
  await sendLongReply(page, 1);
  const originalViewport = page.viewportSize()!;
  const input = page.getByRole('textbox', { name: 'Message Home Concierge' });
  await input.fill('First instruction\nSecond instruction\nThird instruction\nFourth instruction');
  await input.focus();

  // A keyboard-sized reduction exercises the focused composer and layout resize
  // together; desktop browser automation does not open a native soft keyboard.
  await page.setViewportSize({ width: originalViewport.width, height: 420 });
  await expect(input).toBeFocused();
  await expectFixedPage(page);
  await expect(input).toHaveValue('First instruction\nSecond instruction\nThird instruction\nFourth instruction');
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeInViewport({ ratio: 1 });

  await page.setViewportSize({ width: 844, height: 390 });
  await expectFixedPage(page);
  await page.setViewportSize(originalViewport);
  await expectFixedPage(page);
  await expect(input).toBeFocused();
});

test('unconfigured welcome and setup fit the fixed page in portrait and short landscape', async ({ page }) => {
  await openConcierge(page, false);
  await expect(page.getByRole('textbox', { name: 'Message Home Concierge' })).toBeDisabled();
  await expectFixedPage(page);
  await page.setViewportSize({ width: 844, height: 390 });
  await expectFixedPage(page);
  const setup = page.getByRole('button', { name: 'Set up Concierge', exact: true });
  await setup.scrollIntoViewIfNeeded();
  await expect(setup).toBeInViewport({ ratio: 1 });
  await expectFixedPage(page);
  await setup.click();
  await expect(page.getByRole('heading', { name: 'Home Concierge', exact: true })).toBeVisible();
});
