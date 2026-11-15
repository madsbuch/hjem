import { Channel, invoke, isTauri } from '@tauri-apps/api/core';
import { streamConciergeVoiceInBrowser } from './concierge-api';

export const CONCIERGE_VOICE_MODEL = 'openai/gpt-audio';
export const CONCIERGE_VOICE_SAMPLE_RATE = 24_000;
const REQUEST_LIMIT = 8 * 1024 * 1024;
const STREAM_LIMIT = 24 * 1024 * 1024;
const AUDIO_LIMIT = 2 * 1024 * 1024;
const PROTOCOL_ERROR = 'OpenRouter returned an incomplete or unreadable voice response. No actions from this response were run.';
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const array = (value: unknown): value is unknown[] => Array.isArray(value);
const base64 = (value: unknown): value is string => typeof value === 'string' &&
  value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
const stopped = () => new DOMException('Stopped.', 'AbortError');
const protocolError = () => new Error(PROTOCOL_ERROR);

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

/** Shared strict SSE decoder for native IPC and browser fetch. */
export class VoiceCompletionStream {
  private decoder = new TextDecoder('utf-8', { fatal: true });
  private buffer = '';
  private data: string[] = [];
  private bytes = 0;
  private done = false;
  private terminal: string | null = null;
  private text = '';
  private transcript = '';
  private calls = new Map<number, StreamTool>();
  private usage: Record<string, unknown> | undefined;
  private id: string | undefined;

  constructor(private readonly onAudio: (base64Pcm16: string) => void) {}

  push(chunk: Uint8Array): void {
    this.bytes += chunk.byteLength;
    if (this.bytes > STREAM_LIMIT) throw new Error('OpenRouter returned a voice response that is too large.');
    try { this.buffer += this.decoder.decode(chunk, { stream: true }); }
    catch { throw protocolError(); }
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
      throw protocolError();
    }
  }

  private event(data: string): void {
    if (this.done) throw protocolError();
    if (data === '[DONE]') {
      if (!this.terminal) throw protocolError();
      this.done = true;
      return;
    }
    let value: unknown;
    try { value = JSON.parse(data); } catch { throw protocolError(); }
    if (!record(value)) throw protocolError();
    if (value.error != null) throw new Error('The voice model could not finish this response. Please try again.');
    if (value.id !== undefined) {
      if (typeof value.id !== 'string' || !value.id || (this.id && value.id !== this.id)) throw protocolError();
      this.id = value.id;
    }
    if (value.usage != null) {
      if (!record(value.usage)) throw protocolError();
      for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'cost']) {
        const count = value.usage[key];
        if (count !== undefined && (typeof count !== 'number' || !Number.isFinite(count) || count < 0)) throw protocolError();
      }
      this.usage = value.usage;
    }
    if (!array(value.choices) || value.choices.length > 1 || (!value.choices.length && value.usage == null)) throw protocolError();
    for (const choice of value.choices) {
      if (!record(choice) || choice.index !== 0 || !record(choice.delta)) throw protocolError();
      const delta = choice.delta;
      if (choice.error != null || choice.finish_reason === 'error')
        throw new Error('The voice model could not finish this response. Please try again.');
      if (delta.role != null && delta.role !== 'assistant') throw protocolError();
      if (delta.refusal != null && delta.refusal !== '') throw new Error('The voice model declined this request.');
      if (delta.content != null && typeof delta.content !== 'string') throw protocolError();
      // OpenRouter repeats finish_reason on its final usage frame. It must not
      // introduce new content or calls after a completed choice.
      if (this.terminal && (delta.content || delta.audio != null || delta.tool_calls != null)) throw protocolError();
      if (typeof delta.content === 'string') this.text += delta.content;
      if (delta.audio != null) {
        if (!record(delta.audio)) throw protocolError();
        if (delta.audio.transcript !== undefined) {
          if (typeof delta.audio.transcript !== 'string') throw protocolError();
          this.transcript += delta.audio.transcript;
        }
        if (delta.audio.data !== undefined) {
          if (!base64(delta.audio.data)) throw protocolError();
          this.onAudio(delta.audio.data);
        }
      }
      if (delta.tool_calls != null) {
        if (!array(delta.tool_calls)) throw protocolError();
        for (const part of delta.tool_calls) this.tool(part);
      }
      if (choice.finish_reason != null) {
        if (choice.finish_reason !== 'stop' && choice.finish_reason !== 'tool_calls')
          throw new Error('The voice response was cut short. Please try again.');
        if (this.terminal && this.terminal !== choice.finish_reason) throw protocolError();
        this.terminal = choice.finish_reason;
      }
    }
  }

  private tool(part: unknown): void {
    if (!record(part) || typeof part.index !== 'number' || !Number.isSafeInteger(part.index) || part.index < 0 || part.index >= 64)
      throw protocolError();
    const call: StreamTool = this.calls.get(part.index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
    if (part.type !== undefined && part.type !== 'function') throw protocolError();
    if (part.id !== undefined) {
      if (typeof part.id !== 'string' || !part.id || (call.id && call.id !== part.id)) throw protocolError();
      call.id = part.id;
    }
    if (part.function !== undefined) {
      if (!record(part.function)) throw protocolError();
      for (const field of ['name', 'arguments']) {
        const value = part.function[field];
        if (value !== undefined && typeof value !== 'string') throw protocolError();
      }
      if (typeof part.function.name === 'string') call.function.name += part.function.name;
      if (typeof part.function.arguments === 'string') call.function.arguments += part.function.arguments;
    }
    this.calls.set(part.index, call);
  }

  finish(): unknown {
    try { this.buffer += this.decoder.decode(); } catch { throw protocolError(); }
    if (this.buffer.trim() || this.data.length || !this.done || !this.terminal) throw protocolError();
    const calls = [...this.calls.entries()].sort(([a], [b]) => a - b).map(([index, call], expected) => {
      if (index !== expected || !call.id || !/^[A-Za-z0-9_-]{1,128}$/.test(call.function.name)) throw protocolError();
      let args: unknown;
      try { args = JSON.parse(call.function.arguments); } catch { throw protocolError(); }
      if (!record(args)) throw protocolError();
      return call;
    });
    if (new Set(calls.map((call) => call.id)).size !== calls.length ||
        (this.terminal === 'tool_calls') !== (calls.length > 0)) throw protocolError();
    const content = this.transcript || this.text;
    if (!content.trim() && !calls.length) throw protocolError();
    return {
      ...(this.id ? { id: this.id } : {}), model: CONCIERGE_VOICE_MODEL,
      choices: [{ index: 0, finish_reason: this.terminal,
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
        if (!record(event) || receivedDone) throw protocolError();
        if (event.type === 'done') {
          receivedDone = true;
          complete();
        } else if (event.type === 'chunk' && array(event.data) && event.data.every((byte) =>
          typeof byte === 'number' && Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
          const data = event.data.filter((byte): byte is number => typeof byte === 'number');
          onChunk(Uint8Array.from(data));
        } else throw protocolError();
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
