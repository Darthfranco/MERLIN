import test from 'node:test';
import assert from 'node:assert/strict';
import { homeAssistant } from '../src/connectors/home-assistant.js';
import { ConnectorError } from '../src/connectors/base.js';
import { mockFetch, noSleep } from './mock-fetch.js';

const BASE = 'http://homeassistant.local:8123';
const TOKEN = 'ha-test-token-not-real';
const auth = call => assert.equal(call.headers.authorization, `Bearer ${TOKEN}`);
const ctx = fetch => ({ fetch, sleep: noSleep });

const states = [
  { entity_id: 'light.kitchen', state: 'on', attributes: { friendly_name: 'Kitchen Light', supported_color_modes: ['color_temp'], brightness: 128 } },
  { entity_id: 'light.porch', state: 'unavailable', attributes: { friendly_name: 'Porch' } },
  { entity_id: 'switch.fan_plug', state: 'off', attributes: { friendly_name: 'Fan Plug' } },
  { entity_id: 'cover.garage', state: 'closed', attributes: { friendly_name: 'Garage Door', device_class: 'garage', supported_features: 3 } },
  { entity_id: 'cover.blind', state: 'open', attributes: { friendly_name: 'Office Blind', device_class: 'blind', supported_features: 15, current_position: 80 } },
  { entity_id: 'lock.front', state: 'locked', attributes: { friendly_name: 'Front Door' } },
  { entity_id: 'climate.hall', state: 'heat', attributes: { friendly_name: 'Hall Thermostat', supported_features: 1, current_temperature: 20, min_temp: 7, max_temp: 35 } },
  { entity_id: 'sensor.temp', state: '20', attributes: { friendly_name: 'Not a controllable thing' } },
];

const connectRoutes = [
  { url: `${BASE}/api/`, json: { message: 'API running.' }, check: auth },
  { url: `${BASE}/api/config`, json: { location_name: 'Home', version: '2026.5.1', unit_system: { temperature: '°C' } }, check: auth },
];

test('connecting proves access with the real API and keeps the token only in the saved config', async () => {
  const fetch = mockFetch(connectRoutes);
  const result = await homeAssistant().connect({ url: `${BASE}/`, token: TOKEN }, null, ctx(fetch));
  assert.equal(result.config.url, BASE);
  assert.equal(result.config.token, TOKEN);
  assert.match(result.summary, /Connected to Home/);
  assert.equal(fetch.pending(), 0);
  assert.ok(fetch.calls.every(call => call.redirect === 'error'), 'never follows redirects');
  assert.deepEqual(homeAssistant().publicConfig(result.config), { url: BASE, name: 'Home', version: '2026.5.1' }, 'public config omits the token');
});

test('a rejected token is an authentication failure, not a connection', async () => {
  const fetch = mockFetch([{ url: `${BASE}/api/`, status: 401, json: { message: 'nope' } }]);
  await assert.rejects(homeAssistant().connect({ url: BASE, token: 'wrong' }, null, ctx(fetch)), error => error instanceof ConnectorError && error.kind === 'auth' && !/wrong/.test(error.message));
});

test('an address that is not Home Assistant, a missing token and an unreachable host are each reported', async () => {
  await assert.rejects(homeAssistant().connect({ url: BASE, token: TOKEN }, null, ctx(mockFetch([{ url: `${BASE}/api/`, json: { hello: 'world' } }]))), /does not look like Home Assistant/);
  await assert.rejects(homeAssistant().connect({ url: BASE }, null, ctx(mockFetch([]))), /long-lived access token/);
  await assert.rejects(homeAssistant().connect({ url: BASE, token: TOKEN }, null, ctx(mockFetch([{ url: `${BASE}/api/`, throws: 'timeout' }]))), error => error.kind === 'unreachable' && /did not answer in time/.test(error.message));
  await assert.rejects(homeAssistant().connect({ url: 'ftp://x', token: TOKEN }, null, ctx(mockFetch([]))), /http:\/\/ or https:\/\//);
  await assert.rejects(homeAssistant().connect({ url: 'http://user:pass@host:8123', token: TOKEN }, null, ctx(mockFetch([]))), /no password/);
});

test('rate limiting is reported with the wait', async () => {
  const fetch = mockFetch([{ url: `${BASE}/api/`, status: 429, headers: { 'retry-after': '12' }, json: {} }]);
  await assert.rejects(homeAssistant().connect({ url: BASE, token: TOKEN }, null, ctx(fetch)), error => error.kind === 'rate_limit' && /12 seconds/.test(error.message));
});

test('only controllable entities are listed and risky doors expose no actions', async () => {
  const config = { url: BASE, token: TOKEN, name: 'Home', temperature_unit: '°C' };
  const fetch = mockFetch([{ url: `${BASE}/api/states`, json: states, check: auth }]);
  const devices = await homeAssistant().devices(config, ctx(fetch));
  const byName = Object.fromEntries(devices.map(device => [device.name, device]));
  assert.deepEqual(Object.keys(byName).sort(), ['Fan Plug', 'Front Door', 'Garage Door', 'Hall Thermostat', 'Kitchen Light', 'Office Blind']);
  assert.deepEqual(byName['Garage Door'].actions, [], 'a garage door can be read but never moved');
  assert.deepEqual(byName['Front Door'].actions, ['lock'], 'a lock can be locked and never unlocked');
  assert.ok(byName['Kitchen Light'].actions.includes('set_color_temperature') && byName['Kitchen Light'].actions.includes('set_brightness'));
  assert.equal(byName['Kitchen Light'].state.brightness, 50);
  assert.deepEqual(byName['Office Blind'].actions, ['open', 'close', 'stop', 'set_position']);
  assert.ok(!devices.some(device => device.name === 'Porch'), 'unavailable entities are not offered');
});

test('actions call the documented service and are confirmed only when the entity reports the result', async () => {
  const config = { url: BASE, token: TOKEN, name: 'Home', temperature_unit: '°C' };
  const light = { id: 'light.kitchen', name: 'Kitchen Light', kind: 'light', actions: ['turn_on', 'turn_off', 'set_brightness'] };
  const confirmed = mockFetch([
    { method: 'POST', url: `${BASE}/api/services/light/turn_on`, json: [], check: call => { auth(call); assert.deepEqual(call.body, { entity_id: 'light.kitchen', brightness_pct: 30 }); } },
    { url: `${BASE}/api/states/light.kitchen`, json: { entity_id: 'light.kitchen', state: 'on', attributes: { brightness: 77 } } },
  ]);
  assert.deepEqual(await homeAssistant().act(config, light, 'set_brightness', 30, ctx(confirmed)), { confirmed: true });
  const lagging = mockFetch([
    { method: 'POST', url: `${BASE}/api/services/light/turn_off`, json: [] },
    { url: `${BASE}/api/states/light.kitchen`, json: { entity_id: 'light.kitchen', state: 'on', attributes: {} } },
  ]);
  assert.deepEqual(await homeAssistant().act(config, light, 'turn_off', undefined, ctx(lagging)), { confirmed: false }, 'a device that still reports on is not confirmed off');
  const stateFails = mockFetch([{ method: 'POST', url: `${BASE}/api/services/light/turn_off`, json: [] }, { url: `${BASE}/api/states/light.kitchen`, throws: 'boom' }]);
  assert.deepEqual(await homeAssistant().act(config, light, 'turn_off', undefined, ctx(stateFails)), { confirmed: false });
});

test('thermostat targets are converted to the instance unit and bounded by the device', async () => {
  const thermostat = { id: 'climate.hall', name: 'Hall Thermostat', kind: 'climate', actions: ['set_temperature'], extra: { min: 45, max: 95, unit: '°F' } };
  const config = { url: BASE, token: TOKEN, temperature_unit: '°F' };
  const fetch = mockFetch([
    { method: 'POST', url: `${BASE}/api/services/climate/set_temperature`, json: [], check: call => assert.deepEqual(call.body, { entity_id: 'climate.hall', temperature: 71.6 }) },
    { url: `${BASE}/api/states/climate.hall`, json: { entity_id: 'climate.hall', state: 'heat', attributes: { temperature: 71.6 } } },
  ]);
  assert.deepEqual(await homeAssistant().act(config, thermostat, 'set_temperature', 22, ctx(fetch)), { confirmed: true });
  await assert.rejects(homeAssistant().act(config, { ...thermostat, extra: { min: 60, max: 80, unit: '°F' } }, 'set_temperature', 8, ctx(mockFetch([]))), /accepts 60 to 80/);
});

test('an action with no matching service never reaches the network', async () => {
  const lock = { id: 'lock.front', name: 'Front Door', kind: 'lock', actions: ['lock'] };
  await assert.rejects(homeAssistant().act({ url: BASE, token: TOKEN }, lock, 'open', undefined, ctx(mockFetch([]))), error => error.kind === 'unsupported');
});

test('disconnect is honest that Home Assistant tokens must be deleted there', async () => {
  const result = await homeAssistant().disconnect({ url: BASE, token: TOKEN });
  assert.equal(result.revoked, false);
  assert.match(result.message, /delete the MERLIN token/i);
});
