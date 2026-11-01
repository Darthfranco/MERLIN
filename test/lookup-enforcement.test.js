import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../src/server.js';
import { LOOKUP_REPLIES } from '../src/lookup.js';
import { MAX_LOOKUP_ENFORCEMENTS } from '../src/limits.js';

const call = (name, args, call_id = randomUUID()) => ({ type: 'function_call', status: 'completed', name, arguments: JSON.stringify(args), call_id });
const reply = (text, annotations = []) => ({ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text, annotations }] });
const search = (query = 'synthetic query', results = [], status = 'completed') => ({ type: 'web_search_call', id: `ws_${randomUUID()}`, status, action: { type: 'search', query }, results });
const chat = (message, session_id = randomUUID()) => ({ message, session_id, request_id: randomUUID(), time_zone: 'America/New_York' });
const hasSearch = tools => tools.some(tool => tool.type === 'web_search');

function scriptedMeta(steps) {
  return {
    configured: true, model: 'synthetic-lookup-enforcement', calls: [], failures: [],
    async respond(input, tools, instructions) {
      this.calls.push(structuredClone({ input, tools, instructions }));
      assert.ok(steps.length, 'Unexpected extra model invocation');
      const step = steps.shift();
      // An assertion thrown inside a scripted step would otherwise surface only as a generic 500.
      try { return typeof step === 'function' ? await step(input, { tools, instructions }) : structuredClone(step); }
      catch (error) { this.failures.push(error); throw error; }
    },
  };
}

async function fixture(t, meta) {
  const directory = await mkdtemp(join(tmpdir(), 'merlin-lookup-'));
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
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
  return Object.assign(app, { post });
}

test('an explicit lookup request gets search immediately, with no preparation step for the model to skip', async t => {
  const meta = scriptedMeta([
    (_input, { tools, instructions }) => {
      assert.ok(hasSearch(tools));
      assert.equal(tools.some(tool => tool.name === 'prepare_web_search'), false);
      assert.match(instructions, /searching is mandatory/);
      assert.match(instructions, /call web_search directly/);
      assert.doesNotMatch(instructions, /call prepare_web_search once/);
      return [search('mets score last night', [{ type: 'text_result', title: 'Game recap', url: 'https://example.org/recap', snippet: 'private' }]), reply('The Mets won, four to two.')];
    },
  ]);
  const app = await fixture(t, meta);
  const { status, body } = await app.post('/api/chat', chat('look up the Mets score'));
  assert.equal(status, 200);
  assert.equal(meta.calls.length, 1, 'one model round: no preparation hop');
  assert.equal(body.lookup.policy, 'explicit');
  assert.equal(body.lookup.state, 'done');
  assert.equal(body.lookup.searches, 1);
  assert.deepEqual(body.lookup.queries, ['mets score last night']);
  assert.ok(body.tool_events.some(event => event.tool === 'web_search' && event.status === 'completed'));
  // No citation came back, so the pages Meta actually retrieved are shown and marked as such.
  assert.deepEqual(body.sources, [{ url: 'https://example.org/recap', title: 'Game recap', basis: 'retrieved', snippet: 'private' }]);
  // Result text appears only as source context for the person, never in the trace, lookup record or tool events.
  assert.ok(!JSON.stringify({ trace: body.trace, lookup: body.lookup, tool_events: body.tool_events }).includes('private'));
  assert.ok(body.trace.events.some(event => event.stage === 'search_ready'));
  assert.ok(body.trace.events.some(event => event.stage === 'lookup' && event.data?.level === 'explicit'));
});

test('cited sources win over retrieved pages and keep their original shape', async t => {
  const meta = scriptedMeta([[search('q', [{ title: 'Other', url: 'https://example.org/other' }]), reply('Answer.', [{ type: 'url_citation', url: 'https://example.org/cited', title: 'Cited page' }])]]);
  const app = await fixture(t, meta);
  const { body } = await app.post('/api/chat', chat('search the web for tea steeping times'));
  assert.deepEqual(body.sources, [{ url: 'https://example.org/cited', title: 'Cited page' }]);
});

test('a skipped explicit lookup is discarded and retried with search as the only tool', async t => {
  const meta = scriptedMeta([
    [reply('Alaska, by recollection alone.')],
    (input, { tools, instructions }) => {
      assert.deepEqual(tools, [{ type: 'web_search' }], 'the retry offers nothing but search');
      assert.match(instructions, /did not search, so it was discarded/);
      assert.ok(!JSON.stringify(input).includes('recollection'), 'the ungrounded draft is not replayed');
      assert.match(input.at(-1).content[0].text, /explicitly asked you to look this up/);
      return [search('largest us state'), reply('Alaska is the largest state.')];
    },
  ]);
  const app = await fixture(t, meta);
  const { status, body } = await app.post('/api/chat', chat('whats the biggest state? look it up'));
  assert.deepEqual(meta.failures.map(error => error.message), []);
  assert.equal(status, 200);
  assert.equal(body.reply.includes('Alaska is the largest state'), true);
  assert.equal(body.lookup.state, 'enforced');
  assert.equal(body.lookup.enforced, 1);
  const history = JSON.stringify((await app.store.snapshot()).conversations);
  assert.ok(!history.includes('recollection'), 'the discarded draft is not archived');
});

test('a factual question is searched even when the model would have answered from memory', async t => {
  const meta = scriptedMeta([
    (_input, { tools }) => { assert.ok(hasSearch(tools)); return [reply('Canberra.')]; },
    [search('capital of australia'), reply('Canberra is the capital.')],
  ]);
  const app = await fixture(t, meta);
  const { body } = await app.post('/api/chat', chat("what's the capital of Australia?"));
  assert.equal(body.lookup.policy, 'required');
  assert.equal(body.lookup.state, 'enforced');
  assert.equal(meta.calls.length, 2);
});

test('when the user said to look it up and nothing can be searched, MERLIN says so instead of answering from memory', async t => {
  const draft = 'It is probably sunny, by recollection alone.';
  const meta = scriptedMeta([[reply(draft)], ...Array.from({ length: MAX_LOOKUP_ENFORCEMENTS }, () => [reply(draft)])]);
  const app = await fixture(t, meta);
  const { status, body } = await app.post('/api/chat', chat('look up the weather in Boston'));
  assert.equal(status, 200);
  assert.equal(meta.calls.length, 1 + MAX_LOOKUP_ENFORCEMENTS);
  assert.equal(body.reply, LOOKUP_REPLIES.failed);
  assert.equal(body.lookup.state, 'failed');
  assert.equal(body.lookup.searches, 0);
  assert.deepEqual(body.sources, []);
  const stored = JSON.stringify((await app.store.snapshot()).conversations);
  assert.ok(!stored.includes('recollection'), 'the ungrounded draft never reaches the archive');
  assert.ok(stored.includes("couldn't look that up"));
});

test('a search that fails is retried, then reported honestly', async t => {
  const meta = scriptedMeta([
    [search('q', [], 'failed'), reply('Guess.')],
    [search('q', [], 'failed'), reply('Another guess.')],
    [search('q', [], 'failed'), reply('A third guess.')],
  ]);
  const app = await fixture(t, meta);
  const { body } = await app.post('/api/chat', chat('google the pharmacy hours'));
  assert.equal(body.reply, LOOKUP_REPLIES.failed);
  assert.equal(body.lookup.state, 'failed');
  assert.equal(body.lookup.failed_searches, 3);
  assert.ok(body.tool_events.filter(event => event.tool === 'web_search').every(event => event.status === 'failed'));
});

test('a required but non-explicit lookup that is still skipped keeps the answer and is marked unverified', async t => {
  const meta = scriptedMeta([[reply('Maybe.')], [reply('Maybe, still.')], [reply('Maybe, again.')]]);
  const app = await fixture(t, meta);
  const { body } = await app.post('/api/chat', chat('how tall is mount everest?'));
  assert.equal(body.reply, 'Maybe, again.');
  assert.equal(body.lookup.policy, 'required');
  assert.equal(body.lookup.state, 'unverified');
});

test('a saved instruction against web search still wins, and an explicit request is told so plainly', async t => {
  const meta = scriptedMeta([
    [call('memory_save_rule', { kind: 'tool_deny', value: 'web_search', scope: 'tools', source_quote: 'Never search the web.', explanation: 'Block web search.' }, 'ban'), call('prepare_web_search', {}, 'prep')],
    input => {
      const preparation = input.findLast(item => item.type === 'function_call_output' && item.call_id === 'prep');
      assert.equal(JSON.parse(preparation.output).ok, false);
      return [reply('Saved.')];
    },
    (_input, { tools, instructions }) => {
      assert.equal(hasSearch(tools), false, 'the ban removes search even for an explicit request');
      assert.match(instructions, /blocks web search/);
      return [reply('It is sunny, mister!')];
    },
  ]);
  const app = await fixture(t, meta);
  const session = randomUUID();
  assert.equal((await app.post('/api/chat', chat('Never search the web.', session))).status, 200);
  const { body } = await app.post('/api/chat', chat('look up the weather', session));
  assert.equal(body.reply, LOOKUP_REPLIES.denied);
  assert.equal(body.lookup.state, 'blocked');
  assert.equal(meta.calls.length, 3, 'no search-only retry is attempted against a saved ban');
  assert.equal(body.tool_events.some(event => event.tool === 'web_search'), false);
});

test('a declined lookup keeps the preparation step and never forces a search', async t => {
  const meta = scriptedMeta([(_input, { tools, instructions }) => {
    assert.equal(hasSearch(tools), false);
    assert.ok(tools.some(tool => tool.name === 'prepare_web_search'));
    assert.doesNotMatch(instructions, /Lookup required/);
    return [reply('Understood.')];
  }]);
  const app = await fixture(t, meta);
  const { body } = await app.post('/api/chat', chat("no need to look it up, what's your name?"));
  assert.equal(body.lookup, undefined);
});

test('lookup finished alongside timers keeps both, and a failed lookup keeps the finished timer visible', async t => {
  const ok = scriptedMeta([
    [search('steeping'), call('create_timer', { label: 'Tea', duration: 3, unit: 'minutes' }, 'tea')],
    [reply('Tea timer set, and green tea steeps for about two minutes.')],
  ]);
  const app = await fixture(t, ok);
  const done = await app.post('/api/chat', chat('Set a 3 minute tea timer and look up how long green tea should steep'));
  assert.equal(done.body.lookup.state, 'done');
  assert.equal(done.body.timers.length, 1);

  const bad = scriptedMeta([
    [call('create_timer', { label: 'Pasta', duration: 10, unit: 'minutes' }, 'pasta')],
    [reply('Pasta timer set. Boil time is nine minutes, by recollection alone.')],
    [reply('Still from memory.')],
    [reply('Once more from memory.')],
  ]);
  const second = await fixture(t, bad);
  const failed = await second.post('/api/chat', chat('Set a 10 minute pasta timer and look up how long spaghetti takes'));
  assert.equal(failed.status, 200);
  assert.equal(failed.body.timers.length, 1);
  assert.ok(failed.body.reply.startsWith(LOOKUP_REPLIES.failed));
  assert.match(failed.body.reply, /Pasta/);
  assert.ok(!failed.body.reply.includes('recollection'));
  assert.equal(failed.body.lookup.state, 'failed');
});

test('provider citation markers never reach the reply, archive, or history sent back to Meta', async t => {
  const meta = scriptedMeta([
    [search('weather brooklyn'), reply('Rain is likely tomorrow.【1743273222577323410†L8-L10】 Bring an umbrella.')],
  ]);
  const app = await fixture(t, meta);
  const session = randomUUID();
  const { body } = await app.post('/api/chat', chat('look up tomorrow weather in Brooklyn', session));
  assert.equal(body.reply, 'Rain is likely tomorrow. Bring an umbrella.');
  assert.ok(!JSON.stringify((await app.store.snapshot()).conversations).includes('†'));
});

test('lookup policy does not apply to routine setup, appreciation, or saved-routine lookups', async t => {
  const meta = scriptedMeta([
    (_input, { tools }) => { assert.equal(hasSearch(tools), false); return [reply('Got it.')]; },
    (_input, { tools }) => { assert.equal(hasSearch(tools), false); return [reply('You bet.')]; },
  ]);
  const app = await fixture(t, meta);
  const session = randomUUID();
  const setup = await app.post('/api/chat', chat('When I say coffee, look up the weather and set a 3 minute timer', session));
  assert.deepEqual(meta.failures.map(error => error.message), []);
  assert.equal(setup.status, 200);
  assert.equal(setup.body.lookup, undefined);
  const thanks = await app.post('/api/chat', chat('Thanks, looking that up was great!', session));
  assert.equal(thanks.status, 200);
});
