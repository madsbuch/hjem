import { expect, test, type Page, type Route } from '@playwright/test';
import { isRecord } from '../src/lib/home-assistant-protocol';
import { openSettings } from './helpers/settings';

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
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
  const mobile = page.getByRole('navigation', { name: 'Mobile navigation' });
  const nav = await mobile.isVisible() ? mobile : page.getByRole('navigation', { name: 'Main navigation' });
  await nav.getByRole('button', { name, exact: true }).click();
}
async function openSetup(page: Page, configure = true) {
  await page.goto('/');
  if (configure) {
    await openSettings(page, 'Concierge');
    await page.getByLabel('OpenRouter API key', { exact: true }).fill('fixture-only-key');
    await page.getByRole('radio', { name: 'Use another model', exact: true }).check();
    await page.getByLabel('Custom model ID', { exact: true }).fill('fixture/setup-model');
    await page.getByRole('button', { name: 'Save concierge settings' }).click();
    await expect(page.getByText('Home Concierge settings saved.', { exact: true })).toBeVisible();
  }
  await openSettings(page, 'Home setup');
  await page.getByRole('button', { name: 'Open home setup' }).click();
  await expect(page.getByRole('heading', { name: 'Home setup.' })).toBeVisible();
}
/** On narrow screens one side shows at a time. */
async function show(page: Page, side: 'Concierge' | 'Your home') {
  const toggle = page.getByRole('group', { name: 'Show' });
  if (await toggle.isVisible()) await toggle.getByRole('button', { name: side, exact: true }).click();
}
async function provider(page: Page, handler: (body: unknown, round: number, route: Route) => Promise<void>) {
  let round = 0;
  await page.route('https://openrouter.ai/**', async (route) => {
    if (route.request().method() === 'OPTIONS') await route.fulfill({ status: 204, headers: cors });
    else if (route.request().url().endsWith('/chat/completions')) await handler(route.request().postDataJSON(), round++, route);
    else await route.abort('blockedbyclient');
  });
}

test('Home setup shows the home beside Concierge, in plain language', async ({ page }) => {
  await openSetup(page, false);
  const home = page.getByRole('region', { name: 'Your home' });
  const wide = !await page.getByRole('group', { name: 'Show' }).isVisible();
  if (wide) {
    // One third Concierge, two thirds home.
    const chat = await page.getByRole('region', { name: 'Home Concierge' }).boundingBox();
    const state = await home.boundingBox();
    if (!chat || !state) throw new Error('Both sides should be visible');
    expect(state.width).toBeGreaterThan(chat.width * 1.3);
    expect(chat.width).toBeGreaterThanOrEqual(300);
    expect(chat.x + chat.width).toBeLessThanOrEqual(state.x);
  } else {
    await expect(home).toBeHidden();
    await show(page, 'Your home');
    await expect(page.getByRole('region', { name: 'Home Concierge' })).toBeHidden();
  }
  await expect(home.getByRole('heading', { name: 'Demo home' })).toBeVisible();
  const kitchen = home.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Kitchen', exact: true }) });
  await expect(kitchen).toContainText('0 of 3 active');
  await expect(kitchen.getByRole('listitem').filter({ hasText: 'Coffee machine' })).toContainText('Off');
  await expect(home.getByRole('listitem').filter({ hasText: 'Pendant lights' }).last()).toContainText('On · 70%');

  await home.getByRole('tab', { name: /Automations/ }).click();
  const welcome = home.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Welcome home light' }) });
  await expect(welcome).toContainText('Front door opens');
  await expect(welcome).toContainText('It is after sunset');
  await expect(welcome).toContainText('Turn on Reading lamp (60%)');
  await expect(welcome).toContainText('Has not run yet');
  await expect(home.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Wake up gently' }) })).toContainText('Paused');
  await welcome.getByText('Configuration').click();
  await expect(welcome.locator('pre')).toContainText('"binary_sensor.front_door"');

  await home.getByRole('tab', { name: /Scripts/ }).click();
  await expect(home.getByRole('listitem').filter({ hasText: 'Movie time' }).first()).toContainText('Activate Cosy evening');
  await home.getByRole('tab', { name: /Moods/ }).click();
  await expect(home.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Cosy evening' }) })).toContainText('Reading lamp: on, 35%');
  await home.getByRole('tab', { name: /Helpers/ }).click();
  await expect(home.getByRole('listitem').filter({ hasText: 'Wake-up time' })).toContainText('06:45');
  await home.getByRole('tab', { name: /Changes/ }).click();
  await expect(home.getByText('What Concierge changes in your home is listed here')).toBeVisible();

  // No page-level scrolling: each side scrolls on its own.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('Asking about something in the home starts a message to Concierge', async ({ page }) => {
  await openSetup(page);
  await show(page, 'Your home');
  const home = page.getByRole('region', { name: 'Your home' });
  await home.getByRole('tab', { name: /Automations/ }).click();
  await home.getByRole('button', { name: 'Ask Concierge about Wake up gently' }).click();
  const message = page.getByLabel('Message Home Concierge');
  await expect(message).toBeVisible();
  await expect(message).toHaveValue('About the automation “Wake up gently”: ');
  await expect(message).toBeFocused();
});

test('Concierge sets up an automation from a remote, the home shows it, and it can be undone', async ({ page }) => {
  let saved: Record<string, unknown> = {};
  await provider(page, async (body, round, route) => {
    if (round === 0) return reply(route, [tool('list_home_structure')]);
    if (round === 1) return reply(route, [tool('list_routines')]);
    if (round === 2) return reply(route, [tool('list_device_triggers', { device_id: 'demo_remote_scene' })]);
    if (round === 3) {
      const triggers = result(body, 'list_device_triggers');
      expect(triggers.event_entities).toEqual([expect.objectContaining({ entity_id: 'event.remote_scene_action', event_types: ['single', 'double', 'hold'] })]);
      // A guessed lamp is refused with a reason the model can act on.
      return reply(route, [tool('save_automation', {
        name: 'Scene button toggles the kitchen lights',
        triggers: [{ trigger: 'state', entity_id: 'event.remote_scene_action', attribute: 'event_type', to: 'single' }],
        actions: [{ action: 'light.toggle', target: { entity_id: 'light.kitchen_ceiling' } }],
      })]);
    }
    if (round === 4) {
      expect(String(result(body, 'save_automation').error)).toContain('light.kitchen_ceiling');
      return reply(route, [{ ...tool('save_automation', {
        name: 'Scene button toggles the kitchen lights',
        description: 'A single press on the scene button toggles the kitchen lights.',
        triggers: [{ trigger: 'state', entity_id: 'event.remote_scene_action', attribute: 'event_type', to: 'single' }],
        actions: [{ action: 'light.toggle', target: { entity_id: 'light.kitchen' } }],
      }), id: 'save_again' }]);
    }
    saved = result(body, 'save_again');
    return reply(route, [], 'A single press on the scene button now toggles the kitchen lights.');
  });
  await openSetup(page);
  await show(page, 'Concierge');
  await page.getByLabel('Message Home Concierge').fill('Make the scene button toggle the kitchen lights');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByText('A single press on the scene button now toggles the kitchen lights.')).toBeVisible();
  expect(saved).toMatchObject({ changed: true, demo: true, entity_id: 'automation.scene_button_toggles_the_kitchen_lights' });
  await expect(page.getByText('Saving your automation · done')).toBeVisible();

  // The home follows Concierge to what it changed.
  await show(page, 'Your home');
  const home = page.getByRole('region', { name: 'Your home' });
  await expect(home.getByRole('tab', { name: /Automations/ })).toHaveAttribute('aria-selected', 'true');
  const card = home.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Scene button toggles the kitchen lights' }) });
  await expect(card).toContainText('Scene button: single');
  await expect(card).toContainText('Toggle Kitchen lights');
  await expect(card).toHaveClass(/is-changed/);
  await expect(home.getByRole('tab', { name: /Automations/ })).toContainText('4');

  await home.getByRole('tab', { name: /Changes/ }).click();
  await home.getByRole('button', { name: 'Undo Created automation Scene button toggles the kitchen lights' }).click();
  await expect(page.getByText('Undone: Created automation Scene button toggles the kitchen lights.')).toBeVisible();
  await home.getByRole('tab', { name: /Automations/ }).click();
  await expect(card).toHaveCount(0);
  await expect(home.getByRole('tab', { name: /Automations/ })).toContainText('3');
});

test('Concierge pauses, runs, and deletes routines through the conversation', async ({ page }) => {
  const done: Record<string, unknown>[] = [];
  await provider(page, async (body, round, route) => {
    if (round === 0) return reply(route, [tool('list_routines')]);
    if (round === 1) return reply(route, [tool('set_automation_enabled', { entity_id: 'automation.wake_up_gently', enabled: true })]);
    if (round === 2) {
      done.push(result(body, 'set_automation_enabled'));
      return reply(route, [tool('run_routine', { entity_id: 'script.movie_time' })]);
    }
    if (round === 3) {
      done.push(result(body, 'run_routine'));
      // Deleting needs a read first.
      return reply(route, [tool('delete_routine', { entity_id: 'automation.welcome_home_light' })]);
    }
    if (round === 4) {
      expect(String(result(body, 'delete_routine').error)).toContain('inspect_routine');
      return reply(route, [tool('inspect_routine', { entity_id: 'automation.welcome_home_light' })]);
    }
    if (round === 5) return reply(route, [{ ...tool('delete_routine', { entity_id: 'automation.welcome_home_light' }), id: 'delete_again' }]);
    done.push(result(body, 'delete_again'));
    return reply(route, [], 'Wake up gently is on, Movie time has run, and Welcome home light is gone.');
  });
  await openSetup(page);
  await show(page, 'Concierge');
  await page.getByLabel('Message Home Concierge').fill('Turn on wake up gently, run movie time, and delete the welcome light');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByText('Welcome home light is gone.')).toBeVisible();
  expect(done).toEqual([
    expect.objectContaining({ changed: true, enabled: true }),
    expect.objectContaining({ accepted: true, verified: false }),
    expect.objectContaining({ changed: true }),
  ]);

  await show(page, 'Your home');
  const home = page.getByRole('region', { name: 'Your home' });
  await home.getByRole('tab', { name: /Automations/ }).click();
  await expect(home.getByRole('heading', { name: 'Welcome home light' })).toHaveCount(0);
  await expect(home.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Wake up gently' }) })).not.toContainText('Paused');
  await home.getByRole('tab', { name: /Scripts/ }).click();
  await expect(home.getByRole('listitem').filter({ hasText: 'Movie time' }).first()).toContainText('Ran just now');
  await home.getByRole('tab', { name: /Changes/ }).click();
  await expect(home.getByRole('button', { name: /^Undo / })).toHaveCount(2);
  await home.getByRole('button', { name: 'Undo Deleted automation Welcome home light' }).click();
  await home.getByRole('tab', { name: /Automations/ }).click();
  await expect(home.getByRole('heading', { name: 'Welcome home light' })).toBeVisible();
});
