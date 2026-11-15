import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  enabled: false,
  invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  receive: (_event: unknown) => {},
}));
vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => native.enabled,
  invoke: native.invoke,
  Channel: class {
    constructor(callback: (event: unknown) => void) { native.receive = callback; }
  },
}));

const encoder = new TextEncoder();
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const delta = (value: unknown, finish: string | null = null) => ({
  id: 'voice-1', choices: [{ index: 0, delta: value, finish_reason: finish }],
});
const done = 'data: [DONE]\n\n';
const answer = event(delta({ audio: { data: 'AAABAA==', transcript: 'Hello ' } })) +
  event(delta({ audio: { data: 'AgADAA==', transcript: 'there.' } }, 'stop')) +
  event({ ...delta({ content: '', role: 'assistant' }, 'stop'), usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5, cost: 0.01 } }) + done;
// Model the public audio guide's partial audio deltas and the SDK's nullable
// usage.cost, rather than requiring every frame to contain a complete audio blob.
// https://openrouter.ai/docs/guides/overview/multimodal/audio
// https://github.com/OpenRouterTeam/typescript-sdk/blob/main/src/models/chatusage.ts
const partialAudioAnswer = ': OPENROUTER PROCESSING\n\n' +
  event(delta({ role: 'assistant', content: null, audio: { id: 'audio-1', data: '', transcript: '' } })) +
  event({ choices: [{ delta: { audio: { transcript: 'Hello there.' } } }] }) +
  event(delta({ audio: { data: 'AAAB' } })) +
  event(delta({ audio: { data: 'AA==' } })) +
  event(delta({}, 'stop')) +
  event(delta({ audio: { id: 'audio-1', expires_at: 1794770000 }, tool_calls: [] }, 'stop')) +
  event({ ...delta({}, 'stop'), usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5,
    cost: null, completion_tokens_details: { audio_tokens: 2, reasoning_tokens: null } } }) + done;
const voiceMessage = { role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'UklGRg==', format: 'wav' } }] };
const request = { messages: [voiceMessage], max_tokens: 4096 };
const response = (text: string) => new Response(text, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });

beforeEach(() => {
  vi.resetModules();
  native.enabled = false;
  native.invoke.mockReset();
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('voice SSE completion boundaries', () => {
  it.each([
    ['nullable usage.cost', event(delta({ content: 'Done' }, 'stop')) + event({ choices: [], usage: { cost: null } })],
    ['omitted single choice index', event({ choices: [{ delta: { content: 'Done' }, finish_reason: 'stop' }] })],
    ['empty audio delta', event(delta({ content: 'Done', audio: { data: '', transcript: '' } }, 'stop'))],
    ['[DONE] without any finish_reason (OpenRouter gpt-audio)', event(delta({ audio: { transcript: 'Done' } }))],
    ['finish chunk without a delta', event(delta({ content: 'Done' })) + event({ choices: [{ index: 0, finish_reason: 'stop' }] })],
    ['late transcript after finish_reason', event(delta({ content: 'Do' }, 'stop')) + event(delta({ content: 'ne' }))],
    ['event without choices', event({ id: 'x' }) + event(delta({ content: 'Done' }))],
    ['changing chunk ids', event({ id: 'a', choices: [{ delta: { content: 'Do' } }] }) + event({ id: 'b', choices: [{ delta: { content: 'ne' } }] })],
    ['audio metadata trailer', event(delta({ content: 'Done' }, 'stop')) + event(delta({ audio: { expires_at: 1794770000 } }))],
  ])('accepts the compatible response variant: %s', async (_name, text) => {
    const { VoiceCompletionStream } = await import('./concierge-voice-api');
    const stream = new VoiceCompletionStream(vi.fn());
    stream.push(encoder.encode(text + done));
    expect(stream.finish()).toMatchObject({ choices: [{ message: { content: 'Done' } }] });
  });

  it('accepts partial audio, metadata-only trailers, empty fields and an unavailable usage cost', async () => {
    const { VoiceCompletionStream } = await import('./concierge-voice-api');
    const audio = vi.fn();
    const stream = new VoiceCompletionStream(audio);
    for (const byte of encoder.encode(partialAudioAnswer)) stream.push(Uint8Array.of(byte));
    expect(stream.finish()).toMatchObject({ choices: [{ finish_reason: 'stop', message: { content: 'Hello there.' } }],
      usage: { cost: null, prompt_tokens: 2, completion_tokens: 3 } });
    expect(audio.mock.calls).toEqual([['AAAB'], ['AA==']]);
  });

  it('infers tool_calls when the stream ends without a finish_reason', async () => {
    const { VoiceCompletionStream } = await import('./concierge-voice-api');
    const stream = new VoiceCompletionStream(vi.fn());
    stream.push(encoder.encode(event(delta({ tool_calls: [
      { index: 0, id: 'call', type: 'function', function: { name: 'home_status', arguments: '{}' } },
    ] })) + done));
    expect(stream.finish()).toMatchObject({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'call' }] } }] });
  });

  it('reassembles base64 quartets split across audio deltas without dropping bytes', async () => {
    const { VoiceCompletionStream } = await import('./concierge-voice-api');
    const audio = vi.fn();
    const stream = new VoiceCompletionStream(audio);
    for (const data of ['A', 'AA', 'BA', 'A=', '=']) stream.push(encoder.encode(event(delta({ audio: { data } }))));
    stream.push(encoder.encode(event(delta({ audio: { transcript: 'Done' } }, 'stop')) + done));
    expect(stream.finish()).toMatchObject({ choices: [{ message: { content: 'Done' } }] });
    expect(audio.mock.calls.map(([value]) => atob(value)).join('')).toBe(atob('AAABAA=='));
  });

  it('treats optional null fields as absent while assembling complete tool calls', async () => {
    const { VoiceCompletionStream } = await import('./concierge-voice-api');
    const stream = new VoiceCompletionStream(vi.fn());
    stream.push(encoder.encode(event(delta({ audio: { data: null, transcript: null }, tool_calls: [
      { index: 0, id: 'first', type: 'function', function: { name: 'home_status', arguments: '' } },
    ] })) + event({ id: null, choices: [{ index: 0, finish_reason: 'tool_calls', delta: { content: null, tool_calls: [
      { index: 0, id: null, type: null, function: { name: null, arguments: '{}' } },
    ] } }] }) + done));
    expect(stream.finish()).toMatchObject({ choices: [{ message: { tool_calls: [
      { id: 'first', type: 'function', function: { name: 'home_status', arguments: '{}' } },
    ] } }] });
  });

  it('merges split UTF-8, multiline SSE, audio transcripts and repeated terminal usage chunks', async () => {
    const { VoiceCompletionStream } = await import('./concierge-voice-api');
    const audio = vi.fn();
    const stream = new VoiceCompletionStream(audio);
    const data = encoder.encode(': OPENROUTER PROCESSING\r\n\r\n' +
      'event: message\ndata: {"id":"voice-1",\ndata: "choices":[{"index":0,"delta":{"role":"assistant","content":"Hæ"},"finish_reason":null}]}\n\n' + answer);
    for (let index = 0; index < data.length; index += 7) stream.push(data.slice(index, index + 7));
    expect(stream.finish()).toEqual({ id: 'voice-1', model: 'openai/gpt-audio',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Hello there.' } }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5, cost: 0.01 } });
    expect(audio.mock.calls).toEqual([['AAABAA=='], ['AgADAA==']]);
  });

  it('assembles interleaved tool calls only after complete valid arguments and a terminal stream', async () => {
    const { VoiceCompletionStream } = await import('./concierge-voice-api');
    const stream = new VoiceCompletionStream(vi.fn());
    stream.push(encoder.encode(event(delta({ tool_calls: [
      { index: 0, id: 'first', type: 'function', function: { name: 'home_', arguments: '{"scene":' } },
      { index: 1, id: 'second', type: 'function', function: { name: 'home_status', arguments: '{' } },
    ] }))));
    expect(() => stream.finish()).toThrow('missing stream completion');
    stream.push(encoder.encode(event(delta({ tool_calls: [
      { index: 1, function: { arguments: '}' } },
      { index: 0, function: { name: 'scene', arguments: '"calm"}' } },
    ] }, 'tool_calls')) + done));
    expect(stream.finish()).toMatchObject({ choices: [{ finish_reason: 'tool_calls', message: {
      content: null, tool_calls: [
        { id: 'first', type: 'function', function: { name: 'home_scene', arguments: '{"scene":"calm"}' } },
        { id: 'second', type: 'function', function: { name: 'home_status', arguments: '{}' } },
      ],
    } }] });
  });

  it.each([
    event(delta({ content: 'No done' }, 'stop')),
    event(delta({ content: 'Truncated' }, 'length')) + done,
    event(delta({ audio: { data: 'not base64' } }, 'stop')) + done,
    event(delta({ audio: { data: 'AA', transcript: 'Truncated audio' } }, 'stop')) + done,
    event(delta({ audio: { data: 'AA==A', transcript: 'Bad padding' } }, 'stop')) + done,
    event(delta({ audio: { data: 123, transcript: 'Invalid audio type' } }, 'stop')) + done,
    event(delta({ audio: { data: null, transcript: 123 } }, 'stop')) + done,
    event(delta({ tool_calls: [{ index: 0, id: 'call', type: 'function', function: { name: 'home_status', arguments: '{' } }] }, 'tool_calls')) + done,
    event(delta({ tool_calls: [{ index: 1, id: 'call', type: 'function', function: { name: 'home_status', arguments: '{}' } }] }, 'tool_calls')) + done,
    event(delta({ tool_calls: [{ index: 0, id: 'call', type: 'function', function: { name: 'home_status', arguments: '[]' } }] }, 'tool_calls')) + done,
    event(delta({ content: 'Done' }, 'stop')) + event(delta({ tool_calls: [{ index: 0, id: 'late' }] })) + done,
    event(delta({ content: 'Done' }, 'stop')) + done + event(delta({ content: 'After done' })),
    event({ choices: [{ index: 0, delta: {} }, { index: 1, delta: {} }] }) + done,
    event(delta({ content: 'Hello' }, 'stop')) + event({ choices: [], usage: { cost: -1 } }) + done,
    event(delta({ content: 'Hello' }, 'stop')) + 'data: [DONE]',
  ])('rejects malformed/incomplete streams before returning executable actions %#', async (text) => {
    const { VoiceCompletionStream } = await import('./concierge-voice-api');
    const stream = new VoiceCompletionStream(vi.fn());
    expect(() => { stream.push(encoder.encode(text)); stream.finish(); }).toThrow();
  });

  it('rejects invalid UTF-8, oversized streams and remote errors without exposing remote text', async () => {
    const { VoiceCompletionStream } = await import('./concierge-voice-api');
    expect(() => new VoiceCompletionStream(vi.fn()).push(Uint8Array.from([255]))).toThrow('unreadable');
    expect(() => new VoiceCompletionStream(vi.fn()).push(new Uint8Array(24 * 1024 * 1024 + 1))).toThrow('too large');
    expect(() => new VoiceCompletionStream(vi.fn()).push(encoder.encode(event({ error: { message: 'private-provider-content' } })))).toThrow('could not finish');
  });

  it('identifies the failed field or stage without exposing provider content', async () => {
    const { VoiceCompletionStream } = await import('./concierge-voice-api');
    for (const [text, detail] of [
      [event(delta({ audio: { data: 'private-provider-content' } })), 'invalid audio.data base64'],
      [event({ choices: [], usage: { cost: 'private-provider-content' } }), 'invalid usage.cost'],
      [event(delta({ content: 'private-provider-content' }, 'stop')), 'missing stream completion'],
    ]) {
      let failure: unknown;
      try { const stream = new VoiceCompletionStream(vi.fn()); stream.push(encoder.encode(text)); stream.finish(); }
      catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      if (!(failure instanceof Error)) throw new Error('Expected a diagnostic error');
      expect(failure.message).toContain(detail);
      expect(failure.message).not.toContain('private-provider-content');
    }
  });
});

describe('voice transports', () => {
  it.each([
    ['', 'missing stream completion'],
    [event({ error: { message: 'private-provider-content' } }) + done, 'could not finish'],
  ])('never returns complete-looking actions from an unfinished or failed response %#', async (ending, expected) => {
    const action = event(delta({ tool_calls: [
      { index: 0, id: 'call', type: 'function', function: { name: 'home_scene', arguments: '{"scene":"calm"}' } },
    ] }, 'tool_calls'));
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(response(action + ending)));
    await (await import('./concierge-api')).saveConciergeSettings('test-key', 'model');
    const voice = await import('./concierge-voice-api');
    await expect(voice.requestConciergeVoice(request, new AbortController().signal, vi.fn())).rejects.toThrow(expected);
  });

  it('uses the saved preview key, fixed voice model and PCM stream without changing the text model', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response(answer));
    vi.stubGlobal('fetch', fetchMock);
    const api = await import('./concierge-api');
    await api.saveConciergeSettings('test-key', 'chosen/text-model');
    const voice = await import('./concierge-voice-api');
    const audio = vi.fn();
    const result = await voice.requestConciergeVoice({ ...request, model: 'injected', stream: false, audio: { voice: 'injected' },
      provider: { api_key: 'other' }, plugins: [{ id: 'web' }], max_tokens: 90000 }, new AbortController().signal, audio);
    expect(result).toMatchObject({ choices: [{ message: { content: 'Hello there.' } }] });
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(options?.headers).toMatchObject({ Authorization: 'Bearer test-key' });
    expect(options?.redirect).toBe('error');
    const body = JSON.parse(String(options?.body));
    expect(body).toEqual({ ...request, max_tokens: 8192, model: 'openai/gpt-audio', stream: true,
      modalities: ['text', 'audio'], audio: { voice: 'alloy', format: 'pcm16' } });
    expect(await api.getConciergeSettings()).toEqual({ hasApiKey: true, model: 'chosen/text-model' });
    expect(audio).toHaveBeenCalledTimes(2);
  });

  it('requires a key but not a chosen text model', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response(answer));
    vi.stubGlobal('fetch', fetchMock);
    const voice = await import('./concierge-voice-api');
    await expect(voice.requestConciergeVoice(request, new AbortController().signal, vi.fn())).rejects.toThrow('API key');
    await (await import('./concierge-api')).saveConciergeSettings('test-key', '');
    await expect(voice.requestConciergeVoice(request, new AbortController().signal, vi.fn())).resolves.toBeDefined();
  });

  it.each([
    { messages: [{ role: 'system', content: voiceMessage.content }] },
    { messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: '%%%%', format: 'wav' } }] }] },
    { messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'UklGRg==', format: 'mp3' } }] }] },
    { messages: Array.from({ length: 5 }, () => voiceMessage) },
    { messages: [{ role: 'user', content: 'x'.repeat(8 * 1024 * 1024) }] },
  ])('bounds and validates voice input before dispatch %#', async (body) => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    await expect((await import('./concierge-voice-api')).requestConciergeVoice(body, new AbortController().signal, vi.fn())).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('parses identical native bytes without requesting native credentials or fetching in the webview', async () => {
    native.enabled = true;
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    native.invoke.mockImplementation(async (command, args) => {
      expect(command).toBe('concierge_voice_request');
      expect(args?.body).toMatchObject({ model: 'openai/gpt-audio', stream: true });
      const data = encoder.encode(partialAudioAnswer);
      for (let index = 0; index < data.length; index += 9) native.receive({ type: 'chunk', data: [...data.slice(index, index + 9)] });
      native.receive({ type: 'done' });
      return null;
    });
    const voice = await import('./concierge-voice-api');
    const audio = vi.fn();
    await expect(voice.requestConciergeVoice(request, new AbortController().signal, audio)).resolves.toMatchObject({
      choices: [{ message: { content: 'Hello there.' } }], usage: { cost: null },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(native.invoke).toHaveBeenCalledTimes(1);
    expect(audio).toHaveBeenCalledTimes(2);
  });

  it('aborts native work and ignores all late audio and actions', async () => {
    native.enabled = true;
    native.invoke.mockImplementation((command) => command === 'concierge_cancel' ? Promise.resolve(null) : new Promise(() => {}));
    const controller = new AbortController();
    const audio = vi.fn();
    const pending = (await import('./concierge-voice-api')).requestConciergeVoice(request, controller.signal, audio);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    native.receive({ type: 'chunk', data: [...encoder.encode(answer)] });
    native.receive({ type: 'done' });
    expect(audio).not.toHaveBeenCalled();
    expect(native.invoke.mock.calls.filter(([command]) => command === 'concierge_cancel')).toHaveLength(1);
  });

  it('times out native streams, including a missing terminal IPC event', async () => {
    vi.useFakeTimers();
    native.enabled = true;
    native.invoke.mockResolvedValue(null);
    const pending = (await import('./concierge-voice-api')).requestConciergeVoice(request, new AbortController().signal, vi.fn());
    const rejection = expect(pending).rejects.toThrow('too long');
    await vi.advanceTimersByTimeAsync(90_000);
    await rejection;
    expect(native.invoke.mock.calls.some(([command]) => command === 'concierge_cancel')).toBe(true);
  });

  it('rejects malformed native chunk payloads and cancels the native request', async () => {
    native.enabled = true;
    native.invoke.mockImplementation(async (command) => {
      if (command === 'concierge_voice_request') native.receive({ type: 'chunk', data: [999] });
      return null;
    });
    await expect((await import('./concierge-voice-api')).requestConciergeVoice(request, new AbortController().signal, vi.fn())).rejects.toThrow('unreadable');
    expect(native.invoke.mock.calls.some(([command]) => command === 'concierge_cancel')).toBe(true);
  });

  it('sanitizes HTTP errors and rejects successful JSON responses instead of treating them as streams', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('private-provider-content', { status: 402 }))
      .mockResolvedValueOnce(new Response('{}', { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await (await import('./concierge-api')).saveConciergeSettings('test-key', 'model');
    const voice = await import('./concierge-voice-api');
    await expect(voice.requestConciergeVoice(request, new AbortController().signal, vi.fn())).rejects.toThrow('needs credits');
    await expect(voice.requestConciergeVoice(request, new AbortController().signal, vi.fn())).rejects.toThrow('unreadable voice stream');
  });
});
