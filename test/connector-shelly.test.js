import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { shelly } from '../src/connectors/shelly.js';
import { ConnectorError } from '../src/connectors/base.js';
import { mockFetch, noSleep } from './mock-fetch.js';

const HOST = '192.168.1.20';
const URL = path => `http://${HOST}/rpc/${path}`;
const ctx = fetch => ({ fetch, sleep: noSleep });
const sha256 = text => createHash('sha256').update(text).digest('hex');
const INFO = { id: 'shellyplus1-a8032abc', name: 'Hallway', model: 'SNSW-001X16EU', gen: 2, auth_en: false };
const STATUS = { 'switch:0': { id: 0, output: true }, wifi: { sta_ip: HOST } };
const CHALLENGE = 'Digest qop="auth", realm="shellyplus1-a8032abc", nonce="5f3a9c1e", algorithm=SHA-256';

/** Independent check of the documented RFC 7616 SHA-256 response, written without the implementation's helper. */
function assertValidDigest(call, { password, uri, nc }) {
  const header = call.headers.authorization;
  assert.match(header, /^Digest /);
  const field = name => header.match(new RegExp(`${name}=(?:"([^"]*)"|([^,\\s]+))`))?.slice(1).find(Boolean);
  assert.equal(field('username'), 'admin');
  assert.equal(field('realm'), 'shellyplus1-a8032abc');
  assert.equal(field('nonce'), '5f3a9c1e');
  assert.equal(field('uri'), uri);
  assert.equal(field('qop'), 'auth');
  assert.equal(field('algorithm'), 'SHA-256');
  assert.equal(field('nc'), nc);
  const ha1 = sha256(`admin:shellyplus1-a8032abc:${password}`);
  const ha2 = sha256(`GET:${uri}`);
  assert.equal(field('response'), sha256(`${ha1}:5f3a9c1e:${nc}:${field('cnonce')}:auth:${ha2}`));
  assert.ok(!header.includes(password), 'the password itself is never sent');
}

test('connecting an open Shelly proves access and stores no password', async () => {
  const fetch = mockFetch([{ url: URL('Shelly.GetDeviceInfo'), json: INFO }, { url: URL('Shelly.GetStatus'), json: STATUS }]);
  const connector = shelly();
  const { config, summary } = await connector.connect({ host: HOST, password: 'unused-because-no-auth' }, null, ctx(fetch));
  assert.deepEqual(config.devices, [{ host: HOST, id: INFO.id, name: 'Hallway', model: INFO.model, gen: 2, auth: false }]);
  assert.match(summary, /Connected Hallway/);
  assert.equal(fetch.pending(), 0);
  assert.ok(fetch.calls.every(call => call.redirect === 'error' && !call.headers.authorization));
  assert.deepEqual(connector.publicConfig(config), { devices: [{ host: HOST, name: 'Hallway', model: INFO.model }] });
});

test('another Shelly is added beside the first and the same address is replaced', async () => {
  const existing = { host: '192.168.1.21', id: 'shelly1pm-1', name: 'Garden', model: 'X', gen: 2, auth: false };
  const connector = shelly();
  const added = await connector.connect({ host: HOST }, { devices: [existing] }, ctx(mockFetch([{ url: URL('Shelly.GetDeviceInfo'), json: INFO }, { url: URL('Shelly.GetStatus'), json: STATUS }])));
  assert.deepEqual(added.config.devices.map(device => device.host), ['192.168.1.21', HOST]);
  const again = await connector.connect({ host: HOST }, added.config, ctx(mockFetch([{ url: URL('Shelly.GetDeviceInfo'), json: { ...INFO, name: 'Renamed' } }, { url: URL('Shelly.GetStatus'), json: STATUS }])));
  assert.deepEqual(again.config.devices.map(device => device.name), ['Garden', 'Renamed']);
});

test('first-generation devices and unreadable answers are refused plainly', async () => {
  const gen1 = await shelly().connect({ host: HOST }, null, ctx(mockFetch([{ url: URL('Shelly.GetDeviceInfo'), status: 404, text: 'Not Found' }]))).catch(error => error);
  assert.ok(gen1 instanceof ConnectorError);
  assert.equal(gen1.kind, 'unsupported');
  assert.match(gen1.message, /First-generation Shelly devices are not supported/);
  await assert.rejects(shelly().connect({ host: HOST }, null, ctx(mockFetch([{ url: URL('Shelly.GetDeviceInfo'), json: { ...INFO, gen: 1 } }]))), /First-generation/);
  await assert.rejects(shelly().connect({ host: HOST }, null, ctx(mockFetch([{ url: URL('Shelly.GetDeviceInfo'), text: '<html>router</html>' }]))), /First-generation/);
  await assert.rejects(shelly().connect({ host: HOST }, null, ctx(mockFetch([{ url: URL('Shelly.GetDeviceInfo'), json: INFO }, { url: URL('Shelly.GetStatus'), json: { wifi: {}, 'input:0': {} } }]))), error => error.kind === 'unsupported' && /no switch, light or cover/.test(error.message));
});

test('addresses off the home network never reach the network', async () => {
  const fetch = mockFetch([]);
  for (const host of ['8.8.8.8', 'example.com', 'http://192.168.1.20', '192.168.1.20:80', '']) {
    await assert.rejects(shelly().connect({ host }, null, ctx(fetch)), error => error.kind === 'invalid', host);
  }
  assert.equal(fetch.calls.length, 0);
});

test('a Shelly with a password needs it, then answers the SHA-256 digest challenge', async () => {
  const guarded = { ...INFO, auth_en: true };
  await assert.rejects(shelly().connect({ host: HOST }, null, ctx(mockFetch([{ url: URL('Shelly.GetDeviceInfo'), json: guarded }]))), error => error.kind === 'invalid' && /has a password/.test(error.message));

  const fetch = mockFetch([
    { url: URL('Shelly.GetDeviceInfo'), json: guarded, check: call => assert.ok(!call.headers.authorization, 'device info never needs authentication') },
    { url: URL('Shelly.GetStatus'), status: 401, headers: { 'www-authenticate': CHALLENGE }, json: {} },
    { url: URL('Shelly.GetStatus'), json: STATUS, check: call => assertValidDigest(call, { password: 'correct horse', uri: '/rpc/Shelly.GetStatus', nc: '00000001' }) },
  ]);
  const { config } = await shelly().connect({ host: HOST, password: 'correct horse' }, null, ctx(fetch));
  assert.equal(fetch.pending(), 0);
  assert.equal(config.devices[0].password, 'correct horse', 'kept on the server for later requests');
  assert.ok(!JSON.stringify(shelly().publicConfig(config)).includes('correct horse'));
});

test('a wrong password is an authentication failure that never echoes the password', async () => {
  const fetch = mockFetch([
    { url: URL('Shelly.GetDeviceInfo'), json: { ...INFO, auth_en: true } },
    { url: URL('Shelly.GetStatus'), status: 401, headers: { 'www-authenticate': CHALLENGE }, json: {} },
    { url: URL('Shelly.GetStatus'), status: 401, headers: { 'www-authenticate': CHALLENGE }, json: {} },
  ]);
  const error = await shelly().connect({ host: HOST, password: 'wrong-pass' }, null, ctx(fetch)).catch(item => item);
  assert.ok(error instanceof ConnectorError);
  assert.equal(error.kind, 'auth');
  assert.match(error.message, /rejected the saved password/);
  assert.ok(!error.message.includes('wrong-pass'));
  assert.equal(fetch.calls.filter(call => call.url.endsWith('Shelly.GetStatus')).length, 2, 'retries once, no more');
});

test('an unsupported authentication scheme is not answered', async () => {
  const fetch = mockFetch([
    { url: URL('Shelly.GetDeviceInfo'), json: { ...INFO, auth_en: true } },
    { url: URL('Shelly.GetStatus'), status: 401, headers: { 'www-authenticate': 'Digest realm="x", nonce="n", algorithm=MD5' }, json: {} },
  ]);
  await assert.rejects(shelly().connect({ host: HOST, password: 'pw' }, null, ctx(fetch)), error => error.kind === 'auth');
  assert.equal(fetch.calls.filter(call => call.headers.authorization).length, 0);
});

test('the nonce is reused with an increasing counter instead of a challenge per request', async () => {
  const config = { devices: [{ host: HOST, id: INFO.id, name: 'Hallway', model: 'M', gen: 2, auth: true, password: 'pw1' }] };
  const connector = shelly();
  const fetch = mockFetch([
    { url: URL('Shelly.GetStatus'), status: 401, headers: { 'www-authenticate': CHALLENGE }, json: {} },
    { url: URL('Shelly.GetStatus'), json: STATUS, check: call => assertValidDigest(call, { password: 'pw1', uri: '/rpc/Shelly.GetStatus', nc: '00000001' }) },
    { url: URL('Shelly.GetStatus'), json: STATUS, check: call => assertValidDigest(call, { password: 'pw1', uri: '/rpc/Shelly.GetStatus', nc: '00000002' }) },
  ]);
  await connector.verify(config, ctx(fetch));
  await connector.verify(config, ctx(fetch));
  assert.equal(fetch.pending(), 0);
});

test('timeouts and rate limits are reported with the device named', async () => {
  const timeout = await shelly().connect({ host: HOST }, null, ctx(mockFetch([{ url: URL('Shelly.GetDeviceInfo'), throws: 'timeout' }]))).catch(error => error);
  assert.equal(timeout.kind, 'unreachable');
  assert.match(timeout.message, new RegExp(`Shelly at ${HOST} did not answer in time`));
  const limited = await shelly().connect({ host: HOST }, null, ctx(mockFetch([{ url: URL('Shelly.GetDeviceInfo'), status: 429, headers: { 'retry-after': '5' }, json: {} }]))).catch(error => error);
  assert.equal(limited.kind, 'rate_limit');
});

const LISTING = {
  status: { 'switch:0': { id: 0, output: true }, 'switch:1': { id: 1, output: false }, 'light:0': { id: 0, output: true, brightness: 60 },
    'cover:0': { id: 0, state: 'open', current_pos: 70, pos_control: true }, 'cover:1': { id: 1, state: 'stopped', current_pos: null }, wifi: {} },
  settings: { 'switch:0': { id: 0, name: 'Desk Lamp' }, 'switch:1': { id: 1, name: null }, 'light:0': { id: 0, name: '' }, 'cover:0': { id: 0, name: 'Office Blind' }, 'cover:1': { id: 1, name: 'Garage Door' } },
};
const listed = { devices: [{ host: HOST, id: INFO.id, name: 'Hallway', model: 'M', gen: 2, auth: false }] };

test('components become devices with honest actions and state', async () => {
  const fetch = mockFetch([{ url: URL('Shelly.GetStatus'), json: LISTING.status }, { url: URL('Shelly.GetConfig'), json: LISTING.settings }]);
  const devices = await shelly().devices(listed, ctx(fetch));
  const by = Object.fromEntries(devices.map(device => [device.name, device]));
  assert.deepEqual(Object.keys(by).sort(), ['Desk Lamp', 'Garage Door', 'Hallway', 'Hallway 2', 'Office Blind']);
  assert.equal(by['Desk Lamp'].id, `${HOST}#switch:0`);
  assert.equal(by['Desk Lamp'].room, 'Hallway');
  assert.deepEqual([by['Desk Lamp'].kind, by['Desk Lamp'].state.on, by['Desk Lamp'].actions], ['switch', true, ['turn_on', 'turn_off', 'toggle']]);
  assert.equal(by.Hallway.id, `${HOST}#light:0`, 'a lone unnamed component takes the device name');
  assert.equal(by['Hallway 2'].id, `${HOST}#switch:1`, 'several unnamed components of one type are numbered');
  assert.deepEqual([by.Hallway.kind, by.Hallway.state.brightness, by.Hallway.actions.includes('set_brightness')], ['light', 60, true]);
  assert.deepEqual(by['Office Blind'].actions, ['open', 'close', 'stop', 'set_position']);
  assert.equal(by['Office Blind'].state.position, 70);
  assert.deepEqual(by['Garage Door'].actions, [], 'anything that might be a garage door is read-only');
});

test('an uncalibrated cover cannot be sent to a position', async () => {
  const status = { 'cover:0': { id: 0, state: 'stopped', current_pos: null } };
  const devices = await shelly().devices(listed, ctx(mockFetch([{ url: URL('Shelly.GetStatus'), json: status }, { url: URL('Shelly.GetConfig'), json: { 'cover:0': { name: 'Bedroom Shade' } } }])));
  assert.deepEqual(devices[0].actions, ['open', 'close', 'stop']);
});

test('one device being off does not hide the others, but all being off is an error', async () => {
  const two = { devices: [...listed.devices, { host: '192.168.1.21', id: 'b', name: 'Garden', model: 'M', gen: 2, auth: false }] };
  const partial = mockFetch([
    { url: URL('Shelly.GetStatus'), json: { 'switch:0': { output: false } } }, { url: URL('Shelly.GetConfig'), json: { 'switch:0': { name: 'Lamp' } } },
    { url: 'http://192.168.1.21/rpc/Shelly.GetStatus', throws: 'boom' }, { url: 'http://192.168.1.21/rpc/Shelly.GetConfig', throws: 'boom' },
  ]);
  assert.deepEqual((await shelly().devices(two, ctx(partial))).map(device => device.name), ['Lamp']);
  const none = mockFetch([{ url: /Shelly\.Get/, throws: 'boom', repeat: true }]);
  await assert.rejects(shelly().devices(two, ctx(none)), error => error.kind === 'unreachable');
  const verified = mockFetch([{ url: URL('Shelly.GetStatus'), json: STATUS }, { url: 'http://192.168.1.21/rpc/Shelly.GetStatus', throws: 'boom' }]);
  assert.match((await shelly().verify(two, ctx(verified))).summary, /1 of 2 Shelly devices answered\. Not answering: Garden/);
  await assert.rejects(shelly().verify(two, ctx(mockFetch([{ url: /Shelly\.GetStatus/, throws: 'boom', repeat: true }]))), error => error.kind === 'unreachable');
});

test('switch commands use the documented RPC and are confirmed only when the output matches', async () => {
  const device = { id: `${HOST}#switch:0`, name: 'Desk Lamp', kind: 'switch', actions: ['turn_on', 'turn_off', 'toggle'] };
  const on = mockFetch([
    { url: URL('Switch.Set?id=0&on=true'), json: { was_on: false } },
    { url: URL('Switch.GetStatus?id=0'), json: { id: 0, output: true } },
  ]);
  assert.deepEqual(await shelly().act(listed, device, 'turn_on', undefined, ctx(on)), { confirmed: true });
  const stuck = mockFetch([
    { url: URL('Switch.Set?id=0&on=false'), json: { was_on: true } },
    { url: URL('Switch.GetStatus?id=0'), json: { id: 0, output: true } },
  ]);
  assert.deepEqual(await shelly().act(listed, device, 'turn_off', undefined, ctx(stuck)), { confirmed: false });
  const toggled = mockFetch([
    { url: URL('Switch.Toggle?id=0'), json: { was_on: true } },
    { url: URL('Switch.GetStatus?id=0'), json: { id: 0, output: false } },
  ]);
  assert.deepEqual(await shelly().act(listed, device, 'toggle', undefined, ctx(toggled)), { confirmed: true });
  const unreadable = mockFetch([{ url: URL('Switch.Set?id=0&on=true'), json: { was_on: false } }, { url: URL('Switch.GetStatus?id=0'), throws: 'boom' }]);
  assert.deepEqual(await shelly().act(listed, device, 'turn_on', undefined, ctx(unreadable)), { confirmed: false });
});

test('light brightness uses Light.Set and zero means off', async () => {
  const device = { id: `${HOST}#light:0`, name: 'Hall Light', kind: 'light', actions: ['turn_on', 'turn_off', 'set_brightness'] };
  const dim = mockFetch([
    { url: URL('Light.Set?id=0&on=true&brightness=40'), json: { was_on: true } },
    { url: URL('Light.GetStatus?id=0'), json: { id: 0, output: true, brightness: 41 } },
  ]);
  assert.deepEqual(await shelly().act(listed, device, 'set_brightness', 40, ctx(dim)), { confirmed: true });
  const off = mockFetch([
    { url: URL('Light.Set?id=0&on=false'), json: { was_on: true } },
    { url: URL('Light.GetStatus?id=0'), json: { id: 0, output: false, brightness: 41 } },
  ]);
  assert.deepEqual(await shelly().act(listed, device, 'set_brightness', 0, ctx(off)), { confirmed: true });
  const toggle = mockFetch([{ url: URL('Light.Toggle?id=0'), json: { was_on: false } }, { url: URL('Light.GetStatus?id=0'), json: { output: true } }]);
  assert.deepEqual(await shelly().act(listed, device, 'toggle', undefined, ctx(toggle)), { confirmed: true });
});

test('covers are confirmed only after they arrive, never while moving', async () => {
  const device = { id: `${HOST}#cover:0`, name: 'Office Blind', kind: 'cover', actions: ['open', 'close', 'stop', 'set_position'] };
  const moving = mockFetch([{ url: URL('Cover.Open?id=0'), json: null }, { url: URL('Cover.GetStatus?id=0'), json: { id: 0, state: 'opening', current_pos: 10 } }]);
  assert.deepEqual(await shelly().act(listed, device, 'open', undefined, ctx(moving)), { confirmed: false });
  const arrived = mockFetch([{ url: URL('Cover.Close?id=0'), json: null }, { url: URL('Cover.GetStatus?id=0'), json: { id: 0, state: 'closed', current_pos: 0 } }]);
  assert.deepEqual(await shelly().act(listed, device, 'close', undefined, ctx(arrived)), { confirmed: true });
  const there = mockFetch([{ url: URL('Cover.GoToPosition?id=0&pos=50'), json: null }, { url: URL('Cover.GetStatus?id=0'), json: { id: 0, state: 'stopped', current_pos: 49 } }]);
  assert.deepEqual(await shelly().act(listed, device, 'set_position', 50, ctx(there)), { confirmed: true });
  const short = mockFetch([{ url: URL('Cover.GoToPosition?id=0&pos=50'), json: null }, { url: URL('Cover.GetStatus?id=0'), json: { id: 0, state: 'opening', current_pos: 20 } }]);
  assert.deepEqual(await shelly().act(listed, device, 'set_position', 50, ctx(short)), { confirmed: false });
  const stopped = mockFetch([{ url: URL('Cover.Stop?id=0'), json: null }, { url: URL('Cover.GetStatus?id=0'), json: { id: 0, state: 'stopped', current_pos: 20 } }]);
  assert.deepEqual(await shelly().act(listed, device, 'stop', undefined, ctx(stopped)), { confirmed: true });
});

test('unsupported actions and removed devices never reach the network', async () => {
  const fetch = mockFetch([]);
  const lamp = { id: `${HOST}#switch:0`, name: 'Desk Lamp', kind: 'switch', actions: ['turn_on'] };
  await assert.rejects(shelly().act(listed, lamp, 'open', undefined, ctx(fetch)), error => error.kind === 'unsupported');
  await assert.rejects(shelly().act(listed, { ...lamp, id: '192.168.1.99#switch:0' }, 'turn_on', undefined, ctx(fetch)), error => error.kind === 'device');
  assert.equal(fetch.calls.length, 0);
});

test('a rejected saved password during an action is an authentication failure', async () => {
  const guarded = { devices: [{ ...listed.devices[0], auth: true, password: 'old-pass' }] };
  const lamp = { id: `${HOST}#switch:0`, name: 'Desk Lamp', kind: 'switch', actions: ['turn_on'] };
  const fetch = mockFetch([
    { url: URL('Switch.Set?id=0&on=true'), status: 401, headers: { 'www-authenticate': CHALLENGE }, json: {} },
    { url: URL('Switch.Set?id=0&on=true'), status: 401, headers: { 'www-authenticate': CHALLENGE }, json: {} },
  ]);
  await assert.rejects(shelly().act(guarded, lamp, 'turn_on', undefined, ctx(fetch)), error => error.kind === 'auth' && !error.message.includes('old-pass'));
});

test('live state is read from the component', async () => {
  const device = { id: `${HOST}#cover:0`, name: 'Office Blind', kind: 'cover', actions: [] };
  const state = await shelly().state(listed, device, ctx(mockFetch([{ url: URL('Cover.GetStatus?id=0'), json: { id: 0, state: 'open', current_pos: 55 } }])));
  assert.deepEqual(state, { position: 55, on: true });
});

test('removing one Shelly keeps the rest and refuses to remove the last', async () => {
  const two = { devices: [...listed.devices, { host: '192.168.1.21', id: 'b', name: 'Garden', model: 'M', gen: 2, auth: false }] };
  const { remove } = shelly().operations;
  assert.equal(remove.needs, 'saved');
  const result = await remove.run(two, { host: '192.168.1.21' }, {});
  assert.deepEqual(result.config.devices.map(device => device.host), [HOST]);
  await assert.rejects(remove.run(result.config, { host: HOST }, {}), /Use Disconnect to remove the last Shelly/);
  await assert.rejects(remove.run(two, { host: '192.168.1.77' }, {}), /not saved/);
  await assert.rejects(remove.run(two, { host: '8.8.8.8' }, {}), error => error.kind === 'invalid');
});

test('disconnect says plainly that nothing remote needs revoking', async () => {
  const result = await shelly().disconnect(listed);
  assert.equal(result.revoked, false);
  assert.match(result.message, /no remote access to revoke/);
});
