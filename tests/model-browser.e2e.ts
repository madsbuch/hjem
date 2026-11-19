import { expect, test, type Page } from '@playwright/test';
import { nativeStorage } from './helpers/native-storage';

const recommendations = [
  { id: 'anthropic/claude-haiku-5.5', name: 'Claude Haiku 5.5' },
  { id: 'openai/gpt-6.1-terra', name: 'GPT-6.1 Terra' },
  { id: 'anthropic/claude-sonnet-5.5', name: 'Claude Sonnet 5.5' },
];
const model = (id: string, name: string, index = 1) => ({
  id, name, description: `Description of ${name}.`, context_length: index * 16000,
  created: 1700000000 + index * 100,
  supported_parameters: ['tools'],
  architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  pricing: { prompt: String(index / 1000000), completion: String(index * 2 / 1000000), request: '0' },
});
const catalogue = [
  ...recommendations.map((item, index) => model(item.id, item.name, index + 1)),
  { ...model('alpha/plain', 'Alpha text only'), supported_parameters: [] },
  { ...model('images/generator', 'Bravo image generator'), architecture: { input_modalities: ['text'], output_modalities: ['image'] } },
  ...Array.from({ length: 25 }, (_, index) => model(
    `${index % 2 ? 'beta' : 'alpha'}/catalogue-${index + 1}`,
    `Catalogue model ${String(index + 1).padStart(2, '0')}`, index + 1,
  )),
  { ...model('alpha/dynamic', 'Dynamic price'), pricing: { prompt: '-1', completion: '-1', request: '0' } },
  { ...model('free/home', 'Free home model'), pricing: { prompt: '0', completion: '0', request: '0' } },
  { ...model('zeta/custom-home', 'Zebra home model', 20), context_length: 262144 },
];
const nativeCatalogue = catalogue.map((item) => ({
  id: item.id, name: item.name, description: item.description, contextLength: item.context_length,
  inputPrice: Number(item.pricing.prompt) < 0 ? null : Number(item.pricing.prompt),
  outputPrice: Number(item.pricing.completion) < 0 ? null : Number(item.pricing.completion),
  requestPrice: Number(item.pricing.request), supportsTools: item.supported_parameters.includes('tools'),
  isFree: Object.values(item.pricing).every((price) => price === '0'),
  inputModalities: item.architecture.input_modalities, outputModalities: item.architecture.output_modalities,
  created: item.created,
}));
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };

async function settings(page: Page) {
  const mobile = page.getByRole('navigation', { name: 'Mobile navigation' });
  await page.locator('nav:visible').first().waitFor();
  const navigation = await mobile.isVisible() ? mobile : page.getByRole('navigation', { name: 'Main navigation' });
  await navigation.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('navigation', { name: 'Settings', exact: true }).getByRole('button', { name: /^Concierge/ }).click();
  return page.locator('#concierge-settings');
}

async function publicCatalogue(page: Page) {
  const requests: URL[] = [];
  let failing = false;
  await page.route('https://openrouter.ai/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== '/api/v1/models') return route.abort('blockedbyclient');
    requests.push(url);
    expect(route.request().headers().authorization).toBeUndefined();
    expect(url.searchParams.get('output_modalities')).toBe('all');
    expect(url.searchParams.has('supported_parameters')).toBe(false);
    await route.fulfill({ status: failing ? 503 : 200, headers: cors, contentType: 'application/json',
      body: JSON.stringify(failing ? { error: { message: 'Unavailable' } } : { data: catalogue }) });
  });
  return { requests, fail(value: boolean) { failing = value; } };
}

test('full catalogue is browsable without a key, including non-tool and image models, with live recommendations', async ({ page }) => {
  const mock = await publicCatalogue(page);
  await page.goto('/');
  const section = await settings(page);
  for (const item of recommendations) await expect(section.getByRole('radio', { name: item.name, exact: true })).toBeEnabled();
  const rows = section.getByRole('radio', { name: / from catalogue$/ });
  await expect(rows).toHaveCount(20);
  await expect(section.getByRole('radio', { name: 'Alpha text only from catalogue', exact: true })).toBeDisabled();
  await expect(section.getByRole('radio', { name: 'Bravo image generator from catalogue', exact: true })).toBeDisabled();
  await section.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(section.getByRole('radio', { name: 'Zebra home model from catalogue', exact: true })).toBeVisible();
  await section.getByRole('button', { name: 'Previous page', exact: true }).click();
  await expect(section.getByRole('radio', { name: 'Alpha text only from catalogue', exact: true })).toBeVisible();
  const search = section.getByRole('searchbox', { name: 'Search models', exact: true });
  await search.fill('zeta/custom-home');
  await expect(rows).toHaveCount(1);
  await expect(rows).toHaveAccessibleName('Zebra home model from catalogue');
  await search.fill('there-is-no-such-model');
  await expect(rows).toHaveCount(0);
  await expect(section.getByText(/no models/i).first()).toBeVisible();
  await search.fill('');
  await section.getByRole('combobox', { name: 'Provider', exact: true }).selectOption('beta');
  await expect(rows).toHaveCount(12);
  await expect(section.getByRole('radio', { name: 'Catalogue model 02 from catalogue', exact: true })).toBeVisible();
  await expect(section.getByRole('radio', { name: 'Catalogue model 01 from catalogue', exact: true })).toHaveCount(0);
  await section.getByRole('combobox', { name: 'Provider', exact: true }).selectOption({ label: 'All providers' });
  await section.getByRole('combobox', { name: 'Capability', exact: true }).selectOption('tools');
  await expect(section.getByRole('radio', { name: 'Alpha text only from catalogue', exact: true })).toHaveCount(0);
  await section.getByRole('combobox', { name: 'Capability', exact: true }).selectOption('all');
  await section.getByRole('combobox', { name: 'Pricing', exact: true }).selectOption('free');
  await expect(rows).toHaveCount(1);
  await expect(rows).toHaveAccessibleName('Free home model from catalogue');
  await section.getByRole('combobox', { name: 'Pricing', exact: true }).selectOption('all');
  await section.getByRole('combobox', { name: 'Sort models', exact: true }).selectOption('context');
  await expect(rows.first()).toHaveAccessibleName('Catalogue model 25 from catalogue');
  expect(mock.requests.length).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('catalogue failures offer retry and a failed refresh preserves the selected model', async ({ page }) => {
  const mock = await publicCatalogue(page);
  mock.fail(true);
  await page.goto('/');
  const section = await settings(page);
  await expect(section.getByRole('button', { name: 'Retry loading models', exact: true })).toBeVisible();
  mock.fail(false);
  await section.getByRole('button', { name: 'Retry loading models', exact: true }).click();
  const search = section.getByRole('searchbox', { name: 'Search models', exact: true });
  await search.fill('zeta/custom-home');
  const choice = section.getByRole('radio', { name: 'Zebra home model from catalogue', exact: true });
  await choice.check();
  await expect(choice).toBeChecked();
  mock.fail(true);
  await section.getByRole('button', { name: 'Refresh models', exact: true }).click();
  await expect(section.getByRole('button', { name: 'Retry loading models', exact: true })).toBeVisible();
  await expect(choice).toBeChecked();
  mock.fail(false);
  await section.getByRole('button', { name: 'Retry loading models', exact: true }).click();
  await expect(choice).toBeChecked();
});

test('a model selected from the full native catalogue is saved and restored after reload', async ({ page }) => {
  await nativeStorage(page);
  await page.route('https://openrouter.ai/**', (route) => route.abort('blockedbyclient'));
  await page.addInitScript((models) => {
    const target = window as typeof window & {
      __TAURI_INTERNALS__: { invoke: (command: string, args?: unknown) => Promise<unknown> };
    };
    const invoke = target.__TAURI_INTERNALS__.invoke;
    target.__TAURI_INTERNALS__.invoke = (command, args) => command === 'concierge_list_models'
      ? Promise.resolve(models) : invoke(command, args);
  }, nativeCatalogue);
  await page.goto('/');
  let section = await settings(page);
  await section.getByRole('searchbox', { name: 'Search models', exact: true }).fill('zeta/custom-home');
  await section.getByRole('radio', { name: 'Zebra home model from catalogue', exact: true }).check();
  await section.getByLabel('OpenRouter API key', { exact: true }).fill('test-only-key');
  await section.getByRole('button', { name: 'Save concierge settings', exact: true }).click();
  await expect(section.getByText('Home Concierge settings saved.', { exact: true })).toBeVisible();
  await page.reload();
  section = await settings(page);
  await section.getByRole('searchbox', { name: 'Search models', exact: true }).fill('zeta/custom-home');
  await expect(section.getByRole('radio', { name: 'Zebra home model from catalogue', exact: true })).toBeChecked();
  await expect(section.getByLabel('OpenRouter API key', { exact: true })).toHaveValue('');
});

test('pressing Enter in model search keeps draft settings unsaved and the active model unchanged', async ({ page }) => {
  const storage = await nativeStorage(page);
  await page.route('https://openrouter.ai/**', (route) => route.abort('blockedbyclient'));
  await page.addInitScript((models) => {
    const target = window as typeof window & {
      __TAURI_INTERNALS__: { invoke: (command: string, args?: unknown) => Promise<unknown> };
    };
    const invoke = target.__TAURI_INTERNALS__.invoke;
    target.__TAURI_INTERNALS__.invoke = (command, args) => command === 'concierge_list_models'
      ? Promise.resolve(models) : invoke(command, args);
  }, nativeCatalogue);
  await page.goto('/');
  let section = await settings(page);
  await section.getByRole('radio', { name: recommendations[0].name, exact: true }).check();
  await section.getByLabel('OpenRouter API key', { exact: true }).fill('test-only-original-key');
  await section.getByRole('button', { name: 'Save concierge settings', exact: true }).click();
  await expect(section.getByText('Home Concierge settings saved.', { exact: true })).toBeVisible();
  await page.reload();
  section = await settings(page);

  const search = section.getByRole('searchbox', { name: 'Search models', exact: true });
  await search.fill('zeta/custom-home');
  await section.getByRole('radio', { name: 'Zebra home model from catalogue', exact: true }).check();
  await section.getByLabel('OpenRouter API key', { exact: true }).fill('test-only-draft-key');
  await expect(section.getByRole('button', { name: 'Save concierge settings', exact: true })).toBeEnabled();
  await search.press('Enter');

  await expect(section.getByLabel('OpenRouter API key', { exact: true })).toHaveValue('test-only-draft-key');
  await expect(section.getByText('Home Concierge settings saved.', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => window.__hjemStorageInvoke('concierge_get_settings')))
    .toEqual({ hasApiKey: true, model: recommendations[0].id });
  expect(storage.commands.filter((command) => command === 'concierge_save_settings')).toHaveLength(1);
  await page.reload();
  section = await settings(page);
  await expect(section.getByRole('radio', { name: recommendations[0].name, exact: true })).toBeChecked();
});
