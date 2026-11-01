import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hueTransport, philipsHue } from '../src/connectors/hue.js';
import { ConnectorHub } from '../src/connectors/hub.js';
import { ConnectorError } from '../src/connectors/base.js';
import { mockFetch, noSleep } from './mock-fetch.js';

const BRIDGE = '192.168.1.50';
const ROOT = `https://${BRIDGE}`;
const FP = 'ab'.repeat(32);
const OTHER_FP = 'cd'.repeat(32);
const KEY = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd';
const NEW_KEY = 'ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210zyxw';
const keyed = call => assert.equal(call.headers['hue-application-key'], KEY);
const unkeyed = call => assert.equal(call.headers['hue-application-key'], undefined, 'no key is sent before pairing');

const INFO = { name: 'Philips hue', bridgeid: 'ECB5FAFFFE123456', modelid: 'BSB002', apiversion: '1.65.0' };
const saved = { bridge: BRIDGE, name: 'Philips hue', bridge_id: 'ecb5fafffe123456', model: 'BSB002', fingerprint: FP };
const paired = { ...saved, app_key: KEY };

// A scripted transport. Mock responses prove request/response handling only, not a real bridge.
function transportFor(routes, { fingerprint = FP } = {}) {
  const fetch = mockFetch(routes);
  const requests = [];
  const transport = async request => {
    requests.push(request);
    const response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body });
    return { status: response.status, headers: Object.fromEntries(response.headers), text: await response.text(), fingerprint: typeof fingerprint === 'function' ? fingerprint(request) : fingerprint };
  };
  return Object.assign(transport, { fetch, requests });
}
const ctxFor = transport => ({ hueRequest: transport, fetch: transport.fetch, sleep: noSleep });
const v2 = data => ({ errors: [], data });

const lightResource = (id, over = {}) => ({ id, type: 'light', owner: { rid: `dev-${id}`, rtype: 'device' }, metadata: { name: `Lamp ${id}` }, on: { on: true }, dimming: { brightness: 50.4 }, ...over });
const inventory = [
  { url: `${ROOT}/clip/v2/resource/light`, json: v2([
    lightResource('l1', { metadata: { name: 'Ceiling' }, color_temperature: { mirek: 300, mirek_schema: { mirek_minimum: 153, mirek_maximum: 454 } } }),
    lightResource('l2', { metadata: { name: 'Ceiling' }, on: { on: false }, dimming: undefined }),
    lightResource('l3', { metadata: { name: 'Plug' }, owner: { rid: 'dev-orphan', rtype: 'device' }, dimming: undefined }),
  ]), check: keyed },
  { url: `${ROOT}/clip/v2/resource/room`, json: v2([
    { id: 'r1', metadata: { name: 'Kitchen' }, children: [{ rid: 'dev-l1', rtype: 'device' }], services: [{ rid: 'g1', rtype: 'grouped_light' }] },
    { id: 'r2', metadata: { name: 'Office' }, children: [{ rid: 'dev-l2', rtype: 'device' }, { rid: 'bridge-ignored', rtype: 'bridge_home' }], services: [{ rid: 'g2', rtype: 'grouped_light' }] },
    { id: 'r3', metadata: { name: 'Empty' }, children: [], services: [] },
  ]), check: keyed },
  { url: `${ROOT}/clip/v2/resource/scene`, json: v2([
    { id: 's1', metadata: { name: 'Relax' }, group: { rid: 'r1', rtype: 'room' } },
    { id: 's2', metadata: { name: 'Zone scene' }, group: { rid: 'z1', rtype: 'zone' } },
  ]), check: keyed },
  { url: `${ROOT}/clip/v2/resource/grouped_light`, json: v2([
    { id: 'g1', on: { on: true }, dimming: { brightness: 70 } },
    { id: 'g2', on: { on: false } },
  ]), check: keyed },
  { url: `${ROOT}/clip/v2/resource/zigbee_connectivity`, json: v2([{ owner: { rid: 'dev-l1' }, status: 'connected' }, { owner: { rid: 'dev-l2' }, status: 'connectivity_issue' }]), check: keyed },
];

test('saving the address pins the certificate and stays unverified until pairing', async () => {
  const transport = transportFor([{ url: `${ROOT}/api/config`, json: INFO, check: unkeyed }]);
  const result = await philipsHue().connect({ bridge: BRIDGE }, null, ctxFor(transport));
  assert.match(result.pending, /Press the round link button/);
  assert.equal(result.config.fingerprint, FP);
  assert.equal(result.config.bridge_id, 'ecb5fafffe123456');
  assert.equal(result.config.app_key, undefined);
  assert.equal(transport.requests[0].url, `${ROOT}/api/config`);
  assert.equal(transport.requests[0].pin, null, 'first contact has nothing to compare with');
  assert.deepEqual(philipsHue().publicConfig({ ...paired, clientkey: 'x' }), { bridge: BRIDGE, name: 'Philips hue' }, 'public config omits the key and fingerprint');
  assert.equal(transport.fetch.pending(), 0);
});

test('only home-network addresses that really are Hue bridges are accepted', async () => {
  await assert.rejects(philipsHue().connect({ bridge: '8.8.8.8' }, null, ctxFor(transportFor([]))), /home-network address/);
  await assert.rejects(philipsHue().connect({}, null, ctxFor(transportFor([]))), /Enter just the device address/);
  await assert.rejects(philipsHue().connect({ bridge: BRIDGE }, null, ctxFor(transportFor([{ url: `${ROOT}/api/config`, json: { hello: 'there' } }]))), /does not look like a Hue Bridge/);
  await assert.rejects(philipsHue().connect({ bridge: BRIDGE }, null, ctxFor(transportFor([{ url: `${ROOT}/api/config`, json: INFO }], { fingerprint: 'nope' }))), /certificate MERLIN can pin/);
  await assert.rejects(philipsHue().connect({ bridge: BRIDGE }, null, ctxFor(transportFor([{ url: `${ROOT}/api/config`, throws: 'timeout' }]))), error => error.kind === 'unreachable' && /did not answer in time/.test(error.message));
});

test('a different certificate on a pinned bridge is refused, from the connector or the transport', async () => {
  const swapped = transportFor([{ url: `${ROOT}/api/config`, json: INFO }], { fingerprint: OTHER_FP });
  await assert.rejects(philipsHue().connect({ bridge: BRIDGE }, saved, ctxFor(swapped)), error => error instanceof ConnectorError && error.kind === 'auth' && /certificate .* changed/.test(error.message));
  assert.equal(swapped.requests[0].pin, FP, 'the pin travels with every request so the real transport can check it before sending anything');

  const act = transportFor([{ url: `${ROOT}/clip/v2/resource/light/l1`, method: 'PUT', json: v2([]) }], { fingerprint: OTHER_FP });
  await assert.rejects(philipsHue().act(paired, { id: 'l1', name: 'Ceiling', kind: 'light', actions: ['turn_on'] }, 'turn_on', undefined, ctxFor(act)), error => error.kind === 'auth' && /changed/.test(error.message));

  const refusing = async () => { throw Object.assign(new Error('pin'), { code: 'HUE_PIN_MISMATCH' }); };
  await assert.rejects(philipsHue().verify(paired, { hueRequest: refusing }), error => error.kind === 'auth' && /changed/.test(error.message));

  const other = transportFor([{ url: `${ROOT}/api/config`, json: { ...INFO, bridgeid: 'AAAAAAFFFEBBBBBB' } }]);
  await assert.rejects(philipsHue().connect({ bridge: BRIDGE }, saved, ctxFor(other)), error => error.kind === 'auth', 'a different bridge answering at the same address is refused');
});

test('pair reports an unpressed link button and does not save anything', async () => {
  const transport = transportFor([{ method: 'POST', url: `${ROOT}/api`, json: [{ error: { type: 101, address: '', description: 'link button not pressed' } }], check: call => {
    unkeyed(call);
    assert.deepEqual(call.body, { devicetype: 'merlin#home', generateclientkey: true });
  } }]);
  await assert.rejects(philipsHue().operations.pair.run(saved, {}, ctxFor(transport)), error => error.kind === 'invalid' && error.message === 'The link button was not pressed. Press it and choose Pair again within 30 seconds.');
  await assert.rejects(philipsHue().operations.pair.run(saved, {}, ctxFor(transportFor([{ method: 'POST', url: `${ROOT}/api`, json: [{ error: { type: 7 } }] }]))), /would not pair/);
  await assert.rejects(philipsHue().operations.pair.run(saved, {}, ctxFor(transportFor([{ method: 'POST', url: `${ROOT}/api`, json: [{ success: { username: 'short' } }] }]))), /usable key/);
  await assert.rejects(philipsHue().operations.pair.run(null, {}, ctxFor(transportFor([]))), /Save the bridge address first/);
});

test('pair stores the application key, drops the client key and verifies access before connecting', async () => {
  const transport = transportFor([
    { method: 'POST', url: `${ROOT}/api`, json: [{ success: { username: KEY, clientkey: 'CLIENT-KEY-NOT-NEEDED' } }] },
    { url: `${ROOT}/clip/v2/resource/bridge`, json: v2([{ id: 'b1', type: 'bridge', bridge_id: 'ECB5FAFFFE123456' }]), check: keyed },
  ]);
  const result = await philipsHue().operations.pair.run(saved, {}, ctxFor(transport));
  assert.equal(result.config.app_key, KEY);
  assert.doesNotMatch(JSON.stringify(result.config), /CLIENT-KEY/);
  assert.match(result.summary, /Paired with Philips hue/);
  assert.equal(transport.requests.at(-1).pin, FP);
  assert.doesNotMatch(JSON.stringify(philipsHue().publicConfig(result.config)), new RegExp(KEY));
});

test('a key the bridge will not honour is revoked instead of left behind', async () => {
  const transport = transportFor([
    { method: 'POST', url: `${ROOT}/api`, json: [{ success: { username: KEY } }] },
    { url: `${ROOT}/clip/v2/resource/bridge`, status: 403, json: {} },
    { method: 'DELETE', url: `${ROOT}/api/${KEY}/config/whitelist/${KEY}`, json: [{ success: `/config/whitelist/${KEY} deleted` }] },
  ]);
  await assert.rejects(philipsHue().operations.pair.run(saved, {}, ctxFor(transport)), error => error.kind === 'auth');
  assert.equal(transport.fetch.pending(), 0);
});

test('pairing again removes the previous key from the bridge', async () => {
  const transport = transportFor([
    { method: 'POST', url: `${ROOT}/api`, json: [{ success: { username: NEW_KEY } }] },
    { url: `${ROOT}/clip/v2/resource/bridge`, json: v2([{ id: 'b1' }]), check: call => assert.equal(call.headers['hue-application-key'], NEW_KEY) },
    { method: 'DELETE', url: `${ROOT}/api/${KEY}/config/whitelist/${KEY}`, json: [{ success: 'deleted' }] },
  ]);
  const result = await philipsHue().operations.pair.run(paired, {}, ctxFor(transport));
  assert.equal(result.config.app_key, NEW_KEY);
  assert.equal(transport.fetch.pending(), 0);
});

test('re-saving a paired bridge re-verifies the key, and falls back to pairing if it was revoked', async () => {
  const ok = transportFor([{ url: `${ROOT}/api/config`, json: INFO }, { url: `${ROOT}/clip/v2/resource/bridge`, json: v2([{ id: 'b1' }]), check: keyed }]);
  const connected = await philipsHue().connect({ bridge: BRIDGE }, paired, ctxFor(ok));
  assert.equal(connected.pending, undefined);
  assert.equal(connected.config.app_key, KEY);
  const revoked = transportFor([{ url: `${ROOT}/api/config`, json: INFO }, { url: `${ROOT}/clip/v2/resource/bridge`, status: 403, json: {} }]);
  const again = await philipsHue().connect({ bridge: BRIDGE }, paired, ctxFor(revoked));
  assert.match(again.pending, /link button/);
  assert.equal(again.config.app_key, undefined, 'a rejected key is not kept');
  const offline = transportFor([{ url: `${ROOT}/api/config`, json: INFO }, { url: `${ROOT}/clip/v2/resource/bridge`, throws: 'timeout' }]);
  await assert.rejects(philipsHue().connect({ bridge: BRIDGE }, paired, ctxFor(offline)), error => error.kind === 'unreachable', 'an outage is not mistaken for a revoked key');
});

test('verify needs a key and reports what the bridge says', async () => {
  await assert.rejects(philipsHue().verify(saved, ctxFor(transportFor([]))), /not finished/);
  assert.match((await philipsHue().verify(paired, ctxFor(transportFor([{ url: `${ROOT}/clip/v2/resource/bridge`, json: v2([{ id: 'b1' }]) }])))).summary, /accepted MERLIN’s key/);
  await assert.rejects(philipsHue().verify(paired, ctxFor(transportFor([{ url: `${ROOT}/clip/v2/resource/bridge`, status: 403, json: {} }]))), error => error.kind === 'auth' && /no longer accepts MERLIN’s key/.test(error.message));
  await assert.rejects(philipsHue().verify(paired, ctxFor(transportFor([{ url: `${ROOT}/clip/v2/resource/bridge`, status: 404, json: {} }]))), error => error.kind === 'unsupported' && /Hue v2 API/.test(error.message));
  await assert.rejects(philipsHue().verify(paired, ctxFor(transportFor([{ url: `${ROOT}/clip/v2/resource/bridge`, json: v2([]) }]))), /did not identify itself/);
});

test('devices map lights to rooms, rooms to group lights, and scenes to their room', async () => {
  const transport = transportFor(inventory);
  const devices = await philipsHue().devices(paired, ctxFor(transport));
  const find = (kind, id) => devices.find(device => device.kind === kind && device.id === id);
  assert.equal(find('light', 'l1').room, 'Kitchen');
  assert.equal(find('light', 'l2').room, 'Office', 'two lamps may share a name; the room tells them apart');
  assert.equal(find('light', 'l3').room, undefined);
  assert.deepEqual(find('light', 'l1').actions, ['turn_on', 'turn_off', 'set_brightness', 'set_color_temperature']);
  assert.deepEqual(find('light', 'l2').actions, ['turn_on', 'turn_off'], 'a light without dimming is not offered brightness');
  assert.deepEqual(find('light', 'l1').state, { on: true, brightness: 50, reachable: true });
  assert.equal(find('light', 'l2').state.reachable, false, 'a light the bridge cannot reach says so');
  assert.deepEqual(find('light', 'l1').extra.mirek, { min: 153, max: 454 });
  assert.deepEqual(find('room', 'g1'), { id: 'g1', name: 'Kitchen', kind: 'room', state: { on: true, brightness: 70 }, actions: ['turn_on', 'turn_off', 'set_brightness'] });
  assert.deepEqual(find('room', 'g2').actions, ['turn_on', 'turn_off']);
  assert.ok(!devices.some(device => device.name === 'Empty'), 'a room with no group light cannot be controlled');
  assert.equal(find('scene', 's1').room, 'Kitchen');
  assert.deepEqual(find('scene', 's1').actions, ['activate']);
  assert.equal(find('scene', 's2').room, undefined);
  assert.equal(transport.fetch.pending(), 0);
});

test('devices still list when connectivity details are unavailable, but not when the key is rejected', async () => {
  const withoutConnectivity = transportFor([...inventory.slice(0, 4), { url: `${ROOT}/clip/v2/resource/zigbee_connectivity`, status: 500, json: {} }]);
  const devices = await philipsHue().devices(paired, ctxFor(withoutConnectivity));
  assert.equal(devices.find(device => device.id === 'l1').state.reachable, undefined);
  const rejected = transportFor([{ url: `${ROOT}/clip/v2/resource/light`, status: 403, json: {}, repeat: true }, { url: /\/clip\/v2\/resource\/(?!light)/u, status: 403, json: {}, repeat: true }]);
  await assert.rejects(philipsHue().devices(paired, ctxFor(rejected)), error => error.kind === 'auth');
});

test('every action sends the documented request and confirms only what the bridge reports', async () => {
  const sleeps = [];
  const light = { id: 'l1', name: 'Ceiling', kind: 'light', actions: [], extra: { mirek: { min: 153, max: 454 } } };
  const room = { id: 'g1', name: 'Kitchen', kind: 'room', actions: [] };
  const scene = { id: 's1', name: 'Relax', kind: 'scene', actions: ['activate'] };
  const run = async (device, action, value, put, after) => {
    const resource = device.kind === 'room' ? 'grouped_light' : device.kind;
    const transport = transportFor([
      { method: 'PUT', url: `${ROOT}/clip/v2/resource/${resource}/${device.id}`, json: v2([{ rid: device.id, rtype: resource }]), check: call => { keyed(call); assert.deepEqual(call.body, put); } },
      ...(after ? [{ url: `${ROOT}/clip/v2/resource/${resource}/${device.id}`, json: v2([after]), check: keyed }] : []),
    ]);
    const result = await philipsHue().act(paired, device, action, value, { ...ctxFor(transport), sleep: async ms => { sleeps.push(ms); } });
    assert.equal(transport.fetch.pending(), 0, `${action} made exactly the expected requests`);
    return result;
  };
  assert.deepEqual(await run(light, 'turn_on', undefined, { on: { on: true } }, { on: { on: true } }), { confirmed: true });
  assert.deepEqual(await run(light, 'turn_off', undefined, { on: { on: false } }, { on: { on: false } }), { confirmed: true });
  assert.deepEqual(await run(light, 'turn_off', undefined, { on: { on: false } }, { on: { on: true } }), { confirmed: false }, 'a light still reporting on is not confirmed off');
  assert.deepEqual(await run(light, 'set_brightness', 30, { on: { on: true }, dimming: { brightness: 30 } }, { on: { on: true }, dimming: { brightness: 30.2 } }), { confirmed: true });
  assert.deepEqual(await run(light, 'set_brightness', 30, { on: { on: true }, dimming: { brightness: 30 } }, { on: { on: true }, dimming: { brightness: 80 } }), { confirmed: false });
  assert.deepEqual(await run(light, 'set_brightness', 0, { on: { on: false } }, { on: { on: false } }), { confirmed: true }, 'brightness zero switches the light off');
  assert.deepEqual(await run(light, 'set_color_temperature', 2700, { on: { on: true }, color_temperature: { mirek: 370 } }, { on: { on: true }, color_temperature: { mirek: 370 } }), { confirmed: true });
  assert.deepEqual(await run(light, 'set_color_temperature', 1500, { on: { on: true }, color_temperature: { mirek: 454 } }, { on: { on: true }, color_temperature: { mirek: 300 } }), { confirmed: false }, 'a warmth the lamp cannot reach is clamped to its own range');
  assert.deepEqual(await run({ ...light, extra: undefined }, 'set_color_temperature', 9000, { on: { on: true }, color_temperature: { mirek: 153 } }, { on: { on: true }, color_temperature: { mirek: 153 } }), { confirmed: true }, 'the Hue default range applies without a schema');
  assert.deepEqual(await run(room, 'turn_off', undefined, { on: { on: false } }, { on: { on: false } }), { confirmed: true });
  assert.deepEqual(await run(room, 'set_brightness', 40, { on: { on: true }, dimming: { brightness: 40 } }, { on: { on: true }, dimming: { brightness: 43 } }), { confirmed: true });
  assert.deepEqual(await run(scene, 'activate', undefined, { recall: { action: 'active' } }), { confirmed: false }, 'a scene recall is accepted, never reported as confirmed');
  assert.ok(sleeps.every(ms => ms === 300));
});

test('an action the device cannot do never reaches the bridge', async () => {
  const none = ctxFor(transportFor([]));
  const room = { id: 'g1', name: 'Kitchen', kind: 'room', actions: [] };
  await assert.rejects(philipsHue().act(paired, room, 'set_color_temperature', 2700, none), error => error.kind === 'unsupported');
  await assert.rejects(philipsHue().act(paired, { id: 's1', name: 'Relax', kind: 'scene', actions: [] }, 'turn_on', undefined, none), error => error.kind === 'unsupported');
  await assert.rejects(philipsHue().act(paired, { id: 'l1', name: 'Ceiling', kind: 'light', actions: [] }, 'lock', undefined, none), error => error.kind === 'unsupported');
});

test('bridge errors, rejected keys, outages and rate limits become honest failures', async () => {
  const light = { id: 'l1', name: 'Ceiling', kind: 'light', actions: ['turn_on'] };
  const put = response => ctxFor(transportFor([{ method: 'PUT', url: `${ROOT}/clip/v2/resource/light/l1`, ...response }]));
  await assert.rejects(philipsHue().act(paired, light, 'turn_on', undefined, put({ json: { errors: [{ description: 'device (light) has communication issues' }], data: [] } })), error => error.kind === 'failed' && /communication issues/.test(error.message));
  await assert.rejects(philipsHue().act(paired, light, 'turn_on', undefined, put({ status: 403, json: {} })), error => error.kind === 'auth');
  await assert.rejects(philipsHue().act(paired, light, 'turn_on', undefined, put({ throws: 'timeout' })), error => error.kind === 'unreachable');
  await assert.rejects(philipsHue().act(paired, light, 'turn_on', undefined, put({ status: 429, headers: { 'retry-after': '3' }, json: {} })), error => error.kind === 'rate_limit' && /3 seconds/.test(error.message));
  await assert.rejects(philipsHue().act(paired, light, 'turn_on', undefined, put({ status: 404, json: {} })), error => error.kind === 'device');
  await assert.rejects(philipsHue().act(paired, light, 'turn_on', undefined, put({ text: 'not json' })), /could not read/);
  const confirmFails = ctxFor(transportFor([{ method: 'PUT', url: `${ROOT}/clip/v2/resource/light/l1`, json: v2([]) }, { url: `${ROOT}/clip/v2/resource/light/l1`, throws: 'timeout' }]));
  assert.deepEqual(await philipsHue().act(paired, light, 'turn_on', undefined, confirmFails), { confirmed: false }, 'an unconfirmed result is still reported as accepted, not as done');
});

test('state reads one resource, and scenes have none', async () => {
  const transport = transportFor([{ url: `${ROOT}/clip/v2/resource/grouped_light/g1`, json: v2([{ id: 'g1', on: { on: true }, dimming: { brightness: 61.2 } }]), check: keyed }]);
  assert.deepEqual(await philipsHue().state(paired, { id: 'g1', kind: 'room' }, ctxFor(transport)), { on: true, brightness: 61 });
  assert.deepEqual(await philipsHue().state(paired, { id: 's1', kind: 'scene' }, ctxFor(transportFor([]))), {});
});

test('disconnect removes the key from the bridge and says so only when the bridge confirms', async () => {
  const revoke = { method: 'DELETE', url: `${ROOT}/api/${KEY}/config/whitelist/${KEY}` };
  const ok = transportFor([{ ...revoke, json: [{ success: `/config/whitelist/${KEY} deleted` }], check: unkeyed }]);
  assert.deepEqual(await philipsHue().disconnect(paired, ctxFor(ok)), { revoked: true, message: 'MERLIN’s key was removed from the Hue Bridge.' });
  const refused = await philipsHue().disconnect(paired, ctxFor(transportFor([{ ...revoke, json: [{ error: { type: 3, description: 'resource not available' } }] }])));
  assert.equal(refused.revoked, false);
  assert.match(refused.message, /may still be allowed to control your lights/);
  assert.match(refused.message, /Hue app/);
  const offline = await philipsHue().disconnect(paired, ctxFor(transportFor([{ ...revoke, throws: 'timeout' }])));
  assert.equal(offline.revoked, false);
  const never = ctxFor(transportFor([]));
  assert.equal((await philipsHue().disconnect(saved, never)).revoked, false, 'nothing was created, so nothing is contacted');
});

test('discovery lists only home-network bridges, at most five, and says what it shares', async () => {
  const found = Array.from({ length: 8 }, (_, index) => ({ id: `00178800000${index}`, internalipaddress: `192.168.1.${60 + index}`, port: 443 }));
  const fetch = mockFetch([{ url: 'https://discovery.meethue.com', json: [{ id: 'x', internalipaddress: '8.8.8.8' }, { id: 'y' }, ...found], check: call => assert.equal(call.redirect, 'error') }]);
  const result = await philipsHue().operations.discover.run(null, {}, { fetch });
  assert.equal(result.config, undefined, 'discovery changes no saved setting');
  assert.equal(result.result.length, 5);
  assert.deepEqual(result.result[0], { id: '001788000000', ip: '192.168.1.60' });
  assert.ok(result.result.every(item => item.ip.startsWith('192.168.')), 'a public address from the service is never offered');
  assert.match(philipsHue().operations.discover.label, /public IP address/);
  assert.match((await philipsHue().operations.discover.run(null, {}, { fetch: mockFetch([{ url: 'https://discovery.meethue.com', json: [] }]) })).summary, /No bridge was found/);
  await assert.rejects(philipsHue().operations.discover.run(null, {}, { fetch: mockFetch([{ url: 'https://discovery.meethue.com', status: 429, json: {} }]) }), error => error.kind === 'rate_limit');
});

test('through the hub: saved after the address, connected after pairing, controlled by name with a receipt', async () => {
  const transport = transportFor([
    { url: `${ROOT}/api/config`, json: INFO },
    { method: 'POST', url: `${ROOT}/api`, json: [{ success: { username: KEY } }] },
    { url: `${ROOT}/clip/v2/resource/bridge`, json: v2([{ id: 'b1' }]) },
    ...inventory,
    { method: 'PUT', url: `${ROOT}/clip/v2/resource/light/l2`, json: v2([{ rid: 'l2', rtype: 'light' }]), check: call => assert.deepEqual(call.body, { on: { on: true } }) },
    { url: `${ROOT}/clip/v2/resource/light/l2`, json: v2([{ id: 'l2', on: { on: true } }]) },
  ]);
  const dir = await mkdtemp(join(tmpdir(), 'merlin-hue-'));
  const filePath = join(dir, 'connectors.json');
  const hub = await new ConnectorHub({ filePath, connectors: [philipsHue({ transport })], fetch: transport.fetch, sleep: noSleep }).init();

  const first = await hub.connect('philips-hue', { bridge: BRIDGE });
  assert.equal(first.status, 'saved');
  assert.deepEqual(hub.tools(), [], 'a saved address is not a working connection');
  assert.match(hub.instructions(), /Philips Hue \(setup unfinished\)/);
  const second = await hub.operation('philips-hue', 'pair');
  assert.equal(second.status, 'connected');
  assert.deepEqual(second.values, { bridge: BRIDGE, name: 'Philips hue' });
  assert.doesNotMatch(JSON.stringify([hub.list(), hub.instructions(), hub.tools()]), new RegExp(`${KEY}|${FP}`));
  assert.match(await readFile(filePath, 'utf8'), new RegExp(KEY), 'the key lives only in the private server file');

  // The inventory is fetched once and cached briefly, so ask the ambiguous question first.
  const ambiguous = await hub.executeTool('home_control', { device: 'ceiling', action: 'turn_off' });
  assert.match(ambiguous.message, /More than one device matches/, 'same name in two rooms asks which one');
  const receipt = await hub.executeTool('home_control', { device: 'office ceiling', action: 'turn_on' });
  assert.deepEqual([receipt.ok, receipt.status, receipt.confirmed], [true, 'confirmed', true]);
  assert.match(receipt.message, /Turned on Ceiling\. Philips Hue reports it/);
});

// ---- the real transport, against a throwaway local TLS server -------------------------------------------------------

async function localTlsServer() {
  const dir = await mkdtemp(join(tmpdir(), 'merlin-hue-tls-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=bridge.test'], { stdio: 'ignore' });
  } catch { return null; }
  const key = await readFile(join(dir, 'key.pem'));
  const cert = await readFile(join(dir, 'cert.pem'));
  const seen = [];
  const server = https.createServer({ key, cert }, (request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      seen.push({ method: request.method, url: request.url, key: request.headers['hue-application-key'], body: Buffer.concat(chunks).toString('utf8') });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const fingerprint = new X509Certificate(cert).fingerprint256.toLowerCase().replace(/:/gu, '');
  return { server, seen, fingerprint, port: server.address().port };
}

test('the real transport checks the pinned certificate before sending the application key', async t => {
  const local = await localTlsServer();
  if (!local) { t.skip('openssl is not available to create a test certificate'); return; }
  t.after(() => new Promise(done => { local.server.closeAllConnections(); local.server.close(done); }));
  const url = `https://127.0.0.1:${local.port}/clip/v2/resource/light/l1`;

  const first = await hueTransport({ url, method: 'PUT', headers: { 'hue-application-key': 'first-contact-key' }, body: '{"on":{"on":true}}', pin: null });
  assert.equal(first.status, 200);
  assert.equal(JSON.parse(first.text).ok, true);
  assert.equal(first.fingerprint, local.fingerprint, 'first use reports the certificate to pin');
  assert.deepEqual(local.seen.at(-1), { method: 'PUT', url: '/clip/v2/resource/light/l1', key: 'first-contact-key', body: '{"on":{"on":true}}' });

  const pinned = await hueTransport({ url, headers: { 'hue-application-key': 'pinned-key' }, pin: local.fingerprint });
  assert.equal(pinned.status, 200);

  const before = local.seen.length;
  await assert.rejects(hueTransport({ url, headers: { 'hue-application-key': 'must-not-be-sent' }, pin: OTHER_FP }), error => error.code === 'HUE_PIN_MISMATCH');
  assert.equal(local.seen.length, before, 'the server never saw a request, so the key was never sent');

  await assert.rejects(hueTransport({ url, pin: null, signal: AbortSignal.abort() }), error => error.name === 'AbortError');
  await assert.rejects(hueTransport({ url: 'https://127.0.0.1:1/', pin: null }), error => error.code === 'ECONNREFUSED');
});
