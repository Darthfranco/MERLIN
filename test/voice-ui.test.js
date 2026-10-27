import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInContext, createContext } from 'node:vm';
import test from 'node:test';

async function fixture() {
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, {
      value: '', hidden: selector === '#error', dataset: {}, style: {}, parentElement: { dataset: {} }, handlers: new Map(),
      addEventListener(name, handler) { this.handlers.set(name, handler); },
      pause() {}, load() {}, removeAttribute() {},
    });
    return elements.get(selector);
  };
  const context = createContext({
    document: { querySelector: element },
    navigator: { mediaDevices: { getUserMedia() {} } },
    window: { AudioContext() {}, AudioWorkletNode() {}, addEventListener() {} },
    AbortController, setTimeout, clearTimeout, setInterval, clearInterval, URL, Blob, DOMException,
    fetch: async () => ({ ok: true, json: async () => ({ metaConfigured: true, tts: { configured: true } }) }),
  });
  const source = await readFile(new URL('../public/voice/voice.js', import.meta.url), 'utf8');
  // vm.Script supplies a minimal browser fixture; this URL is used only if a
  // recording loads the worklet, which these media-event regression tests avoid.
  runInContext(source.replaceAll('import.meta.url', '"http://localhost/voice.js"'), context);
  await new Promise(setImmediate);
  const run = code => runInContext(code, context);
  return { element, run, event: (selector, name) => element(selector).handlers.get(name)() };
}

test('a delayed error from earlier playback cannot hide active recording or disable microphone cancellation', async () => {
  const ui = await fixture();
  ui.run(`
    audioUrl = 'blob:previous-playback';
    requestController = new AbortController();
    globalThis.capture = { disposed: false, dispose() { this.disposed = true; } };
    recorder = capture;
    setState('recording', 'Recording. Speak now.');
  `);
  ui.event('#audio', 'error');
  assert.equal(ui.run('state'), 'recording');
  assert.equal(ui.run('recorder === capture && !capture.disposed'), true);
  assert.equal(ui.element('#stop').disabled, false);
  assert.equal(ui.element('#record-label').textContent, 'Stop & speak');
  assert.equal(ui.element('#error').hidden, true);

  ui.event('#stop', 'click');
  assert.equal(ui.run('capture.disposed'), true);
  assert.equal(ui.run('recorder'), null);
  assert.equal(ui.run('state'), 'idle');
});

test('a current playback error still offers recovery when no capture or generation is active', async () => {
  const ui = await fixture();
  ui.run("audioUrl = 'blob:current-playback'; setState('playing', 'Fenrir is speaking.');");
  ui.event('#audio', 'error');
  assert.equal(ui.run('state'), 'idle');
  assert.equal(ui.element('#error').hidden, false);
  assert.match(ui.element('#error').textContent, /couldn’t play this audio/);
});

test('the wall-time cap stops and disposes a microphone even when the device supplies no audio frames', async () => {
  const ui = await fixture();
  ui.run(`
    globalThis.clock = 0;
    globalThis.performance = { now: () => clock };
    globalThis.tick = null;
    globalThis.intervalCleared = false;
    globalThis.setInterval = callback => { tick = callback; return 1; };
    globalThis.clearInterval = id => { if (id === 1) intervalCleared = true; };
    globalThis.capture = {
      stopCalls: 0, disposed: false,
      async stop() { this.stopCalls++; throw new Error('The recording was too short.'); },
      dispose() { this.disposed = true; },
    };
    createRecorder = async () => capture;
  `);
  await ui.run('startRecording()');
  assert.equal(ui.run('state'), 'recording');
  ui.run('clock = 59000; tick();');
  assert.equal(ui.run('capture.stopCalls'), 0);
  assert.equal(ui.run('state'), 'recording');

  ui.run('clock = 61000; tick();');
  await new Promise(setImmediate);
  assert.equal(ui.run('capture.stopCalls'), 1);
  assert.equal(ui.run('capture.disposed'), true);
  assert.equal(ui.run('intervalCleared'), true);
  assert.equal(ui.run('recorder'), null);
  assert.equal(ui.run('state'), 'idle');
  assert.equal(ui.element('#record-label').textContent, 'Start recording');
  assert.match(ui.element('#error').textContent, /recording was too short/);
});
