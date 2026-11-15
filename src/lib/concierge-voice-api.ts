import { Channel, invoke, isTauri } from '@tauri-apps/api/core';
import { streamConciergeVoiceInBrowser } from './concierge-api';

export const CONCIERGE_VOICE_MODEL = 'openai/gpt-audio';
export const CONCIERGE_VOICE_SAMPLE_RATE = 24_000;
const REQUEST_LIMIT = 8 * 1024 * 1024;
const STREAM_LIMIT = 24 * 1024 * 1024;
const AUDIO_LIMIT = 2 * 1024 * 1024;
const PROTOCOL_ERROR = 'The voice reply was unreadable, so nothing was changed. Please try again.';
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const array = (value: unknown): value is unknown[] => Array.isArray(value);
const base64 = (value: unknown): value is string => typeof value === 'string' &&
  value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
const stopped = () => new DOMException('Stopped.', 'AbortError');
// Only locally defined field/stage names belong in diagnostics. Never include
// provider payloads: they can contain the recording, transcript or tool arguments.
const protocolError = (detail: string) => new Error(`${PROTOCOL_ERROR} (${detail})`);

function voiceBody(body: Record<string, unknown>): Record<string, unknown> {
  if (!array(body.messages) || body.messages.length === 0 || body.messages.length > 200)
    throw new Error('This voice conversation is too long. Start a new conversation.');
  let audioCount = 0;
  for (const message of body.messages) {
    if (!record(message) || !['system', 'user', 'assistant', 'tool'].includes(String(message.role)))
      throw new Error('The voice conversation contains an invalid message.');
    if (message.reasoning_details !== undefined && (message.role !== 'assistant' ||
        !array(message.reasoning_details) || !message.reasoning_details.every(record)))
      throw new Error('The voice conversation contains invalid model context.');
    const calls = message.tool_calls;
    if (calls !== undefined && (message.role !== 'assistant' || !array(calls) || calls.length > 64 ||
        !calls.every((call) => record(call) && call.type === 'function' && typeof call.id === 'string' && call.id.length > 0 &&
          record(call.function) && typeof call.function.name === 'string' && call.function.name.length > 0 && typeof call.function.arguments === 'string')))
      throw new Error('The voice conversation contains invalid tool calls.');
    if (message.role === 'tool' && (typeof message.tool_call_id !== 'string' || !message.tool_call_id))
      throw new Error('A voice tool result is missing its request ID.');
    if (typeof message.content === 'string' || (message.role === 'assistant' &&
        array(calls) && calls.length > 0 && message.content === null)) continue;
    if (message.role !== 'user' || !array(message.content) || message.content.length === 0 || message.content.length > 2)
      throw new Error('Voice accepts text or WAV audio messages only.');
    let messageAudio = 0;
    for (const part of message.content) {
      if (!record(part)) throw new Error('Voice accepts text or WAV audio messages only.');
      if (part.type === 'text' && typeof part.text === 'string') continue;
      if (part.type !== 'input_audio' || !record(part.input_audio) || part.input_audio.format !== 'wav' ||
          !base64(part.input_audio.data) || part.input_audio.data.length > AUDIO_LIMIT)
        throw new Error('Voice accepts WAV recordings of up to 30 seconds.');
      messageAudio++;
    }
    if (messageAudio !== 1) throw new Error('Each voice message needs one WAV recording.');
    audioCount += messageAudio;
  }
  if (audioCount > 4) throw new Error('This voice conversation has too many recordings. Start a new conversation.');
  const next: Record<string, unknown> = {};
  for (const key of ['messages', 'tools', 'tool_choice', 'parallel_tool_calls', 'temperature'])
    if (body[key] !== undefined) next[key] = body[key];
  next.model = CONCIERGE_VOICE_MODEL;
  next.stream = true;
  next.modalities = ['text', 'audio'];
  next.audio = { voice: 'alloy', format: 'pcm16' };
  next.max_tokens = typeof body.max_tokens === 'number' && Number.isSafeInteger(body.max_tokens) && body.max_tokens >= 0
    ? Math.max(1, Math.min(8192, body.max_tokens)) : 8192;
  if (new TextEncoder().encode(JSON.stringify(next)).byteLength > REQUEST_LIMIT)
    throw new Error('This voice conversation is too large. Start a new conversation.');
  return next;
}

interface StreamTool {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** Shared SSE decoder; tolerant of partial metadata, strict about completed actions. */
export class VoiceCompletionStream {
  private decoder = new TextDecoder('utf-8', { fatal: true });
  private buffer = '';
  private data: string[] = [];
  private bytes = 0;
  private done = false;
  private terminal: string | null = null;
  private text = '';
  private transcript = '';
  private audioRemainder = '';
  private calls = new Map<number, StreamTool>();
  private usage: Record<string, unknown> | undefined;
  private id: string | undefined;

  constructor(private readonly onAudio: (base64Pcm16: string) => void) {}

  push(chunk: Uint8Array): void {
    this.bytes += chunk.byteLength;
    if (this.bytes > STREAM_LIMIT) throw new Error('OpenRouter returned a voice response that is too large.');
    try { this.buffer += this.decoder.decode(chunk, { stream: true }); }
    catch { throw protocolError('invalid UTF-8'); }
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      this.line(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  private line(line: string): void {
    if (!line) {
      if (this.data.length) this.event(this.data.join('\n'));
      this.data = [];
    } else if (line.startsWith('data:')) {
      this.data.push(line.slice(5).replace(/^ /, ''));
    } else if (!line.startsWith(':') && !/^(event|id|retry):/.test(line)) {
      throw protocolError('invalid SSE field');
    }
  }

  private event(data: string): void {
    if (this.done) throw protocolError('data after stream completion');
    if (data === '[DONE]') {
      // OpenRouter's gpt-audio stream can end with [DONE] without ever sending a
      // finish_reason. The [DONE] sentinel itself marks a complete response; the
      // outcome is inferred from the assembled output in finish().
      this.done = true;
      return;
    }
    let value: unknown;
    try { value = JSON.parse(data); } catch { throw protocolError('invalid event JSON'); }
    if (!record(value)) throw protocolError('invalid event object');
    if (value.error != null) throw new Error('The voice model could not finish this response. Please try again.');
    // Only the first response id is kept; providers may vary it per chunk.
    if (typeof value.id === 'string' && value.id && !this.id) this.id = value.id;
    if (value.usage != null) {
      if (!record(value.usage)) throw protocolError('invalid usage');
      for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'cost']) {
        const count = value.usage[key];
        // OpenRouter's ChatUsage schema explicitly permits an unknown cost.
        if (key === 'cost' && count === null) continue;
        if (count !== undefined && (typeof count !== 'number' || !Number.isFinite(count) || count < 0))
          throw protocolError(`invalid usage.${key}`);
      }
      this.usage = value.usage;
    }
    // Keep-alive, usage-only or other metadata events may omit choices.
    if (value.choices == null) return;
    if (!array(value.choices) || value.choices.length > 1) throw protocolError('invalid choices');
    for (const choice of value.choices) {
      if (!record(choice)) throw protocolError('invalid choice');
      if (choice.error != null || choice.finish_reason === 'error')
        throw new Error('The voice model could not finish this response. Please try again.');
      // The audio guide's partial chunks omit index. This request asks for one
      // choice; an explicit index must still identify that same choice.
      if (choice.index !== undefined && choice.index !== 0) throw protocolError('invalid choice.index');
      if (choice.delta != null && !record(choice.delta)) throw protocolError('invalid choice.delta');
      const delta: Record<string, unknown> = record(choice.delta) ? choice.delta : {};
      if (delta.role != null && delta.role !== 'assistant') throw protocolError('invalid delta.role');
      if (delta.refusal != null && delta.refusal !== '') throw new Error('The voice model declined this request.');
      if (delta.content != null && typeof delta.content !== 'string') throw protocolError('invalid delta.content');
      if (delta.audio != null && !record(delta.audio)) throw protocolError('invalid delta.audio');
      const audio = record(delta.audio) ? delta.audio : undefined;
      if (audio?.transcript != null && typeof audio.transcript !== 'string') throw protocolError('invalid audio.transcript');
      if (audio?.data != null && typeof audio.data !== 'string') throw protocolError('invalid audio.data');
      if (delta.tool_calls != null && !array(delta.tool_calls)) throw protocolError('invalid delta.tool_calls');
      const tools = array(delta.tool_calls) ? delta.tool_calls : [];
      // Repeated finish/usage and audio id/expiry trailers are metadata, not new
      // output. Actual text, audio or tool changes must stop at finish_reason.
      // Late transcript or audio is harmless and is kept. New tool calls after
      // the model declared it was finished are not trusted.
      if (this.terminal && tools.length) throw protocolError('tool call after finish_reason');
      if (typeof delta.content === 'string') this.text += delta.content;
      if (typeof audio?.transcript === 'string') this.transcript += audio.transcript;
      if (typeof audio?.data === 'string' && audio.data) this.audio(audio.data);
      for (const part of tools) this.tool(part);
      if (choice.finish_reason != null) {
        if (choice.finish_reason === 'length' || choice.finish_reason === 'content_filter')
          throw new Error('The voice response was cut short. Please try again.');
        this.terminal = String(choice.finish_reason);
      }
    }
  }

  private audio(fragment: string): void {
    // Audio deltas are base64 fragments, not necessarily complete quartets.
    // Retain at most three characters and send only decodable pieces to playback.
    const encoded = this.audioRemainder + fragment;
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw protocolError('invalid audio.data base64');
    const length = encoded.length - encoded.length % 4;
    const complete = encoded.slice(0, length);
    this.audioRemainder = encoded.slice(length);
    if (complete) {
      if (!base64(complete) || (complete.includes('=') && this.audioRemainder))
        throw protocolError('invalid audio.data padding');
      this.onAudio(complete);
    }
  }

  private tool(part: unknown): void {
    if (!record(part) || typeof part.index !== 'number' || !Number.isSafeInteger(part.index) || part.index < 0 || part.index >= 64)
      throw protocolError('invalid tool_call.index');
    const call: StreamTool = this.calls.get(part.index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
    if (part.type != null && part.type !== 'function') throw protocolError('invalid tool_call.type');
    if (part.id != null) {
      if (typeof part.id !== 'string' || !part.id || (call.id && call.id !== part.id)) throw protocolError('invalid tool_call.id');
      call.id = part.id;
    }
    if (part.function != null) {
      if (!record(part.function)) throw protocolError('invalid tool_call.function');
      for (const field of ['name', 'arguments']) {
        const value = part.function[field];
        if (value != null && typeof value !== 'string') throw protocolError(`invalid tool_call.function.${field}`);
      }
      if (typeof part.function.name === 'string') call.function.name += part.function.name;
      if (typeof part.function.arguments === 'string') call.function.arguments += part.function.arguments;
    }
    this.calls.set(part.index, call);
  }

  finish(): unknown {
    try { this.buffer += this.decoder.decode(); } catch { throw protocolError('incomplete UTF-8'); }
    if (this.buffer.trim() || this.data.length) throw protocolError('incomplete SSE event');
    if (!this.done) throw protocolError('missing stream completion');
    if (this.audioRemainder) throw protocolError('incomplete audio.data base64');
    const calls = [...this.calls.entries()].sort(([a], [b]) => a - b).map(([index, call], expected) => {
      if (index !== expected || !call.id || !/^[A-Za-z0-9_-]{1,128}$/.test(call.function.name))
        throw protocolError('incomplete tool_call');
      let args: unknown;
      try { args = JSON.parse(call.function.arguments); } catch { throw protocolError('incomplete tool_call arguments'); }
      if (!record(args)) throw protocolError('invalid tool_call arguments');
      return call;
    });
    if (new Set(calls.map((call) => call.id)).size !== calls.length) throw protocolError('duplicate tool_call ids');
    const finishReason = calls.length ? 'tool_calls' : 'stop';
    const content = this.transcript || this.text;
    if (!content.trim() && !calls.length) throw protocolError('missing transcript or text');
    return {
      ...(this.id ? { id: this.id } : {}), model: CONCIERGE_VOICE_MODEL,
      choices: [{ index: 0, finish_reason: finishReason,
        message: { role: 'assistant', content: content || null, ...(calls.length ? { tool_calls: calls } : {}) } }],
      ...(this.usage ? { usage: this.usage } : {}),
    };
  }
}

async function nativeStream(body: Record<string, unknown>, signal: AbortSignal, onChunk: (chunk: Uint8Array) => void): Promise<void> {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    let closed = false;
    let receivedDone = false;
    let returned = false;
    const cancel = () => { void invoke<unknown>('concierge_cancel', { requestId }).catch(() => undefined); };
    const fail = (cause: unknown) => {
      if (closed) return;
      closed = true;
      signal.removeEventListener('abort', abort);
      cancel();
      reject(cause instanceof Error ? cause : new Error(typeof cause === 'string' ? cause : 'Could not complete the voice request.'));
    };
    const abort = () => fail(stopped());
    const complete = () => {
      if (receivedDone && returned && !closed) {
        closed = true;
        signal.removeEventListener('abort', abort);
        resolve();
      }
    };
    const onEvent = new Channel<unknown>((event) => {
      if (closed) return;
      try {
        if (!record(event) || receivedDone) throw protocolError('invalid native event');
        if (event.type === 'done') {
          receivedDone = true;
          complete();
        } else if (event.type === 'chunk' && array(event.data) && event.data.every((byte) =>
          typeof byte === 'number' && Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
          const data = event.data.filter((byte): byte is number => typeof byte === 'number');
          onChunk(Uint8Array.from(data));
        } else throw protocolError('invalid native audio chunk');
      } catch (cause) { fail(cause); }
    });
    if (signal.aborted) { fail(stopped()); return; }
    signal.addEventListener('abort', abort, { once: true });
    void invoke<unknown>('concierge_voice_request', { requestId, body, onEvent }).then(() => {
      returned = true;
      complete();
    }, fail);
  });
}

export async function requestConciergeVoice(
  body: Record<string, unknown>,
  signal: AbortSignal,
  onAudio: (base64Pcm16: string) => void,
): Promise<unknown> {
  if (signal.aborted) throw stopped();
  const request = voiceBody(body);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 90_000);
  const stream = new VoiceCompletionStream((data) => {
    if (controller.signal.aborted) throw stopped();
    onAudio(data);
  });
  try {
    const transport = isTauri() ? nativeStream : streamConciergeVoiceInBrowser;
    await transport(request, controller.signal, (chunk) => {
      if (controller.signal.aborted) throw stopped();
      stream.push(chunk);
    });
    if (controller.signal.aborted) throw stopped();
    return stream.finish();
  } catch (cause) {
    controller.abort();
    if (signal.aborted) throw stopped();
    if (timedOut) throw new Error('The voice model took too long to reply. Please try again.');
    if (cause instanceof TypeError) throw new Error('Could not reach OpenRouter. Check your connection and try again.');
    throw cause;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
  }
}
