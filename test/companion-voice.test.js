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

async function fixture(t, { microphone, gate, play } = {}) {
  const events = [], sockets = [], streams = [], contexts = [], worklets = [], urls = [], revoked = [], blobs = new Map();
  let micCalls = 0;
  class Surface {
    constructor() { this.handlers = new Map(); }
    addEventListener(name, handler) { const list = this.handlers.get(name) || []; list.push(handler); this.handlers.set(name, list); }
    removeEventListener(name, handler) { this.handlers.set(name, (this.handlers.get(name) || []).filter(item => item !== handler)); }
    dispatch(name, event = {}) { for (const handler of this.handlers.get(name) || []) handler(event); }
  }
  const audio = new Surface();
  Object.assign(audio, {
    src: '', currentSrc: '', paused: true, plays: 0, primes: 0,
    play() { this.currentSrc = this.src; this.paused = false; if (blobs.get(this.src)?.size === 524) this.primes++; else this.plays++; this.dispatch('play'); return play ? play(this) : Promise.resolve(); },
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
    static createObjectURL(blob) { const url = `blob:voice-${urls.length}`; urls.push(url); blobs.set(url, blob); return url; }
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
  runInContext(source.replace('export class CompanionVoiceClient', 'class CompanionVoiceClient').replace('export function unlockAudioPlayback', 'function unlockAudioPlayback') + '\nglobalThis.client = new CompanionVoiceClient({audio,onEvent,playbackGate});', vm);
  const client = vm.client;
  t.after(() => client.destroy());
  return {
    client, events, sockets, streams, contexts, worklets, audio, urls, revoked, makeStream, unlock: () => vm.unlockAudioPlayback(audio),
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
  assert.equal(h.revoked.length, 2, 'both the silent unlock clip and stale speech are released');
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

test('granted microphone reports detector startup separately from permission and silently primes playback', async t => {
  const h = await fixture(t);
  await h.client.start(contextInfo);
  assert.equal(h.client.state, 'starting');
  assert.match(h.events.at(-1).message, /Preparing local listening/);
  assert.equal(h.audio.primes, 1);
  assert.equal(h.events.some(event => event.type === 'playback'), false);
  assert.equal(h.audio.src, '');
  h.sockets[0].open(); h.sockets[0].receive({ type: 'ready', revision: 0 });
  h.sockets[0].receive({ type: 'state', state: 'wake', revision: 0 });
  assert.equal(h.client.state, 'wake');
});

test('embedded microphone denial is actionable and releases every startup resource', async t => {
  const microphone = deferred(), h = await fixture(t, { microphone });
  const start = h.client.start(contextInfo);
  microphone.reject(new DOMException('Permission denied by the embedder', 'NotAllowedError'));
  await start;
  const error = h.events.at(-1);
  assert.equal(error.code, 'microphone_permission_denied');
  assert.equal(error.permissionReason, 'policy');
  assert.match(error.message, /browser/);
  assert.equal(h.client.active, false);
  assert.equal(h.contexts[0].state, 'closed');
  assert.equal(h.sockets[0].readyState, 3);
});

test('delayed silent playback unlock cannot pause or remove a newer reply', async t => {
  const pending = deferred(), h = await fixture(t, { play: () => pending.promise });
  const unlock = h.unlock();
  assert.equal(h.audio.primes, 1);
  h.audio.src = 'blob:new-answer'; h.audio.currentSrc = 'blob:new-answer'; h.audio.paused = false;
  pending.resolve(); assert.equal(await unlock, true);
  assert.equal(h.audio.src, 'blob:new-answer');
  assert.equal(h.audio.paused, false);
  assert.equal(h.revoked.length, 1);
  await h.unlock();
  assert.equal(h.audio.primes, 1, 'unlock does not replace or replay an existing answer');
});

test('checked typed replies use the wake socket and resolve only when their face-mode playback ends', async t => {
  const h = await fixture(t), socket = await h.start();
  const requestId = contextInfo.sessionId;
  let settled = false;
  const work = h.client.speakReply(requestId).then(played => { settled = true; return played; });
  assert.deepEqual(socket.sent.at(-1), { type: 'reply_audio', requestId });
  socket.receive({ type: 'interrupt', revision: 1, reason: 'reply-audio' });
  socket.receive({ type: 'notification', kind: 'reply', requestId, revision: 1, presentationMode: 'face', response: { reply: 'Checked answer.', presentation: [] } });
  socket.receive({ type: 'audio', requestId, revision: 1, utteranceId: 'typed', presentationMode: 'face' });
  socket.receive(new ArrayBuffer(100)); await flush();
  assert.equal(settled, false);
  h.audio.ended = true; h.audio.dispatch('ended');
  assert.equal(await work, true);
});

test('busy and interrupted typed read-aloud requests finish without hanging or disabling wake capture', async t => {
  const h = await fixture(t), socket = await h.start();
  let work = h.client.speakReply(contextInfo.sessionId);
  socket.receive({ type: 'speech_complete', requestId: contextInfo.sessionId, revision: 0, played: false, reason: 'busy' });
  assert.equal(await work, false);
  work = h.client.speakReply(contextInfo.sessionId);
  socket.receive({ type: 'notification', kind: 'reply', requestId: contextInfo.sessionId, revision: 1, response: { reply: 'Checked answer.' } });
  socket.receive({ type: 'interrupt', revision: 2, reason: 'reply-audio-interrupted' });
  assert.equal(await work, false);
  assert.equal(h.client.active, true);
});

test('Stop cancels a read-aloud request still awaiting acceptance in local wake', async t => {
  const h = await fixture(t), socket = await h.start();
  const work = h.client.speakReply(contextInfo.sessionId);
  h.client.interrupt();
  assert.equal(await work, false);
  assert.equal(socket.sent.at(-1).type, 'sleep');
  socket.receive({ type: 'audio', requestId: contextInfo.sessionId, revision: 1, utteranceId: 'late', presentationMode: 'face' });
  socket.receive(new ArrayBuffer(100)); await flush();
  assert.equal(h.audio.plays, 0);
});

test('blocked notification audio survives its end acknowledgment for manual play in local wake', async t => {
  const h = await fixture(t), socket = await h.start();
  const requestId = contextInfo.sessionId, play = h.audio.play.bind(h.audio);
  h.audio.play = () => Promise.reject(new DOMException('Autoplay blocked', 'NotAllowedError'));
  const work = h.client.speakReply(requestId);
  socket.receive({ type: 'interrupt', revision: 1, reason: 'reply-audio' });
  socket.receive({ type: 'notification', kind: 'reply', requestId, revision: 1, response: { reply: 'Checked answer.' } });
  socket.receive({ type: 'audio', requestId, revision: 1, utteranceId: 'blocked', presentationMode: 'face' });
  socket.receive(new ArrayBuffer(100)); await flush();
  assert.equal(await work, false);
  const url = h.audio.src;
  assert.ok(url);
  socket.receive({ type: 'interrupt', revision: 2, reason: 'reply-audio-ended' });
  socket.receive({ type: 'state', state: 'wake', revision: 2 });
  assert.equal(h.audio.src, url);
  assert.equal(h.revoked.includes(url), false);
  assert.equal(h.client.state, 'wake', 'a player fallback does not reopen cloud follow-up listening');
  assert.equal(h.audio.plays, 0, 'the retained clip is never replayed automatically');
  const sent = socket.sent.length;
  h.audio.play = play; await h.audio.play(); await flush();
  assert.equal(h.events.at(-1).type, 'playback');
  assert.equal(h.events.at(-1).playing, true);
  assert.equal(socket.sent.length, sent, 'manual playback does not claim a finished server turn');
  h.audio.ended = true; h.audio.dispatch('ended');
  assert.equal(h.events.at(-1).state, 'wake');
  socket.receive({ type: 'interrupt', revision: 3 });
  assert.equal(h.audio.src, '');
  assert.equal(h.revoked.includes(url), true);
});

test('manual fallback waits for its presentation and cannot resume after an interruption during that wait', async t => {
  const h = await fixture(t), socket = await h.start();
  const play = h.audio.play.bind(h.audio);
  h.audio.play = () => Promise.reject(new DOMException('Autoplay blocked', 'NotAllowedError'));
  socket.receive({ type: 'audio', revision: 1, utteranceId: 'timer', presentationMode: 'body' });
  socket.receive(new ArrayBuffer(100)); await flush();
  socket.receive({ type: 'interrupt', revision: 2, reason: 'notification-ended' });
  socket.receive({ type: 'state', state: 'wake', revision: 2 });
  const gate = deferred(); h.client.setPlaybackGate(() => gate.promise);
  h.audio.play = play; await h.audio.play();
  assert.equal(h.audio.paused, true);
  assert.equal(h.events.filter(event => event.type === 'playback' && event.playing).length, 0);
  socket.receive({ type: 'interrupt', revision: 3 });
  gate.resolve(true); await flush();
  assert.equal(h.audio.src, '');
  assert.equal(h.audio.plays, 1, 'the interrupted manual gesture cannot resume audio');
});

test('Stop and a real interruption both discard blocked timer audio instead of preserving a stale fallback', async t => {
  for (const stop of [false, true]) {
    const h = await fixture(t), socket = await h.start();
    h.audio.play = () => Promise.reject(new DOMException('Autoplay blocked', 'NotAllowedError'));
    socket.receive({ type: 'audio', revision: 1, utteranceId: 'timer', presentationMode: 'body' });
    socket.receive(new ArrayBuffer(100)); await flush();
    const url = h.audio.src;
    if (stop) {
      socket.receive({ type: 'interrupt', revision: 2, reason: 'notification-ended' });
      socket.receive({ type: 'state', state: 'wake', revision: 2 });
      assert.equal(h.audio.src, url);
      h.client.interrupt();
    } else socket.receive({ type: 'interrupt', revision: 2, reason: 'notification-interrupted' });
    assert.equal(h.audio.src, '');
    assert.equal(h.revoked.includes(url), true);
    assert.equal(h.audio.plays, 0);
  }
});

test('typed read-aloud queues through cold startup and sends once capture and local wake are ready', async t => {
  const h = await fixture(t);
  await h.client.start(contextInfo);
  const socket = h.sockets.at(-1); socket.open();
  let settled = false;
  const work = h.client.speakReply(contextInfo.sessionId).then(value => { settled = true; return value; });
  await flush();
  assert.equal(settled, false);
  assert.equal(socket.sent.filter(event => event.type === 'reply_audio').length, 0);
  socket.receive({ type: 'ready', revision: 0 });
  assert.equal(socket.sent.filter(event => event.type === 'reply_audio').length, 0);
  socket.receive({ type: 'state', state: 'wake', revision: 0 });
  socket.receive({ type: 'state', state: 'wake', revision: 0 });
  assert.equal(socket.sent.filter(event => event.type === 'reply_audio').length, 1);
  h.client.stop(); assert.equal(await work, false);
});

test('canceling a queued startup reply keeps microphone preparation valid and cannot replay after restart', async t => {
  const h = await fixture(t);
  await h.client.start(contextInfo);
  let socket = h.sockets.at(-1); socket.open();
  const work = h.client.speakReply(contextInfo.sessionId);
  h.client.interrupt();
  assert.equal(await work, false);
  socket.receive({ type: 'ready', revision: 0 });
  socket.receive({ type: 'state', state: 'wake', revision: 0 });
  assert.equal(h.client.state, 'wake');
  assert.equal(socket.sent.some(event => event.type === 'reply_audio'), false);
  h.client.stop(); socket = await h.start();
  assert.equal(socket.sent.some(event => event.type === 'reply_audio'), false);
});

test('typed read-aloud waits for a pending end-conversation acknowledgment before sending', async t => {
  const h = await fixture(t), socket = await h.start();
  h.client.endConversation();
  const work = h.client.speakReply(contextInfo.sessionId);
  assert.equal(socket.sent.some(event => event.type === 'reply_audio'), false);
  socket.receive({ type: 'interrupt', revision: 1 });
  socket.receive({ type: 'state', state: 'wake', revision: 1 });
  assert.equal(socket.sent.filter(event => event.type === 'reply_audio').length, 1);
  h.client.stop(); assert.equal(await work, false);
});
