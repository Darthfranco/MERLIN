import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import test from 'node:test';

const flush = () => new Promise(setImmediate);
const contextInfo = { sessionId: '12345678-1234-1234-1234-123456789abc', timeZone: 'America/New_York' };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function fixture(t, { microphone, gate } = {}) {
  const events = [], sockets = [], streams = [], contexts = [], worklets = [], urls = [], revoked = [];
  let micCalls = 0;
  class Surface {
    constructor() { this.handlers = new Map(); }
    addEventListener(name, handler) { const list = this.handlers.get(name) || []; list.push(handler); this.handlers.set(name, list); }
    removeEventListener(name, handler) { this.handlers.set(name, (this.handlers.get(name) || []).filter(item => item !== handler)); }
    dispatch(name, event = {}) { for (const handler of this.handlers.get(name) || []) handler(event); }
  }
  const audio = new Surface();
  Object.assign(audio, {
    src: '', currentSrc: '', paused: true, plays: 0,
    play() { this.currentSrc = this.src; this.paused = false; this.plays++; this.dispatch('play'); return Promise.resolve(); },
    pause() { this.paused = true; this.dispatch('pause'); },
    removeAttribute(name) { if (name === 'src') this.src = ''; },
    load() { if (!this.src) this.currentSrc = ''; },
  });
  function makeStream() {
    const track = new Surface(); track.stopped = false; track.stop = () => { track.stopped = true; };
    const stream = { track, getTracks: () => [track], getAudioTracks: () => [track] };
    streams.push(stream); return stream;
  }
  class AudioContext {
    constructor({ sampleRate } = {}) { this.sampleRate = sampleRate || 48000; this.state = 'running'; this.destination = {}; this.audioWorklet = { addModule: async url => { this.module = url; } }; contexts.push(this); }
    async resume() {}
    async close() { this.state = 'closed'; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  }
  class AudioWorkletNode {
    constructor(_context, _name, options) { this.options = options; this.port = { postMessage() {} }; worklets.push(this); }
    connect() {}
    disconnect() { this.disconnected = true; }
  }
  class WebSocket extends Surface {
    static OPEN = 1; static CLOSING = 2;
    constructor(url) { super(); this.url = String(url); this.readyState = 0; this.bufferedAmount = 0; this.sent = []; sockets.push(this); }
    send(value) { this.sent.push(typeof value === 'string' ? JSON.parse(value) : value); }
    open() { this.readyState = 1; this.dispatch('open'); }
    close() { this.readyState = 3; this.dispatch('close'); }
    receive(value) { this.dispatch('message', { data: value instanceof ArrayBuffer ? value : JSON.stringify(value) }); }
  }
  class ObjectURL extends URL {
    static createObjectURL() { const url = `blob:voice-${urls.length}`; urls.push(url); return url; }
    static revokeObjectURL(url) { revoked.push(url); }
  }
  const document = new Surface(); document.visibilityState = 'visible';
  const window = new Surface(); Object.assign(window, { AudioContext, AudioWorkletNode, WebSocket, location: { href: 'http://localhost:3000/companion/' } });
  const vm = createContext({
    audio, onEvent: event => events.push(event), playbackGate: gate || (async () => {}), document, window,
    navigator: { mediaDevices: { getUserMedia: () => { micCalls++; return microphone ? microphone.promise : Promise.resolve(makeStream()); } } },
    AudioContext, AudioWorkletNode, WebSocket, URL: ObjectURL, AbortController, DOMException, ArrayBuffer, Blob, setTimeout, clearTimeout,
  });
  const source = await readFile(new URL('../public/companion/voice-client.js', import.meta.url), 'utf8');
  runInContext(source.replace('export class CompanionVoiceClient', 'class CompanionVoiceClient') + '\nglobalThis.client = new CompanionVoiceClient({audio,onEvent,playbackGate});', vm);
  const client = vm.client;
  t.after(() => client.destroy());
  return {
    client, events, sockets, streams, contexts, worklets, audio, urls, revoked, makeStream,
    get micCalls() { return micCalls; },
    async start() {
      await client.start(contextInfo);
      const socket = sockets.at(-1); socket.open();
      socket.receive({ type: 'ready', revision: 0 });
      socket.receive({ type: 'state', state: 'wake', revision: 0 });
      return socket;
    },
    hide() { document.visibilityState = 'hidden'; document.dispatch('visibilitychange'); },
    leave() { window.dispatch('pagehide'); },
  };
}

test('companion voice requests capture only on explicit start and sends frames only after local readiness', async t => {
  const h = await fixture(t);
  assert.equal(h.micCalls, 0);
  assert.equal(h.sockets.length, 0);
  await h.client.start(contextInfo);
  assert.equal(h.micCalls, 1);
  const socket = h.sockets[0]; socket.open();
  assert.equal(socket.url, 'ws://localhost:3000/api/voice/session');
  assert.equal(socket.sent[0].sessionId, contextInfo.sessionId);
  assert.equal(socket.sent[0].timeZone, contextInfo.timeZone);
  assert.equal(h.contexts[0].module, '/voice/recorder-worklet.js');
  const pcm = new ArrayBuffer(2560);
  h.worklets[0].port.onmessage({ data: { type: 'frame', pcm } });
  assert.equal(socket.sent.length, 1);
  socket.receive({ type: 'ready', revision: 0 });
  socket.receive({ type: 'state', state: 'wake', revision: 0 });
  h.worklets[0].port.onmessage({ data: { type: 'frame', pcm } });
  assert.equal(socket.sent[1], pcm);
  assert.equal(h.client.state, 'wake');
  h.hide();
  assert.equal(h.client.active, false);
  assert.equal(h.streams[0].track.stopped, true);
  assert.equal(h.contexts[0].state, 'closed');
  assert.equal(socket.readyState, 3);
  assert.equal(h.client.state, 'off');
});

test('microphone permission resolving after stop cannot restart capture', async t => {
  const microphone = deferred(), h = await fixture(t, { microphone });
  const start = h.client.start(contextInfo);
  h.client.stop();
  const stream = h.makeStream(); microphone.resolve(stream); await start;
  assert.equal(stream.track.stopped, true);
  assert.equal(h.worklets.length, 0);
  assert.equal(h.client.active, false);
  assert.equal(h.contexts[0].state, 'closed');
});

test('audio waits for the presentation gate and an interruption invalidates the waiting clip', async t => {
  const gate = deferred(), h = await fixture(t, { gate: () => gate.promise });
  const socket = await h.start();
  socket.receive({ type: 'state', state: 'speaking', revision: 2 });
  socket.receive({ type: 'audio', revision: 2, utteranceId: 'old' });
  socket.receive(new ArrayBuffer(100));
  assert.equal(h.audio.plays, 0);
  socket.receive({ type: 'interrupt', revision: 3 });
  gate.resolve(); await flush();
  assert.equal(h.audio.plays, 0);
  assert.equal(h.revoked.length, 1);
  h.client.setPlaybackGate(async () => {});
  socket.receive({ type: 'audio', revision: 3, utteranceId: 'new' });
  socket.receive(new ArrayBuffer(100)); await flush();
  assert.equal(h.audio.plays, 1);
  assert.equal(socket.sent.at(-1).type, 'playback');
  assert.equal(socket.sent.at(-1).utteranceId, 'new');
  assert.equal(socket.sent.at(-1).playing, true);
});

test('stale response and audio cannot replace a new turn, while progress stays revision tagged', async t => {
  const h = await fixture(t), socket = await h.start();
  socket.receive({ type: 'state', state: 'processing', revision: 4 });
  socket.receive({ type: 'response', revision: 3, response: { reply: 'STALE' } });
  socket.receive({ type: 'audio', revision: 3, utteranceId: 'stale' });
  socket.receive(new ArrayBuffer(100));
  socket.receive({ type: 'progress', revision: 4, progress: { stage: 'action' } });
  socket.receive({ type: 'response', revision: 4, response: { reply: 'Current answer' } });
  await flush();
  assert.equal(h.audio.plays, 0);
  assert.equal(JSON.stringify(h.events).includes('STALE'), false);
  assert.equal(h.events.find(event => event.type === 'progress').revision, 4);
  assert.equal(h.events.find(event => event.type === 'response').response.reply, 'Current answer');
});

test('manual interruption rejects in-flight audio until a newer server revision arrives', async t => {
  const h = await fixture(t), socket = await h.start();
  socket.receive({ type: 'state', state: 'generating', revision: 5 });
  h.client.interrupt();
  assert.equal(socket.sent.at(-1).type, 'interrupt');
  socket.receive({ type: 'response', revision: 5, response: { reply: 'STALE' } });
  socket.receive({ type: 'audio', revision: 5, utteranceId: 'stale' });
  socket.receive(new ArrayBuffer(100));
  socket.receive({ type: 'interrupt', revision: 6 });
  socket.receive({ type: 'state', state: 'followup', revision: 6 });
  await flush();
  assert.equal(h.audio.plays, 0);
  assert.equal(JSON.stringify(h.events).includes('STALE'), false);
  assert.equal(h.client.state, 'followup');
  assert.equal(h.client.active, true);
});

test('end conversation suppresses queued output until wake and page exit stops all capture', async t => {
  const h = await fixture(t), socket = await h.start();
  socket.receive({ type: 'state', state: 'processing', revision: 2 });
  h.client.endConversation();
  socket.receive({ type: 'transcript', revision: 2, text: 'STALE' });
  socket.receive({ type: 'audio', revision: 2, utteranceId: 'stale' });
  socket.receive(new ArrayBuffer(100));
  socket.receive({ type: 'interrupt', revision: 3 });
  socket.receive({ type: 'state', state: 'wake', revision: 3 });
  assert.equal(h.client.state, 'wake');
  assert.equal(JSON.stringify(h.events).includes('STALE'), false);
  assert.equal(h.events.some(event => event.type === 'interrupt'), false, 'sleep acknowledgment must not interrupt a newly started typed turn');
  assert.equal(h.audio.plays, 0);
  h.leave();
  assert.equal(h.client.active, false);
  assert.ok(h.streams.every(stream => stream.track.stopped));
});

test('playback receipts are tied to the current clip and duplicate completion does not reset quiet time', async t => {
  const h = await fixture(t), socket = await h.start();
  socket.receive({ type: 'audio', revision: 2, utteranceId: 'current' });
  socket.receive(new ArrayBuffer(100)); await flush();
  h.audio.pause(); h.audio.pause(); h.audio.ended = true; h.audio.dispatch('ended');
  assert.equal(socket.sent.filter(event => event.type === 'playback' && event.playing === false).length, 1);
  socket.receive({ type: 'interrupt', revision: 3 });
  h.audio.dispatch('play');
  assert.equal(socket.sent.filter(event => event.type === 'playback').length, 2);
});

test('socket failure releases capture and a delayed playback gate cannot restart sound', async t => {
  const gate = deferred(), h = await fixture(t, { gate: () => gate.promise });
  const socket = await h.start();
  socket.receive({ type: 'audio', revision: 2, utteranceId: 'current' });
  socket.receive(new ArrayBuffer(100));
  socket.dispatch('error');
  gate.resolve(); await flush();
  assert.equal(h.client.active, false);
  assert.equal(h.streams[0].track.stopped, true);
  assert.equal(h.audio.plays, 0);
  assert.equal(h.events.at(-1).fatal, true);
});

test('timer alerts carry only an ID and body presentation reaches the playback gate and events', async t => {
  const headers = [], h = await fixture(t, { gate: async header => headers.push(header) });
  const socket = await h.start();
  assert.equal(h.client.announceTimer('synthetic-timer'), true);
  assert.deepEqual(socket.sent.at(-1), { type: 'timer_alert', timerId: 'synthetic-timer' });
  socket.receive({ type: 'interrupt', revision: 1, reason: 'notification' });
  socket.receive({ type: 'notification', revision: 1, presentationMode: 'body', response: { reply: 'Your timer is finished.', presentation: [{ type: 'timer' }] } });
  socket.receive({ type: 'state', state: 'speaking', revision: 1, presentationMode: 'body' });
  assert.equal(h.client.announceTimer('another-timer'), false);
  socket.receive({ type: 'audio', revision: 1, utteranceId: 'timer-alert', presentationMode: 'body' });
  socket.receive(new ArrayBuffer(100)); await flush();
  assert.equal(headers[0].presentationMode, 'body');
  assert.equal(h.events.find(event => event.type === 'notification').response.reply, 'Your timer is finished.');
  assert.equal(h.events.find(event => event.type === 'playback').presentationMode, 'body');
  assert.equal(socket.sent.at(-1).presentationMode, undefined, 'browser-only display hints are not sent as playback authorization');
});
