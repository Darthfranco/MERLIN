import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInContext, createContext } from 'node:vm';
import test from 'node:test';

async function fixture(t, { listenerConfigured = true, getUserMedia } = {}) {
  const elements = new Map();
  const documentHandlers = new Map();
  const windowHandlers = new Map();
  const sockets = [];
  const contexts = [];
  const worklets = [];
  const microphoneRequests = [];
  const streams = [];
  const requests = [];
  const objectUrls = new Map();
  const revokedUrls = [];
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, {
      value: selector === '#delivery' ? 'natural' : selector === '#speed' ? '1' : '',
      hidden: selector === '#error', dataset: {}, style: {}, parentElement: { dataset: {} }, handlers: new Map(),
      addEventListener(name, handler) { this.handlers.set(name, handler); },
      setAttribute(name, value) { this[name] = value; },
      removeAttribute(name) { delete this[name]; },
      pause() { this.paused = true; this.pauseCount = (this.pauseCount || 0) + 1; },
      play() { this.currentSrc = this.src; this.paused = false; return Promise.resolve(); },
      load() { if (!this.src) this.currentSrc = ''; },
      focus() { this.focused = true; },
    });
    return elements.get(selector);
  };
  const makeStream = () => {
    const track = { stopped: false, handlers: new Map(), stop() { this.stopped = true; }, addEventListener(name, handler) { this.handlers.set(name, handler); } };
    const stream = { track, getTracks: () => [track], getAudioTracks: () => [track] };
    streams.push(stream);
    return stream;
  };
  class AudioContext {
    constructor({ sampleRate } = {}) {
      this.sampleRate = sampleRate || 48000;
      this.state = 'running';
      this.audioWorklet = { addModule: async () => {} };
      this.destination = {};
      contexts.push(this);
    }
    async resume() {}
    async close() { this.state = 'closed'; }
    createMediaStreamSource() {
      return { connect() {}, disconnect() { this.disconnected = true; } };
    }
  }
  class AudioWorkletNode {
    constructor(context, name, options) {
      this.options = options;
      this.port = { messages: [], postMessage(message) { this.messages.push(message); } };
      worklets.push(this);
    }
    connect() {}
    disconnect() { this.disconnected = true; }
  }
  class WebSocket {
    static OPEN = 1;
    static CLOSING = 2;
    constructor(url) { this.url = String(url); this.readyState = 0; this.bufferedAmount = 0; this.handlers = new Map(); this.messages = []; sockets.push(this); }
    addEventListener(name, handler) { this.handlers.set(name, handler); }
    open() { this.readyState = 1; this.handlers.get('open')?.(); }
    send(message) { this.messages.push(message); }
    close() { this.readyState = 3; this.closed = true; }
    message(data) { this.handlers.get('message')({ data: typeof data === 'object' && !(data instanceof ArrayBuffer) ? JSON.stringify(data) : data }); }
  }
  let nextUrl = 0;
  class ObjectURL extends URL {
    static createObjectURL(blob) { const url = `blob:test-${++nextUrl}`; objectUrls.set(url, blob); return url; }
    static revokeObjectURL(url) { revokedUrls.push(url); }
  }
  const document = { querySelector: element, visibilityState: 'visible', addEventListener(name, handler) { documentHandlers.set(name, handler); } };
  const context = createContext({
    document,
    navigator: { mediaDevices: { getUserMedia(options) { microphoneRequests.push(options); return getUserMedia ? getUserMedia(options) : Promise.resolve(makeStream()); } } },
    window: { AudioContext, AudioWorkletNode, WebSocket, location: { href: 'http://localhost:3001/' }, addEventListener(name, handler) { windowHandlers.set(name, handler); } },
    AudioContext, AudioWorkletNode, WebSocket, ArrayBuffer, AbortController, setTimeout, clearTimeout, setInterval, clearInterval, URL: ObjectURL, Blob, DOMException,
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      return { ok: true, json: async () => ({ metaConfigured: true, tts: { configured: true }, listener: { configured: listenerConfigured } }), blob: async () => new Blob([new Uint8Array(100)], { type: 'audio/wav' }) };
    },
  });
  const source = await readFile(new URL('../public/voice/voice.js', import.meta.url), 'utf8');
  // vm.Script supplies browser events without using a real microphone or API.
  runInContext(source.replaceAll('import.meta.url', '"http://localhost/voice.js"'), context);
  await new Promise(setImmediate);
  const run = code => runInContext(code, context);
  t.after(() => run('stopWakeMode(); cancelOperation(); removeAudio();'));
  return {
    element, run, sockets, contexts, worklets, microphoneRequests, streams, requests, objectUrls, revokedUrls, makeStream,
    event: (selector, name) => element(selector).handlers.get(name)(),
    hide() { document.visibilityState = 'hidden'; documentHandlers.get('visibilitychange')(); },
    leave() { windowHandlers.get('pagehide')(); },
  };
}

test('a delayed error from earlier playback cannot hide active recording or disable microphone cancellation', async t => {
  const ui = await fixture(t);
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

test('a current playback error still offers recovery when no capture or generation is active', async t => {
  const ui = await fixture(t);
  ui.run("audioUrl = 'blob:current-playback'; setState('playing', 'Fenrir is speaking.');");
  ui.event('#audio', 'error');
  assert.equal(ui.run('state'), 'idle');
  assert.equal(ui.element('#error').hidden, false);
  assert.match(ui.element('#error').textContent, /couldn’t play this audio/);
});

test('the wall-time cap stops and disposes a microphone even when the device supplies no audio frames', async t => {
  const ui = await fixture(t);
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

async function startSession(ui) {
  await ui.event('#wake-toggle', 'click');
  const socket = ui.sockets.at(-1);
  socket.open();
  socket.message({ type: 'ready', revision: 0 });
  socket.message({ type: 'state', state: 'wake', revision: 0 });
  return socket;
}

function speech(socket, revision, utteranceId = `utterance-${revision}`) {
  socket.message({ type: 'state', state: 'speaking', revision });
  socket.message({ type: 'audio', revision, utteranceId });
  socket.message(new ArrayBuffer(100));
}

function messages(socket) {
  return socket.messages.filter(message => typeof message === 'string').map(message => JSON.parse(message));
}

test('local wake starts only on explicit enable and sends no frames before readiness; Mic off restores manual use', async t => {
  const ui = await fixture(t);
  assert.equal(ui.microphoneRequests.length, 0);
  assert.equal(ui.sockets.length, 0);
  assert.equal(ui.element('#wake-toggle').disabled, false);
  await ui.event('#wake-toggle', 'click');
  const socket = ui.sockets[0];
  const worklet = ui.worklets[0];
  const pcm = new ArrayBuffer(2560);
  assert.equal(ui.microphoneRequests.length, 1);
  assert.equal(ui.microphoneRequests[0].audio.echoCancellation, true);
  assert.equal(ui.microphoneRequests[0].audio.noiseSuppression, true);
  assert.equal(ui.element('#record').disabled, true);
  assert.equal(ui.element('#words').readOnly, true);
  assert.equal(ui.element('#stop').textContent, 'Mic off');
  worklet.port.onmessage({ data: { type: 'frame', pcm } });
  assert.equal(socket.messages.length, 0);
  socket.open();
  assert.equal(socket.url, 'ws://localhost:3001/api/voice/session');
  assert.deepEqual(messages(socket), [{ type: 'start', delivery: 'natural', speed: 1 }]);
  worklet.port.onmessage({ data: { type: 'frame', pcm } });
  assert.equal(socket.messages.length, 1);
  socket.message({ type: 'ready', revision: 0 });
  socket.message({ type: 'state', state: 'wake', revision: 0 });
  assert.equal(ui.element('#wake-status').textContent, 'Local wake only — say MERLIN');
  worklet.port.onmessage({ data: { type: 'frame', pcm } });
  assert.equal(socket.messages.at(-1), pcm);
  ui.event('#stop', 'click');
  assert.equal(ui.run('wakeSession'), null);
  assert.equal(ui.streams[0].track.stopped, true);
  assert.equal(ui.contexts[0].state, 'closed');
  assert.equal(worklet.port.onmessage, null);
  assert.equal(worklet.disconnected, true);
  assert.equal(socket.closed, true);
  assert.deepEqual(messages(socket).at(-1), { type: 'stop' });
  assert.equal(ui.element('#wake-status').textContent, 'Microphone off');
  assert.equal(ui.element('#record').disabled, false);
  assert.equal(ui.element('#words').readOnly, false);
});

test('missing local detector setup disables wake mode without disabling typed speech', async t => {
  const ui = await fixture(t, { listenerConfigured: false });
  ui.element('#words').value = 'A synthetic test phrase.';
  ui.event('#words', 'input');
  assert.equal(ui.element('#wake-toggle').disabled, true);
  assert.equal(ui.element('#speak').disabled, false);
  assert.equal(ui.element('#wake-setup').hidden, false);
  assert.match(ui.element('#wake-setup').textContent, /npm run setup:voice/);
  await ui.event('#wake-toggle', 'click');
  assert.equal(ui.microphoneRequests.length, 0);
});

test('interrupt discards stale audio and late play promises or media events cannot pause or acknowledge replacement speech', async t => {
  const ui = await fixture(t);
  const socket = await startSession(ui);
  const audio = ui.element('#audio');
  const plays = [];
  audio.play = function () {
    this.currentSrc = this.src;
    this.paused = false;
    return new Promise(resolve => plays.push(resolve));
  };
  speech(socket, 1);
  const oldUrl = audio.src;
  socket.message({ type: 'interrupt', revision: 2 });
  assert.ok(ui.revokedUrls.includes(oldUrl));
  socket.message({ type: 'audio', revision: 1, utteranceId: 'old' });
  socket.message(new ArrayBuffer(100));
  assert.equal(ui.objectUrls.size, 1);
  speech(socket, 3);
  const nextUrl = audio.src;
  const pauseCount = audio.pauseCount;
  const messageCount = socket.messages.length;
  plays[0]();
  await new Promise(setImmediate);
  assert.equal(audio.pauseCount, pauseCount);
  assert.equal(audio.src, nextUrl);
  audio.currentSrc = oldUrl;
  audio.paused = true;
  audio.ended = true;
  for (const event of ['play', 'pause', 'ended', 'error']) ui.event('#audio', event);
  assert.equal(audio.pauseCount, pauseCount);
  assert.equal(socket.messages.length, messageCount);
  assert.equal(ui.element('#error').hidden, true);
  audio.currentSrc = nextUrl;
  audio.paused = false;
  ui.event('#audio', 'play');
  assert.deepEqual(messages(socket).at(-1), { type: 'playback', playing: true, revision: 3, utteranceId: 'utterance-3' });
  plays[1]();
});

test('End conversation blocks pending audio until wake acknowledgment and keeps only local wake capture armed', async t => {
  const ui = await fixture(t);
  const socket = await startSession(ui);
  socket.message({ type: 'state', state: 'generating', revision: 1 });
  ui.event('#end-conversation', 'click');
  assert.deepEqual(messages(socket).at(-1), { type: 'sleep' });
  assert.equal(ui.streams[0].track.stopped, false);
  assert.equal(socket.closed, undefined);
  speech(socket, 1);
  assert.equal(ui.objectUrls.size, 0);
  socket.message({ type: 'interrupt', revision: 2 });
  socket.message({ type: 'state', state: 'wake', revision: 2 });
  assert.equal(ui.run('wakeSession.awaitingSleep'), false);
  assert.equal(ui.element('#wake-status').textContent, 'Local wake only — say MERLIN');
  assert.equal(ui.element('#end-conversation').hidden, true);
  speech(socket, 1);
  assert.equal(ui.objectUrls.size, 0);
});

for (const exit of ['hide', 'leave']) {
  test(`${exit === 'hide' ? 'Hiding' : 'Leaving'} the page releases the microphone and socket, and late server events cannot restart them`, async t => {
    const ui = await fixture(t);
    const socket = await startSession(ui);
    speech(socket, 1);
    ui[exit]();
    assert.equal(ui.run('wakeSession'), null);
    assert.equal(ui.streams[0].track.stopped, true);
    assert.equal(ui.contexts[0].state, 'closed');
    assert.equal(ui.worklets[0].port.onmessage, null);
    assert.equal(socket.closed, true);
    assert.equal(ui.element('#playback').hidden, true);
    speech(socket, 3);
    socket.message({ type: 'transcript', revision: 3, text: 'Late synthetic transcript' });
    assert.equal(ui.objectUrls.size, 1);
    assert.equal(ui.element('#words').value, '');
    assert.equal(ui.element('#wake-status').textContent, 'Microphone off');
  });
}

test('turning wake mode off while microphone permission is pending stops the late-granted track', async t => {
  let grant;
  const ui = await fixture(t, { getUserMedia: () => new Promise(resolve => { grant = resolve; }) });
  const starting = ui.event('#wake-toggle', 'click');
  assert.equal(ui.microphoneRequests.length, 1);
  ui.event('#wake-toggle', 'click');
  const stream = ui.makeStream();
  grant(stream);
  await starting;
  assert.equal(stream.track.stopped, true);
  assert.equal(ui.run('wakeSession'), null);
  assert.equal(ui.contexts[0].state, 'closed');
  assert.equal(ui.sockets[0].closed, true);
  assert.equal(ui.worklets.length, 0);
  assert.equal(ui.element('#error').hidden, true);
});

test('socket failure and excessive frame backlog release capture instead of silently keeping the microphone on', async t => {
  const ui = await fixture(t);
  const first = await startSession(ui);
  first.handlers.get('error')();
  assert.equal(ui.streams[0].track.stopped, true);
  assert.equal(first.closed, true);
  assert.equal(ui.element('#error').hidden, false);
  const second = await startSession(ui);
  second.bufferedAmount = 64001;
  const before = second.messages.length;
  ui.worklets[1].port.onmessage({ data: { type: 'frame', pcm: new ArrayBuffer(2560) } });
  assert.equal(ui.streams[1].track.stopped, true);
  assert.equal(second.closed, true);
  assert.equal(second.messages.length, before + 1);
  assert.deepEqual(messages(second).at(-1), { type: 'stop' });
  assert.match(ui.element('#error').textContent, /processing fell behind/);
});

test('blocked autoplay acknowledges the matching clip and its later Play action can resume the same revision', async t => {
  const ui = await fixture(t);
  const socket = await startSession(ui);
  const audio = ui.element('#audio');
  audio.play = function () { this.currentSrc = this.src; return Promise.reject(new Error('Autoplay blocked')); };
  speech(socket, 1);
  await new Promise(setImmediate);
  assert.deepEqual(messages(socket).at(-1), { type: 'playback', playing: false, revision: 1, utteranceId: 'utterance-1' });
  assert.match(ui.element('#playback-help').textContent, /Press Play/);
  socket.message({ type: 'state', state: 'followup', revision: 1 });
  ui.event('#audio', 'play');
  assert.deepEqual(messages(socket).at(-1), { type: 'playback', playing: true, revision: 1, utteranceId: 'utterance-1' });
});

test('typed and hands-free speech both carry the selected delivery and pace', async t => {
  const ui = await fixture(t);
  ui.element('#words').value = 'A synthetic test phrase.';
  ui.element('#delivery').value = 'gentle';
  ui.element('#speed').value = '0.9';
  ui.event('#words', 'input');
  await ui.event('#voice-form', 'submit');
  const request = ui.requests.find(item => item.url === '/api/voice/speak');
  assert.deepEqual(JSON.parse(request.options.body), { text: 'A synthetic test phrase.', delivery: 'gentle', speed: 0.9 });
  const socket = await startSession(ui);
  assert.deepEqual(messages(socket)[0], { type: 'start', delivery: 'gentle', speed: 0.9 });
  ui.element('#delivery').value = 'lively';
  ui.event('#delivery', 'change');
  assert.deepEqual(messages(socket).at(-1), { type: 'configure', delivery: 'lively', speed: 0.9 });
});
