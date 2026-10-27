// Collect microphone PCM only while explicitly recording. The output is always
// silent, so connecting this node to the destination cannot feed the mic back.
class VoiceRecorder extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.limit = options.processorOptions.maxSamples;
    this.recording = true;
    this.total = 0;
    this.buffer = new Float32Array(2048);
    this.offset = 0;
    this.port.onmessage = ({ data }) => {
      if (data === 'stop') {
        this.recording = false;
        this.flush();
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

  process(inputs, outputs) {
    for (const output of outputs) {
      for (const channel of output) channel.fill(0);
    }
    const channels = inputs[0];
    if (!this.recording || !channels?.length) return true;
    const length = channels[0].length;
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
