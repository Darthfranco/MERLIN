import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../src/server.js';

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

async function fixture(t, meta) {
  const directory = await mkdtemp(join(tmpdir(), 'merlin-connections-it-'));
  const app = await createApp({ dataDir: directory, meta, learningDelayMs: 60000 });
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
  return Object.assign(app, { send, directory });
}

test('asking how to connect something opens the setup guide on the large screen', async t => {
  const meta = scriptedMeta([(_input, { tools, instructions }) => {
    assert.ok(tools.some(tool => tool.name === 'show_connections'));
    assert.match(instructions, /large connection screen is now open/);
    assert.match(instructions, /setup guide for Ring/);
    assert.match(instructions, /cannot control any connected device yet/);
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

test('a category with only a preview connection does not reopen the screen and the model is told previews control nothing', async t => {
  const meta = scriptedMeta([(_input, { instructions }) => {
    assert.match(instructions, /Philips Hue is marked connected only as a preview/);
    assert.match(instructions, /Do not claim the action happened/);
    return [reply("Hue is only a preview connection, so I can't switch lights yet.")];
  }]);
  const app = await fixture(t, meta);
  assert.equal((await app.send('/api/connections/connect', { id: 'philips-hue' })).status, 200);
  const { body } = await app.send('/api/chat', chat('turn on the lights'));
  assert.deepEqual(meta.failures.map(error => error.message), []);
  assert.deepEqual(connectionCards(body), []);
  assert.equal(body.tool_events.some(event => event.tool === 'show_connections'), false);
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
    (_input, { tools }) => { assert.equal(tools.some(tool => tool.name === 'show_connections'), false, 'routine setup limits tools'); return [reply('Saved.')]; },
    (_input, { tools }) => { assert.ok(tools.some(tool => tool.name === 'show_connections')); return [reply('Timer talk.')]; },
  ]);
  const app = await fixture(t, meta);
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

test('the connection API validates ids, rejects extra fields, persists privately, and survives clear-all memory', async t => {
  const app = await fixture(t, scriptedMeta([]));
  assert.deepEqual((await app.send('/api/connections')).body, { connections: [], preview: true });
  for (const bad of [{ id: 'ghost' }, { id: '' }, {}, { id: 'ring', token: 'x' }, { id: ['ring'] }]) assert.equal((await app.send('/api/connections/connect', bad)).status, 400, JSON.stringify(bad));
  assert.equal((await app.send('/api/connections/connect', { id: 'myq' })).status, 409);
  const connected = await app.send('/api/connections/connect', { id: 'ring' });
  assert.equal(connected.status, 200);
  assert.deepEqual(connected.body.connections.map(entry => entry.id), ['ring']);
  assert.deepEqual((await app.send('/api/companion/state')).body.connections.map(entry => entry.id), ['ring']);
  assert.ok(!JSON.stringify(await readFile(join(app.directory, 'connections.json'), 'utf8')).includes('token'));
  assert.equal((await app.send('/api/memory/clear', {})).status, 200);
  assert.deepEqual((await app.send('/api/connections')).body.connections.map(entry => entry.id), ['ring'], 'clear-all memory keeps the household\'s preview choices');
  assert.deepEqual((await app.send('/api/connections/disconnect', { id: 'ring' })).body.connections, []);
  // Mutations stay same-origin JSON like every other private API.
  assert.equal((await app.send('/api/connections/connect', { id: 'ring' }, { Origin: 'http://evil.example' })).status, 403);
});

test('the shared catalog is served to the companion page under its content security policy', async t => {
  const app = await fixture(t, scriptedMeta([]));
  const asset = await app.send('/connections/catalog.js');
  assert.equal(asset.status, 200);
  assert.match(asset.headers['content-type'], /text\/javascript/);
  assert.match(asset.body, /export const CONNECTIONS/);
  assert.match(asset.headers['content-security-policy'], /default-src 'self'/);
  assert.equal((await app.send('/connections/state.js')).status, 404, 'only the catalog is shared, not the Connection Center app');
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
