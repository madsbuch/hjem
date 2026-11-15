import { expect, test, type Page } from '@playwright/test';

async function navigate(page: Page, name: 'Settings' | 'Concierge') {
  await page.locator('nav:visible').first().waitFor();
  const mobile = page.getByRole('navigation', { name: 'Mobile navigation' });
  const navigation = (await mobile.isVisible())
    ? mobile
    : page.getByRole('navigation', { name: 'Main navigation' });
  await navigation.getByRole('button', { name, exact: true }).click();
}

test('native model saves block new requests and clear previous provider history', async ({
  page,
}) => {
  await page.route('https://openrouter.ai/**', (route) =>
    route.abort('blockedbyclient'),
  );
  await page.addInitScript(() => {
    type ChatBody = { messages: { role: string; content: string | null }[] };
    type Settings = { hasApiKey: boolean; model: string };
    const settings: Settings = { hasApiKey: true, model: 'fake/old-model' };
    const fixture = {
      requests: [] as { requestId: string; model: string; body: ChatBody }[],
      savePending: false,
      finishSave: () => {},
    };
    const completion = (text: string) => ({
      choices: [
        {
          finish_reason: 'stop',
          message: { role: 'assistant', content: text },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0 },
    });
    const target = window as typeof window & {
      isTauri: boolean;
      __TAURI_INTERNALS__: unknown;
      conciergeNativeFixture: typeof fixture;
    };
    target.isTauri = true;
    target.conciergeNativeFixture = fixture;
    target.__TAURI_INTERNALS__ = {
      async invoke(command: string, args: Record<string, any> = {}) {
        if (command === 'storage_load') return {
          serverUrl: '', connection: null, theme: 'system', pinnedApps: [],
          favourites: [], selectedSpeakers: [], legacyImportComplete: true, calendarFeeds: [], hiddenApps: [],
        };
        if (command === 'plugin:launcher|get_status')
          return { supported: false, isDefaultHome: false };
        if (command === 'concierge_get_settings') return { ...settings };
        if (command === 'concierge_list_models') return ['fake/old-model', 'fake/new-model'].map((id) => ({
          id, name: id, description: 'Test model', contextLength: 32000,
          inputPrice: 0, outputPrice: 0, requestPrice: 0, isFree: true, supportsTools: true,
          inputModalities: ['text'], outputModalities: ['text'], created: null,
        }));
        if (command === 'concierge_save_settings') {
          fixture.savePending = true;
          // The disk write can complete before its IPC result reaches React.
          settings.model = args.model;
          return new Promise((resolve) => {
            fixture.finishSave = () => {
              fixture.savePending = false;
              resolve({ ...settings });
            };
          });
        }
        if (command === 'concierge_cancel') {
          return;
        }
        if (command === 'concierge_request') {
          const index =
            fixture.requests.push({
              requestId: args.requestId,
              model: settings.model,
              body: args.body,
            }) - 1;
          if (index === 0)
            return completion('An answer from the old provider.');
          return completion('A fresh answer from the new provider.');
        }
        throw new Error(`Unexpected mocked native command: ${command}`);
      },
    };
  });

  await page.goto('/');
  await navigate(page, 'Concierge');
  const composer = page.getByRole('textbox', {
    name: 'Message Home Concierge',
  });
  await expect(composer).toBeEnabled();
  await composer.fill('Remember this old provider context.');
  await composer.press('Enter');
  const log = page.getByRole('log', {
    name: 'Conversation with Home Concierge',
  });
  await expect(
    log.getByText('An answer from the old provider.', { exact: true }),
  ).toBeVisible();

  await navigate(page, 'Settings');
  await page
    .getByLabel('Custom model ID', { exact: true })
    .fill('fake/new-model');
  await page.getByRole('button', { name: 'Save concierge settings' }).click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).conciergeNativeFixture.savePending),
    )
    .toBe(true);

  // Pending state must survive unmounting Settings, even if the native model
  // has already changed and the saved-settings response has not arrived yet.
  await navigate(page, 'Concierge');
  await expect(composer).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Send message', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Stop concierge', exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as any).conciergeNativeFixture.requests.length,
    ),
  ).toBe(1);
  await navigate(page, 'Settings');
  await expect(
    page.getByRole('button', { name: 'Save concierge settings' }),
  ).toBeDisabled();
  await navigate(page, 'Concierge');
  await expect(composer).toBeDisabled();
  await page.evaluate(() =>
    (window as any).conciergeNativeFixture.finishSave(),
  );
  await expect(composer).toBeEnabled();
  await expect(log).toHaveText('');
  await expect(
    page.getByRole('button', { name: 'Stop concierge', exact: true }),
  ).toHaveCount(0);

  await composer.fill('Start fresh with this provider.');
  await composer.press('Enter');
  await expect(
    log.getByText('A fresh answer from the new provider.', { exact: true }),
  ).toBeVisible();
  const fresh = await page.evaluate(
    () => (window as any).conciergeNativeFixture.requests[1],
  );
  expect(fresh.model).toBe('fake/new-model');
  expect(
    fresh.body.messages.filter(
      (message: { role: string }) => message.role !== 'system',
    ),
  ).toEqual([{ role: 'user', content: 'Start fresh with this provider.' }]);
  expect(JSON.stringify(fresh.body)).not.toContain('old provider');
  expect(
    await page.evaluate(
      () => (window as any).conciergeNativeFixture.requests.length,
    ),
  ).toBe(2);
  await expect(
    log.getByText('A fresh answer from the new provider.', { exact: true }),
  ).toHaveCount(1);
});
