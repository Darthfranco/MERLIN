import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../src/server.js';

// A model that asks for a tool this round did not offer must not take the whole reply down: the call is never run, the
// model is told the tool is unavailable, and the answer still arrives.
const call = (name, args, call_id = randomUUID()) => ({ type: 'function_call', status: 'completed', name, arguments: JSON.stringify(args), call_id });
const reply = text => ({ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text, annotations: [] }] });
const search = (query, results = []) => ({ type: 'web_search_call', id: `ws_${randomUUID()}`, status: 'completed', action: { type: 'search', query }, results });
const chat = message => ({ message, session_id: randomUUID(), request_id: randomUUID(), time_zone: 'America/New_York' });

function scriptedMeta(steps) {
  return {
    configured: true, model: 'synthetic-unavailable-tools', calls: [], failures: [],
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
  const directory = await mkdtemp(join(tmpdir(), 'merlin-unavailable-'));
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
  const post = (path, body) => new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
  return Object.assign(app, { post });
}

test('a stray tool call in a tool-free rewrite round is ignored and the corrected answer is delivered', async t => {
  const meta = scriptedMeta([
    // The first draft says a banned word, so the next round is a rewrite with every tool disabled.
    [search('weather in ny', [{ type: 'text_result', title: 'NWS', url: 'https://forecast.weather.gov/x', snippet: '' }]), reply('It is twenty degrees Celsius in New York.')],
    (_input, { tools }) => {
      assert.deepEqual(tools, [], 'the rewrite round offers no tools');
      return [call('read_web_page', { url: 'https://forecast.weather.gov/x' }, 'stray'), call('create_timer', { label: 'Unrequested', duration_seconds: 30 }), reply('It is sixty eight degrees in New York.')];
    },
  ]);
  const app = await fixture(t, meta);
  assert.equal((await app.post('/api/memory/rule', { kind: 'avoid_word', value: 'Celsius', scope: 'assistant_reply' })).status, 200);
  const { status, body } = await app.post('/api/chat', chat('look up the weather in ny'));
  assert.equal(status, 200, JSON.stringify(body.error));
  assert.deepEqual(meta.failures, []);
  assert.equal(body.reply, 'It is sixty eight degrees in New York.');
  assert.equal((await app.timers.list()).length, 0, 'the stray timer call never ran');
  assert.ok(body.trace.events.some(event => event.stage === 'tool_check' && /where only a rewrite or search was allowed/.test(event.detail)));
  assert.ok(!body.tool_events.some(event => event.tool === 'read_web_page' || event.tool === 'create_timer'));
});

test('a stray tool call in a search-only retry is dropped and the search it made still counts', async t => {
  const meta = scriptedMeta([
    [reply('It is probably mild in New York.')],
    (_input, { tools }) => {
      assert.deepEqual(tools.map(tool => tool.type), ['web_search'], 'the retry offers search and nothing else');
      return [call('read_web_page', { url: 'https://forecast.weather.gov/x' }), search('weather in ny', [{ type: 'text_result', title: 'NWS', url: 'https://forecast.weather.gov/x', snippet: '' }]), reply('It is mild in New York.')];
    },
  ]);
  const app = await fixture(t, meta);
  const { status, body } = await app.post('/api/chat', chat('look up the weather in ny'));
  assert.equal(status, 200, JSON.stringify(body.error));
  assert.deepEqual(meta.failures, []);
  assert.equal(body.lookup.state, 'enforced');
  assert.match(body.reply, /mild in New York/);
  assert.ok(!body.tool_events.some(event => event.tool === 'read_web_page'), 'the stray call never ran');
});

test('in a normal round an invented tool still rejects the whole response before anything runs', async t => {
  const meta = scriptedMeta([[call('create_timer', { label: 'Tea', duration_seconds: 30 }), call('execute_code', { code: 'rm -rf /' })]]);
  const app = await fixture(t, meta);
  const { status, body } = await app.post('/api/chat', chat('set a 30 second tea timer'));
  assert.equal(status, 502);
  assert.match(body.error, /tool that was not enabled/);
  assert.equal((await app.timers.list()).length, 0);
  const rejection = body.trace.events.find(event => event.stage === 'tool_check' && /Rejected the whole response/.test(event.detail));
  assert.ok(rejection, 'the inspector records the rejection');
  assert.deepEqual(rejection.data.tools, ['create_timer', 'execute_code'], 'and names the tools the model asked for');
});

test('a made-up search tool name becomes the real search instead of failing the reply', async t => {
  const meta = scriptedMeta([
    (_input, { tools }) => {
      assert.ok(tools.some(tool => tool.name === 'prepare_web_search') && !tools.some(tool => tool.type === 'web_search'), 'search is reachable but not yet enabled');
      return [call('browser.search', { query: 'weather Brooklyn' })];
    },
    (input, { tools, instructions }) => {
      assert.ok(tools.some(tool => tool.type === 'web_search'), 'the retry offers the real search');
      assert.ok(!tools.some(tool => tool.name === 'prepare_web_search'));
      assert.match(instructions, /Web search is enabled for this request/);
      assert.ok(!input.some(item => item.type === 'function_call'), 'the rejected response is not replayed');
      assert.match(input.at(-1).content[0].text, /"browser\.search", which does not exist, so nothing in it ran/);
      return [search('weather Brooklyn', [{ type: 'text_result', title: 'NWS', url: 'https://forecast.weather.gov/b', snippet: '' }]), reply('Got it. It is sunny in Brooklyn today.')];
    },
  ]);
  const app = await fixture(t, meta);
  const { status, body } = await app.post('/api/chat', chat('Whenever I ask about the weather, just assume Brooklyn New York.'));
  assert.equal(status, 200, JSON.stringify(body.error));
  assert.deepEqual(meta.failures, []);
  assert.match(body.reply, /sunny in Brooklyn/);
  assert.ok(body.tool_events.some(event => event.tool === 'web_search' && event.status === 'completed'));
  const recovered = body.trace.events.find(event => event.stage === 'tool_check' && /named a search tool that does not exist/.test(event.detail));
  assert.deepEqual(recovered?.data.tools, ['browser.search'], 'the inspector names the made-up tool');
});

test('nothing in a response with a made-up search name runs, and a second one still fails safely', async t => {
  let app;
  const meta = scriptedMeta([
    [call('create_timer', { label: 'Tea', duration: 30, unit: 'seconds' }), call('browser.search', { query: 'tea' })],
    async () => {
      assert.equal((await app.timers.list()).length, 0, 'the timer in the rejected response never started');
      return [call('web.search', { query: 'tea' })];
    },
  ]);
  app = await fixture(t, meta);
  const { status, body } = await app.post('/api/chat', chat('Give me an idea for dinner tonight.'));
  assert.equal(status, 502);
  assert.match(body.error, /tool that was not enabled/);
  assert.equal((await app.timers.list()).length, 0);
  assert.deepEqual(body.trace.events.find(event => /Rejected the whole response/.test(event.detail ?? '')).data.tools, ['web.search']);
});

test('a made-up search name stays a hard failure when search is off or the name is not a search', async t => {
  const blocked = scriptedMeta([[call('browser.search', { query: 'weather' })]]);
  const app = await fixture(t, blocked);
  assert.equal((await app.post('/api/memory/rule', { kind: 'tool_deny', value: 'web_search', scope: 'tools' })).status, 200);
  const banned = await app.post('/api/chat', chat('Give me an idea for dinner tonight.'));
  assert.equal(banned.status, 502, 'a saved search ban is not bypassed');
  assert.equal(blocked.calls.length, 1);
  const mixed = scriptedMeta([[call('browser.search', { query: 'x' }), call('execute_code', { code: 'x' })]]);
  const other = await fixture(t, mixed);
  assert.equal((await other.post('/api/chat', chat('Tell me something fun about octopuses.'))).status, 502, 'a non-search invented tool still rejects');
  assert.equal(mixed.calls.length, 1);
});
