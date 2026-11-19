import { expect, test, type Page, type Route } from '@playwright/test';
import { openSettings } from './helpers/settings';
import type { ChatRecord } from '../src/lib/concierge-history';
import { nativeStorage } from './helpers/native-storage';

const model = 'fixture/history';
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
type WireMessage = { role: string; content: unknown; tool_calls?: unknown[] };
type Request = { messages: WireMessage[]; model?: string };
const completion = (text: string | null, calls?: unknown[]) => ({
  choices: [{ index: 0, finish_reason: calls?.length ? 'tool_calls' : 'stop',
    message: { role: 'assistant', content: text, ...(calls ? { tool_calls: calls } : {}) } }],
  usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0 },
});
const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({
  id, type: 'function', function: { name, arguments: JSON.stringify(args) },
});
async function reply(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, headers: cors, contentType: 'application/json', body: JSON.stringify(body) });
}
async function navigate(page: Page, name: string) {
  await page.locator('nav:visible').first().waitFor();
  await page.locator('nav:visible').getByRole('button', { name, exact: true }).click();
}
async function browserChat(page: Page, respond?: (request: Request, index: number, route: Route) => Promise<void>) {
  const requests: Request[] = [];
  await page.route('https://openrouter.ai/**', async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/models') return reply(route, { data: [{
      id: model, name: 'History fixture', supported_parameters: ['tools'],
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    }] });
    if (path !== '/api/v1/chat/completions') return route.abort('blockedbyclient');
    const request = route.request().postDataJSON() as Request;
    const index = requests.push(request) - 1;
    if (respond) return respond(request, index, route);
    return reply(route, completion(`Saved answer ${index + 1}.`));
  });
  await page.goto('/');
  await openSettings(page, 'Concierge');
  await page.getByLabel('OpenRouter API key', { exact: true }).fill('fixture-only-history-key');
  await page.getByRole('radio', { name: 'Use another model', exact: true }).check();
  await page.getByLabel('Custom model ID', { exact: true }).fill(model);
  await page.getByRole('button', { name: 'Save concierge settings', exact: true }).click();
  await expect(page.getByText('Home Concierge settings saved.', { exact: true })).toBeVisible();
  await navigate(page, 'Concierge');
  return requests;
}
async function send(page: Page, text: string) {
  const composer = page.getByRole('textbox', { name: 'Message Home Concierge', exact: true });
  await composer.fill(text);
  await composer.press('Enter');
}
async function nativeReplies(page: Page, respond: (request: Request, index: number) => unknown) {
  const requests: Request[] = [];
  await page.route('https://openrouter.ai/**', (route) => route.abort('blockedbyclient'));
  await page.exposeFunction('__historyCompletion', (request: Request) => {
    const index = requests.push(structuredClone(request)) - 1;
    return respond(request, index);
  });
  await page.addInitScript(() => {
    const target = window as typeof window & {
      __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
      __historyCompletion: (request: unknown) => Promise<unknown>;
    };
    const invoke = target.__TAURI_INTERNALS__.invoke;
    target.__TAURI_INTERNALS__.invoke = (command, args = {}) => command === 'concierge_request'
      ? target.__historyCompletion(args.body)
      : command === 'concierge_cancel' ? Promise.resolve(null) : invoke(command, args);
  });
  return requests;
}
const log = (page: Page) => page.getByRole('log', { name: 'Conversation with Home Concierge' });
async function openHistory(page: Page) {
  await page.getByRole('button', { name: 'Chat history', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Previous chats', exact: true });
  await expect(drawer).toBeVisible();
  return drawer;
}
async function reopen(page: Page, title: string) {
  const drawer = await openHistory(page);
  await drawer.getByRole('searchbox', { name: 'Search chats', exact: true }).fill('');
  await drawer.getByRole('button', { name: title, exact: true }).click();
  await expect(drawer).not.toBeVisible();
}
async function expectBrowserSaved(page: Page, text: string) {
  await expect.poll(() => page.evaluate((expected) => new Promise<boolean>((resolve, reject) => {
    const request = indexedDB.open('hjem-concierge-history', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction('chats', 'readonly');
      const records = transaction.objectStore('chats').getAll();
      records.onsuccess = () => {
        const chats = records.result as ChatRecord[];
        resolve(chats.some((chat) => chat.messages.some((message) => message.text === expected)));
      };
      transaction.oncomplete = () => database.close();
      transaction.onabort = () => { database.close(); reject(transaction.error); };
    };
  }), text)).toBe(true);
}

// Uses the real browser IndexedDB adapter, not an in-memory storage mock.
test('new conversations preserve older chats and IndexedDB restores readable messages after reload', async ({ page }) => {
  const requests = await browserChat(page);
  await send(page, 'Which lights are on in the kitchen?');
  await expect(log(page)).toContainText('Saved answer 1.');
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await expect(log(page)).toHaveText('');
  await send(page, 'Help me organize the bedroom.');
  await expect(log(page)).toContainText('Saved answer 2.');
  const drawer = await openHistory(page);
  await expect(drawer.getByRole('button').filter({ hasText: 'Which lights are on in the kitchen?' })).toBeVisible();
  await expect(drawer.getByRole('button').filter({ hasText: 'Help me organize the bedroom.' })).toBeVisible();
  await drawer.getByRole('searchbox', { name: 'Search chats', exact: true }).fill('kitchen');
  await expect(drawer.getByRole('button').filter({ hasText: 'Help me organize the bedroom.' })).toHaveCount(0);
  await drawer.getByRole('button').filter({ hasText: 'Which lights are on in the kitchen?' }).click();
  await expect(log(page)).toContainText('Saved answer 1.');
  await expect(log(page)).not.toContainText('Saved answer 2.');
  await expectBrowserSaved(page, 'Saved answer 1.');
  await expectBrowserSaved(page, 'Saved answer 2.');
  await page.reload();
  await navigate(page, 'Concierge');
  // The browser preview intentionally forgets keys; saved conversations remain readable.
  await expect(page.getByRole('textbox', { name: 'Message Home Concierge', exact: true })).toBeDisabled();
  await reopen(page, 'Which lights are on in the kitchen?');
  await expect(log(page)).toContainText('Which lights are on in the kitchen?');
  await expect(log(page)).toContainText('Saved answer 1.');
  expect(requests).toHaveLength(2);
  expect(await page.evaluate(() => document.documentElement.scrollHeight - document.documentElement.clientHeight)).toBeLessThanOrEqual(1);
});

test('saved native chats restore on restart and resume text context without replaying old tool calls', async ({ page }) => {
  const storage = await nativeStorage(page);
  storage.setConciergeSettings({ hasApiKey: true, model });
  const requests = await nativeReplies(page, (_request, index) => {
    if (index === 0) return completion(null, [call('saved-read', 'get_home_state')]);
    if (index === 1) return completion(null, [call('saved-action', 'control_device', {
      entity_id: 'light.living_pendant', action: 'turn_off',
    })]);
    if (index === 2) return completion('The pendant lights are off.');
    return completion('The earlier answer is still in our conversation.');
  });
  await page.goto('/');
  await navigate(page, 'Concierge');
  await send(page, 'Turn off the pendant lights.');
  await expect(log(page)).toContainText('The pendant lights are off.');
  await expect.poll(() => storage.chats[0]?.messages.some((message) => message.text === 'The pendant lights are off.')).toBe(true);
  expect(JSON.stringify(storage.chats)).not.toContain('tool_calls');
  expect(JSON.stringify(storage.chats)).not.toContain('saved-read');
  expect(JSON.stringify(storage.chats)).not.toContain('saved-action');
  await navigate(page, 'Controls');
  await page.getByRole('tab', { name: 'All devices', exact: true }).click();
  await expect(page.getByRole('switch', { name: 'Toggle Pendant lights', exact: true })).not.toBeChecked();
  await page.reload();
  // Demo devices reset on reload; restoring a transcript must not replay its action.
  await navigate(page, 'Controls');
  await page.getByRole('tab', { name: 'All devices', exact: true }).click();
  await expect(page.getByRole('switch', { name: 'Toggle Pendant lights', exact: true })).toBeChecked();
  await navigate(page, 'Concierge');
  await expect(log(page)).toContainText('The pendant lights are off.');
  expect(requests).toHaveLength(3);
  await send(page, 'What did you just change?');
  await expect(log(page)).toContainText('The earlier answer is still in our conversation.');
  expect(requests).toHaveLength(4);
  const resumed = requests[3].messages.filter((message) => message.role !== 'system');
  expect(resumed.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
  expect(resumed.map((message) => message.content)).toEqual([
    'Turn off the pendant lights.', 'The pendant lights are off.', 'What did you just change?',
  ]);
  expect(JSON.stringify(resumed)).not.toContain('saved-read');
});

test('failed requests remain in saved history after restart without retrying them', async ({ page }) => {
  const requests = await browserChat(page, (_request, _index, route) => reply(route, { error: { message: 'Fixture unavailable' } }, 503));
  await send(page, 'Please check my unavailable model.');
  await expect(log(page)).toContainText('temporarily unavailable');
  await expectBrowserSaved(page, await log(page).locator('.concierge-message-error p').innerText());
  await page.reload();
  await navigate(page, 'Concierge');
  await reopen(page, 'Please check my unavailable model.');
  await expect(log(page)).toContainText('Please check my unavailable model.');
  await expect(log(page)).toContainText('temporarily unavailable');
  expect(requests).toHaveLength(1);
});

test('a failed history write is visible and retry saves the complete conversation', async ({ page }) => {
  const storage = await nativeStorage(page);
  storage.setConciergeSettings({ hasApiKey: true, model });
  storage.fail('concierge_save_chat');
  const requests = await nativeReplies(page, () => completion('This answer needs a storage retry.'));
  await page.goto('/');
  await navigate(page, 'Concierge');
  await send(page, 'Remember this conversation despite a disk failure.');
  await expect(log(page)).toContainText('This answer needs a storage retry.');
  const warning = page.getByRole('alert').filter({ hasText: 'This conversation could not be saved.' });
  await expect(warning).toBeVisible();
  expect(storage.chats).toHaveLength(0);
  storage.fail('');
  await warning.getByRole('button', { name: 'Retry saving', exact: true }).click();
  await expect(warning).not.toBeVisible();
  await expect.poll(() => storage.chats[0]?.messages.map((message) => message.text)).toEqual([
    'Remember this conversation despite a disk failure.', 'This answer needs a storage retry.',
  ]);
  await page.reload();
  await navigate(page, 'Concierge');
  await expect(log(page)).toContainText('This answer needs a storage retry.');
  expect(requests).toHaveLength(1);
});

test('an interrupted late response cannot overwrite a different saved conversation', async ({ page }) => {
  let held: Route | undefined;
  const requests = await browserChat(page, async (_request, index, route) => {
    if (index === 0) { held = route; return; }
    await reply(route, completion('This belongs to the second chat.'));
  });
  await send(page, 'First chat waiting for a reply.');
  await expect.poll(() => requests.length).toBe(1);
  await page.getByRole('button', { name: 'Stop concierge', exact: true }).click();
  await expect(page.getByRole('button', { name: 'New conversation', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await send(page, 'Second independent chat.');
  await expect(log(page)).toContainText('This belongs to the second chat.');
  if (!held) throw new Error('The first request was not captured');
  await reply(held, completion('Late answer from the first chat.')).catch(() => {});
  await reopen(page, 'First chat waiting for a reply.');
  await expect(log(page)).toContainText('Stopped.');
  await expect(log(page)).not.toContainText('Late answer from the first chat.');
  await reopen(page, 'Second independent chat.');
  await expect(log(page)).toContainText('This belongs to the second chat.');
  await expect(log(page)).not.toContainText('First chat');
  expect(requests).toHaveLength(2);
});

test('history includes all saved chats and keeps a different home read-only', async ({ page }) => {
  const storage = await nativeStorage(page);
  storage.setConciergeSettings({ hasApiKey: true, model });
  const records: ChatRecord[] = Array.from({ length: 125 }, (_, index) => ({
    id: `saved-${index + 1}`, title: `Saved chat ${String(index + 1).padStart(3, '0')}`,
    createdAt: 1700000000000 + index, updatedAt: 1700000000000 + index,
    model, homeKey: 'demo', messages: [
      { id: `question-${index + 1}`, role: 'user', text: `Question from chat ${index + 1}` },
      { id: `answer-${index + 1}`, role: 'assistant', text: `Answer from chat ${index + 1}` },
    ],
  }));
  records.push({ id: 'other-home', title: 'A conversation at the other home',
    createdAt: 1700000000200, updatedAt: 1700000000200, model,
    homeKey: 'https://other-home.invalid', messages: [{ id: 'other-question', role: 'user', text: 'Turn on the other home lights.' }] });
  storage.setChats(records);
  await page.goto('/');
  await navigate(page, 'Concierge');
  const drawer = await openHistory(page);
  await expect(drawer.getByRole('button', { name: /^Saved chat \d{3}$/ })).toHaveCount(125);
  const scroll = drawer.locator('.chat-history-scroll');
  expect(await scroll.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await scroll.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(drawer.getByRole('button', { name: 'Saved chat 001', exact: true })).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => ({ top: document.scrollingElement?.scrollTop, overflow: document.documentElement.scrollHeight - document.documentElement.clientHeight })))
    .toEqual({ top: 0, overflow: 0 });
  await drawer.getByRole('searchbox', { name: 'Search chats', exact: true }).fill('Saved chat 001');
  await drawer.getByRole('button').filter({ hasText: 'Saved chat 001' }).click();
  await expect(log(page)).toContainText('Answer from chat 1');
  await reopen(page, 'A conversation at the other home');
  await expect(log(page)).toContainText('Turn on the other home lights.');
  await expect(page.getByRole('textbox', { name: 'Message Home Concierge', exact: true })).toBeDisabled();
  expect(storage.commands.filter((command) => command === 'concierge_request')).toHaveLength(0);
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Message Home Concierge', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(await page.evaluate(() => document.documentElement.scrollHeight - document.documentElement.clientHeight)).toBeLessThanOrEqual(1);
});

test('IndexedDB rejects divergent conversation branches without replacing the saved transcript', async ({ page }) => {
  await page.route('https://openrouter.ai/**', (route) => route.abort('blockedbyclient'));
  await page.goto('/');
  const results = await page.evaluate(async () => {
    // Exercise actual IndexedDB transactions through the browser storage adapter.
    const modulePath = '/src/lib/concierge-history.ts';
    const history = await import(modulePath);
    const initial: ChatRecord = {
      id: 'branch-fixture', title: 'An original conversation', createdAt: 1000, updatedAt: 1000,
      model: 'fixture/history', homeKey: 'demo', messages: [
        { id: 'first-user', role: 'user', text: 'Check the lights.' },
        { id: 'activity', role: 'activity', text: 'Checking your home…' },
      ],
    };
    await history.saveConciergeChat(initial);
    const completed: ChatRecord = { ...initial, updatedAt: 1001, messages: [
      initial.messages[0], { ...initial.messages[1], text: 'Checking your home · done' },
      { id: 'first-answer', role: 'assistant', text: 'The lights are on.' },
    ] };
    await history.saveConciergeChat(completed);
    const appended: ChatRecord = { ...completed, updatedAt: 1002, messages: [
      ...completed.messages, { id: 'follow-up', role: 'user', text: 'Which room?' },
    ] };
    await history.saveConciergeChat(appended);
    const accepted = await history.loadConciergeChat(initial.id);
    const attempts = [];
    for (const updatedAt of [1002, 1003, 1001]) {
      const branch: ChatRecord = { ...appended, updatedAt, messages: appended.messages.map((message) =>
        message.id === 'first-answer' ? { ...message, text: 'A conflicting answer from another window.' } : message) };
      let rejected = false;
      try { await history.saveConciergeChat(branch); } catch { rejected = true; }
      attempts.push({ rejected, stored: await history.loadConciergeChat(initial.id) });
    }
    // An older snapshot of the same transcript may arrive late without erasing
    // a newer reply or turning an activity back into its pending state.
    await history.saveConciergeChat(initial);
    return { appended, accepted, attempts, afterOldPrefix: await history.loadConciergeChat(initial.id) };
  });
  expect(results.accepted).toEqual(results.appended);
  expect(results.attempts).toHaveLength(3);
  for (const attempt of results.attempts) {
    expect(attempt.rejected).toBe(true);
    expect(attempt.stored).toEqual(results.appended);
  }
  expect(results.afterOldPrefix).toEqual(results.appended);
});
