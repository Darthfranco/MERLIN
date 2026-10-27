import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { AppError } from './errors.js';

const API = 'https://api.spotify.com/v1';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SCOPES = ['user-read-playback-state', 'user-modify-playback-state', 'playlist-read-private'];
const AUTH_TTL = 10 * 60_000;
const SNAPSHOT_TTL = 3_000;
const RESULTS_TTL = 60_000;
const TYPES = ['track', 'album', 'artist', 'playlist'];
const URI = /^spotify:(track|album|artist|playlist):([A-Za-z0-9]{22})$/u;
const CLIENT_ID = /^[a-f0-9]{32}$/iu;
const DEVICE_ID = /^[A-Za-z0-9_-]{1,200}$/u;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);
const normalized = value => value.normalize('NFKC').toLocaleLowerCase('en').replace(/\s+/gu, ' ').trim();
const label = value => typeof value === 'string' ? value.replace(/[\u0000-\u001F\u007F]/gu, '').slice(0, 500) : '';

function error(code, message, status = 400) {
  const result = new AppError(message, status); result.code = `SPOTIFY_${code}`; return result;
}
function invalid() { return error('INVALID', 'Choose valid Spotify controls and try again.'); }
function keys(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw invalid();
}
function text(value, maximum = 300) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001F\u007F]/u.test(value)) throw invalid();
  return value.trim();
}
function unavailable() {
  return error('UNAVAILABLE', 'Spotify did not confirm the request. Check playback before trying again.', 502);
}
function stale() { return error('STALE', 'The Spotify connection changed. Please try again.', 409); }
function credentials(value) {
  if (!object(value) || Object.keys(value).some(key => !['access_token', 'refresh_token', 'expires_at', 'scope'].includes(key))
    || !['access_token', 'refresh_token'].every(key => typeof value[key] === 'string' && value[key].length > 0 && value[key].length <= 8192 && /^[\x21-\x7E]+$/u.test(value[key]))
    || !Number.isSafeInteger(value.expires_at) || value.expires_at <= 0 || typeof value.scope !== 'string' || value.scope.length > 2000
    || !SCOPES.every(scope => value.scope.split(' ').includes(scope))) throw unavailable();
  return value;
}
function validRedirect(value) {
  let url;
  try { url = new URL(value); } catch { throw invalid(); }
  // This integration is a local desktop server. No arbitrary remote callback can receive a code.
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || typeof value !== 'string' || value.length > 1000) throw invalid();
  return url.href;
}
function imageUrl(item) {
  const images = item.images ?? item.album?.images;
  if (!Array.isArray(images)) return null;
  for (const image of images.slice(0, 10)) {
    try {
      const url = new URL(image.url);
      if (url.protocol === 'https:' && !url.username && !url.password && !url.port
        && ['i.scdn.co', 'mosaic.scdn.co', 'image-cdn-ak.spotifycdn.com'].includes(url.hostname)) return url.href;
    } catch { /* Untrusted metadata URLs are never fetched by the service. */ }
  }
  return null;
}
function itemMetadata(item, expectedType) {
  if (!object(item) || typeof item.uri !== 'string') return null;
  const match = URI.exec(item.uri);
  if (!match || (expectedType && match[1] !== expectedType) || !label(item.name)) return null;
  const type = match[1];
  return { type, name: label(item.name), artists: (Array.isArray(item.artists) ? item.artists : []).slice(0, 20).map(artist => label(artist?.name)).filter(Boolean),
    uri: item.uri, url: `https://open.spotify.com/${type}/${match[2]}`, image_url: imageUrl(item) };
}
function deviceMetadata(item) {
  if (!object(item) || typeof item.id !== 'string' || !DEVICE_ID.test(item.id)) return null;
  return { id: item.id, name: label(item.name), type: label(item.type), is_active: item.is_active === true,
    is_restricted: item.is_restricted === true, supports_volume: item.supports_volume === true,
    volume_percent: Number.isInteger(item.volume_percent) && item.volume_percent >= 0 && item.volume_percent <= 100 ? item.volume_percent : null };
}
function uniqueItems(items, type) {
  const ids = new Set();
  return (Array.isArray(items) ? items : []).slice(0, 100).map(item => itemMetadata(item, type)).filter(item => {
    if (!item || ids.has(item.uri)) return false;
    ids.add(item.uri); return true;
  });
}
const accepted = () => ({ ok: true, status: 'accepted', message: 'Spotify accepted the playback request.' });
const choice = () => ({ ok: true, status: 'choice_required', message: 'Choose an item or device in the Spotify panel, then try again.' });

/** Local OAuth credentials; Spotify metadata is transient and must never be supplied to a model. */
export class SpotifyService {
  #filePath; #fetch; #now; #state; #epoch = 0; #writes = Promise.resolve();
  #authorizations = new Map(); #refreshing = null; #snapshotting = null;
  #cache = null; #results = []; #resultsAt = 0; #cooldownUntil = 0;

  constructor({ filePath, clientId = '', fetchImpl = fetch, now = Date.now } = {}) {
    if (typeof filePath !== 'string' || !filePath || typeof fetchImpl !== 'function' || typeof now !== 'function'
      || (clientId !== '' && (typeof clientId !== 'string' || !CLIENT_ID.test(clientId)))) throw invalid();
    this.#filePath = resolve(filePath); this.#fetch = fetchImpl; this.#now = now;
    this.#state = { version: 1, client_id: clientId, credentials: null };
  }

  async init() {
    let stored;
    try { stored = JSON.parse(await readFile(this.#filePath, 'utf8')); }
    catch (cause) {
      if (cause.code !== 'ENOENT') throw error('STORAGE', 'Spotify connection storage could not be read safely.', 500);
    }
    if (stored !== undefined) {
      try {
        keys(stored, ['version', 'client_id', 'credentials']);
        if (stored.version !== 1 || typeof stored.client_id !== 'string' || (stored.client_id !== '' && !CLIENT_ID.test(stored.client_id))
          || (!stored.client_id && stored.credentials !== null)) throw invalid();
        if (stored.credentials !== null) credentials(stored.credentials);
      } catch { throw error('STORAGE', 'Spotify connection storage could not be read safely.', 500); }
      if (!this.#state.client_id || this.#state.client_id === stored.client_id) this.#state = stored;
    }
    await this.#persist();
    return this;
  }

  status() {
    return { configured: Boolean(this.#state.client_id), connected: Boolean(this.#state.credentials), client_id: this.#state.client_id };
  }

  #clearTransient() {
    this.#authorizations.clear(); this.#cache = null; this.#results = []; this.#resultsAt = 0;
    this.#refreshing = null; this.#snapshotting = null; this.#cooldownUntil = 0;
  }

  async configure(clientId) {
    if (typeof clientId !== 'string' || !CLIENT_ID.test(clientId)) throw invalid();
    if (clientId !== this.#state.client_id) {
      const previous = this.#state;
      this.#epoch++; this.#clearTransient(); this.#state = { version: 1, client_id: clientId, credentials: null };
      const epoch = this.#epoch;
      try { await this.#persist(); }
      catch (cause) { if (this.#epoch === epoch) this.#state = previous; throw cause; }
    }
    return this.status();
  }

  beginAuthorization(redirectUri) {
    if (!this.#state.client_id) throw error('NOT_CONFIGURED', 'Add your Spotify app Client ID in the Spotify panel first.');
    const redirect = validRedirect(redirectUri);
    for (const [key, value] of this.#authorizations) if (value.expires <= this.#now()) this.#authorizations.delete(key);
    if (this.#authorizations.size >= 20) this.#authorizations.delete(this.#authorizations.keys().next().value);
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(64).toString('base64url');
    this.#authorizations.set(state, { verifier, redirect, expires: this.#now() + AUTH_TTL, epoch: this.#epoch, client_id: this.#state.client_id });
    const url = new URL('https://accounts.spotify.com/authorize');
    url.search = new URLSearchParams({ response_type: 'code', client_id: this.#state.client_id, redirect_uri: redirect,
      scope: SCOPES.join(' '), state, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') }).toString();
    return { url: url.href, state };
  }

  async completeAuthorization({ code, state, redirectUri } = {}) {
    const pending = this.#authorizations.get(state);
    this.#authorizations.delete(state);
    if (!pending || pending.expires <= this.#now() || pending.epoch !== this.#epoch || pending.redirect !== validRedirect(redirectUri)) {
      throw error('AUTHORIZATION', 'The Spotify sign-in expired or did not match. Connect again.');
    }
    const response = await this.#tokenRequest({ grant_type: 'authorization_code', code: text(code, 4096),
      redirect_uri: pending.redirect, client_id: pending.client_id, code_verifier: pending.verifier }, pending.epoch);
    this.#checkEpoch(pending.epoch);
    // Reconnecting must also invalidate an older account's in-flight refresh/read.
    this.#epoch++; this.#clearTransient();
    await this.#saveTokens(response, null, this.#epoch);
    // Other outstanding authorization pages cannot silently replace this account later.
    this.#authorizations.clear(); this.#cache = null; this.#results = []; this.#resultsAt = 0;
    return this.status();
  }

  async disconnect() {
    this.#epoch++; this.#clearTransient(); this.#state = { ...this.#state, credentials: null };
    await this.#persist();
    return this.status();
  }

  #persist() {
    const state = clone(this.#state);
    const write = this.#writes.catch(() => {}).then(async () => {
      const temporary = `${this.#filePath}.${randomUUID()}.tmp`;
      let handle;
      try {
        await mkdir(dirname(this.#filePath), { recursive: true, mode: 0o700 });
        handle = await open(temporary, 'wx', 0o600);
        await handle.writeFile(`${JSON.stringify(state)}\n`, 'utf8'); await handle.sync(); await handle.close(); handle = null;
        await rename(temporary, this.#filePath);
      } catch { throw error('STORAGE', 'Spotify connection storage could not be saved safely.', 500); }
      finally { if (handle) await handle.close().catch(() => {}); await rm(temporary, { force: true }).catch(() => {}); }
    });
    this.#writes = write; return write;
  }

  #checkEpoch(epoch) { if (epoch !== this.#epoch) throw stale(); }
  #checkCooldown() {
    if (this.#cooldownUntil > this.#now()) throw error('RATE_LIMITED', 'Spotify is busy. Wait a little before trying again.', 429);
  }
  #httpError(response) {
    if (response.status === 429) {
      const retry = response.headers?.get('retry-after');
      const delay = /^\d+(?:\.\d+)?$/u.test(retry ?? '') ? Number(retry) * 1000 : Date.parse(retry) - this.#now();
      this.#cooldownUntil = this.#now() + (Number.isFinite(delay) && delay > 0 ? delay : 30_000);
      return error('RATE_LIMITED', 'Spotify is busy. Wait a little before trying again.', 429);
    }
    if (response.status === 401) return error('NOT_CONNECTED', 'Reconnect Spotify in the Spotify panel.', 401);
    if (response.status === 403) return error('PREMIUM', 'Spotify did not allow this action. Check your account access and Premium subscription.', 403);
    if (response.status === 404) return error('DEVICE', 'Open Spotify on the device you want to use, then try again.', 409);
    if (response.status === 400) return error('INVALID', 'Spotify could not use that request. Choose another item or device.');
    return unavailable();
  }
  async #fetchResponse(url, options, epoch) {
    this.#checkEpoch(epoch); this.#checkCooldown();
    try {
      const response = await this.#fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(8_000) });
      this.#checkEpoch(epoch); return response;
    } catch { this.#checkEpoch(epoch); throw unavailable(); }
  }
  async #json(response, epoch) {
    try { const body = await response.json(); this.#checkEpoch(epoch); return body; }
    catch { this.#checkEpoch(epoch); throw unavailable(); }
  }
  async #tokenRequest(params, epoch) {
    const response = await this.#fetchResponse(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() }, epoch);
    if (!response.ok) {
      if ([400, 401].includes(response.status)) throw error('AUTHORIZATION', 'Spotify sign-in could not be renewed. Connect again.', 401);
      throw this.#httpError(response);
    }
    return this.#json(response, epoch);
  }
  async #saveTokens(response, previous, epoch) {
    this.#checkEpoch(epoch);
    if (!object(response) || response.token_type?.toLowerCase() !== 'bearer'
      || !Number.isInteger(response.expires_in) || response.expires_in <= 0 || response.expires_in > 31_536_000) throw unavailable();
    const token = credentials({ access_token: response.access_token, refresh_token: response.refresh_token ?? previous?.refresh_token,
      expires_at: this.#now() + response.expires_in * 1000, scope: response.scope ?? previous?.scope });
    const previousState = this.#state;
    this.#state = { ...this.#state, credentials: token };
    try { await this.#persist(); }
    catch (cause) { if (this.#epoch === epoch) this.#state = previousState; throw cause; }
    this.#checkEpoch(epoch);
    return token.access_token;
  }
  async #accessToken(epoch, rejectedToken) {
    this.#checkEpoch(epoch);
    const current = this.#state.credentials;
    if (!current) throw error('NOT_CONNECTED', 'Connect Spotify in the Spotify panel first.', 401);
    if (rejectedToken && current.access_token !== rejectedToken) return current.access_token;
    if (!rejectedToken && current.expires_at > this.#now() + 30_000) return current.access_token;
    if (this.#refreshing) return this.#refreshing;
    const refreshing = (async () => {
      try {
        const response = await this.#tokenRequest({ grant_type: 'refresh_token', refresh_token: current.refresh_token, client_id: this.#state.client_id }, epoch);
        return await this.#saveTokens(response, current, epoch);
      } catch (cause) {
        if (cause.code === 'SPOTIFY_AUTHORIZATION' && epoch === this.#epoch) await this.disconnect();
        throw cause;
      }
    })();
    this.#refreshing = refreshing;
    try { return await refreshing; }
    finally { if (this.#refreshing === refreshing) this.#refreshing = null; }
  }
  async #request(path, { method = 'GET', params, body } = {}, epoch = this.#epoch) {
    let token = await this.#accessToken(epoch);
    for (let attempt = 0; attempt < 2; attempt++) {
      const url = new URL(`${API}${path}`);
      if (params) url.search = new URLSearchParams(params).toString();
      const response = await this.#fetchResponse(url.href, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, epoch);
      // Only a rejected 401 can be retried: never retry uncertain mutations/timeouts.
      if (response.status === 401 && attempt === 0) { token = await this.#accessToken(epoch, token); continue; }
      if (!response.ok) throw this.#httpError(response);
      if (response.status === 204) return null;
      return this.#json(response, epoch);
    }
    throw unavailable();
  }

  #currentResults() { return this.#resultsAt + RESULTS_TTL > this.#now() ? clone(this.#results) : []; }
  async #devices(epoch) {
    const data = await this.#request('/me/player/devices', {}, epoch);
    return (Array.isArray(data?.devices) ? data.devices : []).slice(0, 100).map(deviceMetadata).filter(Boolean);
  }
  async snapshot(options = {}) {
    keys(options, ['refresh']);
    const { refresh = false } = options;
    if (typeof refresh !== 'boolean') throw invalid();
    const empty = () => ({ ...this.status(), devices: [], playback: null, results: this.#currentResults() });
    if (!this.#state.credentials) return empty();
    if (!refresh && this.#cache && this.#cache.at + SNAPSHOT_TTL > this.#now()) return { ...empty(), ...clone(this.#cache.data) };
    if (this.#snapshotting) return this.#snapshotting;
    const epoch = this.#epoch;
    const pending = (async () => {
      try {
        const [devices, player] = await Promise.all([this.#devices(epoch), this.#request('/me/player', {}, epoch)]);
        this.#checkEpoch(epoch);
        const playback = player === null ? null : { is_playing: player.is_playing === true, device: deviceMetadata(player.device), track: itemMetadata(player.item, 'track') };
        const data = { devices, playback };
        this.#cache = { at: this.#now(), data };
        return { ...empty(), ...clone(data) };
      } catch (cause) {
        this.#checkEpoch(epoch);
        return { ...empty(), notice: cause instanceof AppError ? cause.message : unavailable().message };
      }
    })();
    this.#snapshotting = pending;
    try { return await pending; }
    finally { if (this.#snapshotting === pending) this.#snapshotting = null; }
  }

  async search(args = {}) {
    keys(args, ['query', 'type']);
    const { type = 'track' } = args;
    const query = text(args.query);
    if (!TYPES.includes(type)) throw invalid();
    const epoch = this.#epoch;
    const data = await this.#request('/search', { params: { q: query, type, limit: '5' } }, epoch);
    this.#checkEpoch(epoch);
    const results = uniqueItems(data?.[`${type}s`]?.items, type).slice(0, 5);
    this.#results = results; this.#resultsAt = this.#now();
    return { results: clone(results) };
  }

  async playlists() {
    const epoch = this.#epoch;
    const data = await this.#request('/me/playlists', { params: { limit: '20' } }, epoch);
    this.#checkEpoch(epoch);
    const results = uniqueItems(data?.items, 'playlist').slice(0, 20);
    this.#results = results; this.#resultsAt = this.#now();
    return { results: clone(results) };
  }

  async control(args) {
    const fields = {
      play: ['uri', 'query', 'type'], pause: [], next: [], previous: [], volume: ['volume_percent'],
      shuffle: ['state'], repeat: ['state'], transfer: [], queue: ['uri', 'query', 'type'],
    };
    if (!object(args) || !Object.hasOwn(fields, args.action)) throw invalid();
    keys(args, ['action', 'device_id', 'device_name', ...fields[args.action]]);
    const { action } = args;
    if (args.device_id !== undefined && (typeof args.device_id !== 'string' || !DEVICE_ID.test(args.device_id))) throw invalid();
    if (args.device_name !== undefined) text(args.device_name, 500);
    if (args.device_id !== undefined && args.device_name !== undefined) throw invalid();
    if (action === 'transfer' && args.device_id === undefined && args.device_name === undefined) throw invalid();
    if (args.uri !== undefined && (typeof args.uri !== 'string' || !URI.test(args.uri))) throw invalid();
    if (args.query !== undefined) text(args.query);
    if (args.uri !== undefined && args.query !== undefined) throw invalid();
    if (args.type !== undefined && (!TYPES.includes(args.type) || args.query === undefined)) throw invalid();
    if (action === 'queue' && ((args.uri === undefined && args.query === undefined) || (args.uri && !args.uri.startsWith('spotify:track:')) || (args.type !== undefined && args.type !== 'track'))) throw invalid();
    if (action === 'volume' && (!Number.isInteger(args.volume_percent) || args.volume_percent < 0 || args.volume_percent > 100)) throw invalid();
    if (action === 'shuffle' && typeof args.state !== 'boolean') throw invalid();
    if (action === 'repeat' && !['track', 'context', 'off'].includes(args.state)) throw invalid();
    const epoch = this.#epoch;
    let uri = args.uri;
    if (args.query !== undefined) {
      const { results } = await this.search({ query: args.query, type: args.type ?? 'track' });
      this.#checkEpoch(epoch);
      const query = normalized(args.query);
      let exact = results.filter(item => normalized(item.name) === query);
      if (!exact.length) {
        const split = /^(.*?)\s+by\s+(.+)$/u.exec(query);
        if (split) exact = results.filter(item => normalized(item.name) === split[1] && item.artists.some(artist => normalized(artist) === split[2]));
      }
      if (exact.length !== 1) return choice();
      uri = exact[0].uri;
    }
    const devices = await this.#devices(epoch);
    this.#checkEpoch(epoch);
    const matching = devices.filter(device => args.device_id !== undefined ? device.id === args.device_id
      : args.device_name !== undefined ? normalized(device.name) === normalized(args.device_name) : device.is_active);
    if (matching.length > 1) return choice();
    const device = matching[0];
    if (!device || device.is_restricted) throw error('DEVICE', 'Open Spotify on the device you want to use, then choose it in the Spotify panel.', 409);
    if (action === 'volume' && !device.supports_volume) throw error('DEVICE', 'Change the volume directly on this Spotify device.', 409);
    let path = `/me/player/${action}`; let method = 'PUT'; let body; const params = { device_id: device.id };
    if (action === 'play' && uri) body = uri.startsWith('spotify:track:') ? { uris: [uri] } : { context_uri: uri };
    if (['next', 'previous', 'queue'].includes(action)) method = 'POST';
    if (action === 'queue') params.uri = uri;
    if (action === 'volume') params.volume_percent = String(args.volume_percent);
    if (['shuffle', 'repeat'].includes(action)) params.state = String(args.state);
    if (action === 'transfer') { path = '/me/player'; body = { device_ids: [device.id], play: false }; delete params.device_id; }
    await this.#request(path, { method, params, body }, epoch);
    this.#checkEpoch(epoch); this.#cache = null;
    return accepted();
  }
}
