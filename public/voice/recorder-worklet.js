// Capture starts only after an explicit user action. Manual mode collects a
// bounded recording; local wake mode emits bounded PCM frames without retaining
// room audio. Output stays silent so the microphone never feeds the speakers.
class VoiceRecorder extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.limit = options.processorOptions.maxSamples;
    this.streaming = options.processorOptions.mode === 'stream';
    this.frameSamples = options.processorOptions.frameSamples || 1280;
    this.sampleRatio = (options.processorOptions.sourceSampleRate || 16000) / (options.processorOptions.targetSampleRate || 16000);
    this.sampleWeight = 0;
    this.sampleSum = 0;
    this.recording = true;
    this.total = 0;
    this.buffer = this.streaming ? new Int16Array(this.frameSamples) : new Float32Array(2048);
    this.offset = 0;
    this.port.onmessage = ({ data }) => {
      if (data === 'stop') {
        this.recording = false;
        if (!this.streaming) this.flush();
        this.port.postMessage({ type: 'stopped' });
      }
    };
  }

  flush() {
    if (!this.offset) return;
    const samples = this.buffer.slice(0, this.offset);
    this.port.postMessage({ type: 'samples', samples }, [samples.buffer]);
    this.offset = 0;
  }

  appendStreamingSample(value) {
    // Carry fractional source-sample weights across process() calls. This keeps
    // 44.1/48 kHz devices aligned without gaps, repeated boundaries, or drift.
    let remaining = 1;
    while (remaining > 1e-9) {
      const weight = Math.min(remaining, this.sampleRatio - this.sampleWeight);
      this.sampleSum += value * weight;
      this.sampleWeight += weight;
      remaining -= weight;
      if (this.sampleWeight >= this.sampleRatio - 1e-9) {
        const sample = Math.max(-1, Math.min(1, this.sampleSum / this.sampleRatio));
        this.buffer[this.offset++] = Math.round(sample < 0 ? sample * 32768 : sample * 32767);
        this.sampleWeight = 0;
        this.sampleSum = 0;
        if (this.offset === this.frameSamples) {
          const pcm = this.buffer.buffer;
          this.port.postMessage({ type: 'frame', pcm }, [pcm]);
          this.buffer = new Int16Array(this.frameSamples);
          this.offset = 0;
        }
      }
    }
  }

  process(inputs, outputs) {
    for (const output of outputs) {
      for (const channel of output) channel.fill(0);
    }
    const channels = inputs[0];
    if (!this.recording || !channels?.length) return true;
    const length = channels[0].length;
    if (this.streaming) {
      for (let i = 0; i < length; i += 1) {
        let value = 0;
        for (const channel of channels) value += channel[i] || 0;
        this.appendStreamingSample(value / channels.length);
      }
      return true;
    }
    for (let i = 0; i < length && this.total < this.limit; i += 1) {
      let value = 0;
      for (const channel of channels) value += channel[i] || 0;
      this.buffer[this.offset++] = value / channels.length;
      this.total += 1;
      if (this.offset === this.buffer.length) this.flush();
    }
    if (this.total >= this.limit) {
      this.recording = false;
      this.flush();
      this.port.postMessage({ type: 'limit' });
    }
    return true;
  }
}

registerProcessor('voice-recorder', VoiceRecorder);
