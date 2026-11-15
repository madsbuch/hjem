export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null | { type: 'input_audio'; input_audio: { data: string; format: 'wav' } }[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /** Opaque provider state. Replay unchanged; never display it as assistant text. */
  reasoning_details?: Record<string, unknown>[];
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
  };
}

export interface AgentUsage {
  promptTokens: number;
  completionTokens: number;
  /** Null if any request's cost was not reported. */
  cost: number | null;
}

export type AgentEvent =
  | { type: 'text'; text: string }
  | {
      type: 'tool';
      name: string;
      phase: 'running' | 'done' | 'error';
      detail?: string;
    }
  | ({ type: 'usage' } & AgentUsage);

export interface ConciergeResult {
  /** Conversation only; the fresh system prompt is injected per request. */
  messages: WireMessage[];
  text: string;
  usage: AgentUsage;
}

export interface ConciergeRequest extends Record<string, unknown> {
  messages: WireMessage[];
  max_tokens: number;
  stream: false;
  usage: { include: true };
  tools?: ToolDefinition[];
  tool_choice?: 'auto';
  parallel_tool_calls?: false;
}

export interface ConciergeOptions {
  messages: WireMessage[];
  systemPrompt: string;
  tools: ToolDefinition[];
  request: (
    body: ConciergeRequest,
    signal: AbortSignal,
  ) => Promise<unknown>;
  executeTool: (
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<unknown>;
  signal: AbortSignal;
  onEvent: (event: AgentEvent) => void;
}

type ErrorCode = 'aborted' | 'request' | 'protocol' | 'limit';

/** Partial history is safe to resume: every recorded tool call has a result. */
export class ConciergeRunError extends Error implements ConciergeResult {
  readonly messages: WireMessage[];
  readonly text: string;
  readonly usage: AgentUsage;
  readonly aborted: boolean;

  constructor(
    message: string,
    readonly code: ErrorCode,
    partial: ConciergeResult,
  ) {
    super(message);
    this.name = 'ConciergeRunError';
    this.messages = copyMessages(partial.messages);
    this.text = partial.text;
    this.usage = { ...partial.usage };
    this.aborted = code === 'aborted';
  }
}

const MAX_REQUESTS = 6;
const MAX_TOOLS = 12;
const MAX_CALLS_IN_RESPONSE = 64;
const MAX_REASONING_BLOCKS = 128;
const MAX_REASONING_BYTES = 1024 * 1024;

class RunFailure extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const array = (value: unknown): value is unknown[] => Array.isArray(value);
const messageOf = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;
const errorResult = (error: string, status = 'failed') =>
  JSON.stringify({ error, status });

function copyReasoningDetails(
  value: unknown,
): Record<string, unknown>[] | undefined {
  if (value == null) return undefined;
  if (
    !array(value) ||
    value.length > MAX_REASONING_BLOCKS ||
    !value.every(record)
  ) {
    throw new RunFailure(
      'protocol',
      'The model returned malformed reasoning metadata. No actions from that response were run.',
    );
  }
  try {
    // Validate only JSON structure and size. Do not interpret, filter, reorder,
    // or expose any block's contents, signatures, or encrypted provider state.
    const json = JSON.stringify(value, (_key, part: unknown) => {
      if (
        typeof part === 'undefined' ||
        typeof part === 'function' ||
        typeof part === 'symbol' ||
        typeof part === 'bigint' ||
        (typeof part === 'number' && !Number.isFinite(part))
      )
        throw new Error('Invalid JSON');
      return part;
    });
    if (new TextEncoder().encode(json).byteLength > MAX_REASONING_BYTES)
      throw new Error('Metadata too large');
    const copy: unknown = JSON.parse(json);
    if (!array(copy) || !copy.every(record)) throw new Error('Invalid metadata');
    return copy;
  } catch {
    throw new RunFailure(
      'protocol',
      'The model returned invalid or oversized reasoning metadata. No actions from that response were run.',
    );
  }
}

function copyMessages(messages: WireMessage[]): WireMessage[] {
  return messages.map((message) => {
    const { reasoning_details: opaque, ...copy } = message;
    if (Array.isArray(copy.content) && copy.role !== 'user')
      throw new RunFailure('protocol', 'Audio input belongs only on user messages.');
    if (opaque != null && message.role !== 'assistant')
      throw new RunFailure(
        'protocol',
        'Reasoning metadata belongs only on assistant messages.',
      );
    const reasoningDetails = copyReasoningDetails(opaque);
    return {
      ...copy,
      ...(Array.isArray(copy.content)
        ? { content: copy.content.map((part) => ({ ...part, input_audio: { ...part.input_audio } })) }
        : {}),
      ...(message.tool_calls
        ? {
            tool_calls: message.tool_calls.map((call) => ({
              ...call,
              function: { ...call.function },
            })),
          }
        : {}),
      ...(reasoningDetails ? { reasoning_details: reasoningDetails } : {}),
    };
  });
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted)
    throw new RunFailure(
      'aborted',
      'Stopped. Completed actions are kept; any action already sent may still finish.',
    );
}

/** Do not wait indefinitely for a transport/tool that fails to observe abort. */
function abortable<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  checkAbort(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(
        new RunFailure(
          'aborted',
          'Stopped. Completed actions are kept; any action already sent may still finish.',
        ),
      );
    signal.addEventListener('abort', onAbort, { once: true });
    let pending: Promise<T>;
    try {
      checkAbort(signal);
      pending = operation();
    } catch (error) {
      signal.removeEventListener('abort', onAbort);
      reject(error);
      return;
    }
    Promise.resolve(pending).then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function providerError(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (record(value) && typeof value.message === 'string') return value.message;
  return 'The model provider reported an error.';
}

function contentText(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content.trim();
  if (array(content)) {
    // Only public text content is surfaced; provider reasoning fields are not read.
    return content
      .flatMap((part) =>
        record(part) &&
        typeof part.text === 'string' &&
        (part.type == null ||
          part.type === 'text' ||
          part.type === 'output_text')
          ? [part.text]
          : [],
      )
      .join('')
      .trim();
  }
  throw new RunFailure(
    'protocol',
    'The model returned malformed assistant content.',
  );
}

function parseTurn(response: unknown): {
  text: string;
  calls: ToolCall[];
  truncated: boolean;
  reasoningDetails?: Record<string, unknown>[];
} {
  if (!record(response))
    throw new RunFailure('protocol', 'The model returned an invalid response.');
  const topError = providerError(response.error);
  if (topError) throw new RunFailure('request', topError);
  const choice = array(response.choices) ? response.choices[0] : null;
  if (!record(choice))
    throw new RunFailure(
      'protocol',
      'The model returned no completion choice.',
    );
  const choiceError = providerError(choice.error);
  if (choiceError || choice.finish_reason === 'error') {
    throw new RunFailure(
      'request',
      choiceError || 'The model provider could not finish the response.',
    );
  }
  if (choice.finish_reason === 'content_filter')
    throw new RunFailure(
      'request',
      'The model provider declined this request.',
    );
  const message = choice.message;
  if (
    !record(message) ||
    (message.role != null && message.role !== 'assistant')
  ) {
    throw new RunFailure(
      'protocol',
      'The model returned no valid assistant message.',
    );
  }
  const reasoningDetails = copyReasoningDetails(message.reasoning_details);
  const text = contentText(message.content);
  if (message.tool_calls != null && !array(message.tool_calls)) {
    throw new RunFailure(
      'protocol',
      'The model returned a malformed tool-call list.',
    );
  }
  const rawCalls: unknown[] = message.tool_calls ?? [];
  if (rawCalls.length > MAX_CALLS_IN_RESPONSE)
    throw new RunFailure(
      'limit',
      'The model requested too many actions in one response. No actions from that response were run.',
    );
  const calls = rawCalls.map((call): ToolCall => {
    if (
      !record(call) ||
      typeof call.id !== 'string' ||
      !call.id.trim() ||
      call.type !== 'function' ||
      !record(call.function) ||
      typeof call.function.name !== 'string' ||
      !call.function.name.trim() ||
      typeof call.function.arguments !== 'string'
    ) {
      throw new RunFailure(
        'protocol',
        'The model returned a malformed tool call. No actions from that response were run.',
      );
    }
    return {
      id: call.id,
      type: 'function',
      function: {
        name: call.function.name,
        arguments: call.function.arguments,
      },
    };
  });
  return {
    text,
    calls,
    truncated: choice.finish_reason === 'length',
    reasoningDetails,
  };
}

function parseArguments(text: string): Record<string, unknown> {
  let args: unknown;
  try {
    args = JSON.parse(text);
  } catch {
    throw new Error('Tool arguments must be a valid JSON object.');
  }
  if (!record(args))
    throw new Error(
      'Tool arguments must be a JSON object, not an array, null, or a primitive.',
    );
  return args;
}

function canonical(value: unknown): string {
  if (array(value)) return `[${value.map(canonical).join(',')}]`;
  if (record(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('Unsupported JSON value.');
  return serialized;
}

function fingerprint(call: ToolCall): string {
  let args = call.function.arguments;
  try {
    const parsed: unknown = JSON.parse(args);
    args = canonical(parsed);
  } catch {
    /* Invalid JSON is reported as a tool result. */
  }
  return `${call.function.name}\u0000${args}`;
}

interface CompletedCall {
  fingerprint: string;
  content: string;
  failed: boolean;
}

function failedResult(content: string): boolean {
  try {
    const value: unknown = JSON.parse(content);
    if (!record(value)) return false;
    const error = value.error;
    const hasError =
      (typeof error === 'string' && error.length > 0) ||
      error === true ||
      (typeof error === 'number' && Number.isFinite(error) && error !== 0) ||
      record(error) || array(error);
    return hasError || (typeof value.status === 'string' &&
      ['failed', 'unconfirmed', 'not_executed'].includes(value.status));
  } catch {
    return false;
  }
}

function previousResults(messages: WireMessage[]): Map<string, CompletedCall> {
  const requests = new Map<string, ToolCall>();
  const completed = new Map<string, CompletedCall>();
  for (const message of messages) {
    if (message.role === 'assistant')
      for (const call of message.tool_calls || []) requests.set(call.id, call);
    if (
      message.role === 'tool' &&
      message.tool_call_id &&
      !completed.has(message.tool_call_id)
    ) {
      const call = requests.get(message.tool_call_id);
      if (call) {
        const content = typeof message.content === 'string' ? message.content : 'null';
        completed.set(call.id, {
          fingerprint: fingerprint(call),
          content,
          failed: failedResult(content),
        });
      }
    }
  }
  return completed;
}

/**
 * A bounded, sequential OpenRouter-compatible model/tool loop. Based on Tally's
 * paired transcript/error feedback and Learn Polish's final summary round and
 * partial outcomes. This layer never retries model requests or home actions.
 */
export async function runConcierge(
  options: ConciergeOptions,
): Promise<ConciergeResult> {
  let messages: WireMessage[] = [];
  const textParts: string[] = [];
  const usage: AgentUsage = {
    promptTokens: 0,
    completionTokens: 0,
    cost: null,
  };
  let allCostsKnown = true;
  let knownCost = 0;
  let toolsExecuted = 0;
  let outstanding: ToolCall[] = [];
  let executingId: string | null = null;
  let waitingForResponse = false;
  const completed = new Map<string, CompletedCall>();
  const allowed = new Set(options.tools.map((tool) => tool.function.name));
  const partial = (): ConciergeResult => ({
    messages,
    text: textParts.join('\n\n'),
    usage: { ...usage },
  });
  const emit = (event: AgentEvent) => {
    try {
      options.onEvent(event);
    } catch {
      /* UI observers cannot interrupt or replay a home action. */
    }
  };
  const appendResult = (call: ToolCall, content: string) => {
    messages.push({ role: 'tool', tool_call_id: call.id, content });
    if (!completed.has(call.id))
      completed.set(call.id, {
        fingerprint: fingerprint(call),
        content,
        failed: failedResult(content),
      });
    outstanding = outstanding.filter((candidate) => candidate.id !== call.id);
  };
  const updateUsage = (response: unknown) => {
    const reported =
      record(response) && record(response.usage) ? response.usage : {};
    const nonNegative = (value: unknown): value is number =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0;
    if (nonNegative(reported.prompt_tokens))
      usage.promptTokens += Math.floor(reported.prompt_tokens);
    if (nonNegative(reported.completion_tokens))
      usage.completionTokens += Math.floor(reported.completion_tokens);
    if (nonNegative(reported.cost)) knownCost += reported.cost;
    else allCostsKnown = false;
    usage.cost = allCostsKnown ? knownCost : null;
    emit({ type: 'usage', ...usage });
  };

  try {
    messages = copyMessages(
      options.messages.filter((message) => message.role !== 'system'),
    );
    for (const [id, result] of previousResults(messages))
      completed.set(id, result);
    checkAbort(options.signal);
    for (let round = 0; round < MAX_REQUESTS; round++) {
      checkAbort(options.signal);
      const offerTools =
        round < MAX_REQUESTS - 1 &&
        toolsExecuted < MAX_TOOLS &&
        options.tools.length > 0;
      const summaryOnly =
        round === MAX_REQUESTS - 1 || toolsExecuted >= MAX_TOOLS;
      const prompt =
        options.systemPrompt +
        (summaryOnly
          ? '\n\nNo more tools are available in this run. Summarize only the results already obtained. Clearly distinguish completed, failed, and unconfirmed actions; do not claim further actions were performed.'
          : '');
      const body: ConciergeRequest = {
        messages: [
          { role: 'system', content: prompt },
          ...copyMessages(messages),
        ],
        // Reasoning models share this allowance between reasoning and output.
        max_tokens: 8192,
        stream: false,
        usage: { include: true },
        ...(offerTools
          ? {
              tools: options.tools,
              tool_choice: 'auto',
              parallel_tool_calls: false,
            }
          : {}),
      };
      waitingForResponse = true;
      const response = await abortable(
        () => options.request(body, options.signal),
        options.signal,
      );
      checkAbort(options.signal);
      updateUsage(response);
      waitingForResponse = false;
      const turn = parseTurn(response);
      checkAbort(options.signal);

      // One result per ID in each assistant batch. Repeated IDs never execute twice.
      const unique = new Map<string, ToolCall>();
      const conflicts = new Set<string>();
      for (const call of turn.calls) {
        const first = unique.get(call.id);
        if (first && fingerprint(first) !== fingerprint(call))
          conflicts.add(call.id);
        if (!first) unique.set(call.id, call);
      }
      const calls = [...unique.values()];
      if (turn.text) {
        textParts.push(turn.text);
        emit({ type: 'text', text: turn.text });
      }
      const reasoning = turn.reasoningDetails
        ? { reasoning_details: turn.reasoningDetails }
        : {};
      if (calls.length) {
        messages.push({
          role: 'assistant',
          content: turn.text || null,
          tool_calls: calls,
          ...reasoning,
        });
        outstanding = [...calls];
      } else if (turn.text || turn.reasoningDetails?.length) {
        messages.push({
          role: 'assistant',
          content: turn.text || null,
          ...reasoning,
        });
      }
      checkAbort(options.signal);
      if (turn.truncated)
        throw new RunFailure(
          'limit',
          'The model reached its response limit. Any tool calls in that unfinished response were not run.',
        );
      if (!calls.length) {
        if (!textParts.length)
          throw new RunFailure(
            'protocol',
            'The model returned an empty answer. Try rephrasing your request.',
          );
        return partial();
      }

      for (const call of calls) {
        checkAbort(options.signal);
        const name = call.function.name;
        const cached = completed.get(call.id);
        if (
          conflicts.has(call.id) ||
          (cached && cached.fingerprint !== fingerprint(call))
        ) {
          const detail =
            'This tool-call ID was reused with different arguments. No new action was run for this ID.';
          appendResult(call, errorResult(detail, 'not_executed'));
          emit({ type: 'tool', name, phase: 'error', detail });
          continue;
        }
        if (cached) {
          appendResult(call, cached.content);
          emit({
            type: 'tool',
            name,
            phase: cached.failed ? 'error' : 'done',
            detail: 'Existing result reused; the action was not run again.',
          });
          continue;
        }
        if (!offerTools || toolsExecuted >= MAX_TOOLS) {
          const detail =
            'The action limit was reached. This action was not run; summarize the available results.';
          appendResult(call, errorResult(detail, 'not_executed'));
          emit({ type: 'tool', name, phase: 'error', detail });
          continue;
        }
        try {
          if (!allowed.has(name))
            throw new Error(
              `Unknown tool: ${name}. Choose one of the tools supplied with the request.`,
            );
          const args = parseArguments(call.function.arguments);
          checkAbort(options.signal);
          emit({ type: 'tool', name, phase: 'running' });
          checkAbort(options.signal);
          executingId = call.id;
          toolsExecuted++;
          const result = await abortable(
            () => options.executeTool(name, args, options.signal),
            options.signal,
          );
          let content: string;
          try {
            content =
              typeof result === 'string'
                ? result
                : JSON.stringify(result ?? null);
            if (typeof content !== 'string')
              throw new Error('Unserializable tool result');
          } catch {
            throw new Error(
              'The tool finished, but its result could not be read. An action may have completed; inspect the current state before trying again.',
            );
          }
          appendResult(call, content);
          executingId = null;
          checkAbort(options.signal);
          emit({
            type: 'tool',
            name,
            phase: failedResult(content) ? 'error' : 'done',
          });
        } catch (error) {
          if (
            options.signal.aborted ||
            (error instanceof RunFailure && error.code === 'aborted')
          )
            throw error;
          const detail = messageOf(
            error,
            'The tool failed. Check the current state before trying again.',
          );
          appendResult(call, errorResult(detail));
          executingId = null;
          emit({ type: 'tool', name, phase: 'error', detail });
        }
      }
      checkAbort(options.signal);
      if (!offerTools)
        throw new RunFailure(
          'limit',
          'The model requested more actions after its tool budget ended. No additional actions were run.',
        );
    }
    throw new RunFailure(
      'limit',
      'The concierge reached its limit. Completed actions are preserved; please ask a shorter follow-up.',
    );
  } catch (error) {
    if (waitingForResponse) usage.cost = null;
    const aborted =
      options.signal.aborted ||
      (error instanceof RunFailure && error.code === 'aborted');
    const failure = aborted
      ? new RunFailure(
          'aborted',
          'Stopped. Completed actions are kept; any action already sent may still finish.',
        )
      : error instanceof RunFailure
        ? error
        : new RunFailure(
            'request',
            messageOf(error, 'The concierge request failed.'),
          );
    // Complete the transcript even if stopped between tools. Never infer that an
    // in-flight home action was rolled back, and never replay it during recovery.
    for (const call of [...outstanding]) {
      const inFlight = call.id === executingId;
      const detail = inFlight
        ? 'Execution was interrupted after this action started. Its outcome is unconfirmed; check current state before any new action.'
        : 'This action was not run because the concierge stopped before executing it.';
      appendResult(
        call,
        errorResult(detail, inFlight ? 'unconfirmed' : 'not_executed'),
      );
      emit({ type: 'tool', name: call.function.name, phase: 'error', detail });
    }
    throw new ConciergeRunError(failure.message, failure.code, partial());
  }
}
