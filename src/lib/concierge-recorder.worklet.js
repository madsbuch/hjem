// Kept as a same-origin asset: AudioWorklet has its own global environment.
class ConciergeRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Float32Array(2048);
    this.used = 0;
    this.running = true;
    this.port.onmessage = (event) => {
      if (event.data !== 'flush') return;
      this.running = false;
      this.flush();
      this.port.postMessage({ type: 'flushed' });
    };
  }

  flush() {
    if (!this.used) return;
    const samples = this.samples.slice(0, this.used);
    this.port.postMessage({ type: 'samples', samples }, [samples.buffer]);
    this.used = 0;
  }

  process(inputs) {
    if (!this.running) return false;
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let index = 0; index < channels[0].length; index++) {
      let sample = 0;
      for (const channel of channels) sample += channel[index] || 0;
      this.samples[this.used++] = sample / channels.length;
      if (this.used === this.samples.length) this.flush();
    }
    // No microphone samples are connected to the speakers.
    return true;
  }
}

registerProcessor('concierge-recorder', ConciergeRecorder);
