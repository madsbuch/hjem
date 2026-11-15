import { expect, test, type Page } from '@playwright/test';

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

async function navigate(page: Page, name: string) {
  const mobile = page.getByRole('navigation', { name: 'Mobile navigation' });
  const navigation = await mobile.isVisible() ? mobile : page.getByRole('navigation', { name: 'Main navigation' });
  await navigation.getByRole('button', { name, exact: true }).click();
}

async function startChat(page: Page, answer: string) {
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
          id: 'fixture/markdown', name: 'Markdown fixture',
          supported_parameters: ['tools'],
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        }] }),
      });
    } else if (path === '/api/v1/chat/completions') {
      await route.fulfill({
        headers: cors, contentType: 'application/json',
        body: JSON.stringify({ choices: [{
          message: { role: 'assistant', content: answer }, finish_reason: 'stop',
        }] }),
      });
    } else await route.abort('blockedbyclient');
  });
  await page.goto('/');
  await navigate(page, 'Settings');
  await page.getByLabel('OpenRouter API key', { exact: true }).fill('fixture-only-key');
  await page.getByRole('radio', { name: 'Use another model', exact: true }).check();
  await page.getByLabel('Custom model ID', { exact: true }).fill('fixture/markdown');
  await page.getByRole('button', { name: 'Save concierge settings' }).click();
  await expect(page.getByText('Home Concierge settings saved.', { exact: true })).toBeVisible();
  await navigate(page, 'Concierge');
  await expect(page.getByText('A little help, right here at home.', { exact: true })).toHaveCount(0);
}

async function send(page: Page, message = 'Which lights are on?') {
  const composer = page.getByRole('textbox', { name: 'Message Home Concierge' });
  await composer.fill(message);
  await composer.press('Enter');
  const response = page.getByRole('article', { name: 'Home Concierge response' });
  await expect(response).toBeVisible();
  return response;
}

test('assistant replies render Markdown while user messages remain plain text', async ({ page }) => {
  await startChat(page, [
    '### Lights that are on',
    '',
    'All **nine lights** are on:',
    '',
    '- **Family Room:** Reading lamp',
    '- **Bedroom:** Natalia bulb',
    '',
    '1. Check the *room*.',
    '2. Use `light.turn_off`.',
    '',
    '> The office light is also on.',
    '',
    '| Room | State |',
    '| --- | --- |',
    '| Office | On |',
    '',
    '```json',
    '{"entity_id":"light.office"}',
    '```',
    '',
    '[Home Assistant documentation](https://www.home-assistant.io/docs/)',
    '',
    '- [x] Checked the home',
  ].join('\n'));
  const response = await send(page, '**Which lights are on?**');
  const user = page.getByRole('article', { name: 'Your message' });
  await expect(user).toContainText('**Which lights are on?**');
  await expect(user.locator('strong')).toHaveCount(0);
  await expect(response.getByRole('heading', { name: 'Lights that are on' })).toBeVisible();
  await expect(response.locator('strong').filter({ hasText: 'Family Room:' })).toBeVisible();
  await expect(response.locator('ul').first().locator('li')).toHaveCount(2);
  await expect(response.locator('ol li')).toHaveCount(2);
  await expect(response.locator('blockquote')).toContainText('office light');
  await expect(response.getByRole('table')).toContainText('Office');
  await expect(response.locator('pre code')).toHaveText('{"entity_id":"light.office"}\n');
  await expect(response.getByRole('checkbox')).toBeChecked();
  await expect(response.getByRole('checkbox')).toBeDisabled();
  const link = response.getByRole('link', { name: 'Home Assistant documentation' });
  await expect(link).toHaveAttribute('href', 'https://www.home-assistant.io/docs/');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
});

test('Markdown never executes raw HTML or unsafe URLs and does not load remote images', async ({ page }) => {
  const imageRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('tracking.invalid')) imageRequests.push(request.url());
  });
  await page.route('https://tracking.invalid/**', (route) => route.abort('blockedbyclient'));
  await startChat(page, [
    '**Safe text remains visible.**',
    '',
    '<script>window.markdownAttack = true</script>',
    '',
    '<img src="https://tracking.invalid/raw.png" onerror="window.markdownAttack=true">',
    '',
    '[Unsafe script](javascript:alert%281%29)',
    '[Unsafe data](data:text/html;base64,PHNjcmlwdD4=)',
    '[Unsafe file](file:///etc/passwd)',
    '',
    '![Floor plan](https://tracking.invalid/floor-plan.png)',
    '',
    '[Safe link](https://example.com/help)',
  ].join('\n'));
  const response = await send(page);
  await expect(response.locator('strong')).toHaveText('Safe text remains visible.');
  await expect(response.locator('script, img, iframe')).toHaveCount(0);
  await expect(response.getByRole('link', { name: /^Unsafe/ })).toHaveCount(0);
  await expect(response).toContainText('Unsafe script');
  await expect(response.getByRole('link', { name: 'Image: Floor plan' })).toHaveAttribute('href', 'https://tracking.invalid/floor-plan.png');
  await expect(response.getByRole('link', { name: 'Safe link' })).toHaveAttribute('href', 'https://example.com/help');
  expect(await page.evaluate(() => Reflect.get(window, 'markdownAttack'))).toBeUndefined();
  expect(imageRequests).toEqual([]);
});

test('long Markdown tables and code scroll within the message in dark mode', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await startChat(page, [
    '| Living room | Bedroom | Kitchen | Office | Hallway |',
    '| --- | --- | --- | --- | --- |',
    '| Reading lamp | Bedside lamp | Ceiling light | Desk lamp | Entrance light |',
    '',
    '```text',
    'A long diagnostic line: ' + 'light.office_'.repeat(35),
    '```',
  ].join('\n'));
  const response = await send(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(response.getByRole('region', { name: 'Response table' })).toBeVisible();
  await expect(response.locator('pre')).toHaveCSS('overflow-x', 'auto');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const message = await response.boundingBox();
  if (!message) throw new Error('Response is not visible');
  expect(message.x + message.width).toBeLessThanOrEqual((page.viewportSize()?.width ?? 0) + 1);
});
