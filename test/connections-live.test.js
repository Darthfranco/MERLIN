import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import { CONNECTIONS } from '../public/connections/catalog.js';
import {
  SPOTIFY_ENTRY, actionLabel, connectedEntryIds, entryConnector, entryMatches, errorText, fieldState, formPayload, missingFields,
  operationState, relativeTime, sortEntries, splitOperationLabel, statusInfo, valueFacts,
} from '../public/connections/live.js';
import { createConnectionsServer } from '../src/connections-server.js';

const PUBLIC = new URL('../public/connections/', import.meta.url);
const hue = (over = {}) => ({
  id: 'philips-hue', name: 'Philips Hue', status: 'not_connected', detail: 'Not connected.', verified_at: null, issue: null,
  fields: [{ name: 'bridge', label: 'Hue Bridge address', type: 'text', required: true }],
  values: {}, secrets_saved: [], operations: [{ name: 'pair', label: 'Pair with the bridge', needs: 'saved' }, { name: 'discover', label: 'Find my bridge (asks Signify’s discovery service, which sees your public IP address)', needs: 'any' }], kinds: ['light'], external: false, ...over,
});
const homeAssistant = (over = {}) => ({
  id: 'home-assistant', name: 'Home Assistant', status: 'not_connected', detail: 'Not connected.', verified_at: null, issue: null,
  fields: [{ name: 'url', label: 'Home Assistant address', type: 'url', required: true }, { name: 'token', label: 'Long-lived access token', type: 'secret', required: true }],
  values: {}, secrets_saved: [], operations: [], kinds: ['light'], external: false, ...over,
});

test('status wording separates verified, unfinished, failing and absent connections', () => {
  const now = Date.parse('2026-11-01T12:00:00Z');
  const connected = statusInfo(hue({ status: 'connected', detail: 'Connected and verified.', verified_at: '2026-11-01T11:55:00Z' }), now);
  assert.deepEqual([connected.key, connected.label, connected.tone], ['connected', 'Connected', 'ok']);
  assert.match(connected.detail, /Verified 5 minutes ago\./);
  const saved = statusInfo(hue({ status: 'saved', detail: 'Settings saved, not yet verified. MERLIN cannot use this until setup is finished.' }), now);
  assert.equal(saved.label, 'Setup unfinished');
  assert.match(saved.detail, /not yet verified. MERLIN cannot use this until setup is finished/);
  assert.match(statusInfo(hue({ status: 'saved', detail: '' }), now).detail, /not verified, so MERLIN cannot use this yet/, 'a missing detail still says it is unusable');
  const attention = statusInfo(hue({ status: 'attention', issue: { kind: 'auth', message: 'The bridge rejected the key.' } }), now);
  assert.equal(attention.label, 'Needs attention');
  assert.match(attention.detail, /rejected the key/);
  assert.equal(statusInfo(hue(), now).label, 'Not connected');
  assert.equal(statusInfo(hue({ status: 'unavailable', detail: 'Not available here.' }), now).label, 'Unavailable');
  assert.equal(statusInfo(undefined).key, 'not_connected', 'a missing record is never shown as connected');
  assert.equal(statusInfo({ status: 'connected-ish' }).key, 'not_connected', 'an unknown status is never promoted');
  assert.match(statusInfo(hue({ status: 'connected', issue: { message: 'Could not be reached.' }, verified_at: '2026-11-01T11:55:00Z' }), now).issue, /Could not be reached/);
});

test('relative times are plain and bounded', () => {
  const now = Date.parse('2026-11-01T12:00:00Z');
  assert.equal(relativeTime('2026-11-01T11:59:50Z', now), 'just now');
  assert.equal(relativeTime('2026-11-01T11:59:00Z', now), '1 minute ago');
  assert.equal(relativeTime('2026-11-01T09:00:00Z', now), '3 hours ago');
  assert.equal(relativeTime('2026-10-30T12:00:00Z', now), '2 days ago');
  assert.equal(relativeTime('garbage', now), '');
});

test('the connect payload carries only declared, non-blank fields so saved secrets are kept', () => {
  const ha = homeAssistant();
  assert.deepEqual(formPayload(ha, { url: ' http://homeassistant.local:8123 ', token: '' }), { url: 'http://homeassistant.local:8123' });
  assert.deepEqual(formPayload(ha, { url: 'http://x', token: 'abc', role: 'admin', __proto__: { evil: 1 }, extra: 'y' }), { url: 'http://x', token: 'abc' });
  assert.deepEqual(formPayload(ha, { url: 5, token: null }), {});
  assert.deepEqual(formPayload(undefined, { url: 'x' }), {});
  assert.deepEqual(formPayload(ha, undefined), {});
});

test('a saved secret is never asked for again and is never prefilled', () => {
  const saved = homeAssistant({ status: 'connected', secrets_saved: ['token'], values: { url: 'http://homeassistant.local:8123', name: 'Home', version: '2026.5' } });
  const token = fieldState(saved, saved.fields[1]);
  assert.deepEqual([token.saved, token.current, token.required], [true, '', false]);
  const url = fieldState(saved, saved.fields[0]);
  assert.deepEqual([url.saved, url.current, url.required], [false, 'http://homeassistant.local:8123', false]);
  assert.deepEqual(missingFields(saved, { url: '', token: '' }), []);
  assert.deepEqual(missingFields(homeAssistant(), { url: '', token: '' }), ['Home Assistant address', 'Long-lived access token']);
  assert.deepEqual(missingFields(homeAssistant(), { url: 'http://x', token: 'abc' }), []);
  assert.equal(fieldState(homeAssistant(), { name: 'password', type: 'secret', required: false }).required, false);
});

test('extra setup steps wait for saved settings, and long labels become a button plus a visible note', () => {
  const [pair, discover] = hue().operations;
  assert.equal(operationState(hue(), pair).enabled, false);
  assert.match(operationState(hue(), pair).reason, /Save the settings/);
  assert.equal(operationState(hue({ status: 'saved' }), pair).enabled, true);
  assert.equal(operationState(hue(), discover).enabled, true);
  assert.deepEqual(splitOperationLabel(discover.label), { text: 'Find my bridge', note: 'Asks Signify’s discovery service, which sees your public IP address.' });
  assert.deepEqual(splitOperationLabel('Pair with the bridge'), { text: 'Pair with the bridge', note: '' });
});

test('only verified connections count as connected, and guides can never be connected', () => {
  const connectors = new Map([['philips-hue', hue({ status: 'saved' })], ['home-assistant', homeAssistant({ status: 'connected' })], ['spotify', { id: 'spotify', external: true, status: 'connected' }]]);
  const entries = [SPOTIFY_ENTRY, ...CONNECTIONS];
  const ids = connectedEntryIds(entries, connectors);
  assert.deepEqual([...ids].sort(), ['home-assistant', 'spotify']);
  const sonos = CONNECTIONS.find(entry => entry.id === 'sonos');
  assert.equal(entryConnector(sonos, connectors), null, 'a guide-only service has no connector');
  assert.equal(entryConnector(CONNECTIONS.find(entry => entry.id === 'philips-hue'), connectors).status, 'saved');
  assert.equal(connectedEntryIds(entries, new Map()).size, 0, 'with no live data nothing is connected');
  assert.equal(actionLabel(sonos, connectors, true), 'Setup guide');
  assert.equal(actionLabel(CONNECTIONS.find(entry => entry.id === 'myq'), connectors, true), 'Details');
  assert.equal(actionLabel(CONNECTIONS.find(entry => entry.id === 'philips-hue'), connectors, true), 'Finish setup');
  assert.equal(actionLabel(CONNECTIONS.find(entry => entry.id === 'home-assistant'), connectors, true), 'Manage');
  assert.equal(actionLabel(CONNECTIONS.find(entry => entry.id === 'shelly'), connectors, true), 'Set up');
  assert.equal(actionLabel(CONNECTIONS.find(entry => entry.id === 'home-assistant'), connectors, false), 'Setup guide', 'without the live server there is nothing to manage');
});

test('real connectors sort first and Spotify obeys the same filters as the catalog', () => {
  const sorted = sortEntries([SPOTIFY_ENTRY, ...CONNECTIONS]).map(entry => entry.integration.type);
  assert.equal(sorted.indexOf('via-home-assistant') > sorted.lastIndexOf('native'), true);
  assert.equal(sorted.indexOf('none') > sorted.lastIndexOf('via-home-assistant'), true);
  const labels = new Map([['speakers', 'Speakers']]);
  assert.equal(entryMatches(SPOTIFY_ENTRY, { query: 'music', categoryLabels: labels }), true);
  assert.equal(entryMatches(SPOTIFY_ENTRY, { query: 'Spotify', category: 'speakers', categoryLabels: labels }), true);
  assert.equal(entryMatches(SPOTIFY_ENTRY, { category: 'lights', categoryLabels: labels }), false);
  assert.equal(entryMatches(SPOTIFY_ENTRY, { difficulty: 'hard', categoryLabels: labels }), false);
  assert.equal(entryMatches(SPOTIFY_ENTRY, { view: 'connected', connectedIds: new Set(), categoryLabels: labels }), false);
  assert.equal(entryMatches(SPOTIFY_ENTRY, { view: 'connected', connectedIds: new Set(['spotify']), categoryLabels: labels }), true);
  assert.match(SPOTIFY_ENTRY.integration.remaining, /voice control/);
});

test('shown facts are plain non-secret values only, and server errors keep their own words', () => {
  assert.deepEqual(valueFacts(homeAssistant({ values: { url: 'http://h:8123', name: 'Home', version: '1', devices: [{ host: 'x' }], token: 'leak', client_id_saved: true } })).map(fact => fact.label), ['Address', 'Name', 'Version']);
  assert.equal(errorText({ error: 'Home Assistant rejected the saved credentials.' }, 401), 'Home Assistant rejected the saved credentials.');
  assert.match(errorText(null, 429), /rate limiting/);
  assert.match(errorText({}, 500), /did not work/);
  assert.ok(errorText({ error: 'x'.repeat(2000) }, 400).length <= 400);
});

test('the page never stores or logs anything, builds no markup from data, and has no demo or inline code', async () => {
  const files = (await readdir(PUBLIC)).filter(name => /\.(?:js|html|css)$/u.test(name));
  assert.ok(files.includes('live.js') && files.includes('integrations.js'));
  assert.ok(!files.includes('state.js'), 'the browser-local demo state is gone');
  for (const name of files) {
    const text = await readFile(new URL(name, PUBLIC), 'utf8');
    assert.doesNotMatch(text, /localStorage|sessionStorage|indexedDB|document\.cookie/u, `${name} must not persist anything in the browser`);
    assert.doesNotMatch(text, /\bconsole\.(?:log|warn|error|info|debug|trace)|\bdebugger\b/u, `${name} must not log`);
    if (name !== 'catalog.js') assert.doesNotMatch(text, /\bdemo\b|simulated|preview/iu, `${name} must not describe a simulated connection`);
    if (name.endsWith('.js') && name !== 'icons.js') assert.doesNotMatch(text, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/u, `${name} builds markup only through text nodes`);
  }
  const html = await readFile(new URL('index.html', PUBLIC), 'utf8');
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)|\son\w+=|\sstyle=|<style/iu, 'no inline code or styles under the strict CSP');
  assert.match(html, /href="styles\.css"/);
  assert.match(html, /src="app\.js"/);
  assert.doesNotMatch(html, /(?:href|src)="\//u, 'asset links are relative so the page works at / and at /connections/');
  const app = await readFile(new URL('app.js', PUBLIC), 'utf8');
  assert.match(app, /input\.type = definition\.type === 'secret' \? 'password' : 'text'/, 'secret fields are password inputs');
  assert.match(app, /autocomplete = 'off'/);
});

test('the guide server serves every module the page imports', async t => {
  const server = createConnectionsServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const port = server.address().port;
  const get = path => new Promise((resolve, reject) => {
    httpRequest({ hostname: '127.0.0.1', port, path, agent: false }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject).end();
  });
  const imports = new Set();
  for (const name of ['app.js', 'live.js', 'catalog.js']) {
    for (const match of (await readFile(new URL(name, PUBLIC), 'utf8')).matchAll(/from '\.\/([\w-]+\.js)'/gu)) imports.add(match[1]);
  }
  assert.ok(imports.has('integrations.js') && imports.has('live.js') && imports.has('icons.js') && imports.has('catalog.js'));
  for (const name of ['app.js', 'styles.css', ...imports]) assert.equal((await get(`/${name}`)).status, 200, name);
  assert.equal((await get('/state.js')).status, 404);
  const page = await get('/');
  assert.doesNotMatch(page.text, /data-live/u, 'the standalone guide never claims to be live');
});
