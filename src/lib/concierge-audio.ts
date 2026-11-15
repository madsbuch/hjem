import recorderWorkletUrl from './concierge-recorder.worklet.js?url&no-inline';

const VOICE_RATE = 24_000;
const RECORDING_SECONDS = 30;
const PLAYBACK_SECONDS = 120;
const aborted = () => new DOMException('Voice stopped.', 'AbortError');

export interface VoiceRecording {
  /** Stop capture and return a mono, 24 kHz PCM16 WAV, or null when cancelled/empty. */
  stop(): Promise<string | null>;
  /** Release the microphone immediately and discard all captured samples. */
  cancel(): void;
}

export interface VoiceRecordingOptions {
  onLimit: () => void;
  onLevel?: (level: number) => void;
  /** Also disposes a microphone permission result that arrives after cancellation. */
  signal?: AbortSignal;
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

/** Average source intervals when downsampling; interpolate when upsampling. */
export function encodeVoiceWav(samples: Float32Array, sampleRate: number): string {
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192_000)
    throw new Error('The microphone returned an unsupported sample rate.');
  if (samples.length > sampleRate * RECORDING_SECONDS)
    throw new Error('Voice recordings can be up to 30 seconds.');
  const count = Math.floor(samples.length * VOICE_RATE / sampleRate);
  const bytes = new Uint8Array(44 + count * 2);
  const view = new DataView(bytes.buffer);
  const label = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++)
      bytes[offset + index] = value.charCodeAt(index);
  };
  label(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  label(8, 'WAVE');
  label(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, VOICE_RATE, true);
  view.setUint32(28, VOICE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  label(36, 'data');
  view.setUint32(40, count * 2, true);
  const ratio = sampleRate / VOICE_RATE;
  for (let index = 0; index < count; index++) {
    const start = index * ratio;
    let sample = 0;
    if (ratio >= 1) {
      const end = Math.min((index + 1) * ratio, samples.length);
      for (let position = Math.floor(start); position < end; position++) {
        const weight = Math.min(end, position + 1) - Math.max(start, position);
        sample += (Number.isFinite(samples[position]) ? samples[position] : 0) * weight;
      }
      sample /= end - start;
    } else {
      const position = Math.floor(start);
      const fraction = start - position;
      sample = samples[position] * (1 - fraction) +
        samples[Math.min(position + 1, samples.length - 1)] * fraction;
    }
    sample = Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0;
    view.setInt16(44 + index * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return base64(bytes);
}

function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    void promise.catch(() => {});
    return Promise.reject(aborted());
  }
  return new Promise((resolve, reject) => {
    const cancel = () => reject(aborted());
    signal.addEventListener('abort', cancel, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}

export async function startVoiceRecording(options: VoiceRecordingOptions): Promise<VoiceRecording> {
  const { signal } = options;
  if (signal?.aborted) throw aborted();
  if (!globalThis.isSecureContext || !navigator.mediaDevices?.getUserMedia)
    throw new Error('Microphone access needs HTTPS or localhost. Open Hjem in the app or on a secure connection.');
  if (typeof AudioContext === 'undefined' || typeof AudioWorkletNode === 'undefined')
    throw new Error('Voice recording is unavailable in this browser. Update your browser or Android System WebView.');

  let stream: MediaStream | null = null;
  let context: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let recorder: AudioWorkletNode | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  let disposed = false;
  let stopping: Promise<string | null> | undefined;
  let flush: (() => void) | undefined;
  let chunks: Float32Array[] = [];
  let total = 0;
  let rate = VOICE_RATE;
  let limitNotified = false;
  const stopTracks = () => {
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
  };
  const cleanup = () => {
    disposed = true;
    clearTimeout(timer);
    stopTracks();
    source?.disconnect();
    source = null;
    recorder?.disconnect();
    recorder?.port.close();
    recorder = null;
    if (context) void context.close().catch(() => {});
    context = null;
    signal?.removeEventListener('abort', cancel);
  };
  const cancel = () => {
    cancelled = true;
    chunks = [];
    cleanup();
    flush?.();
  };
  const limit = () => {
    if (limitNotified || cancelled || stopping) return;
    limitNotified = true;
    options.onLimit();
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const permission = navigator.mediaDevices.getUserMedia({ audio: {
      channelCount: { ideal: 1 }, sampleRate: { ideal: VOICE_RATE },
      echoCancellation: true, noiseSuppression: true, autoGainControl: true,
    } });
    // Permission prompts cannot be aborted. Release a later grant without using it.
    void permission.then((granted) => {
      if (cancelled || signal?.aborted) granted.getTracks().forEach((track) => track.stop());
    }, () => {});
    stream = await withAbort(permission, signal);
    if (cancelled || signal?.aborted) throw aborted();
    context = new AudioContext({ sampleRate: VOICE_RATE });
    rate = context.sampleRate;
    if (!Number.isFinite(rate) || rate < 8000 || rate > 192_000)
      throw new Error('The microphone returned an unsupported sample rate.');
    await withAbort(context.audioWorklet.addModule(recorderWorkletUrl), signal);
    if (cancelled || !context) throw aborted();
    recorder = new AudioWorkletNode(context, 'concierge-recorder', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
    });
    recorder.port.onmessage = (event: MessageEvent<unknown>) => {
      if (cancelled || disposed || event.data === null || typeof event.data !== 'object') return;
      if ('type' in event.data && event.data.type === 'flushed') {
        flush?.();
        return;
      }
      if (!('samples' in event.data) || !(event.data.samples instanceof Float32Array)) return;
      const remaining = Math.max(0, Math.floor(rate * RECORDING_SECONDS) - total);
      const samples = event.data.samples.subarray(0, remaining);
      if (samples.length) {
        chunks.push(samples);
        total += samples.length;
        let square = 0;
        for (const sample of samples) square += sample * sample;
        options.onLevel?.(Math.min(1, Math.sqrt(square / samples.length)));
      }
      if (total >= rate * RECORDING_SECONDS) limit();
    };
    source = context.createMediaStreamSource(stream);
    source.connect(recorder);
    recorder.connect(context.destination);
    await withAbort(context.resume(), signal);
    if (cancelled) throw aborted();
    timer = setTimeout(limit, RECORDING_SECONDS * 1000);
    return {
      cancel,
      stop() {
        if (stopping) return stopping;
        if (cancelled) return Promise.resolve(null);
        clearTimeout(timer);
        // Stop the device immediately, then drain the worklet's last partial block.
        stopTracks();
        const node = recorder;
        stopping = (async () => {
          try {
            if (node) await new Promise<void>((resolve) => {
              const timeout = setTimeout(resolve, 250);
              flush = () => { clearTimeout(timeout); resolve(); };
              node.port.postMessage('flush');
            });
            if (cancelled || !total) return null;
            const samples = new Float32Array(total);
            let offset = 0;
            for (const chunk of chunks) { samples.set(chunk, offset); offset += chunk.length; }
            return encodeVoiceWav(samples, rate);
          } finally {
            chunks = [];
            flush = undefined;
            cleanup();
          }
        })();
        return stopping;
      },
    };
  } catch (error) {
    cleanup();
    if (cancelled || signal?.aborted) throw aborted();
    if (error instanceof DOMException) {
      if (error.name === 'NotAllowedError' || error.name === 'SecurityError')
        throw new Error('Microphone access was denied. Allow microphone access in Hjem’s app or browser settings.');
      if (error.name === 'NotFoundError') throw new Error('No microphone is available on this device.');
      if (error.name === 'NotReadableError') throw new Error('The microphone is in use or unavailable. Close other recording apps and try again.');
    }
    throw new Error(error instanceof Error ? error.message : 'Could not start the microphone. Please try again.');
  }
}

/** Plays streamed little-endian mono PCM16 at 24 kHz without retaining finished audio. */
export class PcmVoicePlayer {
  private context: AudioContext | null = null;
  private sources = new Set<AudioBufferSourceNode>();
  private waiters = new Set<{ resolve: () => void; reject: (error: Error) => void }>();
  private nextTime = 0;
  private trailingByte: number | null = null;
  private samples = 0;
  private failure: Error | null = null;

  async prepare(): Promise<void> {
    if (typeof AudioContext === 'undefined') throw new Error('Voice playback is unavailable in this browser.');
    const context = this.context ?? new AudioContext({ sampleRate: VOICE_RATE });
    this.failure = null;
    this.context = context;
    try {
      await context.resume();
      if (this.context !== context) throw aborted();
      const checkState = () => {
        if (this.context === context && context.state !== 'running')
          this.dispose(new Error('Voice playback was interrupted. Check the audio output, then try again.'));
      };
      context.onstatechange = checkState;
      checkState();
      if (this.failure) throw this.failure;
    } catch (error) {
      if (this.context === context) this.stop();
      throw error;
    }
  }

  add(encoded: string): void {
    try {
      const context = this.context;
      if (this.failure) throw this.failure;
      if (!context || context.state === 'closed') throw new Error('Start voice playback before receiving audio.');
      if (context.state !== 'running')
        throw new Error('Voice playback was interrupted. Check the audio output, then try again.');
      if (!encoded) return;
      if (encoded.length > 2 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
        throw new Error('The model returned invalid or oversized voice audio.');
      let binary: string;
      try { binary = atob(encoded); }
      catch { throw new Error('The model returned invalid voice audio.'); }
      const leading = this.trailingByte;
      const length = binary.length + (leading === null ? 0 : 1);
      const count = Math.floor(length / 2);
      if (this.samples + count > VOICE_RATE * PLAYBACK_SECONDS)
        throw new Error('The voice reply exceeded the two-minute playback limit.');
      const byte = (index: number) => leading === null
        ? binary.charCodeAt(index)
        : index === 0 ? leading : binary.charCodeAt(index - 1);
      this.trailingByte = length % 2 ? byte(length - 1) : null;
      if (!count) return;
      const audio = new Float32Array(count);
      for (let index = 0; index < count; index++) {
        const value = byte(index * 2) | (byte(index * 2 + 1) << 8);
        audio[index] = (value >= 32768 ? value - 65536 : value) / 32768;
      }
      const buffer = context.createBuffer(1, count, VOICE_RATE);
      buffer.copyToChannel(audio, 0);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.onended = () => {
        source.disconnect();
        this.sources.delete(source);
        if (!this.sources.size) this.resolveWaiters();
      };
      this.sources.add(source);
      const start = Math.max(context.currentTime + 0.02, this.nextTime);
      source.start(start);
      this.nextTime = start + count / VOICE_RATE;
      this.samples += count;
    } catch (error) {
      this.dispose(error instanceof Error ? error : new Error('Voice playback failed. Please try again.'));
      throw error;
    }
  }

  async finish(): Promise<void> {
    if (this.failure) throw this.failure;
    const context = this.context;
    if (this.trailingByte !== null) {
      this.stop();
      throw new Error('The model returned an incomplete voice sample.');
    }
    if (this.sources.size) {
      const remaining = Math.max(0, this.nextTime - (context?.currentTime ?? 0));
      const timeout = setTimeout(() => {
        if (this.context === context)
          this.dispose(new Error('Voice playback stopped responding. Check the audio output, then try again.'));
      }, Math.min(PLAYBACK_SECONDS + 5, remaining + 5) * 1000);
      try {
        await new Promise<void>((resolve, reject) => this.waiters.add({ resolve, reject }));
      } finally {
        clearTimeout(timeout);
      }
    }
    if (this.context === context) this.stop();
  }

  stop(): void {
    this.dispose(null);
  }

  private dispose(error: Error | null): void {
    this.failure = error;
    for (const source of this.sources) {
      source.onended = null;
      try { source.stop(); } catch { /* A source may have just ended. */ }
      source.disconnect();
    }
    this.sources.clear();
    if (this.context) {
      this.context.onstatechange = null;
      void this.context.close().catch(() => {});
    }
    this.context = null;
    this.nextTime = 0;
    this.trailingByte = null;
    this.samples = 0;
    this.resolveWaiters(error);
  }

  private resolveWaiters(error: Error | null = null): void {
    for (const waiter of this.waiters) {
      if (error) waiter.reject(error);
      else waiter.resolve();
    }
    this.waiters.clear();
  }
}
