import { expect, test, type Page, type Route } from '@playwright/test';

const fakeKey = 'sk-or-v1-hjem-e2e-only-not-a-real-key';
const fakeModel = 'fake/test-tool-model';
const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

type Message = {
  role: string;
  content: string | null;
  tool_call_id?: string;
};
type ChatBody = {
  model: string;
  stream: boolean;
  messages: Message[];
  tools?: { function: { name: string } }[];
};
type ChatHandler = (
  body: ChatBody,
  index: number,
  route: Route,
) => Promise<void>;

const toolCall = (
  id: string,
  name: string,
  args: Record<string, unknown> = {},
) => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});

function completion(
  content: string | null,
  calls?: ReturnType<typeof toolCall>[],
) {
  return {
    id: 'hjem-test-completion',
    choices: [
      {
        index: 0,
        finish_reason: calls?.length ? 'tool_calls' : 'stop',
        message: {
          role: 'assistant',
          content,
          ...(calls ? { tool_calls: calls } : {}),
        },
      },
    ],
    usage: { prompt_tokens: 20, completion_tokens: 10, cost: 0 },
  };
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    headers: cors,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function mockOpenRouter(page: Page, onChat?: ChatHandler) {
  const requests: ChatBody[] = [];
  const authorization: string[] = [];
  let keyTests = 0;
  let modelLists = 0;
  // No OpenRouter traffic can leave these tests, including an unexpected endpoint.
  await page.route('https://openrouter.ai/**', async (route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: cors });
      return;
    }
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/v1/key') {
      keyTests++;
      authorization.push(route.request().headers().authorization || '');
      await json(route, {
        data: { label: 'Hjem test fixture', limit_remaining: 10 },
      });
    } else if (pathname === '/api/v1/models') {
      modelLists++;
      await json(route, {
        data: [
          {
            id: fakeModel,
            name: 'Test tool model',
            supported_parameters: ['tools'],
            architecture: { output_modalities: ['text'] },
          },
          {
            id: 'fake/no-tools',
            name: 'Text only',
            supported_parameters: ['temperature'],
            architecture: { output_modalities: ['text'] },
          },
          {
            id: 'fake/image-output',
            name: 'Images only',
            supported_parameters: ['tools'],
            architecture: { output_modalities: ['image'] },
          },
          { id: 42, name: 'Malformed ID', supported_parameters: ['tools'] },
        ],
      });
    } else if (pathname === '/api/v1/chat/completions') {
      const body = route.request().postDataJSON() as ChatBody;
      const index = requests.push(body) - 1;
      authorization.push(route.request().headers().authorization || '');
      if (onChat) await onChat(body, index, route);
      else
        await json(route, completion('This is an intercepted test response.'));
    } else {
      await route.abort('blockedbyclient');
    }
  });
  return {
    requests,
    authorization,
    get keyTests() {
      return keyTests;
    },
    get modelLists() {
      return modelLists;
    },
  };
}

async function navigate(
  page: Page,
  name: 'Overview' | 'Controls' | 'Settings' | 'Concierge',
) {
  const mobile = page.getByRole('navigation', { name: 'Mobile navigation' });
  const navigation = (await mobile.isVisible())
    ? mobile
    : page.getByRole('navigation', { name: 'Main navigation' });
  await navigation.getByRole('button', { name, exact: true }).click();
}

async function configure(page: Page) {
  await navigate(page, 'Settings');
  await page.getByLabel('OpenRouter API key', { exact: true }).fill(fakeKey);
  await page
    .getByRole('radio', { name: 'Use another model', exact: true })
    .check();
  await page.getByLabel('Custom model ID', { exact: true }).fill(fakeModel);
  await page.getByRole('button', { name: 'Save concierge settings' }).click();
  await expect(
    page.getByText('Home Concierge settings saved.', { exact: true }),
  ).toBeVisible();
}

async function startConcierge(page: Page) {
  await page.goto('/');
  await configure(page);
  await navigate(page, 'Concierge');
  await expect(
    page.getByRole('heading', { name: /^Home Concierge/, level: 1 }),
  ).toBeVisible();
}

async function send(page: Page, text: string) {
  await page
    .getByRole('textbox', { name: 'Message Home Concierge' })
    .fill(text);
  await page
    .getByRole('textbox', { name: 'Message Home Concierge' })
    .press('Enter');
}

function toolResult(body: ChatBody, id: string) {
  const message = body.messages.find(
    (item) => item.role === 'tool' && item.tool_call_id === id,
  );
  return message?.content ? JSON.parse(message.content) : undefined;
}

test('unconfigured concierge points to Settings and cannot send a message', async ({
  page,
}) => {
  const mock = await mockOpenRouter(page);
  await page.goto('/');
  await navigate(page, 'Concierge');
  await expect(
    page.getByRole('textbox', { name: 'Message Home Concierge' }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Send message', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Set up Concierge' }).click();
  await expect(
    page.getByLabel('OpenRouter API key', { exact: true }),
  ).toBeVisible();
  expect(mock.requests).toHaveLength(0);
});

test('settings check a custom model and key, and keep browser keys out of storage', async ({
  page,
}) => {
  const mock = await mockOpenRouter(page);
  await page.goto('/');
  await configure(page);
  await expect(
    page.getByLabel('OpenRouter API key', { exact: true }),
  ).toHaveValue('');
  await page.getByRole('button', { name: 'Test key', exact: true }).click();
  await expect(
    page.getByText('OpenRouter accepted your key.', { exact: true }),
  ).toBeVisible();
  expect(mock.keyTests).toBe(1);
  expect(mock.authorization).toEqual([`Bearer ${fakeKey}`]);
  await page
    .getByLabel('OpenRouter API key', { exact: true })
    .fill('replacement-not-saved');
  await expect(
    page.getByRole('button', { name: 'Test key', exact: true }),
  ).toBeDisabled();
  await page.getByLabel('OpenRouter API key', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Check model', exact: true }).click();
  await expect(
    page.getByText('Test tool model is available and supports tools.', {
      exact: true,
    }),
  ).toBeVisible();
  expect(mock.modelLists).toBe(1);
  await expect(page.locator('datalist')).toHaveCount(0);
  await page
    .getByLabel('Custom model ID', { exact: true })
    .fill('fake/no-tools');
  await page.getByRole('button', { name: 'Check model', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(
    'not found among OpenRouter’s tool-capable text models',
  );
  const storage = await page.evaluate(() =>
    JSON.stringify({
      local: { ...localStorage },
      session: { ...sessionStorage },
    }),
  );
  expect(storage).not.toContain(fakeKey);
  expect(storage).toContain(fakeModel);
  await page.reload();
  await navigate(page, 'Concierge');
  await expect(
    page.getByRole('button', { name: 'Set up Concierge' }),
  ).toBeVisible();
  await expect(
    page.getByRole('textbox', { name: 'Message Home Concierge' }),
  ).toBeDisabled();
  await navigate(page, 'Settings');
  await expect(page.getByLabel('Custom model ID', { exact: true })).toHaveValue(
    fakeModel,
  );
  await expect(
    page.getByRole('button', { name: 'Test key', exact: true }),
  ).toBeDisabled();
});

test('removing the key disables Concierge until it is configured again', async ({
  page,
}) => {
  await mockOpenRouter(page);
  await page.goto('/');
  await configure(page);
  await page.getByRole('button', { name: 'Remove key', exact: true }).click();
  await expect(
    page.getByText('API key removed.', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Test key', exact: true }),
  ).toBeDisabled();
  await navigate(page, 'Concierge');
  await expect(
    page.getByRole('textbox', { name: 'Message Home Concierge' }),
  ).toBeDisabled();
});

test('a model tool call receives real demo state before the answer is shown', async ({
  page,
}) => {
  const mock = await mockOpenRouter(page, async (_body, index, route) => {
    await json(
      route,
      index === 0
        ? completion(null, [toolCall('read-home', 'get_home_state')])
        : completion(
            'Pendant lights and Reading lamp are on in your demo home.',
          ),
    );
  });
  await startConcierge(page);
  await page
    .getByRole('button', { name: 'Which lights are on?', exact: true })
    .click();
  const log = page.getByRole('log', {
    name: 'Conversation with Home Concierge',
  });
  await expect(
    log.getByText('Pendant lights and Reading lamp are on in your demo home.', {
      exact: true,
    }),
  ).toBeVisible();
  expect(mock.requests).toHaveLength(2);
  expect(mock.requests[0].model).toBe(fakeModel);
  expect(mock.requests[0].stream).toBe(false);
  expect(mock.requests[0].messages.at(-1)?.content).toBe(
    'Which lights are on?',
  );
  expect(mock.requests[0].tools?.map((item) => item.function.name)).toContain(
    'get_home_state',
  );
  const state = toolResult(mock.requests[1], 'read-home');
  expect(state.demo).toBe(true);
  expect(state.devices).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        entity_id: 'light.living_pendant',
        name: 'Pendant lights',
        state: 'on',
        room: 'Living room',
      }),
      expect.objectContaining({ entity_id: 'light.kitchen', state: 'off' }),
    ]),
  );
  expect(JSON.stringify(mock.requests)).not.toContain(fakeKey);
  await expect(
    log.getByText('Checking your home · done', { exact: true }),
  ).toBeVisible();
  await navigate(page, 'Controls');
  await expect(
    page.getByRole('switch', { name: 'Toggle Pendant lights', exact: true }),
  ).toBeChecked();
});

test('requested device changes execute against the demo and show tool progress', async ({
  page,
}) => {
  const mock = await mockOpenRouter(page, async (_body, index, route) => {
    const replies = [
      completion(null, [
        toolCall('find-pendant', 'get_home_state', { query: 'Pendant' }),
      ]),
      completion(null, [
        toolCall('switch-pendant-off', 'control_device', {
          entity_id: 'light.living_pendant',
          action: 'turn_off',
        }),
      ]),
      completion('The pendant lights are now off in your demo home.'),
    ];
    await json(
      route,
      replies[index] ?? completion('No further changes were requested.'),
    );
  });
  await startConcierge(page);
  await send(page, 'Turn off the pendant lights.');
  const log = page.getByRole('log', {
    name: 'Conversation with Home Concierge',
  });
  await expect(
    log.getByText('The pendant lights are now off in your demo home.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    log.getByText('Adjusting a device · done', { exact: true }),
  ).toBeVisible();
  expect(mock.requests).toHaveLength(3);
  expect(toolResult(mock.requests[2], 'switch-pendant-off')).toMatchObject({
    accepted: true,
    demo: true,
    entity_id: 'light.living_pendant',
    service: 'turn_off',
  });
  await navigate(page, 'Controls');
  await expect(
    page.getByRole('switch', { name: 'Toggle Pendant lights', exact: true }),
  ).not.toBeChecked();
  await expect(
    page.getByRole('switch', { name: 'Toggle Reading lamp', exact: true }),
  ).toBeChecked();
});

test('Stop prevents an action from a late model response', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let releasedResponse = false;
  const mock = await mockOpenRouter(page, async (_body, index, route) => {
    if (index === 0)
      await json(
        route,
        completion(null, [toolCall('read-before-stop', 'get_home_state')]),
      );
    else {
      await gate;
      try {
        await json(
          route,
          completion(null, [
            toolCall('late-action', 'control_device', {
              entity_id: 'light.living_pendant',
              action: 'turn_off',
            }),
          ]),
        );
      } catch {
        /* The browser may have already cancelled the intercepted request. */
      }
      releasedResponse = true;
    }
  });
  try {
    await startConcierge(page);
    await send(page, 'Turn off the pendant lights.');
    await expect.poll(() => mock.requests.length).toBe(2);
    await page
      .getByRole('button', { name: 'Stop concierge', exact: true })
      .click();
    await expect(page.getByRole('log').getByText(/^Stopped\./)).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Send message', exact: true }),
    ).toBeVisible();
    release();
    await expect.poll(() => releasedResponse).toBe(true);
    await navigate(page, 'Controls');
    await expect(
      page.getByRole('switch', { name: 'Toggle Pendant lights', exact: true }),
    ).toBeChecked();
    await navigate(page, 'Concierge');
    await expect(
      page
        .getByRole('log')
        .getByText('Adjusting a device · done', { exact: true }),
    ).toHaveCount(0);
    expect(mock.requests).toHaveLength(2);
  } finally {
    release();
  }
});

test('an in-flight conversation survives navigation without duplicate requests', async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const mock = await mockOpenRouter(page, async (_body, _index, route) => {
    await gate;
    await json(
      route,
      completion('I am here whenever your home needs a little attention.'),
    );
  });
  try {
    await startConcierge(page);
    const composer = page.getByRole('textbox', {
      name: 'Message Home Concierge',
    });
    await composer.fill('Hello');
    await composer.press('Shift+Enter');
    await composer.press('End');
    await composer.press('!');
    await expect(composer).toHaveValue('Hello\n!');
    expect(mock.requests).toHaveLength(0);
    await composer.press('Enter');
    await expect.poll(() => mock.requests.length).toBe(1);
    await expect(
      page.getByRole('button', { name: 'New conversation', exact: true }),
    ).toBeDisabled();
    await navigate(page, 'Overview');
    await navigate(page, 'Concierge');
    await expect(
      page.getByRole('button', { name: 'Stop concierge', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('log').getByText('Hello\n!', { exact: true }),
    ).toHaveCount(1);
    release();
    await expect(
      page
        .getByRole('log')
        .getByText('I am here whenever your home needs a little attention.', {
          exact: true,
        }),
    ).toBeVisible();
    expect(mock.requests).toHaveLength(1);
    await navigate(page, 'Overview');
    await navigate(page, 'Concierge');
    await expect(
      page
        .getByRole('log')
        .getByText('I am here whenever your home needs a little attention.', {
          exact: true,
        }),
    ).toHaveCount(1);
    await page
      .getByRole('button', { name: 'New conversation', exact: true })
      .click();
    await expect(page.getByRole('log').locator('article')).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Which lights are on?', exact: true }),
    ).toBeVisible();
  } finally {
    release();
  }
});

for (const [status, message] of [
  [401, 'OpenRouter did not accept the API key. Check it in Settings.'],
  [
    402,
    'Your OpenRouter account needs credits before the concierge can reply.',
  ],
] as const) {
  test(`OpenRouter ${status} is explained without retrying or changing devices`, async ({
    page,
  }) => {
    const mock = await mockOpenRouter(page, async (_body, _index, route) => {
      await json(
        route,
        { error: { message: 'Provider detail is deliberately not shown.' } },
        status,
      );
    });
    await startConcierge(page);
    await send(page, 'Which lights are on?');
    await expect(
      page.getByRole('log').getByText(message, { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Stop concierge', exact: true }),
    ).toHaveCount(0);
    expect(mock.requests).toHaveLength(1);
    await navigate(page, 'Controls');
    await expect(
      page.getByRole('switch', { name: 'Toggle Pendant lights', exact: true }),
    ).toBeChecked();
  });
}

test('model recommendations are concise, selectable, and preserve a saved custom choice', async ({
  page,
}) => {
  const mock = await mockOpenRouter(page);
  await page.goto('/');
  await navigate(page, 'Settings');
  const picker = page.getByRole('group', {
    name: 'Concierge model',
    exact: true,
  });
  await expect(picker.getByRole('radio')).toHaveCount(4);
  await expect(
    page.getByRole('radio', { name: 'Claude Haiku 5.5', exact: true }),
  ).toBeChecked();
  await expect(page.getByLabel('Custom model ID', { exact: true })).toHaveCount(
    0,
  );
  await expect(page.locator('datalist, select')).toHaveCount(0);
  await page.getByLabel('OpenRouter API key', { exact: true }).fill(fakeKey);
  await page.getByRole('radio', { name: 'GPT-6.1 Terra', exact: true }).check();
  await page.getByRole('button', { name: 'Save concierge settings' }).click();
  await expect(
    page.getByText('Home Concierge settings saved.', { exact: true }),
  ).toBeVisible();
  await page.reload();
  await navigate(page, 'Settings');
  await expect(
    page.getByRole('radio', { name: 'GPT-6.1 Terra', exact: true }),
  ).toBeChecked();
  await configure(page);
  await navigate(page, 'Overview');
  await navigate(page, 'Settings');
  await expect(
    page.getByRole('radio', { name: 'Use another model', exact: true }),
  ).toBeChecked();
  await expect(page.getByLabel('Custom model ID', { exact: true })).toHaveValue(
    fakeModel,
  );
  await page
    .getByRole('radio', { name: 'Claude Sonnet 5.5', exact: true })
    .check();
  await page
    .getByRole('radio', { name: 'Use another model', exact: true })
    .check();
  await expect(page.getByLabel('Custom model ID', { exact: true })).toHaveValue(
    fakeModel,
  );
  expect(mock.requests).toHaveLength(0);
  expect(mock.modelLists).toBe(0);
});

test('changing the saved model starts a fresh conversation', async ({
  page,
}) => {
  const mock = await mockOpenRouter(page);
  await startConcierge(page);
  await send(page, 'Hello');
  await expect(
    page.getByRole('log').getByText('This is an intercepted test response.'),
  ).toBeVisible();
  await navigate(page, 'Settings');
  await page
    .getByRole('radio', { name: 'Claude Haiku 5.5', exact: true })
    .check();
  await page.getByRole('button', { name: 'Save concierge settings' }).click();
  await expect(
    page.getByText('Home Concierge settings saved.', { exact: true }),
  ).toBeVisible();
  await navigate(page, 'Concierge');
  await expect(
    page.getByRole('log').getByText('This is an intercepted test response.'),
  ).toHaveCount(0);
  await send(page, 'Start fresh');
  await expect.poll(() => mock.requests.length).toBe(2);
  expect(mock.requests[1].model).toBe('anthropic/claude-haiku-5.5');
  expect(
    mock.requests[1].messages
      .filter((item) => item.role === 'user')
      .map((item) => item.content),
  ).toEqual(['Start fresh']);
});
