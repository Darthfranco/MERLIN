import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../src/server.js';
import { ConnectorHub } from '../src/connectors/hub.js';
import { ConnectorError } from '../src/connectors/base.js';

const call = (name, args, call_id = randomUUID()) => ({ type: 'function_call', status: 'completed', name, arguments: JSON.stringify(args), call_id });
const reply = text => ({ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text, annotations: [] }] });
const chat = (message, session_id = randomUUID()) => ({ message, session_id, request_id: randomUUID(), time_zone: 'America/New_York' });
const connectionCards = body => (body.presentation ?? []).filter(card => card.type === 'connections');

function scriptedMeta(steps) {
  return {
    configured: true, model: 'synthetic-connections', calls: [], failures: [],
    async respond(input, tools, instructions) {
      this.calls.push(structuredClone({ input, tools, instructions }));
      assert.ok(steps.length, 'Unexpected extra model invocation');
      const step = steps.shift();
      try { return typeof step === 'function' ? await step(input, { tools, instructions }) : structuredClone(step); }
      catch (error) { this.failures.push(error); throw error; }
    },
  };
}

const SECRET = 'super-secret-key-1234';

/** A stand-in for a real service. Mock responses prove MERLIN's handling only, not that any live service works. */
function fakeHue() {
  const connector = {
    id: 'philips-hue', name: 'Fake Hue', summary: 'A fake lighting service.', kinds: ['light'], calls: [],
    fields: [{ name: 'bridge', label: 'Bridge address', type: 'text' }, { name: 'key', label: 'Key', type: 'secret' }],
    publicConfig: config => ({ bridge: config.bridge }),
    async connect(input) {
      if (input.key === 'bad') throw new ConnectorError('auth', 'Fake Hue rejected the saved credentials.');
      if (!input.key) return { config: { bridge: input.bridge }, pending: 'Press the link button, then choose Pair.' };
      return { config: { bridge: input.bridge, key: input.key }, summary: 'Connected.' };
    },
    async verify(config) { if (config.key === 'expired') throw new ConnectorError('auth', 'Fake Hue rejected the saved credentials.'); return { summary: 'Still good.' }; },
    async devices() { return [{ id: '1', name: 'Desk Lamp', kind: 'light', state: { on: false }, actions: ['turn_on', 'turn_off'] }]; },
    async act(_config, device, action) { connector.calls.push([device.id, action]); if (connector.fail) throw connector.fail; return { confirmed: true }; },
    async disconnect() { return { revoked: true, message: 'Access revoked on the bridge.' }; },
    operations: { pair: { label: 'Pair', needs: 'saved', async run(config) { return { config: { ...config, key: SECRET }, summary: 'Paired.' }; } } },
  };
  return connector;
}

async function fixture(t, meta) {
  const directory = await mkdtemp(join(tmpdir(), 'merlin-connections-it-'));
  const hue = fakeHue();
  const connectorHub = await new ConnectorHub({ filePath: join(directory, 'connectors.json'), connectors: [hue], sleep: async () => {} }).init();
  const app = await createApp({ dataDir: directory, meta, connectorHub, learningDelayMs: 60000 });
  t.after(async () => {
    await app.learning.close();
    if (app.server.listening) {
      const finished = new Promise((resolve, reject) => app.server.close(error => error ? reject(error) : resolve()));
      app.server.closeAllConnections();
      await finished;
    }
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  const port = app.server.address().port;
  const send = (path, body, headers = {}) => new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = text; try { parsed = JSON.parse(text); } catch { /* static assets are not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return Object.assign(app, { send, directory, hue });
}

test('asking how to connect something opens the setup guide on the large screen', async t => {
  const meta = scriptedMeta([(_input, { tools, instructions }) => {
    assert.ok(tools.some(tool => tool.name === 'show_connections'));
    assert.match(instructions, /large connection screen is now open/);
    assert.match(instructions, /setup guide for Ring/);
    assert.match(instructions, /connects nothing, so never say or imply that a device now works/);
    assert.match(instructions, /No home service is verified as connected/);
    return [reply('Tap Ring on the big screen to get started.')];
  }]);
  const app = await fixture(t, meta);
  const { status, body } = await app.send('/api/chat', chat('How do I connect my Ring doorbell?'));
  assert.deepEqual(meta.failures.map(error => error.message), []);
  assert.equal(status, 200);
  assert.equal(meta.calls.length, 1, 'the screen opens locally; the model only writes the reply');
  assert.deepEqual(connectionCards(body), [{ type: 'connections', id: 'connections', category: 'cameras', entry: 'ring', query: '', reason: 'You asked how to connect something.' }]);
  assert.deepEqual(body.tool_events.filter(event => event.tool === 'show_connections').length, 1);
  assert.ok(body.trace.events.some(event => event.stage === 'tool_result' && event.data?.tool === 'show_connections'));
});

test('asking for something never connected opens the matching category and admits nothing is connected', async t => {
  const meta = scriptedMeta([(_input, { instructions }) => {
    assert.match(instructions, /showing lights options/);
    assert.match(instructions, /cannot do that yet because nothing is connected/);
    return [reply("I can't control the lights yet, mister. Tap an option on the big screen.")];
  }]);
  const app = await fixture(t, meta);
  const { body } = await app.send('/api/chat', chat('turn on the living room lights'));
  assert.deepEqual(meta.failures.map(error => error.message), []);
  assert.equal(connectionCards(body)[0].category, 'lights');
  assert.match(body.reply, /can't control the lights/);
});

test('a category covered by a verified connector does not reopen the screen; the model gets device tools and receipts decide the reply', async t => {
  const meta = scriptedMeta([
    (_input, { tools, instructions }) => {
      assert.ok(tools.some(tool => tool.name === 'home_control') && tools.some(tool => tool.name === 'home_list_devices'));
      assert.match(instructions, /Verified connected home services .*Fake Hue/);
      assert.doesNotMatch(instructions, /large connection screen is now open/);
      return [call('home_control', { device: 'desk lamp', action: 'turn_on' }, 'lamp-1')];
    },
    input => {
      const output = JSON.parse(input.findLast(item => item.type === 'function_call_output').output);
      assert.deepEqual([output.ok, output.result.status, output.result.confirmed], [true, 'confirmed', true]);
      return [reply('All done, mister!')];
    },
  ]);
  const app = await fixture(t, meta);
  await app.send('/api/connectors/philips-hue/connect', { bridge: '192.168.1.5', key: 'k' });
  const { body } = await app.send('/api/chat', chat('turn on the lights'));
  assert.deepEqual(meta.failures.map(error => error.message), []);
  assert.deepEqual(connectionCards(body), [], 'a real connection exists for lights, so the setup screen stays closed');
  assert.deepEqual(app.hue.calls, [['1', 'turn_on']]);
  assert.match(body.reply, /Turned on Desk Lamp\. Fake Hue reports it\./);
  assert.ok(body.tool_events.some(event => event.tool === 'home_control' && event.status === 'completed'));
});

test('saved but unfinished settings are not a connection: the screen still opens and no device tool exists', async t => {
  const meta = scriptedMeta([(_input, { tools, instructions }) => {
    assert.equal(tools.some(tool => tool.name === 'home_control'), false);
    assert.match(instructions, /Fake Hue \(setup unfinished\)/);
    assert.match(instructions, /showing lights options/);
    return [reply("I can't control the lights yet. Finish setting up on the big screen.")];
  }]);
  const app = await fixture(t, meta);
  assert.equal((await app.send('/api/connectors/philips-hue/connect', { bridge: '192.168.1.5' })).body.status, 'saved');
  const { body } = await app.send('/api/chat', chat('turn on the lights'));
  assert.deepEqual(meta.failures.map(error => error.message), []);
  assert.equal(connectionCards(body)[0].category, 'lights');
});

test('a failed device action replaces any success claim the model made', async t => {
  const meta = scriptedMeta([
    [call('home_control', { device: 'desk lamp', action: 'turn_on' }, 'lamp-2')],
    () => [reply('I turned on the lamp. Anything else?')],
  ]);
  const app = await fixture(t, meta);
  await app.send('/api/connectors/philips-hue/connect', { bridge: '192.168.1.5', key: 'k' });
  app.hue.fail = new ConnectorError('unreachable', 'Fake Hue could not be reached.');
  const { body } = await app.send('/api/chat', chat('turn on the desk lamp'));
  assert.deepEqual(meta.failures.map(error => error.message), []);
  assert.doesNotMatch(body.reply, /turned on the lamp/i);
  assert.match(body.reply, /Fake Hue could not be reached\./);
  assert.ok(body.tool_events.some(event => event.tool === 'home_control' && event.status === 'failed'));
});

test('the model can open the screen for phrasing the classifier misses, and a repeat call is idempotent', async t => {
  const meta = scriptedMeta([
    [call('show_connections', { category: 'garage' }, 'open-1')],
    input => {
      const output = JSON.parse(input.findLast(item => item.type === 'function_call_output').output);
      assert.deepEqual([output.ok, output.result.shown, output.result.category], [true, true, 'garage']);
      return [reply('The options are on the big screen.')];
    },
    [call('show_connections', {}, 'confirm-1')],
    input => {
      const output = JSON.parse(input.findLast(item => item.type === 'function_call_output').output);
      assert.match(output.result.note, /already on the large screen/);
      return [reply('Righto, mister! Those options are already on the big screen.')];
    },
  ]);
  const app = await fixture(t, meta);
  const first = await app.send('/api/chat', chat('my opener has been acting up lately'));
  assert.deepEqual(meta.failures.map(error => error.message), []);
  assert.equal(connectionCards(first.body)[0].category, 'garage');
  // The user's words open it locally; the model's argument-free call only confirms and adds nothing.
  const second = await app.send('/api/chat', chat('how do I connect my Sonos speaker'));
  assert.deepEqual(meta.failures.map(error => error.message), []);
  assert.equal(second.status, 200);
  assert.equal(second.body.tool_events.filter(event => event.tool === 'show_connections').length, 1);
  assert.equal(connectionCards(second.body)[0].entry, 'sonos');
});

test('invalid tool arguments are refused and open nothing', async t => {
  const meta = scriptedMeta([
    [call('show_connections', { category: 'bogus' }, 'bad-1'), call('show_connections', { entry: 'ghost' }, 'bad-2'), call('show_connections', { query: 'x'.repeat(200) }, 'bad-3'), call('show_connections', { extra: 1 }, 'bad-4')],
    input => {
      const outputs = input.filter(item => item.type === 'function_call_output').map(item => JSON.parse(item.output));
      assert.deepEqual(outputs.map(output => output.ok), [false, false, false, false]);
      return [reply('I could not open that.')];
    },
  ]);
  const app = await fixture(t, meta);
  const { body } = await app.send('/api/chat', chat('hmm what about my gadgets'));
  assert.deepEqual(meta.failures.map(error => error.message), []);
  assert.deepEqual(connectionCards(body), []);
  assert.ok(body.tool_events.every(event => event.status === 'failed'));
});

test('routine setup, timers, and thanks never open the screen', async t => {
  const meta = scriptedMeta([
    (_input, { tools }) => { assert.equal(tools.some(tool => tool.name === 'show_connections' || tool.name === 'home_control'), false, 'routine setup limits tools'); return [reply('Saved.')]; },
    (_input, { tools }) => { assert.ok(tools.some(tool => tool.name === 'show_connections')); return [reply('Timer talk.')]; },
  ]);
  const app = await fixture(t, meta);
  await app.send('/api/connectors/philips-hue/connect', { bridge: '192.168.1.5', key: 'k' });
  const setup = await app.send('/api/chat', chat('When I say movie night, turn off the lights and play music'));
  assert.deepEqual(meta.failures.map(error => error.message), []);
  assert.deepEqual(connectionCards(setup.body), []);
  const timer = await app.send('/api/chat', chat('what did I set up for the oven timer'));
  assert.deepEqual(connectionCards(timer.body), []);
});

test('pausing music while Spotify is not connected opens the way to connect it', async t => {
  const meta = scriptedMeta([]);
  const app = await fixture(t, meta);
  const { status, body } = await app.send('/api/chat', chat('pause the music'));
  assert.equal(status, 200);
  assert.equal(meta.calls.length, 0, 'the local Spotify route needs no model call');
  assert.equal(connectionCards(body)[0].category, 'music');
  assert.equal(body.reply, "Spotify isn't connected yet. Pick it on the big screen to set it up.");
});

test('the connector API validates input, proves access before connecting, and never returns a credential', async t => {
  const app = await fixture(t, scriptedMeta([]));
  const listed = (await app.send('/api/connectors')).body;
  assert.deepEqual(listed.connectors.map(item => [item.id, item.status]), [['philips-hue', 'not_connected']]);
  assert.equal(listed.search.provider, 'Meta web search');

  const rejected = await app.send('/api/connectors/philips-hue/connect', { bridge: '192.168.1.5', key: 'bad' });
  assert.equal(rejected.status, 401);
  assert.doesNotMatch(JSON.stringify(rejected.body), /bad"/);
  assert.equal((await app.send('/api/connectors/philips-hue')).status, 404, 'no state for a bare connector path');
  assert.equal((await app.send('/api/connectors')).body.connectors[0].status, 'not_connected', 'a failed check saves nothing');
  await assert.rejects(readFile(join(app.directory, 'connectors.json'), 'utf8'), { code: 'ENOENT' });

  assert.equal((await app.send('/api/connectors/philips-hue/connect', { bridge: '192.168.1.5', surprise: 'x' })).status, 400);
  assert.equal((await app.send('/api/connectors/ghost/connect', {})).status, 404);
  assert.equal((await app.send('/api/connectors/philips-hue/explode', {})).status, 404);
  assert.equal((await app.send('/api/connectors/philips-hue/verify', {})).status, 409, 'nothing saved to verify yet');

  const saved = await app.send('/api/connectors/philips-hue/connect', { bridge: '192.168.1.5' });
  assert.equal(saved.status, 200);
  assert.deepEqual([saved.body.status, saved.body.message], ['saved', 'Press the link button, then choose Pair.']);
  assert.equal((await app.send('/api/companion/state')).body.services.lights.connected, false, 'saved settings are not a working connection');
  const paired = await app.send('/api/connectors/philips-hue/pair', {});
  assert.deepEqual([paired.status, paired.body.status], [200, 'connected']);
  assert.deepEqual(paired.body.secrets_saved, ['key']);

  const everywhere = JSON.stringify([paired.body, (await app.send('/api/connectors')).body, (await app.send('/api/companion/state')).body, (await app.send('/api/state')).body]);
  assert.ok(!everywhere.includes(SECRET), 'the credential never leaves the server');
  assert.match(await readFile(join(app.directory, 'connectors.json'), 'utf8'), new RegExp(SECRET), 'it is stored on the server');
  assert.equal(((await stat(join(app.directory, 'connectors.json'))).mode & 0o777), 0o600);

  assert.equal((await app.send('/api/connectors/philips-hue/verify', {})).body.status, 'connected');
  assert.equal((await app.send('/api/connectors/philips-hue/verify', { extra: 1 })).status, 400);
  const disconnected = await app.send('/api/connectors/philips-hue/disconnect', {});
  assert.deepEqual([disconnected.body.status, disconnected.body.message], ['not_connected', 'Disconnected Fake Hue. Access revoked on the bridge.']);
  assert.doesNotMatch(await readFile(join(app.directory, 'connectors.json'), 'utf8'), new RegExp(SECRET), 'disconnect forgets the credential');
});

test('the companion state exposes statuses only, follows verification, and survives clear-all memory', async t => {
  const app = await fixture(t, scriptedMeta([]));
  await app.send('/api/connectors/philips-hue/connect', { bridge: '192.168.1.5', key: SECRET });
  const state = (await app.send('/api/companion/state')).body;
  assert.deepEqual(state.connectors.map(item => Object.keys(item).sort()), [['detail', 'external', 'id', 'name', 'status', 'verified_at']]);
  assert.deepEqual([state.connectors[0].status, state.services.lights.connected], ['connected', true]);
  assert.equal(state.connections, undefined, 'the old preview list is gone');
  assert.equal((await app.send('/api/connections')).status, 404, 'and so is its API');
  assert.equal((await app.send('/api/connections/connect', { id: 'ring' })).status, 404);
  assert.equal((await app.send('/api/memory/clear', {})).status, 200);
  assert.equal((await app.send('/api/connectors')).body.connectors[0].status, 'connected', 'clear-all memory keeps real connections');
  // A credential that stops working flips the shared status everywhere, and the tools disappear.
  await app.send('/api/connectors/philips-hue/connect', { bridge: '192.168.1.5', key: 'expired' });
  assert.equal((await app.send('/api/connectors/philips-hue/verify', {})).status, 401);
  const after = (await app.send('/api/companion/state')).body;
  assert.deepEqual([after.connectors[0].status, after.services.lights.connected], ['attention', false]);
});

test('connector changes stay same-origin JSON like every other private API', async t => {
  const app = await fixture(t, scriptedMeta([]));
  const body = { bridge: '192.168.1.5', key: 'k' };
  assert.equal((await app.send('/api/connectors/philips-hue/connect', body, { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await app.send('/api/connectors/philips-hue/connect', body, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await app.send('/api/connectors/philips-hue/disconnect', {}, { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await app.send('/api/connectors')).body.connectors[0].status, 'not_connected', 'nothing changed');
});

test('the shared catalog is served to the companion page under its content security policy', async t => {
  const app = await fixture(t, scriptedMeta([]));
  for (const file of ['catalog.js', 'integrations.js']) {
    const asset = await app.send(`/connections/${file}`);
    assert.equal(asset.status, 200, file);
    assert.match(asset.headers['content-type'], /text\/javascript/);
    assert.match(asset.headers['content-security-policy'], /default-src 'self'/);
  }
  assert.match((await app.send('/connections/catalog.js')).body, /export const CONNECTIONS/);
  assert.equal((await app.send('/connections/state.js')).status, 404, 'only the Connection Center files are served');
  assert.equal((await app.send('/connections/../src/server.js')).status, 404);
});

test('a connection question is not turned into a web search, but an explicit "look it up" still always searches', async t => {
  const meta = scriptedMeta([
    (_input, { tools }) => { assert.equal(tools.some(tool => tool.type === 'web_search'), false, 'no search is forced for a setup question'); return [reply('Tap Sonos on the big screen, mister.')]; },
    (_input, { tools }) => { assert.ok(tools.some(tool => tool.type === 'web_search')); return [{ type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'connect ring doorbell' } }, reply('Ring connects through its app, and the options are on the big screen.')]; },
  ]);
  const app = await fixture(t, meta);
  const setup = await app.send('/api/chat', chat('how do I connect my Sonos speaker'));
  assert.deepEqual(meta.failures.map(error => error.message), []);
  assert.equal(setup.body.lookup, undefined);
  assert.equal(connectionCards(setup.body)[0].entry, 'sonos');
  const explicit = await app.send('/api/chat', chat('look up how to connect my Ring doorbell'));
  assert.deepEqual(meta.failures.map(error => error.message), []);
  assert.equal(explicit.body.lookup.policy, 'explicit');
  assert.equal(explicit.body.lookup.state, 'done');
  assert.equal(connectionCards(explicit.body)[0].entry, 'ring');
});
