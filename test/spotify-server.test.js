import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../src/server.js';
import { AppError } from '../src/errors.js';
import { RequestLedger } from '../src/requests.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'merlin-spotify-http-'));
  const state = 'a'.repeat(43);
  let pending = false;
  const spotify = {
    calls: [], connected: false, clientId: '',
    status() { return { configured: Boolean(this.clientId), connected: this.connected, client_id: this.clientId }; },
    async configure(id) { this.clientId = id; },
    beginAuthorization(redirectUri) { pending = true; this.calls.push(['authorize', redirectUri]); return { url: `https://accounts.spotify.com/authorize?state=${state}`, state }; },
    async completeAuthorization(args) {
      this.calls.push(['callback', args]);
      if (!pending) throw new AppError('expired');
      pending = false;
      if (!args.code) throw new AppError('denied');
      this.connected = true;
    },
    async disconnect() { pending = false; this.connected = false; },
    async snapshot() { return { ...this.status(), devices: [], playback: null, results: [] }; },
    async search(args) { this.calls.push(['search', args]); return { results: [{ name: 'Synthetic track', uri: 'spotify:track:synthetic', url: 'https://open.spotify.com/track/synthetic' }] }; },
    async playlists() { return { results: [] }; },
    async control(args) { this.calls.push(['control', args]); return { ok: true, status: 'accepted', message: 'Spotify accepted the request.' }; },
  };
  const ledger = await new RequestLedger(join(directory, 'requests.jsonl')).init();
  const app = await createApp({ dataDir: directory, spotify, ledger, meta: { configured: false, model: 'test' }, learningDelayMs: 60_000 });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  });
  const port = app.server.address().port;
  const request = (path, { method = 'GET', body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method, headers: { ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}), ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, headers: res.headers, body: res.headers['content-type']?.includes('json') ? JSON.parse(text) : text }); });
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return { ...app, ledger, state, directory, port, request, post: (path, body, headers) => request(path, { method: 'POST', body, headers }) };
}

test('Spotify setup exposes public configuration, uses canonical callback and browser-bound state', async t => {
  const app = await fixture(t);
  const status = await app.request('/api/spotify/status');
  assert.equal(status.status, 200);
  assert.equal(status.body.redirect_uri, `http://127.0.0.1:${app.port}/api/spotify/callback`);
  assert.equal((await app.post('/api/spotify/config', { client_id: 'public-client-id' })).body.configured, true);
  const started = await app.post('/api/spotify/connect', {});
  assert.equal(started.status, 200);
  assert.match(started.body.url, /^https:\/\/accounts.spotify.com\//);
  const cookie = started.headers['set-cookie'][0];
  assert.match(cookie, /HttpOnly; SameSite=Lax; Max-Age=600/);
  assert.equal('state' in started.body, false);
  const callback = `/api/spotify/callback?state=${app.state}&code=synthetic-code`;
  assert.equal((await app.request(callback, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await app.request(callback, { headers: { Cookie: 'merlin_spotify_oauth=' + 'b'.repeat(43) } })).status, 403);
  assert.equal(app.spotify.calls.filter(call => call[0] === 'callback').length, 0);
  const success = await app.request(callback, { headers: { Cookie: cookie.split(';')[0], 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(success.status, 303);
  assert.equal(success.headers.location, '/?spotify=connected#spotify-title');
  assert.match(success.headers['set-cookie'][0], /Max-Age=0/);
  assert.equal(success.headers['referrer-policy'], 'no-referrer');
  assert.equal(success.headers['cache-control'], 'no-store');
  const replay = await app.request(callback, { headers: { Cookie: cookie.split(';')[0] } });
  assert.match(replay.headers.location, /spotify=error/);
});

test('OAuth exception is GET callback only; normal Spotify mutations retain origin protection', async t => {
  const app = await fixture(t);
  for (const path of ['/api/spotify/connect', '/api/spotify/config', '/api/spotify/control', '/api/spotify/disconnect', '/api/spotify/callback']) {
    assert.equal((await app.post(path, {}, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  }
  assert.equal((await app.request('/api/spotify/status', { headers: { Origin: 'https://untrusted.example' } })).status, 403);
  assert.equal((await app.post('/api/spotify/connect', {}, { Host: `localhost:${app.port}` })).status, 400);
  assert.equal((await app.post('/api/spotify/config', { client_id: 'x', client_secret: 'not-accepted' })).status, 400);
});

test('OAuth denial redirects with generic status and never echoes the code or provider error', async t => {
  const app = await fixture(t);
  const start = await app.post('/api/spotify/connect', {});
  const denied = await app.request(`/api/spotify/callback?state=${app.state}&error=access_denied&error_description=private`, { headers: { Cookie: start.headers['set-cookie'][0].split(';')[0] } });
  assert.equal(denied.status, 303);
  assert.match(denied.headers.location, /spotify=cancelled/);
  assert.equal(JSON.stringify(denied).includes('private'), false);
  assert.equal(app.spotify.connected, false);
});

test('Spotify actions use durable duplicate protection and browser-only results', async t => {
  const app = await fixture(t);
  const body = { request_id: randomUUID(), action: 'next' };
  const results = await Promise.all([app.post('/api/spotify/control', body), app.post('/api/spotify/control', body)]);
  assert.ok(results.every(result => result.status === 200));
  assert.equal(app.spotify.calls.filter(call => call[0] === 'control').length, 1);
  assert.equal((await app.post('/api/spotify/control', { ...body, action: 'previous' })).status, 409);
  assert.equal((await app.post('/api/spotify/control', { action: 'next' })).status, 400);
  assert.equal((await app.post('/api/spotify/control', { ...body, extra: true })).status, 400);
  const search = await app.post('/api/spotify/search', { query: 'synthetic query', type: 'track' });
  assert.equal(search.body.results[0].name, 'Synthetic track');
  assert.equal(app.store.snapshot().conversations.length, 0);
  const receipts = await readFile(join(app.directory, 'requests.jsonl'), 'utf8');
  assert.equal(receipts.includes('Synthetic'), false);
  assert.equal(receipts.includes(body.request_id), false);
  app.ledger.live.clear();
  assert.equal((await app.post('/api/spotify/control', body)).status, 409);
  assert.equal(app.spotify.calls.filter(call => call[0] === 'control').length, 1);
});

test('Spotify disconnect and local status work without a Meta account', async t => {
  const app = await fixture(t);
  app.spotify.connected = true;
  assert.equal((await app.request('/api/spotify')).body.connected, true);
  assert.equal((await app.post('/api/spotify/disconnect', {})).body.connected, false);
  assert.equal((await app.post('/api/spotify/playlists', {})).status, 200);
  assert.equal((await app.request('/api/state')).body.configured, false);
});

test('Manual Spotify controls enforce the same saved ban as chat while disconnect stays available', async t => {
  const app = await fixture(t);
  const rule = await app.post('/api/memory/rule', { kind: 'tool_deny', value: 'spotify_control', scope: 'tools', original: 'Do not change Spotify playback.' });
  assert.equal(rule.status, 200);
  const blocked = await app.post('/api/spotify/control', { request_id: randomUUID(), action: 'next' });
  assert.equal(blocked.status, 400);
  assert.equal(app.spotify.calls.some(call => call[0] === 'control'), false);
  assert.equal((await app.post('/api/spotify/disconnect', {})).status, 200);
});
