import test from 'node:test';
import assert from 'node:assert/strict';
import { rachio } from '../src/connectors/rachio.js';
import { ConnectorError } from '../src/connectors/base.js';
import { mockFetch, noSleep } from './mock-fetch.js';

const BASE = 'https://api.rach.io/1/public';
const KEY = 'rachio-test-key-not-real';
const PERSON = 'c8d10892-fd69-48b3-8743-f111e4392d8a';
const CONTROLLER = '55e57aff-d8a2-4e3b-9836-25cf7f6839e7';
const OFFLINE = '11111111-d8a2-4e3b-9836-25cf7f6839e7';
const ZONE_A = '108e23aa-4999-4da2-994a-62aa6e207221';
const ZONE_B = '208e23aa-4999-4da2-994a-62aa6e207221';
const ZONE_OFF = '308e23aa-4999-4da2-994a-62aa6e207221';
const ctx = fetch => ({ fetch, sleep: noSleep });
const auth = call => assert.equal(call.headers.authorization, `Bearer ${KEY}`);

const person = {
  id: PERSON,
  devices: [
    { id: CONTROLLER, name: 'Backyard', status: 'ONLINE', on: true, zones: [
      { id: ZONE_B, name: 'Flower beds', zoneNumber: 2, enabled: true },
      { id: ZONE_A, name: 'Front lawn', zoneNumber: 1, enabled: true },
      { id: ZONE_OFF, name: 'Unused', zoneNumber: 3, enabled: false },
    ] },
    { id: OFFLINE, name: 'Shed', status: 'OFFLINE', zones: [{ id: '408e23aa-4999-4da2-994a-62aa6e207221', name: 'Shed lawn', zoneNumber: 1, enabled: true }] },
    { id: '99999999-d8a2-4e3b-9836-25cf7f6839e7', name: 'Removed', status: 'ONLINE', deleted: true, zones: [] },
  ],
};
const connectRoutes = [
  { url: `${BASE}/person/info`, json: { id: PERSON }, check: auth },
  { url: `${BASE}/person/${PERSON}`, json: person, check: auth },
];
const config = { api_key: KEY, person_id: PERSON, controllers: 2 };

test('connecting proves access with the real API and stores the key only in the saved config', async () => {
  const fetch = mockFetch(connectRoutes);
  const connector = rachio();
  const result = await connector.connect({ api_key: KEY }, null, ctx(fetch));
  assert.deepEqual(result.config, { api_key: KEY, person_id: PERSON, controllers: 2 });
  assert.match(result.summary, /Connected 2 Rachio controllers/);
  assert.equal(fetch.pending(), 0);
  assert.ok(fetch.calls.every(call => call.redirect === 'error'));
  assert.deepEqual(connector.publicConfig(result.config), { controllers: 2 });
  assert.ok(!JSON.stringify(connector.publicConfig(result.config)).includes(KEY));
});

test('a saved key can be re-verified and an omitted key reuses it', async () => {
  const verified = await rachio().verify(config, ctx(mockFetch(connectRoutes)));
  assert.equal(verified.config.controllers, 2);
  assert.match(verified.summary, /answered with the saved key/);
  const reused = await rachio().connect({}, config, ctx(mockFetch(connectRoutes)));
  assert.equal(reused.config.api_key, KEY);
  await assert.rejects(rachio().connect({}, null, ctx(mockFetch([]))), /Paste your Rachio API key/);
});

test('rejected keys, rate limits and outages are each reported without echoing the key', async () => {
  for (const status of [401, 403]) {
    const error = await rachio().connect({ api_key: KEY }, null, ctx(mockFetch([{ url: `${BASE}/person/info`, status, json: {} }]))).catch(item => item);
    assert.ok(error instanceof ConnectorError);
    assert.equal(error.kind, 'auth');
    assert.ok(!error.message.includes(KEY));
  }
  const limited = await rachio().connect({ api_key: KEY }, null, ctx(mockFetch([{ url: `${BASE}/person/info`, status: 429, headers: { 'retry-after': '90' }, json: {} }]))).catch(item => item);
  assert.deepEqual([limited.kind, /90 seconds/.test(limited.message)], ['rate_limit', true]);
  const timeout = await rachio().connect({ api_key: KEY }, null, ctx(mockFetch([{ url: `${BASE}/person/info`, throws: 'timeout' }]))).catch(item => item);
  assert.equal(timeout.kind, 'unreachable');
  const unreadable = await rachio().connect({ api_key: KEY }, null, ctx(mockFetch([{ url: `${BASE}/person/info`, json: { id: '../../x' } }]))).catch(item => item);
  assert.equal(unreadable.kind, 'failed');
});

test('an account with only a hose timer or no controller is not called connected', async () => {
  const fetch = mockFetch([{ url: `${BASE}/person/info`, json: { id: PERSON } }, { url: `${BASE}/person/${PERSON}`, json: { id: PERSON, devices: [{ id: CONTROLLER, deleted: true }] } }]);
  await assert.rejects(rachio().connect({ api_key: KEY }, null, ctx(fetch)), error => error.kind === 'failed' && /Smart Hose Timers are not supported/.test(error.message));
  const empty = mockFetch([{ url: `${BASE}/person/info`, json: { id: PERSON } }, { url: `${BASE}/person/${PERSON}`, json: { id: PERSON } }]);
  await assert.rejects(rachio().connect({ api_key: KEY }, null, ctx(empty)), /No Rachio controller/);
});

test('controllers and enabled zones are listed with one request, and offline controllers expose no actions', async () => {
  const fetch = mockFetch([{ url: `${BASE}/person/${PERSON}`, json: person, check: auth }]);
  const devices = await rachio().devices(config, ctx(fetch));
  assert.equal(fetch.calls.length, 1, 'one request keeps well inside the 3,500 per day limit');
  assert.deepEqual(devices.map(device => device.name), ['Backyard', 'Front lawn', 'Flower beds', 'Shed', 'Shed lawn']);
  const [backyard, front, , shed, shedLawn] = devices;
  assert.deepEqual([backyard.id, backyard.kind, backyard.actions, backyard.state], [`device:${CONTROLLER}`, 'sprinkler', ['stop'], { reachable: true }]);
  assert.deepEqual([front.id, front.room, front.actions], [`zone:${CONTROLLER}:${ZONE_A}`, 'Backyard', ['start']]);
  assert.ok(!devices.some(device => device.name === 'Unused' || device.name === 'Removed'), 'disabled zones and deleted controllers are not offered');
  assert.deepEqual([shed.actions, shed.state, shedLawn.actions, shedLawn.state], [[], { reachable: false }, [], { reachable: false }]);
});

test('starting a zone sends whole seconds, and is confirmed only when Rachio reports it running', async () => {
  const zone = { id: `zone:${CONTROLLER}:${ZONE_A}`, name: 'Front lawn', kind: 'sprinkler', actions: ['start'] };
  const running = mockFetch([
    { method: 'PUT', url: `${BASE}/zone/start`, status: 204, check: call => { auth(call); assert.deepEqual(call.body, { id: ZONE_A, duration: 600 }); } },
    { url: `${BASE}/device/${CONTROLLER}/current_schedule`, json: { deviceId: CONTROLLER, status: 'PROCESSING', zoneId: ZONE_A, zoneDuration: 600 } },
  ]);
  assert.deepEqual(await rachio().act(config, zone, 'start', 10, ctx(running)), { confirmed: true });
  assert.equal(running.pending(), 0);

  const idle = mockFetch([{ method: 'PUT', url: `${BASE}/zone/start`, status: 204 }, { url: `${BASE}/device/${CONTROLLER}/current_schedule`, text: '' }]);
  assert.deepEqual(await rachio().act(config, zone, 'start', 1.5, ctx(idle)), { confirmed: false }, 'accepted is not running');
  assert.equal(idle.calls[0].body.duration, 90);

  const otherZone = mockFetch([{ method: 'PUT', url: `${BASE}/zone/start`, status: 204 }, { url: `${BASE}/device/${CONTROLLER}/current_schedule`, json: { zoneId: ZONE_B } }]);
  assert.deepEqual(await rachio().act(config, zone, 'start', 5, ctx(otherZone)), { confirmed: false });

  const unreadable = mockFetch([{ method: 'PUT', url: `${BASE}/zone/start`, status: 204 }, { url: `${BASE}/device/${CONTROLLER}/current_schedule`, throws: 'boom' }]);
  assert.deepEqual(await rachio().act(config, zone, 'start', 5, ctx(unreadable)), { confirmed: false });

  const longest = mockFetch([{ method: 'PUT', url: `${BASE}/zone/start`, status: 204 }, { url: `${BASE}/device/${CONTROLLER}/current_schedule`, text: '' }]);
  await rachio().act(config, zone, 'start', 180, ctx(longest));
  assert.equal(longest.calls[0].body.duration, 10_800, 'the documented three hour maximum');
});

test('a zone never starts without a stated number of minutes', async () => {
  const zone = { id: `zone:${CONTROLLER}:${ZONE_A}`, name: 'Front lawn', kind: 'sprinkler', actions: ['start'] };
  const fetch = mockFetch([]);
  await assert.rejects(rachio().act(config, zone, 'start', undefined, ctx(fetch)), error => error.kind === 'invalid' && /How many minutes should it run\?/.test(error.message));
  await assert.rejects(rachio().act(config, zone, 'start', 0.001, ctx(fetch)), /at least a minute/);
  assert.equal(fetch.calls.length, 0);
});

test('stopping all watering is confirmed only when nothing is running', async () => {
  const controller = { id: `device:${CONTROLLER}`, name: 'Backyard', kind: 'sprinkler', actions: ['stop'] };
  const stopped = mockFetch([
    { method: 'PUT', url: `${BASE}/device/stop_water`, status: 204, check: call => { auth(call); assert.deepEqual(call.body, { id: CONTROLLER }); } },
    { url: `${BASE}/device/${CONTROLLER}/current_schedule`, text: '' },
  ]);
  assert.deepEqual(await rachio().act(config, controller, 'stop', undefined, ctx(stopped)), { confirmed: true });
  const still = mockFetch([{ method: 'PUT', url: `${BASE}/device/stop_water`, status: 204 }, { url: `${BASE}/device/${CONTROLLER}/current_schedule`, json: { zoneId: ZONE_A, status: 'PROCESSING' } }]);
  assert.deepEqual(await rachio().act(config, controller, 'stop', undefined, ctx(still)), { confirmed: false });
});

test('combinations the API does not document never reach the network', async () => {
  const fetch = mockFetch([]);
  const zone = { id: `zone:${CONTROLLER}:${ZONE_A}`, name: 'Front lawn', kind: 'sprinkler', actions: ['start'] };
  const controller = { id: `device:${CONTROLLER}`, name: 'Backyard', kind: 'sprinkler', actions: ['stop'] };
  await assert.rejects(rachio().act(config, zone, 'stop', undefined, ctx(fetch)), error => error.kind === 'unsupported');
  await assert.rejects(rachio().act(config, controller, 'start', 5, ctx(fetch)), error => error.kind === 'unsupported');
  await assert.rejects(rachio().act(config, controller, 'turn_on', undefined, ctx(fetch)), error => error.kind === 'unsupported');
  await assert.rejects(rachio().act(config, { ...zone, id: 'zone:../../x:y' }, 'start', 5, ctx(fetch)), error => error.kind === 'failed');
  await assert.rejects(rachio().act(config, { ...zone, id: 'weird' }, 'start', 5, ctx(fetch)), error => error.kind === 'device');
  assert.equal(fetch.calls.length, 0);
});

test('a key rejected while acting is an authentication failure', async () => {
  const zone = { id: `zone:${CONTROLLER}:${ZONE_A}`, name: 'Front lawn', kind: 'sprinkler', actions: ['start'] };
  const fetch = mockFetch([{ method: 'PUT', url: `${BASE}/zone/start`, status: 401, json: {} }]);
  await assert.rejects(rachio().act(config, zone, 'start', 5, ctx(fetch)), error => error.kind === 'auth' && !error.message.includes(KEY));
  const limited = mockFetch([{ method: 'PUT', url: `${BASE}/zone/start`, status: 429, json: {} }]);
  await assert.rejects(rachio().act(config, zone, 'start', 5, ctx(limited)), error => error.kind === 'rate_limit');
});

test('live state reports whether the zone is running and the controller reachable', async () => {
  const zone = { id: `zone:${CONTROLLER}:${ZONE_A}`, name: 'Front lawn', kind: 'sprinkler', actions: ['start'] };
  const fetch = mockFetch([
    { url: `${BASE}/device/${CONTROLLER}/current_schedule`, json: { zoneId: ZONE_B } },
    { url: `${BASE}/device/${CONTROLLER}`, json: { id: CONTROLLER, status: 'ONLINE' } },
  ]);
  assert.deepEqual(await rachio().state(config, zone, ctx(fetch)), { reachable: true, running: false });
  const controller = { id: `device:${CONTROLLER}`, name: 'Backyard', kind: 'sprinkler', actions: [] };
  const busy = mockFetch([
    { url: `${BASE}/device/${CONTROLLER}/current_schedule`, json: { zoneId: ZONE_B } },
    { url: `${BASE}/device/${CONTROLLER}`, json: { id: CONTROLLER, status: 'OFFLINE' } },
  ]);
  assert.deepEqual(await rachio().state(config, controller, ctx(busy)), { reachable: false, running: true });
});

test('disconnect admits the key cannot be revoked through the API', async () => {
  const result = await rachio().disconnect(config);
  assert.equal(result.revoked, false);
  assert.match(result.message, /get a new one in the Rachio app/);
  assert.ok(!result.message.includes(KEY));
});
