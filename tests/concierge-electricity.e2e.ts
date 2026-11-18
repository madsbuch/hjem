import { expect, test, type Page, type Route } from '@playwright/test';
import { isRecord } from '../src/lib/home-assistant-protocol';

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};
const tool = (name: string, args: Record<string, unknown> = {}) => ({
  id: name, type: 'function', function: { name, arguments: JSON.stringify(args) },
});
async function reply(route: Route, calls: ReturnType<typeof tool>[] = [], text: string | null = null) {
  await route.fulfill({
    contentType: 'application/json', headers: cors,
    body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: text, ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: calls.length ? 'tool_calls' : 'stop' }] }),
  });
}
function result(body: unknown, toolId: string): Record<string, unknown> {
  if (!isRecord(body) || !Array.isArray(body.messages)) throw new Error('Missing provider messages');
  const message = [...body.messages].reverse().find((entry: unknown) => isRecord(entry) && entry.role === 'tool' && entry.tool_call_id === toolId);
  if (!isRecord(message) || typeof message.content !== 'string') throw new Error(`Missing result for ${toolId}`);
  const value: unknown = JSON.parse(message.content);
  if (!isRecord(value)) throw new Error(`Malformed result for ${toolId}`);
  return value;
}
async function navigate(page: Page, name: string) {
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const mobile = page.getByRole('navigation', { name: 'Mobile navigation' });
  const nav = await mobile.isVisible() ? mobile : page.getByRole('navigation', { name: 'Main navigation' });
  await nav.getByRole('button', { name, exact: true }).click();
}

test('Concierge answers when electricity is cheapest from the published prices', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-18T20:10:00') });
  const seen: Record<string, unknown>[] = [];
  let offered: unknown[] = [];
  await page.route('https://openrouter.ai/**', async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (!route.request().url().endsWith('/chat/completions')) return route.abort('blockedbyclient');
    const body: unknown = route.request().postDataJSON();
    if (isRecord(body) && Array.isArray(body.tools)) offered = body.tools;
    if (seen.length === 0) {
      seen.push({});
      return reply(route, [tool('find_cheapest_hours', { hours: 3, latest: '07:00' })]);
    }
    const found = result(body, 'find_cheapest_hours');
    seen.push(found);
    return reply(route, [], `Start the dishwasher at ${String(found.start).slice(11)}; that is the cheapest stretch before 07:00.`);
  });
  await page.goto('/');
  await navigate(page, 'Settings');
  await page.getByLabel('OpenRouter API key', { exact: true }).fill('fixture-only-key');
  await page.getByRole('radio', { name: 'Use another model', exact: true }).check();
  await page.getByLabel('Custom model ID', { exact: true }).fill('fixture/electricity-model');
  await page.getByRole('button', { name: 'Save concierge settings' }).click();
  await expect(page.getByText('Home Concierge settings saved.', { exact: true })).toBeVisible();

  await navigate(page, 'Concierge');
  const input = page.getByRole('textbox', { name: 'Message Home Concierge' });
  await input.fill('When should I run the dishwasher tonight? It takes three hours and must be done by 7.');
  await input.press('Enter');
  await expect(page.getByRole('log')).toContainText('cheapest stretch before 07:00');

  expect(offered.map((definition) => isRecord(definition) && isRecord(definition.function) ? definition.function.name : null))
    .toEqual(expect.arrayContaining(['get_electricity_prices', 'find_cheapest_hours', 'get_electricity_usage']));
  const found = seen[1];
  if (!found) throw new Error('The tool did not run');
  // The demo prices are sample data, computed by Hjem rather than by the model.
  expect(found).toMatchObject({ available: true, sample_data: true, found: true, together: true, hours: 3, unit: 'kr/kWh incl. VAT' });
  expect(String(found.start)).toMatch(/^2026-11-19 0[0-4]:00$/);
  expect(String(found.end) <= '2026-11-19 07:00').toBe(true);
});
