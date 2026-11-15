import { describe, expect, it, vi } from 'vitest';
import {
  ConciergeRunError,
  runConcierge,
  type AgentEvent,
  type ConciergeOptions,
  type ToolCall,
  type ToolDefinition,
  type WireMessage,
} from './concierge-agent';

const definitions: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read_home',
      description: 'Read current devices',
      parameters: { type: 'object' },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_device',
      description: 'Adjust one device',
      parameters: { type: 'object' },
    },
  },
];
const call = (id: string, name = 'read_home', args = '{}'): ToolCall => ({
  id,
  type: 'function',
  function: { name, arguments: args },
});
const completion = (
  content: unknown,
  calls?: unknown[],
  usage?: unknown,
  finish = calls?.length ? 'tool_calls' : 'stop',
) => ({
  choices: [
    {
      message: {
        role: 'assistant',
        content,
        ...(calls ? { tool_calls: calls } : {}),
      },
      finish_reason: finish,
    },
  ],
  ...(usage ? { usage } : {}),
});

function setup() {
  const controller = new AbortController();
  const events: AgentEvent[] = [];
  const request = vi
    .fn<ConciergeOptions['request']>()
    .mockResolvedValue(completion('Your home is ready.'));
  const executeTool = vi
    .fn<ConciergeOptions['executeTool']>()
    .mockResolvedValue({ ok: true });
  const options: ConciergeOptions = {
    messages: [{ role: 'user', content: 'Make the living room comfortable.' }],
    systemPrompt: 'You are the Home Concierge.',
    tools: definitions,
    request,
    executeTool,
    signal: controller.signal,
    onEvent: (event) => events.push(event),
  };
  return { controller, events, request, executeTool, options };
}

async function failure(
  promise: ReturnType<typeof runConcierge>,
): Promise<ConciergeRunError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ConciergeRunError);
    if (error instanceof ConciergeRunError) return error;
    throw error;
  }
  throw new Error('Expected the concierge run to fail.');
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('Missing test value.');
  return value;
}
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function object(value: unknown): Record<string, unknown> {
  if (!isObject(value))
    throw new Error('Expected an object.');
  return value;
}
function toolResult(message: WireMessage): Record<string, unknown> {
  if (typeof message.content !== 'string') throw new Error('Expected tool result content.');
  const parsed: unknown = JSON.parse(message.content);
  return object(parsed);
}

function expectPaired(messages: WireMessage[]) {
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role !== 'assistant' || !message.tool_calls?.length) continue;
    const results = messages.slice(
      index + 1,
      index + 1 + message.tool_calls.length,
    );
    expect(results.map((result) => result.role)).toEqual(
      message.tool_calls.map(() => 'tool'),
    );
    expect(results.map((result) => result.tool_call_id)).toEqual(
      message.tool_calls.map((tool) => tool.id),
    );
  }
}

describe('Home Concierge model/tool protocol', () => {
  it('uses one fresh system prompt, reports only public content, and leaves the caller history untouched', async () => {
    const { options, request, events, executeTool } = setup();
    options.messages.unshift({ role: 'system', content: 'Old prompt' });
    const before = structuredClone(options.messages);
    request.mockResolvedValue({
      ...completion([
        { type: 'text', text: 'Your lights ' },
        { type: 'reasoning', text: 'Hidden thoughts' },
        { type: 'text', text: 'are off.' },
      ]),
      reasoning: 'Private provider reasoning',
    });
    const result = await runConcierge(options);
    expect(result.text).toBe('Your lights are off.');
    expect(result.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
    ]);
    expect(options.messages).toEqual(before);
    expect(request.mock.calls[0][0]).toMatchObject({
      max_tokens: 8192,
      stream: false,
      parallel_tool_calls: false,
    });
    expect(request.mock.calls[0][0]).not.toHaveProperty('model');
    expect(
      request.mock.calls[0][0].messages.filter(
        (message) => message.role === 'system',
      ),
    ).toEqual([{ role: 'system', content: options.systemPrompt }]);
    expect(events.filter((event) => event.type === 'text')).toEqual([
      { type: 'text', text: 'Your lights are off.' },
    ]);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('executes tools sequentially and sends paired results into the next model request', async () => {
    const { options, request, executeTool, events } = setup();
    request
      .mockResolvedValueOnce(
        completion(
          'I’ll check the room.',
          [call('read'), call('set', 'set_device', '{"temperature":21}')],
          { prompt_tokens: 20, completion_tokens: 8, cost: 0.001 },
        ),
      )
      .mockResolvedValueOnce(
        completion('The temperature is set to 21°C.', undefined, {
          prompt_tokens: 30,
          completion_tokens: 12,
          cost: 0.002,
        }),
      );
    let release: (value: unknown) => void = () => { throw new Error('Missing pending tool.'); };
    executeTool
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValueOnce({ temperature: 21 });
    const running = runConcierge(options);
    await flush();
    expect(executeTool).toHaveBeenCalledTimes(1);
    release({ temperature: 19 });
    const result = await running;
    expect(executeTool.mock.calls.map(([name]) => name)).toEqual([
      'read_home',
      'set_device',
    ]);
    expect(executeTool.mock.calls[1][1]).toEqual({ temperature: 21 });
    expect(executeTool.mock.calls[1][2]).toBe(options.signal);
    expect(result.text).toBe(
      'I’ll check the room.\n\nThe temperature is set to 21°C.',
    );
    expect(result.usage).toEqual({
      promptTokens: 50,
      completionTokens: 20,
      cost: 0.003,
    });
    expectPaired(result.messages);
    expectPaired(request.mock.calls[1][0].messages);
    expect(request.mock.calls[0][0].messages).toHaveLength(2);
    expect(
      events
        .filter((event) => event.type === 'tool')
        .map((event) => event.phase),
    ).toEqual(['running', 'done', 'running', 'done']);
  });

  it('returns unknown tools and invalid JSON arguments as model-readable results', async () => {
    const { options, request, executeTool } = setup();
    request
      .mockResolvedValueOnce(
        completion(null, [
          call('unknown', 'delete_everything'),
          call('broken', 'set_device', '{broken'),
          call('array', 'set_device', '[]'),
          call('null', 'set_device', 'null'),
        ]),
      )
      .mockResolvedValueOnce(completion('I could not perform those actions.'));
    const result = await runConcierge(options);
    expect(executeTool).not.toHaveBeenCalled();
    const toolResults = result.messages
      .filter((message) => message.role === 'tool')
      .map(toolResult);
    expect(toolResults[0].error).toContain('Unknown tool');
    expect(
      toolResults
        .slice(1)
        .every((result) => typeof result.error === 'string' && result.error.includes('JSON object')),
    ).toBe(true);
    expectPaired(result.messages);
  });

  it('preserves a failed action result and lets the model explain it', async () => {
    const { options, request, executeTool, events } = setup();
    request
      .mockResolvedValueOnce(
        completion(null, [
          call('set', 'set_device', '{"entity_id":"light.sofa"}'),
        ]),
      )
      .mockResolvedValueOnce(completion('The lamp is unavailable.'));
    executeTool.mockRejectedValueOnce(
      new Error('Home Assistant says the lamp is unavailable.'),
    );
    const result = await runConcierge(options);
    expect(result.messages[2]).toMatchObject({
      role: 'tool',
      tool_call_id: 'set',
    });
    expect(toolResult(result.messages[2]).error).toContain(
      'unavailable',
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool',
        phase: 'error',
        name: 'set_device',
      }),
    );
    expect(executeTool).toHaveBeenCalledTimes(1);
    expectPaired(result.messages);
  });

  it('preserves completed actions when the next request fails and avoids replay during recovery', async () => {
    const first = setup();
    first.request
      .mockResolvedValueOnce(
        completion(null, [call('set', 'set_device', '{"on":true}')]),
      )
      .mockRejectedValueOnce(new Error('Network interrupted'));
    const error = await failure(runConcierge(first.options));
    expect(error.code).toBe('request');
    expect(error.message).toBe('Network interrupted');
    expect(first.request).toHaveBeenCalledTimes(2);
    expect(first.executeTool).toHaveBeenCalledTimes(1);
    expectPaired(error.messages);

    const next = setup();
    next.options.messages = error.messages;
    next.request
      .mockResolvedValueOnce(
        completion(null, [call('set', 'set_device', '{"on":true}')]),
      )
      .mockResolvedValueOnce(completion('The light is on.'));
    const recovered = await runConcierge(next.options);
    expect(next.executeTool).not.toHaveBeenCalled();
    expectPaired(recovered.messages);
    expect(next.events).toContainEqual(
      expect.objectContaining({
        type: 'tool',
        detail: 'Existing result reused; the action was not run again.',
      }),
    );
  });

  it('deduplicates identical call IDs within and across rounds', async () => {
    const { options, request, executeTool } = setup();
    request
      .mockResolvedValueOnce(
        completion(null, [
          call('same', 'set_device', '{"a":1,"b":2}'),
          call('same', 'set_device', '{"b":2,"a":1}'),
        ]),
      )
      .mockResolvedValueOnce(
        completion(null, [call('same', 'set_device', '{"a":1,"b":2}')]),
      )
      .mockResolvedValueOnce(completion('Done.'));
    const result = await runConcierge(options);
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(result.messages[1].tool_calls).toHaveLength(1);
    expectPaired(result.messages);
  });

  it('never executes ambiguous duplicate IDs with different arguments', async () => {
    const { options, request, executeTool } = setup();
    request
      .mockResolvedValueOnce(
        completion(null, [
          call('same', 'set_device', '{"on":true}'),
          call('same', 'set_device', '{"on":false}'),
        ]),
      )
      .mockResolvedValueOnce(completion('The conflicting action was not run.'));
    const result = await runConcierge(options);
    expect(executeTool).not.toHaveBeenCalled();
    expect(result.messages[2].content).toContain(
      'reused with different arguments',
    );
    expectPaired(result.messages);
  });

  it('blocks a changed request that reuses a completed ID', async () => {
    const { options, request, executeTool } = setup();
    request
      .mockResolvedValueOnce(
        completion(null, [call('same', 'set_device', '{"on":true}')]),
      )
      .mockResolvedValueOnce(
        completion(null, [call('same', 'set_device', '{"on":false}')]),
      )
      .mockResolvedValueOnce(completion('Only the first action ran.'));
    const result = await runConcierge(options);
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(
      result.messages.filter((message) => message.role === 'tool').at(-1)
        ?.content,
    ).toContain('reused with different arguments');
  });

  it('does not replay a failed call ID and preserves its error status', async () => {
    const { options, request, executeTool, events } = setup();
    request
      .mockResolvedValueOnce(completion(null, [call('failed', 'set_device')]))
      .mockResolvedValueOnce(completion(null, [call('failed', 'set_device')]))
      .mockResolvedValueOnce(
        completion('The action failed; please check the device.'),
      );
    executeTool.mockRejectedValueOnce(new Error('Action result unknown'));
    await runConcierge(options);
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(
      events.filter((event) => event.type === 'tool').at(-1),
    ).toMatchObject({ phase: 'error' });
  });

  it('withholds tools on request six so the model must summarize', async () => {
    const { options, request, executeTool } = setup();
    request.mockImplementation(async () =>
      request.mock.calls.length < 6
        ? completion(null, [call(`read_${request.mock.calls.length}`)])
        : completion('All five checks are complete.'),
    );
    const result = await runConcierge(options);
    expect(request).toHaveBeenCalledTimes(6);
    expect(executeTool).toHaveBeenCalledTimes(5);
    expect(request.mock.calls[5][0]).not.toHaveProperty('tools');
    expect(request.mock.calls[5][0]).not.toHaveProperty('tool_choice');
    expect(
      request.mock.calls[5][0].messages[0].content,
    ).toContain('No more tools');
    expect(result.text).toContain('five checks');
  });

  it('cannot exceed six requests even when the model ignores tool withdrawal', async () => {
    const { options, request, executeTool } = setup();
    request.mockImplementation(async () =>
      completion(null, [call(`read_${request.mock.calls.length}`)]),
    );
    const error = await failure(runConcierge(options));
    expect(error.code).toBe('limit');
    expect(request).toHaveBeenCalledTimes(6);
    expect(executeTool).toHaveBeenCalledTimes(5);
    expect(error.messages.at(-1)?.content).toContain('not_executed');
    expectPaired(error.messages);
  });

  it('executes at most twelve tools, records skipped results, then requests a summary', async () => {
    const { options, request, executeTool } = setup();
    request
      .mockResolvedValueOnce(
        completion(
          null,
          Array.from({ length: 14 }, (_, index) =>
            call(`action_${index}`, 'set_device', JSON.stringify({ index })),
          ),
        ),
      )
      .mockResolvedValueOnce(
        completion('Twelve actions completed. Two were not run.'),
      );
    const result = await runConcierge(options);
    expect(executeTool).toHaveBeenCalledTimes(12);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][0]).not.toHaveProperty('tools');
    expect(
      result.messages.filter((message) => message.role === 'tool'),
    ).toHaveLength(14);
    expectPaired(result.messages);
  });

  it('tolerates an empty final answer only after public text in this run', async () => {
    const first = setup();
    first.request
      .mockResolvedValueOnce(
        completion('The room is ready; I am checking its final status.', [
          call('read'),
        ]),
      )
      .mockResolvedValueOnce(completion(null));
    const result = await runConcierge(first.options);
    expect(result.text).toContain('The room is ready');
    expect(result.messages.at(-1)?.role).toBe('tool');
    const second = setup();
    second.options.messages.unshift({
      role: 'assistant',
      content: 'An answer from an earlier turn.',
    });
    second.request
      .mockResolvedValueOnce(completion(null, [call('read')]))
      .mockResolvedValueOnce(completion(null));
    const error = await failure(runConcierge(second.options));
    expect(error.code).toBe('protocol');
    expect(error.message).toContain('empty answer');
  });

  it('keeps usage totals while leaving a partially unknown price unknown', async () => {
    const { options, request } = setup();
    request
      .mockResolvedValueOnce(
        completion(null, [call('read')], {
          prompt_tokens: 10,
          completion_tokens: -2,
        }),
      )
      .mockResolvedValueOnce(
        completion('Ready.', undefined, {
          prompt_tokens: 20,
          completion_tokens: 5,
          cost: 0.001,
        }),
      );
    const result = await runConcierge(options);
    expect(result.usage).toEqual({
      promptTokens: 30,
      completionTokens: 5,
      cost: null,
    });
  });

  it('does not execute calls in a token-truncated response and retains its partial text', async () => {
    const { options, request, executeTool } = setup();
    request.mockResolvedValueOnce(
      completion(
        'I can adjust the lights.',
        [call('set', 'set_device')],
        undefined,
        'length',
      ),
    );
    const error = await failure(runConcierge(options));
    expect(error.code).toBe('limit');
    expect(error.text).toBe('I can adjust the lights.');
    expect(executeTool).not.toHaveBeenCalled();
    expectPaired(error.messages);
  });

  it.each([
    ['non-object response', null, 'protocol'],
    ['missing choices', {}, 'protocol'],
    ['empty choices', { choices: [] }, 'protocol'],
    ['missing message', { choices: [{}] }, 'protocol'],
    [
      'embedded provider error',
      { error: { message: 'Quota exhausted' } },
      'request',
    ],
    [
      'embedded choice error',
      { choices: [{ error: { message: 'Provider failed' } }] },
      'request',
    ],
    [
      'error finish reason',
      {
        choices: [
          { finish_reason: 'error', message: { content: 'Ignore this' } },
        ],
      },
      'request',
    ],
    ['malformed content', completion(123), 'protocol'],
    [
      'malformed tool',
      completion(null, [
        {
          id: 'bad',
          type: 'function',
          function: { name: 'set_device', arguments: {} },
        },
      ]),
      'protocol',
    ],
  ])(
    'rejects %s without executing any tool',
    async (_label, response, code) => {
      const { options, request, executeTool } = setup();
      request.mockResolvedValueOnce(response);
      const error = await failure(runConcierge(options));
      expect(error.code).toBe(code);
      expect(executeTool).not.toHaveBeenCalled();
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
});

describe('Home Concierge cancellation', () => {
  it('never starts a request after cancellation', async () => {
    const { options, controller, request, executeTool } = setup();
    controller.abort();
    const error = await failure(runConcierge(options));
    expect(error.aborted).toBe(true);
    expect(error.messages).toEqual(options.messages);
    expect(request).not.toHaveBeenCalled();
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('stops even when the request transport ignores its signal', async () => {
    const { options, controller, request, executeTool } = setup();
    let release: (response: unknown) => void = () => { throw new Error('Missing pending request.'); };
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const interrupted = failure(runConcierge(options));
    await flush();
    controller.abort();
    const error = await interrupted;
    expect(error.code).toBe('aborted');
    release(completion(null, [call('late', 'set_device')]));
    await flush();
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('checks cancellation again after announcing a tool and pairs all unstarted calls', async () => {
    const { options, controller, request, executeTool } = setup();
    request.mockResolvedValueOnce(
      completion(null, [
        call('first', 'set_device'),
        call('second', 'set_device'),
      ]),
    );
    options.onEvent = (event) => {
      if (event.type === 'tool' && event.phase === 'running')
        controller.abort();
    };
    const error = await failure(runConcierge(options));
    expect(error.aborted).toBe(true);
    expect(executeTool).not.toHaveBeenCalled();
    expect(
      error.messages
        .filter((message) => message.role === 'tool')
        .every((message) => typeof message.content === 'string' && message.content.includes('not_executed')),
    ).toBe(true);
    expectPaired(error.messages);
  });

  it('keeps an in-flight outcome unconfirmed, never runs following tools, and ignores late completion', async () => {
    const { options, controller, request, executeTool, events } = setup();
    request.mockResolvedValueOnce(
      completion(null, [
        call('first', 'set_device'),
        call('second', 'set_device'),
      ]),
    );
    let release: (value: unknown) => void = () => { throw new Error('Missing pending tool.'); };
    executeTool.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const interrupted = failure(runConcierge(options));
    await flush();
    expect(executeTool).toHaveBeenCalledTimes(1);
    controller.abort();
    const error = await interrupted;
    const results = error.messages.filter((message) => message.role === 'tool');
    expect(toolResult(results[0]).status).toBe('unconfirmed');
    expect(toolResult(results[1]).status).toBe('not_executed');
    expectPaired(error.messages);
    const eventCount = events.length;
    release({ ok: true });
    await flush();
    expect(events).toHaveLength(eventCount);
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
    const next = setup();
    next.options.messages = error.messages;
    next.request
      .mockResolvedValueOnce(completion(null, [call('first', 'set_device')]))
      .mockResolvedValueOnce(
        completion('Please check the current device state.'),
      );
    await runConcierge(next.options);
    expect(next.executeTool).not.toHaveBeenCalled();
  });

  it('keeps a completed action when stopped between tools', async () => {
    const { options, controller, request, executeTool } = setup();
    request.mockResolvedValueOnce(
      completion(null, [
        call('first', 'set_device'),
        call('second', 'set_device'),
      ]),
    );
    options.onEvent = (event) => {
      if (event.type === 'tool' && event.phase === 'done') controller.abort();
    };
    const error = await failure(runConcierge(options));
    expect(executeTool).toHaveBeenCalledTimes(1);
    const results = error.messages.filter((message) => message.role === 'tool');
    expect(toolResult(results[0])).toEqual({ ok: true });
    expect(toolResult(results[1]).status).toBe('not_executed');
    expectPaired(error.messages);
  });
});

describe('Home Concierge opaque reasoning context', () => {
  const opaqueBlocks = () => [
    {
      type: 'reasoning.encrypted',
      data: 'opaque-payload-A',
      signature: 'opaque-signature-A',
      format: 'provider-v1',
      index: 0,
    },
    {
      type: 'reasoning.text',
      text: 'PRIVATE_TEST_SENTINEL',
      signature: 'opaque-signature-B',
      index: 1,
      future_provider_field: { sequence: ['opaque-C', { version: 2 }] },
    },
  ];
  const withDetails = (
    response: ReturnType<typeof completion>,
    details: unknown,
  ) => ({
    ...response,
    choices: response.choices.map((choice) => ({
      ...choice,
      message: { ...choice.message, reasoning_details: details },
    })),
  });

  it('replays signatures and encrypted blocks unchanged through tool rounds without UI events', async () => {
    const { options, request, events } = setup();
    const details = opaqueBlocks();
    const original = structuredClone(details);
    const finalDetails = [
      {
        type: 'reasoning.encrypted',
        data: 'opaque-final-D',
        signature: 'opaque-signature-D',
      },
    ];
    request
      .mockResolvedValueOnce(
        withDetails(completion(null, [call('read')]), details),
      )
      .mockResolvedValueOnce(
        withDetails(completion('The room is ready.'), finalDetails),
      );
    const result = await runConcierge(options);
    const sentAssistant = required(request.mock.calls[1][0].messages
      .find((message) => message.role === 'assistant'));
    expect(sentAssistant.reasoning_details).toEqual(original);
    expect(result.messages[1].reasoning_details).toEqual(original);
    expect(result.messages.at(-1)?.reasoning_details).toEqual(finalDetails);
    expect(sentAssistant.reasoning_details).not.toBe(
      result.messages[1].reasoning_details,
    );
    details[0].signature = 'changed-after-response';
    expect(result.messages[1].reasoning_details).toEqual(original);
    expect(events.filter((event) => event.type === 'text')).toEqual([
      { type: 'text', text: 'The room is ready.' },
    ]);
    expect(JSON.stringify(events)).not.toMatch(
      /PRIVATE_TEST_SENTINEL|opaque-payload|opaque-signature|reasoning_details/,
    );
    expectPaired(result.messages);
  });

  it('deep-copies reasoning in supplied history without interpreting unknown provider fields', async () => {
    const { options, request } = setup();
    const details = opaqueBlocks();
    options.messages.unshift({
      role: 'assistant',
      content: 'An earlier answer.',
      reasoning_details: details,
    });
    const original = structuredClone(options.messages);
    request.mockImplementationOnce(async (body) => {
      const sent = required(body.messages.find(
        (message) => message.role === 'assistant',
      ));
      expect(sent.reasoning_details).toEqual(details);
      const sequence: unknown = object(required(sent.reasoning_details)[1].future_provider_field).sequence;
      if (!Array.isArray(sequence)) throw new Error('Expected an opaque sequence.');
      sequence[0] = 'transport-mutated-copy';
      return completion('A new answer.');
    });
    const result = await runConcierge(options);
    expect(options.messages).toEqual(original);
    expect(result.messages[0].reasoning_details).toEqual(details);
    expect(result.messages[0].reasoning_details).not.toBe(details);
  });

  it('retains opaque context in a partial error and replays it when that history is resumed', async () => {
    const first = setup();
    const details = opaqueBlocks();
    first.request
      .mockResolvedValueOnce(
        withDetails(completion(null, [call('read')]), details),
      )
      .mockRejectedValueOnce(new Error('Provider connection interrupted'));
    const error = await failure(runConcierge(first.options));
    expect(error.messages[1].reasoning_details).toEqual(details);
    expectPaired(error.messages);
    expect(JSON.stringify(first.events)).not.toContain('PRIVATE_TEST_SENTINEL');
    const next = setup();
    next.options.messages = error.messages;
    await runConcierge(next.options);
    const assistant = required(next.request.mock.calls[0][0].messages
      .find((message) => message.role === 'assistant'));
    expect(assistant.reasoning_details).toEqual(details);
    expect(next.executeTool).not.toHaveBeenCalled();
  });

  it('preserves a reasoning-only truncated response as partial context without displaying it', async () => {
    const { options, request, events, executeTool } = setup();
    const details = opaqueBlocks();
    request.mockResolvedValueOnce(
      withDetails(completion(null, undefined, undefined, 'length'), details),
    );
    const error = await failure(runConcierge(options));
    expect(error.code).toBe('limit');
    expect(error.text).toBe('');
    expect(error.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: null,
      reasoning_details: details,
    });
    expect(events.some((event) => event.type === 'text')).toBe(false);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it.each([
    ['record instead of array', { signature: 'PRIVATE_TEST_SENTINEL' }],
    ['string instead of array', 'PRIVATE_TEST_SENTINEL'],
    ['null block', [null]],
    ['nested array block', [[]]],
    ['primitive block', [7]],
    [
      'too many blocks',
      Array.from({ length: 129 }, () => ({
        type: 'reasoning.encrypted',
        data: 'opaque',
      })),
    ],
    [
      'oversized metadata',
      [{ type: 'reasoning.encrypted', data: 'x'.repeat(1024 * 1024) }],
    ],
    ['non-JSON nested value', [{ signature: 'opaque', invalid: undefined }]],
  ])(
    'rejects %s before executing any requested action',
    async (_label, details) => {
      const { options, request, executeTool, events } = setup();
      request.mockResolvedValueOnce(
        withDetails(
          completion('Public text', [call('set', 'set_device')]),
          details,
        ),
      );
      const error = await failure(runConcierge(options));
      expect(error.code).toBe('protocol');
      expect(error.message).toContain('reasoning metadata');
      expect(error.message).not.toContain('PRIVATE_TEST_SENTINEL');
      expect(executeTool).not.toHaveBeenCalled();
      expect(events.some((event) => event.type === 'text')).toBe(false);
    },
  );

  it('rejects reasoning metadata attached to a non-assistant history message', async () => {
    const { options, request, executeTool } = setup();
    options.messages[0].reasoning_details = opaqueBlocks();
    const error = await failure(runConcierge(options));
    expect(error.code).toBe('protocol');
    expect(request).not.toHaveBeenCalled();
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('accepts a null provider field as absent and retains an empty array unchanged', async () => {
    const absent = setup();
    absent.request.mockResolvedValueOnce(
      withDetails(completion('Ready.'), null),
    );
    const omitted = await runConcierge(absent.options);
    expect(omitted.messages.at(-1)).not.toHaveProperty('reasoning_details');
    const empty = setup();
    empty.request.mockResolvedValueOnce(withDetails(completion('Ready.'), []));
    const included = await runConcierge(empty.options);
    expect(included.messages.at(-1)?.reasoning_details).toEqual([]);
  });
});
