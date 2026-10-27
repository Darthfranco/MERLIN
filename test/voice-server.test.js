import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import test from 'node:test';
import { createVoiceApp } from '../src/voice-server.js';
import { AppError } from '../src/errors.js';
import { MAX_AUDIO_BYTES } from '../src/voice/audio.js';

function wav() {
  const audio = Buffer.alloc(44 + 3200);
  audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(16_000, 24); audio.writeUInt32LE(32_000, 28);
  audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
  audio.write('data', 36); audio.writeUInt32LE(3200, 40);
  return audio;
}

async function fixture(t, overrides = {}) {
  const meta = {
    configured: true, model: 'muse-voice-transcribe-1.0', calls: [],
    async transcribe(audio, options) { this.calls.push({ audio, options }); return { text: 'Synthetic spoken words.', model: this.model, audioDurationMs: 100 }; },
    ...overrides.meta,
  };
  const tts = {
    calls: [], closed: false,
    status() { return { ready: true, model: 'Kokoro-82M', voice: 'am_fenrir' }; },
    async synthesize(text, options) { this.calls.push({ text, options }); return wav(); },
    async close() { this.closed = true; },
    ...overrides.tts,
  };
  const app = createVoiceApp({ meta, tts });
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    app.server.closeAllConnections();
    await app.close();
  });
  const port = app.server.address().port;
  const request = (path, { method = 'GET', body, raw, headers = {} } = {}) => new Promise((resolve, reject) => {
    const bytes = raw ?? (body === undefined ? undefined : Buffer.from(JSON.stringify(body)));
    const req = httpRequest({ hostname: '127.0.0.1', port, method, path, agent: false,
      headers: { ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}), ...(bytes ? { 'Content-Length': bytes.length } : {}), ...headers },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, raw,
          body: res.headers['content-type']?.includes('application/json') ? JSON.parse(raw.toString('utf8')) : raw.toString('utf8') });
      });
    });
    req.on('error', reject);
    req.end(bytes);
  });
  return { ...app, meta, tts, port, request,
    speak: (body, extra = {}) => request('/api/voice/speak', { method: 'POST', body, ...extra }),
    transcribe: (audio = wav(), extra = {}) => request('/api/voice/transcribe', { method: 'POST', raw: audio, headers: { 'Content-Type': 'audio/wav' }, ...extra }),
  };
}

test('voice status exposes readiness and limits without starting synthesis or transcription', async t => {
  const app = await fixture(t, { meta: { configured: false } });
  const response = await app.request('/api/voice/status');
  assert.equal(response.status, 200);
  assert.equal(response.body.metaConfigured, false);
  assert.equal(response.body.transcriptionModel, 'muse-voice-transcribe-1.0');
  assert.equal(response.body.voice, 'am_fenrir');
  assert.equal(response.body.tts.ready, true);
  assert.deepEqual(response.body.limits, { maxTextCharacters: 2000, maxRecordingSeconds: 60, maxAudioBytes: MAX_AUDIO_BYTES });
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(app.meta.calls.length, 0);
  assert.equal(app.tts.calls.length, 0);
});

test('voice lab serves a separate development UI and does not expose assistant or private file routes', async t => {
  const app = await fixture(t);
  const page = await app.request('/');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.match(page.body, /Fenrir/i);
  assert.match(page.headers['permissions-policy'], /microphone=\(self\)/);
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  for (const path of ['/api/chat', '/api/state', '/api/memory', '/.env', '/../.env', '/src/voice/meta.js']) {
    assert.equal((await app.request(path)).status, 404, path);
  }
});

test('typed words are spoken verbatim by Fenrir without a Meta key or a transcription call', async t => {
  const app = await fixture(t, { meta: { configured: false } });
  const text = 'Hello, Merlin. Keep <tags> and punctuation as text.';
  const response = await app.speak({ text });
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-type'], 'audio/wav');
  assert.equal(response.headers['x-voice'], 'am_fenrir');
  assert.equal(Number(response.headers['content-length']), response.raw.length);
  assert.ok(Number(response.headers['x-generation-ms']) >= 0);
  assert.deepEqual(response.raw, wav());
  assert.equal(app.tts.calls[0].text, text);
  assert.equal(app.tts.calls[0].options.speed, 1);
  assert.ok(app.tts.calls[0].options.signal instanceof AbortSignal);
  assert.equal(app.meta.calls.length, 0);
});

test('typed speech enforces text, speed, content-type, JSON, and request size limits before synthesis', async t => {
  const app = await fixture(t);
  const invalid = [null, [], {}, { text: '' }, { text: ' \n ' }, { text: 42 }, { text: 'x'.repeat(2001) },
    { text: 'Hello', voice: 'different' }, { text: 'Hello', speed: '1' }, { text: 'Hello', speed: 0.74 }, { text: 'Hello', speed: 1.26 }];
  for (const body of invalid) assert.equal((await app.speak(body)).status, 400, JSON.stringify(body));
  assert.equal((await app.speak(undefined, { raw: Buffer.from('{broken') })).status, 400);
  assert.equal((await app.speak({ text: 'Hello' }, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await app.speak(undefined, { raw: Buffer.from('x'.repeat(16_385)) })).status, 413);
  assert.equal(app.tts.calls.length, 0);
  for (const speed of [0.75, 1.25]) {
    assert.equal((await app.speak({ text: 'x'.repeat(2000), speed })).status, 200);
    assert.equal(app.tts.calls.at(-1).options.speed, speed);
  }
});

test('recorded WAV is transcribed by Meta and returned as text without implicit synthesis', async t => {
  const app = await fixture(t);
  const audio = wav();
  const response = await app.transcribe(audio);
  assert.equal(response.status, 200);
  assert.equal(response.body.text, 'Synthetic spoken words.');
  assert.equal(response.body.model, 'muse-voice-transcribe-1.0');
  assert.ok(Number.isFinite(response.body.elapsedMs) && response.body.elapsedMs >= 0);
  assert.equal(app.meta.calls.length, 1);
  assert.deepEqual(app.meta.calls[0].audio, audio);
  assert.ok(app.meta.calls[0].options.signal instanceof AbortSignal);
  assert.equal(app.tts.calls.length, 0);
});

test('recorded input rejects unsupported audio, malformed WAV, and oversize uploads before Meta', async t => {
  const app = await fixture(t);
  assert.equal((await app.transcribe(wav(), { headers: { 'Content-Type': 'audio/webm' } })).status, 415);
  assert.equal((await app.transcribe(Buffer.from('not WAV'))).status, 415);
  assert.equal((await app.transcribe(Buffer.alloc(0), { headers: { 'Content-Type': 'audio/wav', 'Content-Length': MAX_AUDIO_BYTES + 1 } })).status, 413);
  const stereo = wav(); stereo.writeUInt16LE(2, 22);
  assert.equal((await app.transcribe(stereo)).status, 415);
  assert.equal(app.meta.calls.length, 0);
});

test('voice endpoints require the local host and matching browser origin', async t => {
  const app = await fixture(t);
  for (const host of [`localhost:${app.port}`, `127.0.0.1:${app.port}`]) {
    assert.equal((await app.request('/api/voice/status', { headers: { Host: host, Origin: `http://${host}` } })).status, 200);
  }
  for (const headers of [
    { Host: `attacker.example:${app.port}` }, { Host: 'localhost' },
    { Host: `localhost:${app.port + 1}` }, { Origin: 'https://attacker.example' },
    { Origin: 'null' }, { Origin: `http://localhost:${app.port}` },
    { Origin: `http://127.0.0.1:${app.port + 1}` }, { 'Sec-Fetch-Site': 'cross-site' },
  ]) {
    assert.equal((await app.speak({ text: 'Do not generate this.' }, { headers })).status, 403, JSON.stringify(headers));
    assert.equal((await app.request('/api/voice/status', { headers })).status, 403, JSON.stringify(headers));
  }
  assert.equal(app.tts.calls.length, 0);
  assert.equal(app.meta.calls.length, 0);
});

test('voice errors are truthful and do not expose arbitrary provider or process errors', async t => {
  const privateText = 'synthetic private transcript or worker diagnostic';
  const app = await fixture(t, {
    meta: { async transcribe() { throw new Error(privateText); } },
    tts: { async synthesize() { throw new Error(privateText); } },
  });
  for (const response of [await app.speak({ text: 'Hello' }), await app.transcribe()]) {
    assert.equal(response.status, 500);
    assert.equal(response.body.error.includes(privateText), false);
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  app.meta.transcribe = async () => { throw new AppError('Add META_API_KEY to connect transcription.', 503); };
  const unconfigured = await app.transcribe();
  assert.equal(unconfigured.status, 503);
  assert.match(unconfigured.body.error, /META_API_KEY/);
});

test('voice synthesis limits concurrent requests and releases the slot after failure', async t => {
  let entered;
  let release;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const app = await fixture(t, { tts: { async synthesize() { entered(); await pending; throw new AppError('Synthetic failure.', 502); } } });
  const first = app.speak({ text: 'First' });
  await started;
  assert.equal((await app.speak({ text: 'Second' })).status, 429);
  release();
  assert.equal((await first).status, 502);
  app.tts.synthesize = async () => wav();
  assert.equal((await app.speak({ text: 'Third' })).status, 200);
});

test('voice transcription limits concurrent uploads and releases the slot after failure', async t => {
  let entered;
  let release;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const app = await fixture(t, { meta: { async transcribe() { entered(); await pending; throw new AppError('Synthetic failure.', 502); } } });
  const first = app.transcribe();
  await started;
  assert.equal((await app.transcribe()).status, 429);
  release();
  assert.equal((await first).status, 502);
  app.meta.transcribe = async () => ({ text: 'Retry works.', model: 'muse-voice-transcribe-1.0' });
  assert.equal((await app.transcribe()).status, 200);
});

test('closing the browser request aborts in-flight transcription and allows a new recording', { timeout: 2000 }, async t => {
  let entered;
  let cancelled;
  const started = new Promise(resolve => { entered = resolve; });
  const aborted = new Promise(resolve => { cancelled = resolve; });
  const app = await fixture(t, { meta: {
    async transcribe(_audio, { signal }) {
      entered();
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
        cancelled();
        reject(new AppError('Transcription cancelled.', 499));
      }, { once: true }));
    },
  } });
  const audio = wav();
  const request = httpRequest({ hostname: '127.0.0.1', port: app.port, method: 'POST', path: '/api/voice/transcribe', agent: false,
    headers: { 'Content-Type': 'audio/wav', 'Content-Length': audio.length },
  });
  request.on('error', () => {});
  request.end(audio);
  await started;
  request.destroy();
  await aborted;
  app.meta.transcribe = async () => ({ text: 'A new recording.', model: 'muse-voice-transcribe-1.0' });
  assert.equal((await app.transcribe()).status, 200);
});
