import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../public/voice/recorder-worklet.js', import.meta.url), 'utf8');

function fixture(processorOptions) {
  let Recorder;
  const messages = [];
  runInContext(source, createContext({
    Float32Array, Int16Array,
    AudioWorkletProcessor: class {
      constructor() {
        this.port = {
          // Transfer ownership like a real MessagePort: a detached frame must
          // never be reused by the worklet on its next process() callback.
          postMessage(message, transfer = []) { messages.push(structuredClone(message, { transfer })); },
        };
      }
    },
    registerProcessor(name, implementation) { assert.equal(name, 'voice-recorder'); Recorder = implementation; },
  }));
  const recorder = new Recorder({ processorOptions });
  const feed = (channels, chunkSize = 128) => {
    for (let offset = 0; offset < channels[0].length; offset += chunkSize) {
      const inputs = channels.map(channel => channel.subarray(offset, Math.min(channel.length, offset + chunkSize)));
      const output = new Float32Array(inputs[0].length).fill(1);
      assert.equal(recorder.process([inputs], [[output]]), true);
      assert.ok(output.every(value => value === 0), 'microphone must never feed speaker output');
    }
  };
  return { recorder, messages, feed, frames: () => messages.filter(message => message.type === 'frame') };
}

for (const sourceSampleRate of [8000, 16000, 24000, 44100, 48000]) {
  test(`local wake resamples ${sourceSampleRate} Hz stereo into exact 80 ms mono PCM16 frames without duration drift`, () => {
    const capture = fixture({ mode: 'stream', sourceSampleRate, targetSampleRate: 16000, frameSamples: 1280 });
    capture.feed([new Float32Array(sourceSampleRate * 2).fill(.75), new Float32Array(sourceSampleRate * 2).fill(.25)]);
    const frames = capture.frames();
    assert.equal(frames.length, 25, 'two seconds must remain exactly two seconds');
    assert.ok(frames.every(frame => frame.pcm.byteLength === 2560));
    assert.ok(frames.every(frame => new Int16Array(frame.pcm).every(value => Math.abs(value - 16384) <= 1)), 'stereo channels must average within one PCM16 quantization unit');
    const count = capture.messages.length;
    capture.recorder.port.onmessage({ data: 'stop' });
    capture.feed([new Float32Array(128).fill(1)]);
    assert.equal(capture.messages.length, count + 1, 'stop must emit no more microphone audio');
    assert.equal(capture.messages.at(-1).type, 'stopped');
  });
}

test('fractional resampling preserves a changing waveform across arbitrary worklet callback boundaries', () => {
  const options = { mode: 'stream', sourceSampleRate: 44100, targetSampleRate: 16000, frameSamples: 1280 };
  const input = Float32Array.from({ length: 44100 * 3 }, (_, index) => .5 * Math.sin(index * Math.PI * 2 * 440 / 44100));
  const normal = fixture(options);
  const irregular = fixture(options);
  normal.feed([input], 128);
  irregular.feed([input], 173);
  assert.equal(normal.frames().length, 37);
  assert.equal(irregular.frames().length, 37);
  for (let index = 0; index < normal.frames().length; index += 1) {
    assert.deepEqual(new Int16Array(normal.frames()[index].pcm), new Int16Array(irregular.frames()[index].pcm));
  }
  const pcm = normal.frames().flatMap(frame => [...new Int16Array(frame.pcm)]);
  const rms = Math.sqrt(pcm.reduce((sum, value) => sum + (value / 32768) ** 2, 0) / pcm.length);
  assert.ok(rms > .35 && rms < .36, 'the resampled tone must retain its expected amplitude');
});

test('streamed PCM clamps out-of-range samples rather than wrapping their sign', () => {
  const capture = fixture({ mode: 'stream', sourceSampleRate: 16000, targetSampleRate: 16000, frameSamples: 1280 });
  capture.feed([new Float32Array(1280).fill(2)]);
  capture.feed([new Float32Array(1280).fill(-2)]);
  assert.ok(new Int16Array(capture.frames()[0].pcm).every(value => value === 32767));
  assert.ok(new Int16Array(capture.frames()[1].pcm).every(value => value === -32768));
});

test('manual recording retains its exact sample limit and flushes once with silent output', () => {
  const capture = fixture({ maxSamples: 1025 });
  capture.feed([new Float32Array(4096).fill(.75), new Float32Array(4096).fill(.25)]);
  const chunks = capture.messages.filter(message => message.type === 'samples');
  assert.equal(chunks.reduce((length, chunk) => length + chunk.samples.length, 0), 1025);
  assert.ok(chunks.every(chunk => chunk.samples.every(value => value === .5)));
  assert.equal(capture.messages.filter(message => message.type === 'limit').length, 1);
  capture.recorder.port.onmessage({ data: 'stop' });
  assert.equal(capture.messages.filter(message => message.type === 'samples').length, chunks.length);
  assert.equal(capture.messages.at(-1).type, 'stopped');
});
