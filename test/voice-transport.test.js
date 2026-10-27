import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { createVoiceApp } from '../src/voice-server.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function fixture(t, overrides = {}) {
  const listener = {
    starts: 0, closes: 0, sample: 0, calls: [],
    status() { return { configured: true, ready: false, wakeWord: 'MERLIN', localOnly: true }; },
    async start() { this.starts++; this.sample = 0; },
    async process(pcm, options) {
      this.calls.push({ pcm, options }); this.sample += pcm.length / 2;
      return { sample: this.sample, speech: false, events: [] };
    },
    close() { this.closes++; },
    ...overrides.listener,
  };
  const meta = {
    configured: true, model: 'muse-voice-transcribe-1.0', calls: [],
    async transcribe(audio, options) { this.calls.push({ audio, options }); return { text: 'Hello.' }; },
    ...overrides.meta,
  };
  const tts = {
    calls: [], closes: 0,
    status() { return { configured: true, voice: 'am_fenrir' }; },
    async synthesize(text, options) { this.calls.push({ text, options }); return Buffer.alloc(100); },
    close() { this.closes++; },
    ...overrides.tts,
  };
  const app = createVoiceApp({ listener, meta, tts });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const sockets = new Set();
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    app.server.closeAllConnections();
    await app.close();
  });
  function connect(options = {}) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${options.path || '/api/voice/session'}`, {
      origin, ...options, headers: options.headers,
    });
    const messages = [];
    socket.on('message', (data, binary) => { messages.push(binary ? { binary: Buffer.from(data) } : JSON.parse(data.toString())); });
    socket.on('error', () => {});
    sockets.add(socket);
    return { socket, messages };
  }
  async function opened(options) {
    const client = connect(options);
    await once(client.socket, 'open');
    return client;
  }
  async function start(options) {
    const client = await opened(options);
    client.socket.send(JSON.stringify({ type: 'start' }));
    await waitMessage(client, value => value.type === 'state' && value.state === 'wake');
    return client;
  }
  async function request(path, body) {
    return fetch(`${origin}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  return { ...app, listener, meta, tts, port, origin, connect, opened, start, request };
}

async function waitMessage({ socket, messages }, predicate) {
  const existing = messages.find(predicate);
  if (existing) return existing;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Expected WebSocket message did not arrive.')), 2000);
    const onMessage = (data, binary) => {
      const value = binary ? { binary: Buffer.from(data) } : JSON.parse(data.toString());
      if (predicate(value)) finish(null, value);
    };
    const onClose = () => finish(new Error('WebSocket closed before expected message.'));
    function finish(error, value) {
      clearTimeout(timer); socket.off('message', onMessage); socket.off('close', onClose);
      if (error) reject(error); else resolve(value);
    }
    socket.on('message', onMessage); socket.on('close', onClose);
  });
}

async function rejectedUpgrade(app, options, expectedStatus) {
  const { socket } = app.connect(options);
  const response = await new Promise((resolve, reject) => {
    socket.once('unexpected-response', (_request, response) => { response.resume(); socket.terminate(); resolve(response); });
    socket.once('open', () => reject(new Error('Upgrade unexpectedly succeeded.')));
    socket.once('error', error => {
      if (!error.message.includes('before the connection was established')) reject(error);
    });
  });
  assert.equal(response.statusCode, expectedStatus);
}

test('voice socket requires exact loopback host, path, and matching browser origin', { timeout: 5000 }, async t => {
  const app = await fixture(t);
  for (const options of [
    { path: '/api/voice/session?unexpected=1' }, { path: '/api/voice/other' },
    { origin: undefined }, { origin: 'null' }, { origin: 'https://attacker.example' },
    { origin: `http://localhost:${app.port}` },
    { headers: { Host: `attacker.example:${app.port}` } },
    { headers: { Host: '127.0.0.1' } },
    { headers: { 'Sec-Fetch-Site': 'cross-site' } },
  ]) await rejectedUpgrade(app, options, 403);
  const client = await app.opened({ origin: `http://localhost:${app.port}`, headers: { Host: `localhost:${app.port}` } });
  const closed = once(client.socket, 'close'); client.socket.close(); await closed;
  assert.equal(app.listener.starts, 0);
  assert.equal(app.meta.calls.length, 0);
  assert.equal(app.tts.calls.length, 0);
});

test('voice socket reserves one session and blocks REST inference until disconnect', { timeout: 5000 }, async t => {
  const app = await fixture(t);
  const client = await app.opened();
  await rejectedUpgrade(app, {}, 409);
  assert.equal((await app.request('/api/voice/speak', { text: 'Hello' })).status, 409);
  assert.equal((await app.request('/api/voice/transcribe', {})).status, 409);
  assert.equal(app.listener.starts, 0);
  const closed = once(client.socket, 'close'); client.socket.close(); await closed;
  const retry = await app.start();
  assert.equal(app.listener.starts, 1);
  assert.ok(retry.messages.some(message => message.type === 'ready'));
});

test('voice upgrade rejects a running typed speech request and succeeds after it completes', { timeout: 5000 }, async t => {
  const entered = deferred(), release = deferred();
  const app = await fixture(t, { tts: { async synthesize() { entered.resolve(); await release.promise; return Buffer.alloc(100); } } });
  const request = app.request('/api/voice/speak', { text: 'Hello' });
  await entered.promise;
  await rejectedUpgrade(app, {}, 409);
  release.resolve();
  assert.equal((await request).status, 200);
  await app.start();
});

test('voice socket waits for local readiness and standby audio makes zero cloud calls', { timeout: 5000 }, async t => {
  const app = await fixture(t);
  const client = await app.start();
  const processed = deferred();
  const originalProcess = app.listener.process;
  app.listener.process = async function(...args) {
    const result = await originalProcess.apply(this, args); processed.resolve(); return result;
  };
  const pcm = Buffer.alloc(2560, 7);
  client.socket.send(pcm);
  await processed.promise;
  assert.equal(app.listener.calls.length, 1);
  assert.deepEqual(app.listener.calls[0].pcm, pcm);
  assert.equal(app.listener.calls[0].options.keywordEnabled, true);
  assert.equal(app.meta.calls.length, 0);
  assert.equal(app.tts.calls.length, 0);
});

test('voice socket rejects PCM before readiness and aborts incomplete detector startup', { timeout: 5000 }, async t => {
  let signal;
  const entered = deferred();
  const app = await fixture(t, { listener: { async start(options) {
    signal = options.signal; entered.resolve();
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }));
  } } });
  const client = await app.opened();
  client.socket.send(JSON.stringify({ type: 'start' }));
  await entered.promise;
  const closed = once(client.socket, 'close');
  client.socket.send(Buffer.alloc(2560));
  const error = await waitMessage(client, value => value.type === 'error');
  assert.equal(error.fatal, true);
  assert.match(error.message, /after listener readiness/);
  await closed;
  assert.equal(signal.aborted, true);
  assert.equal(app.listener.calls.length, 0);
  assert.ok(app.listener.closes >= 1);
});

test('voice socket rejects wrong PCM lengths and oversized frames before local inference', { timeout: 5000 }, async t => {
  for (const length of [0, 1, 2558, 2562, 16001]) {
    const app = await fixture(t);
    const client = await app.start();
    const closed = once(client.socket, 'close');
    client.socket.send(Buffer.alloc(length));
    const [code] = await closed;
    assert.ok([1008, 1009].includes(code), `${length}: ${code}`);
    assert.equal(app.listener.calls.length, 0);
    assert.equal(app.meta.calls.length, 0);
  }
});

test('voice socket bounds queued microphone audio and cancels a stalled detector', { timeout: 5000 }, async t => {
  const release = deferred(), entered = deferred();
  const app = await fixture(t, { listener: {
    async process() { entered.resolve(); await release.promise; return { sample: 1280, speech: false, events: [] }; },
    close() { this.closes++; release.resolve(); },
  } });
  const client = await app.start();
  client.socket.send(Buffer.alloc(2560));
  await entered.promise;
  // The two-second burst budget fits 25 frames; a small real-time advance
  // lets frame 26 exercise the separate 64 KB pending-frame bound.
  for (let i = 1; i < 25; i++) client.socket.send(Buffer.alloc(2560));
  await delay(100);
  const closed = once(client.socket, 'close');
  client.socket.send(Buffer.alloc(2560));
  const error = await waitMessage(client, value => value.type === 'error');
  assert.match(error.message, /fell behind/);
  await closed;
  assert.ok(app.listener.closes >= 1);
  assert.equal(app.meta.calls.length, 0);
});

test('voice socket rejects accelerated audio floods independently of detector throughput', { timeout: 5000 }, async t => {
  const app = await fixture(t);
  const client = await app.start();
  const closed = once(client.socket, 'close');
  for (let i = 0; i < 40; i++) client.socket.send(Buffer.alloc(2560));
  const error = await waitMessage(client, value => value.type === 'error');
  assert.match(error.message, /real time/);
  await closed;
  assert.equal(app.meta.calls.length, 0);
});

test('voice controls reject malformed/unknown input, repeated start, and flooding', { timeout: 5000 }, async t => {
  for (const controls of [
    ['{invalid'], ['null'], ['[]'], [JSON.stringify({ type: 'unknown' })],
    [JSON.stringify({ type: 'start' })], [JSON.stringify({ type: 'sleep', extra: true })],
    Array.from({ length: 33 }, () => JSON.stringify({ type: 'configure', speed: 1 })),
  ]) {
    const app = await fixture(t);
    const client = await app.start();
    const closed = once(client.socket, 'close');
    for (const control of controls) client.socket.send(control);
    const error = await waitMessage(client, value => value.type === 'error');
    assert.equal(error.fatal, true);
    await closed;
    assert.equal(app.meta.calls.length, 0);
  }
});

test('voice stop and abrupt disconnect discard local capture and release inference ownership', { timeout: 5000 }, async t => {
  const app = await fixture(t);
  let client = await app.start();
  let closed = once(client.socket, 'close');
  client.socket.send(JSON.stringify({ type: 'stop' }));
  const [code] = await closed;
  assert.equal(code, 1000);
  assert.equal(app.listener.closes, 1);
  assert.equal((await app.request('/api/voice/speak', { text: 'Manual speech works again.' })).status, 200);
  client = await app.start();
  const serverClosed = deferred();
  const originalClose = app.listener.close;
  app.listener.close = function() { originalClose.call(this); serverClosed.resolve(); };
  closed = once(client.socket, 'close'); client.socket.terminate(); await closed;
  await serverClosed.promise;
  assert.equal(app.listener.closes, 2);
  await app.start();
});

test('ending a conversation discards queued audio and ignores a stale in-flight wake result', { timeout: 5000 }, async t => {
  const entered = deferred(), release = deferred(), resumed = deferred();
  const app = await fixture(t, { listener: {
    async process(pcm, options) {
      this.calls.push({ pcm, options });
      this.sample += pcm.length / 2;
      if (this.calls.length === 1) {
        entered.resolve(); await release.promise;
        return { sample: this.sample, speech: true, events: [{ type: 'wake', sample: 1280, startSample: 0, endSample: 640 }] };
      }
      resumed.resolve();
      return { sample: this.sample, speech: false, events: [] };
    },
    close() { this.closes++; release.resolve(); },
  } });
  const client = await app.start();
  client.socket.send(Buffer.alloc(2560, 1));
  await entered.promise;
  client.socket.send(Buffer.alloc(2560, 2));
  client.socket.send(Buffer.alloc(2560, 3));
  client.socket.send(JSON.stringify({ type: 'sleep' }));
  await waitMessage(client, value => value.type === 'state' && value.state === 'wake' && value.revision > 0);
  client.socket.send(Buffer.alloc(2560, 4));
  release.resolve();
  await resumed.promise;
  await delay(0);
  assert.deepEqual(app.listener.calls.map(call => call.pcm[0]), [1, 4]);
  assert.equal(app.listener.sample, 2560);
  assert.equal(client.messages.some(message => message.type === 'state' && message.state === 'listening'), false);
  assert.equal(app.meta.calls.length, 0);
  assert.equal(app.tts.calls.length, 0);
});

test('server shutdown closes active voice socket and stops both local workers', { timeout: 5000 }, async t => {
  const app = await fixture(t);
  const client = await app.start();
  const closed = once(client.socket, 'close');
  await app.close();
  await closed;
  assert.ok(app.listener.closes >= 1);
  assert.equal(app.tts.closes, 1);
  assert.equal(app.server.listening, false);
});
