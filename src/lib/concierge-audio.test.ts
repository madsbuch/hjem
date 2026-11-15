import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeVoiceWav, PcmVoicePlayer, startVoiceRecording } from './concierge-audio';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const contexts: FakeContext[] = [];
const recorders: FakeWorklet[] = [];
let moduleResult: Promise<void>;
let resumeResult: Promise<void>;
class FakeBuffer {
  data: Float32Array;
  constructor(readonly length: number, readonly sampleRate: number) { this.data = new Float32Array(length); }
  copyToChannel(data: Float32Array) { this.data.set(data); }
}
class FakeSource {
  buffer: FakeBuffer | null = null;
  onended: (() => void) | null = null;
  connect = vi.fn();
  disconnect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
  end() { this.onended?.(); }
}
class FakeContext {
  sampleRate = 24_000;
  currentTime = 0;
  state = 'running';
  onstatechange: (() => void) | null = null;
  destination = {};
  sources: FakeSource[] = [];
  buffers: FakeBuffer[] = [];
  microphone = { connect: vi.fn(), disconnect: vi.fn() };
  audioWorklet = { addModule: vi.fn(() => moduleResult) };
  resume = vi.fn(() => resumeResult);
  close = vi.fn(async () => { this.state = 'closed'; });
  constructor() { contexts.push(this); }
  createMediaStreamSource() { return this.microphone; }
  createBuffer(_channels: number, count: number, rate: number) {
    const buffer = new FakeBuffer(count, rate);
    this.buffers.push(buffer);
    return buffer;
  }
  createBufferSource() {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }
}
class FakeWorklet {
  flushSamples: Float32Array | undefined;
  port = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    close: vi.fn(),
    postMessage: vi.fn((message: string) => {
      if (message !== 'flush') return;
      queueMicrotask(() => {
        if (this.flushSamples) this.emit(this.flushSamples);
        this.port.onmessage?.({ data: { type: 'flushed' } });
      });
    }),
  };
  connect = vi.fn();
  disconnect = vi.fn();
  constructor() { recorders.push(this); }
  emit(samples: Float32Array) { this.port.onmessage?.({ data: { type: 'samples', samples } }); }
}

beforeEach(() => {
  vi.useFakeTimers();
  contexts.length = 0;
  recorders.length = 0;
  moduleResult = Promise.resolve();
  resumeResult = Promise.resolve();
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('AudioContext', FakeContext);
  vi.stubGlobal('AudioWorkletNode', FakeWorklet);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function microphone() {
  const stop = vi.fn();
  const stream = { getTracks: () => [{ stop }] };
  const getUserMedia = vi.fn().mockResolvedValue(stream);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  return { stop, stream, getUserMedia };
}
const pcm = (...bytes: number[]) => Buffer.from(bytes).toString('base64');
const wav = (encoded: string) => {
  const bytes = Buffer.from(encoded, 'base64');
  return { bytes, view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
};

describe('voice WAV encoding', () => {
  it('writes a mono24k PCM16 WAV and averages48k input while clipping nonfinite samples', () => {
    const { bytes, view } = wav(encodeVoiceWav(new Float32Array([1, 1, -1, -1, .5, .5, NaN, Infinity]), 48_000));
    expect(bytes.toString('ascii', 0, 4)).toBe('RIFF');
    expect(bytes.toString('ascii', 8, 12)).toBe('WAVE');
    expect(view.getUint32(4, true)).toBe(bytes.length - 8);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(24_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(8);
    expect([44, 46, 48, 50].map((offset) => view.getInt16(offset, true))).toEqual([32767, -32768, 16384, 0]);
  });
  it('preserves duration and amplitude at fractional44.1k and lower16k rates', () => {
    for (const rate of [44_100, 16_000]) {
      const { bytes, view } = wav(encodeVoiceWav(new Float32Array(rate / 100).fill(.25), rate));
      expect(bytes.length).toBe(44 + 240 * 2);
      for (let offset = 44; offset < bytes.length; offset += 2) expect(view.getInt16(offset, true)).toBe(8192);
    }
  });
  it('rejects invalid rates and recordings exceeding30seconds', () => {
    expect(() => encodeVoiceWav(new Float32Array(1), NaN)).toThrow('sample rate');
    expect(() => encodeVoiceWav(new Float32Array(720_001), 24_000)).toThrow('30 seconds');
  });
});

describe('microphone lifecycle', () => {
  it('releases a late permission grant after cancellation without creating an audio context', async () => {
    const device = microphone();
    const permission = deferred<typeof device.stream>();
    device.getUserMedia.mockReturnValue(permission.promise);
    const controller = new AbortController();
    const pending = startVoiceRecording({ onLimit: vi.fn(), signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    permission.resolve(device.stream);
    await Promise.resolve();
    expect(device.stop).toHaveBeenCalledOnce();
    expect(contexts).toHaveLength(0);
  });
  it('stops tracks immediately, drains the final worklet block, and is idempotent', async () => {
    const device = microphone();
    const recording = await startVoiceRecording({ onLimit: vi.fn() });
    expect(device.getUserMedia).toHaveBeenCalledWith({ audio: expect.objectContaining({ echoCancellation: true, noiseSuppression: true }) });
    recorders[0].emit(new Float32Array([.5, -.5]));
    recorders[0].flushSamples = new Float32Array([1]);
    const pending = recording.stop();
    expect(device.stop).toHaveBeenCalledOnce();
    expect(recording.stop()).toBe(pending);
    const encoded = await pending;
    expect(encoded).not.toBeNull();
    expect(wav(encoded!).view.getUint32(40, true)).toBe(6);
    expect(contexts[0].close).toHaveBeenCalledOnce();
    expect(recorders[0].port.close).toHaveBeenCalledOnce();
  });
  it('discards cancelled recordings and ignores late worklet samples', async () => {
    const device = microphone();
    const level = vi.fn();
    const recording = await startVoiceRecording({ onLimit: vi.fn(), onLevel: level });
    recording.cancel();
    recorders[0].emit(new Float32Array([1]));
    expect(await recording.stop()).toBeNull();
    expect(device.stop).toHaveBeenCalledOnce();
    expect(level).not.toHaveBeenCalled();
  });
  it('cleans up on worklet failure and abortion during worklet loading', async () => {
    const device = microphone();
    const loading = deferred<void>();
    moduleResult = loading.promise;
    const controller = new AbortController();
    const pending = startVoiceRecording({ onLimit: vi.fn(), signal: controller.signal });
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(device.stop).toHaveBeenCalledOnce();
    expect(contexts[0].close).toHaveBeenCalledOnce();
    loading.reject(new Error('worklet unavailable'));
    await Promise.resolve();
  });
  it('notifies the30second limit once while leaving stop under caller control', async () => {
    const device = microphone();
    const onLimit = vi.fn();
    const recording = await startVoiceRecording({ onLimit });
    await vi.advanceTimersByTimeAsync(30_000);
    recorders[0].emit(new Float32Array(720_001));
    expect(onLimit).toHaveBeenCalledOnce();
    expect(device.stop).not.toHaveBeenCalled();
    const encoded = await recording.stop();
    expect(wav(encoded!).view.getUint32(40, true)).toBe(1_440_000);
  });
  it('explains microphone permission denial and unavailable secure contexts', async () => {
    const device = microphone();
    device.getUserMedia.mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    await expect(startVoiceRecording({ onLimit: vi.fn() })).rejects.toThrow('Microphone access was denied');
    vi.stubGlobal('isSecureContext', false);
    await expect(startVoiceRecording({ onLimit: vi.fn() })).rejects.toThrow('HTTPS or localhost');
    expect(contexts).toHaveLength(0);
  });
});

describe('streamed PCM playback', () => {
  it('reassembles odd byte boundaries and waits until every scheduled source finishes', async () => {
    const player = new PcmVoicePlayer();
    await player.prepare();
    player.add(pcm(0));
    expect(contexts[0].buffers).toHaveLength(0);
    player.add(pcm(128, 0, 0, 255));
    player.add(pcm(127));
    expect([...contexts[0].buffers[0].data]).toEqual([-1, 0]);
    expect([...contexts[0].buffers[1].data]).toEqual([32767 / 32768]);
    expect(contexts[0].sources[0].start).toHaveBeenCalledWith(.02);
    expect(contexts[0].sources[1].start).toHaveBeenCalledWith(.02 + 2 / 24_000);
    let finished = false;
    const completion = player.finish().then(() => { finished = true; });
    contexts[0].sources[0].end();
    await Promise.resolve();
    expect(finished).toBe(false);
    contexts[0].sources[1].end();
    await completion;
    expect(contexts[0].close).toHaveBeenCalledOnce();
  });
  it('stops scheduled audio immediately, resolves finish, and can prepare another turn', async () => {
    const player = new PcmVoicePlayer();
    await player.prepare();
    player.add(pcm(0, 128));
    const completion = player.finish();
    player.stop();
    await completion;
    expect(contexts[0].sources[0].stop).toHaveBeenCalledOnce();
    expect(contexts[0].close).toHaveBeenCalledOnce();
    await player.prepare();
    expect(contexts).toHaveLength(2);
    player.stop();
  });
  it('rejects truncated, malformed and oversized PCM and cleans up playback', async () => {
    const player = new PcmVoicePlayer();
    await player.prepare();
    player.add(pcm(127));
    await expect(player.finish()).rejects.toThrow('incomplete voice sample');
    await player.prepare();
    expect(() => player.add('not base64!')).toThrow('invalid');
    await player.prepare();
    expect(() => player.add('A'.repeat(2 * 1024 * 1024 + 1))).toThrow('oversized');
    expect(contexts.every((context) => context.close.mock.calls.length === 1)).toBe(true);
  });
  it('bounds total reply length instead of accumulating unlimited scheduled audio', async () => {
    const player = new PcmVoicePlayer();
    await player.prepare();
    const chunk = Buffer.alloc(24_000 * 20 * 2).toString('base64');
    for (let index = 0; index < 6; index++) player.add(chunk);
    expect(() => player.add(pcm(0, 0))).toThrow('two-minute');
    expect(contexts[0].sources.every((source) => source.stop.mock.calls.length === 1)).toBe(true);
  });
  it('does not revive playback when prepare resolves after Stop', async () => {
    const pendingResume = deferred<void>();
    resumeResult = pendingResume.promise;
    const player = new PcmVoicePlayer();
    const preparing = player.prepare();
    player.stop();
    pendingResume.resolve();
    await expect(preparing).rejects.toMatchObject({ name: 'AbortError' });
    expect(contexts[0].close).toHaveBeenCalledOnce();
  });
  it('rejects finish and discards scheduled audio when the OS suspends playback', async () => {
    const player = new PcmVoicePlayer();
    await player.prepare();
    player.add(pcm(0, 128));
    const completion = player.finish();
    const rejected = expect(completion).rejects.toThrow('interrupted');
    contexts[0].state = 'suspended';
    contexts[0].onstatechange?.();
    await rejected;
    expect(contexts[0].sources[0].stop).toHaveBeenCalledOnce();
    expect(contexts[0].close).toHaveBeenCalledOnce();
    expect(() => player.add(pcm(0, 0))).toThrow('interrupted');
  });
  it('rejects audio arriving before a suspended-context state event is dispatched', async () => {
    const player = new PcmVoicePlayer();
    await player.prepare();
    contexts[0].state = 'suspended';
    expect(() => player.add(pcm(0, 0))).toThrow('interrupted');
    expect(contexts[0].sources).toHaveLength(0);
    expect(contexts[0].close).toHaveBeenCalledOnce();
  });
  it('bounds finish when the audio device never reports a source ending', async () => {
    const player = new PcmVoicePlayer();
    await player.prepare();
    player.add(pcm(0, 128));
    const completion = player.finish();
    const rejected = expect(completion).rejects.toThrow('stopped responding');
    await vi.advanceTimersByTimeAsync(6000);
    await rejected;
    expect(contexts[0].sources[0].stop).toHaveBeenCalledOnce();
    expect(contexts[0].close).toHaveBeenCalledOnce();
  });
});
