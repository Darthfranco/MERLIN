import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpotifyService } from '../src/spotify.js';

const CLIENT = 'a'.repeat(32);
const REDIRECT = 'http://127.0.0.1:3210/api/spotify/callback';
const SCOPES = 'user-read-playback-state user-modify-playback-state playlist-read-private';
const TRACK = 'spotify:track:1234567890123456789012';
const ALBUM = 'spotify:album:1234567890123456789012';
const PLAYLIST = 'spotify:playlist:1234567890123456789012';
const otherTrack = 'spotify:track:abcdefghijklmnopqrstuv';
const json = (body, status = 200, headers) => new Response(JSON.stringify(body), { status, headers });
const empty = () => new Response(null, { status: 204 });
const token = (extra = {}) => ({ access_token: 'secret-access', refresh_token: 'secret-refresh', token_type: 'Bearer', expires_in: 3600, scope: SCOPES, ...extra });
const track = (extra = {}) => ({ name: 'Synthetic song', uri: TRACK, artists: [{ name: 'Synthetic artist' }], album: { images: [{ url: 'https://i.scdn.co/image/example' }] }, ...extra });
const device = (extra = {}) => ({ id: 'device1', name: 'Living room', type: 'Computer', is_active: true, is_restricted: false, volume_percent: 40, supports_volume: true, ...extra });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t, handler = () => empty(), { connected = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'merlin-spotify-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, 'spotify.json');
  let now = Date.parse('2026-10-26T15:00:00.000Z'); const calls = [];
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url); calls.push({ url: parsed, ...options });
    if (parsed.pathname === '/api/token') return tokenHandler(options);
    return handler(parsed, options);
  };
  let tokenHandler = () => json(token());
  const service = await new SpotifyService({ filePath, clientId: CLIENT, fetchImpl, now: () => now }).init();
  if (connected) {
    const { state } = service.beginAuthorization(REDIRECT);
    await service.completeAuthorization({ code: 'synthetic-code', state, redirectUri: REDIRECT });
  }
  calls.length = 0;
  return { service, filePath, calls, fetchImpl, now: () => now, advance: ms => { now += ms; }, setToken: handler => { tokenHandler = handler; } };
}

test('PKCE uses an expiring one-time state, minimal scopes, no client secret, and private durable credentials', async t => {
  const f = await fixture(t, undefined, { connected: false });
  const auth = f.service.beginAuthorization(REDIRECT); const url = new URL(auth.url);
  assert.equal(url.origin, 'https://accounts.spotify.com'); assert.equal(url.pathname, '/authorize');
  assert.equal(url.searchParams.get('state'), auth.state); assert.equal(url.searchParams.get('scope'), SCOPES);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('redirect_uri'), REDIRECT);
  await f.service.completeAuthorization({ code: 'code', state: auth.state, redirectUri: REDIRECT });
  const request = f.calls[0]; const body = new URLSearchParams(request.body);
  assert.equal(body.get('grant_type'), 'authorization_code'); assert.equal(body.get('client_secret'), null);
  assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'), url.searchParams.get('code_challenge'));
  assert.equal(request.redirect, 'error'); assert.ok(request.signal instanceof AbortSignal);
  assert.deepEqual(f.service.status(), { configured: true, connected: true, client_id: CLIENT });
  assert.equal((await stat(f.filePath)).mode & 0o777, 0o600);
  const stored = JSON.parse(await readFile(f.filePath, 'utf8'));
  assert.deepEqual(Object.keys(stored).sort(), ['client_id', 'credentials', 'version']);
  assert.equal(stored.credentials.access_token, 'secret-access');
  assert.ok(!JSON.stringify(f.service.status()).includes('secret'));
  const restart = await new SpotifyService({ filePath: f.filePath, fetchImpl: f.fetchImpl, now: f.now }).init();
  assert.equal(restart.status().connected, true);
  await assert.rejects(f.service.completeAuthorization({ code: 'code', state: auth.state, redirectUri: REDIRECT }), { code: 'SPOTIFY_AUTHORIZATION' });
  const expires = f.service.beginAuthorization(REDIRECT); f.advance(600_000);
  await assert.rejects(f.service.completeAuthorization({ code: 'code', state: expires.state, redirectUri: REDIRECT }), { code: 'SPOTIFY_AUTHORIZATION' });
  assert.equal(f.calls.length, 1);
});

test('authorization rejects unknown state and mismatched callbacks, and configure/disconnect clear pending credentials', async t => {
  const f = await fixture(t, undefined, { connected: false });
  for (const uri of ['http://localhost:3210/callback', 'https://evil.example/callback', 'http://127.0.0.1:3210/callback?next=evil', 'http://user@127.0.0.1/callback']) {
    assert.throws(() => f.service.beginAuthorization(uri), { code: 'SPOTIFY_INVALID' });
  }
  await assert.rejects(f.service.completeAuthorization({ code: 'code', state: 'unknown', redirectUri: REDIRECT }), { code: 'SPOTIFY_AUTHORIZATION' });
  const auth = f.service.beginAuthorization(REDIRECT);
  await assert.rejects(f.service.completeAuthorization({ code: 'code', state: auth.state, redirectUri: `${REDIRECT}/other` }), { code: 'SPOTIFY_AUTHORIZATION' });
  await assert.rejects(f.service.completeAuthorization({ code: 'code', state: auth.state, redirectUri: REDIRECT }), { code: 'SPOTIFY_AUTHORIZATION' });
  const pending = f.service.beginAuthorization(REDIRECT); await f.service.configure('b'.repeat(32));
  await assert.rejects(f.service.completeAuthorization({ code: 'code', state: pending.state, redirectUri: REDIRECT }), { code: 'SPOTIFY_AUTHORIZATION' });
  assert.equal(f.calls.length, 0);
  await f.service.disconnect(); assert.equal(f.service.status().client_id, 'b'.repeat(32));
});

test('bad credential files fail closed without replacing the file or exposing its contents', async t => {
  const f = await fixture(t); await writeFile(f.filePath, '{secret-private-invalid', 'utf8');
  await assert.rejects(new SpotifyService({ filePath: f.filePath }).init(), error => {
    assert.equal(error.code, 'SPOTIFY_STORAGE'); assert.ok(!error.message.includes('secret-private')); return true;
  });
  assert.equal(await readFile(f.filePath, 'utf8'), '{secret-private-invalid');
});

test('unconfigured setup stays disconnected and invalid token payloads never become credentials', async t => {
  const f = await fixture(t, undefined, { connected: false });
  const unconfiguredPath = join(f.filePath, '..', 'unconfigured.json');
  const unconfigured = await new SpotifyService({ filePath: unconfiguredPath, fetchImpl: f.fetchImpl }).init();
  assert.deepEqual(unconfigured.status(), { configured: false, connected: false, client_id: '' });
  assert.throws(() => unconfigured.beginAuthorization(REDIRECT), { code: 'SPOTIFY_NOT_CONFIGURED' });
  await assert.rejects(unconfigured.control({ action: 'play' }), { code: 'SPOTIFY_NOT_CONNECTED' });
  for (const response of [token({ scope: 'user-read-playback-state' }), token({ token_type: 'Other' }), token({ expires_in: -1 }), token({ access_token: 'bad\ntoken' })]) {
    f.setToken(() => json(response)); const { state } = f.service.beginAuthorization(REDIRECT);
    await assert.rejects(f.service.completeAuthorization({ code: 'code', state, redirectUri: REDIRECT }), { code: 'SPOTIFY_UNAVAILABLE' });
    assert.equal(f.service.status().connected, false);
  }
  assert.equal(JSON.parse(await readFile(f.filePath, 'utf8')).credentials, null);
  await assert.rejects(f.service.search({ query: 'song', unexpected: true }), { code: 'SPOTIFY_INVALID' });
  await assert.rejects(f.service.snapshot({ unexpected: true }), { code: 'SPOTIFY_INVALID' });
});

test('configuration persistence failures preserve the prior connection; disconnect fails closed and reports failure', async t => {
  const f = await fixture(t);
  await rm(f.filePath); await mkdir(f.filePath);
  await assert.rejects(f.service.configure('b'.repeat(32)), { code: 'SPOTIFY_STORAGE' });
  assert.deepEqual(f.service.status(), { configured: true, connected: true, client_id: CLIENT });
  await assert.rejects(f.service.disconnect(), { code: 'SPOTIFY_STORAGE' });
  assert.equal(f.service.status().connected, false);
});

test('snapshot and searches expose bounded browser metadata while persisting no Spotify names, devices, or results', async t => {
  const f = await fixture(t, url => {
    if (url.pathname.endsWith('/devices')) return json({ devices: [device()] });
    if (url.pathname === '/v1/me/player') return json({ is_playing: true, device: device(), item: track() });
    if (url.pathname === '/v1/search') {
      assert.equal(url.searchParams.get('limit'), '5');
      return json({ tracks: { items: [track({ external_urls: { spotify: 'https://malicious.example' } }), track(), null, track({ uri: 'file:///secret' })] } });
    }
    if (url.pathname === '/v1/me/playlists') return json({ items: [{ name: 'Private playlist', uri: PLAYLIST, images: [{ url: 'https://evil.example/tracker' }] }] });
    assert.fail(`Unexpected path ${url.pathname}`);
  });
  const result = await f.service.search({ query: 'synthetic' });
  assert.equal(result.results.length, 1); assert.equal(result.results[0].url, 'https://open.spotify.com/track/1234567890123456789012');
  const snapshot = await f.service.snapshot();
  assert.equal(snapshot.playback.track.name, 'Synthetic song'); assert.deepEqual(snapshot.playback.track.artists, ['Synthetic artist']);
  assert.equal(snapshot.devices[0].name, 'Living room'); assert.equal(snapshot.results.length, 1);
  snapshot.devices[0].name = 'mutated';
  const before = f.calls.length; assert.equal((await f.service.snapshot()).devices[0].name, 'Living room'); assert.equal(f.calls.length, before);
  const playlists = await f.service.playlists(); assert.equal(playlists.results[0].image_url, null);
  const stored = await readFile(f.filePath, 'utf8');
  for (const value of ['Synthetic', 'Living room', 'Private playlist', TRACK]) assert.ok(!stored.includes(value));
  f.advance(60_001); assert.deepEqual((await f.service.snapshot()).results, []);
  await f.service.disconnect();
  assert.deepEqual(await f.service.snapshot(), { configured: true, connected: false, client_id: CLIENT, devices: [], playback: null, results: [] });
  assert.equal(JSON.parse(await readFile(f.filePath, 'utf8')).credentials, null);
});

test('concurrent expired-token reads refresh once and retain an omitted refresh token', async t => {
  const f = await fixture(t, url => url.pathname.endsWith('/devices') ? json({ devices: [] }) : empty());
  f.advance(3_600_000); const gate = deferred(); let refreshes = 0;
  f.setToken(async options => {
    refreshes++; assert.equal(new URLSearchParams(options.body).get('refresh_token'), 'secret-refresh');
    await gate.promise; return json(token({ access_token: 'new-access', refresh_token: undefined, scope: undefined }));
  });
  const snapshot = f.service.snapshot(); const search = f.service.search({ query: 'example' });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(refreshes, 1); gate.resolve();
  await Promise.all([snapshot, search]);
  assert.equal(JSON.parse(await readFile(f.filePath, 'utf8')).credentials.refresh_token, 'secret-refresh');
  const apiCalls = f.calls.filter(call => call.url.host === 'api.spotify.com');
  assert.ok(apiCalls.every(call => call.headers.Authorization === 'Bearer new-access'));
});

test('disconnect wins against late refresh, OAuth completion, and metadata reads', async t => {
  const f = await fixture(t, () => empty()); f.advance(3_600_000);
  const refreshGate = deferred(); f.setToken(() => refreshGate.promise);
  const read = f.service.search({ query: 'private' }); await new Promise(resolve => setImmediate(resolve));
  await f.service.disconnect(); refreshGate.resolve(json(token({ access_token: 'late-access' })));
  await assert.rejects(read, { code: 'SPOTIFY_STALE' });
  assert.equal(f.service.status().connected, false); assert.equal(JSON.parse(await readFile(f.filePath, 'utf8')).credentials, null);
  const auth = f.service.beginAuthorization(REDIRECT); const authGate = deferred(); f.setToken(() => authGate.promise);
  const completing = f.service.completeAuthorization({ code: 'code', state: auth.state, redirectUri: REDIRECT });
  await new Promise(resolve => setImmediate(resolve)); await f.service.disconnect(); authGate.resolve(json(token()));
  await assert.rejects(completing, { code: 'SPOTIFY_STALE' });
  assert.equal(JSON.parse(await readFile(f.filePath, 'utf8')).credentials, null);

  const searchGate = deferred(); const second = await fixture(t, () => searchGate.promise);
  const searching = second.service.search({ query: 'private' }); await new Promise(resolve => setImmediate(resolve));
  await second.service.disconnect(); searchGate.resolve(json({ tracks: { items: [track()] } }));
  await assert.rejects(searching, { code: 'SPOTIFY_STALE' }); assert.deepEqual((await second.service.snapshot()).results, []);
});

test('reconnecting invalidates the old account refresh before it can replace new credentials', async t => {
  const f = await fixture(t, () => json({ tracks: { items: [] } })); f.advance(3_600_000);
  const gate = deferred();
  f.setToken(options => new URLSearchParams(options.body).get('grant_type') === 'refresh_token'
    ? gate.promise : json(token({ access_token: 'new-account-access', refresh_token: 'new-account-refresh' })));
  const reading = f.service.search({ query: 'old account' }); await new Promise(resolve => setImmediate(resolve));
  const { state } = f.service.beginAuthorization(REDIRECT);
  await f.service.completeAuthorization({ code: 'new-account-code', state, redirectUri: REDIRECT });
  gate.resolve(json(token({ access_token: 'old-account-late-refresh' })));
  await assert.rejects(reading, { code: 'SPOTIFY_STALE' });
  const stored = JSON.parse(await readFile(f.filePath, 'utf8'));
  assert.equal(stored.credentials.access_token, 'new-account-access');
  assert.equal(stored.credentials.refresh_token, 'new-account-refresh');
});

test('revoked refresh credentials are removed and error messages never include response bodies or secrets', async t => {
  const f = await fixture(t); f.advance(3_600_000);
  f.setToken(() => json({ error: 'secret-refresh private provider details' }, 400));
  await assert.rejects(f.service.search({ query: 'example' }), error => {
    assert.equal(error.code, 'SPOTIFY_AUTHORIZATION'); assert.ok(!error.message.includes('secret')); return true;
  });
  assert.equal(f.service.status().connected, false);
  assert.equal(JSON.parse(await readFile(f.filePath, 'utf8')).credentials, null);
});

test('play searches resolve exact unique names locally, require choice on ambiguity, and return no metadata to the assistant', async t => {
  let items = [track(), track({ name: 'Another song', uri: otherTrack })]; const mutations = [];
  const f = await fixture(t, (url, options) => {
    if (url.pathname === '/v1/search') return json({ tracks: { items } });
    if (url.pathname.endsWith('/devices')) return json({ devices: [device()] });
    mutations.push({ url, options }); return empty();
  });
  const result = await f.service.control({ action: 'play', query: 'Synthetic song by Synthetic artist' });
  assert.deepEqual(result, { ok: true, status: 'accepted', message: 'Spotify accepted the playback request.' });
  assert.deepEqual(JSON.parse(mutations[0].options.body), { uris: [TRACK] });
  assert.equal(mutations[0].url.searchParams.get('device_id'), 'device1');
  assert.ok(!JSON.stringify(result).includes('Synthetic')); assert.ok(!JSON.stringify(result).includes(TRACK));
  items = [track(), track({ uri: otherTrack })];
  const ambiguous = await f.service.control({ action: 'play', query: 'Synthetic song' });
  assert.equal(ambiguous.status, 'choice_required'); assert.equal(mutations.length, 1);
  const noExact = await f.service.control({ action: 'play', query: 'song' }); assert.equal(noExact.status, 'choice_required'); assert.equal(mutations.length, 1);
});

test('controls validate strict per-action arguments before network access and map supported actions correctly', async t => {
  const mutations = []; const f = await fixture(t, (url, options) => {
    if (url.pathname.endsWith('/devices')) return json({ devices: [device()] });
    mutations.push({ url, ...options }); return empty();
  });
  for (const args of [
    { action: 'delete' }, { action: 'pause', uri: TRACK }, { action: 'play', uri: 'https://evil.example' },
    { action: 'play', uri: TRACK, query: 'anything' }, { action: 'play', type: 'track' },
    { action: 'volume', volume_percent: '50' }, { action: 'volume', volume_percent: 101 },
    { action: 'shuffle', state: 'true' }, { action: 'repeat', state: 'forever' },
    { action: 'transfer' }, { action: 'queue', uri: PLAYLIST }, { action: 'queue' },
    { action: 'pause', device_id: 'one', device_name: 'Living room' },
  ]) await assert.rejects(f.service.control(args), { code: 'SPOTIFY_INVALID' });
  assert.equal(f.calls.length, 0);
  for (const args of [
    { action: 'play', uri: ALBUM }, { action: 'pause' }, { action: 'next' }, { action: 'previous' },
    { action: 'volume', volume_percent: 25 }, { action: 'shuffle', state: true }, { action: 'repeat', state: 'context' },
    { action: 'transfer', device_id: 'device1' }, { action: 'queue', uri: TRACK }, { action: 'play' },
  ]) assert.equal((await f.service.control(args)).status, 'accepted');
  assert.deepEqual(JSON.parse(mutations[0].body), { context_uri: ALBUM });
  assert.equal(mutations[2].method, 'POST'); assert.equal(mutations[3].method, 'POST');
  assert.equal(mutations[4].url.searchParams.get('volume_percent'), '25');
  assert.equal(mutations[5].url.searchParams.get('state'), 'true'); assert.equal(mutations[6].url.searchParams.get('state'), 'context');
  assert.deepEqual(JSON.parse(mutations[7].body), { device_ids: ['device1'], play: false });
  assert.equal(mutations[8].url.searchParams.get('uri'), TRACK); assert.equal(mutations[9].body, undefined);
});

test('device resolution requires active or exact explicit devices, and never chooses ambiguous or restricted devices', async t => {
  let devices = [device({ is_active: false })]; let mutations = 0;
  const f = await fixture(t, url => {
    if (url.pathname.endsWith('/devices')) return json({ devices }); mutations++; return empty();
  });
  await assert.rejects(f.service.control({ action: 'play' }), { code: 'SPOTIFY_DEVICE' });
  await assert.rejects(f.service.control({ action: 'play', device_name: 'Living' }), { code: 'SPOTIFY_DEVICE' });
  assert.equal((await f.service.control({ action: 'play', device_name: 'living ROOM' })).status, 'accepted');
  devices = [device(), device({ id: 'device2' })];
  assert.equal((await f.service.control({ action: 'play' })).status, 'choice_required');
  assert.equal((await f.service.control({ action: 'play', device_name: 'Living room' })).status, 'choice_required');
  devices = [device({ is_restricted: true })];
  await assert.rejects(f.service.control({ action: 'pause' }), { code: 'SPOTIFY_DEVICE' });
  devices = [device({ supports_volume: false })];
  await assert.rejects(f.service.control({ action: 'volume', volume_percent: 10 }), { code: 'SPOTIFY_DEVICE' });
  assert.equal(mutations, 1);
});

test('only an explicit rejected 401 is retried once; ambiguous mutation failures never replay', async t => {
  let attempts = 0; let response = () => ++attempts === 1 ? json({ error: 'expired' }, 401) : empty();
  const f = await fixture(t, url => url.pathname.endsWith('/devices') ? json({ devices: [device()] }) : response());
  let refreshes = 0; f.setToken(() => { refreshes++; return json(token({ access_token: 'refreshed' })); });
  assert.equal((await f.service.control({ action: 'next' })).status, 'accepted'); assert.equal(attempts, 2); assert.equal(refreshes, 1);
  response = () => { attempts++; throw new Error('secret-token / private track name'); };
  await assert.rejects(f.service.control({ action: 'next' }), error => error.code === 'SPOTIFY_UNAVAILABLE' && !error.message.includes('secret'));
  assert.equal(attempts, 3);
  response = () => { attempts++; return json({ error: 'private' }, 503); };
  await assert.rejects(f.service.control({ action: 'next' }), { code: 'SPOTIFY_UNAVAILABLE' }); assert.equal(attempts, 4);
  response = () => { attempts++; return json({ error: 'private' }, 401); };
  await assert.rejects(f.service.control({ action: 'next' }), { code: 'SPOTIFY_NOT_CONNECTED' }); assert.equal(attempts, 6);
});

test('429 establishes a nonblocking Retry-After cooldown without replay; provider failures stay friendly', async t => {
  let response = () => json({ error: 'secret-provider-message' }, 429, { 'Retry-After': '4' });
  const f = await fixture(t, () => response());
  await assert.rejects(f.service.search({ query: 'song' }), { code: 'SPOTIFY_RATE_LIMITED', status: 429 });
  const before = f.calls.length;
  await assert.rejects(f.service.search({ query: 'song' }), { code: 'SPOTIFY_RATE_LIMITED' }); assert.equal(f.calls.length, before);
  f.advance(4001); response = () => json({ tracks: { items: [] } }); await f.service.search({ query: 'song' });
  assert.equal(f.calls.length, before + 1);
  for (const [status, code] of [[403, 'SPOTIFY_PREMIUM'], [404, 'SPOTIFY_DEVICE'], [400, 'SPOTIFY_INVALID']]) {
    response = () => json({ error: 'secret-provider-message' }, status);
    await assert.rejects(f.service.search({ query: 'song' }), error => error.code === code && !error.message.includes('secret-provider'));
  }
  response = () => json({}, 429, { 'Retry-After': String(2 * 24 * 60 * 60) });
  await assert.rejects(f.service.search({ query: 'song' }), { code: 'SPOTIFY_RATE_LIMITED' });
  const longCooldownCalls = f.calls.length; f.advance(24 * 60 * 60_000 + 1);
  await assert.rejects(f.service.search({ query: 'song' }), { code: 'SPOTIFY_RATE_LIMITED' });
  assert.equal(f.calls.length, longCooldownCalls, 'a long provider cooldown must not be shortened');
});
