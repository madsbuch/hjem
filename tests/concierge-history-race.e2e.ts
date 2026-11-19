import { expect, test, type Page } from '@playwright/test';
import { openSettings } from './helpers/settings';
import { localHomeAssistant } from './helpers/home-assistant-server';
import { nativeStorage } from './helpers/native-storage';

const model = 'fixture/history-race';
const oldQuestion = 'Remember this conversation from the first home.';
const oldAnswer = 'An earlier answer from the first home.';
const savedChat = (homeKey: string) => ({
  id: 'first-home-chat', title: oldQuestion, createdAt: 1700000000000,
  updatedAt: 1700000000001, model, homeKey,
  messages: [
    { id: 'old-user', role: 'user' as const, text: oldQuestion },
    { id: 'old-assistant', role: 'assistant' as const, text: oldAnswer },
  ],
});

async function navigate(page: Page, name: 'Settings' | 'Concierge') {
  await page.locator('nav:visible').first().waitFor();
  await page.locator('nav:visible').getByRole('button', { name, exact: true }).click();
}

async function openConnection(page: Page) {
  await openSettings(page, 'Home Assistant');
  await page.locator('main').getByRole('button', { name: 'Manage connection', exact: true }).click();
  await expect(page.locator('.connection-dialog')).toBeVisible();
}

async function nativeConcierge(page: Page, delayedCommand = '') {
  let waiting = false;
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const requests: unknown[] = [];
  await page.exposeFunction('__waitForChatStartup', () => { waiting = true; return gate; });
  await page.exposeFunction('__historyRaceReply', (body: unknown) => {
    requests.push(body);
    return { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'A fresh answer for the current home.' } }],
      usage: { prompt_tokens: 2, completion_tokens: 2, cost: 0 } };
  });
  await page.addInitScript((commandToDelay) => {
    const target = window as typeof window & {
      __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
      __waitForChatStartup: () => Promise<void>;
      __historyRaceReply: (body: unknown) => Promise<unknown>;
    };
    const invoke = target.__TAURI_INTERNALS__.invoke;
    target.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
      if (command === commandToDelay) await target.__waitForChatStartup();
      if (command === 'concierge_request') return target.__historyRaceReply(args.body);
      if (command === 'concierge_cancel') return null;
      return invoke(command, args);
    };
  }, delayedCommand);
  return { requests, release, get waiting() { return waiting; } };
}

for (const delayedCommand of ['concierge_list_chats', 'concierge_load_chat']) {
  test(`switching homes during delayed ${delayedCommand} opens an editable current-home chat`, async ({ page }) => {
    const server = await localHomeAssistant();
    try {
      const storage = await nativeStorage(page, {
        serverUrl: server.url, connection: { serverUrl: server.url, token: 'local-fixture-token' },
      });
      storage.setConciergeSettings({ hasApiKey: true, model });
      storage.setChats([savedChat(server.url)]);
      const fixture = await nativeConcierge(page, delayedCommand);
      await page.goto('/');
      await expect.poll(() => fixture.waiting).toBe(true);
      await openConnection(page);
      await page.locator('.connection-dialog').getByRole('button', { name: /^(Disconnect and explore demo|Cancel and return to demo)$/ }).click();
      await navigate(page, 'Concierge');
      const composer = page.getByRole('textbox', { name: 'Message Home Concierge', exact: true });
      await expect(composer).toBeDisabled();
      fixture.release();
      await expect(composer).toBeEnabled();
      const log = page.getByRole('log', { name: 'Conversation with Home Concierge' });
      await expect(log).toHaveText('');
      await expect(page.getByText('This chat belongs to another home.', { exact: false })).toHaveCount(0);
      await composer.fill('Hello from the demo home.');
      await composer.press('Enter');
      await expect(log).toContainText('A fresh answer for the current home.');
      expect(fixture.requests).toHaveLength(1);
      expect(JSON.stringify(fixture.requests[0])).not.toContain(oldQuestion);
      await expect.poll(() => storage.chats.find((chat) => chat.title === 'Hello from the demo home.')?.homeKey).toBe('demo');
      expect(storage.chats.find((chat) => chat.id === 'first-home-chat')?.messages).toEqual(savedChat(server.url).messages);
      expect(server.failure).toBeUndefined();
    } finally { await server.close(); }
  });
}

test('changing between connected live homes leaves a fresh editable chat in the second home', async ({ page }) => {
  const first = await localHomeAssistant();
  const second = await localHomeAssistant();
  try {
    const storage = await nativeStorage(page, {
      serverUrl: first.url, connection: { serverUrl: first.url, token: 'local-fixture-token' },
    });
    storage.setConciergeSettings({ hasApiKey: true, model });
    storage.setChats([savedChat(first.url)]);
    const fixture = await nativeConcierge(page);
    await page.goto('/');
    await navigate(page, 'Concierge');
    const log = page.getByRole('log', { name: 'Conversation with Home Concierge' });
    await expect(log).toContainText(oldAnswer);
    await expect.poll(() => first.commands.some((command) => command.type === 'get_states')).toBe(true);
    await openConnection(page);
    await page.getByLabel('Home Assistant address', { exact: true }).fill(second.url);
    await page.getByLabel('Long-lived access token', { exact: true }).fill('local-fixture-token');
    await page.getByRole('button', { name: 'Connect Home Assistant', exact: true }).click();
    await expect.poll(() => storage.snapshot.connection?.serverUrl).toBe(second.url);
    await expect(page.locator('.connection-dialog')).not.toBeVisible();
    await navigate(page, 'Concierge');
    const composer = page.getByRole('textbox', { name: 'Message Home Concierge', exact: true });
    await expect(composer).toBeEnabled();
    await expect(log).toHaveText('');
    await composer.fill('Hello from the second live home.');
    await composer.press('Enter');
    await expect(log).toContainText('A fresh answer for the current home.');
    expect(fixture.requests).toHaveLength(1);
    expect(JSON.stringify(fixture.requests[0])).not.toContain(oldQuestion);
    await expect.poll(() => storage.chats.find((chat) => chat.title === 'Hello from the second live home.')?.homeKey).toBe(second.url);
    expect(storage.chats.find((chat) => chat.id === 'first-home-chat')?.messages).toEqual(savedChat(first.url).messages);
    expect(first.failure).toBeUndefined();
    expect(second.failure).toBeUndefined();
  } finally { await first.close(); await second.close(); }
});
