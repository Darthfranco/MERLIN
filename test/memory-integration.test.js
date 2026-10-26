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
const savedRule = (value, source_quote, kind = 'timer_default_unit', scope = 'timers') => ({ kind, value, scope, source_quote, explanation: kind === 'timer_default_unit' ? `Use ${value} only when the user omits timer units.` : 'Apply the literal wording restriction to assistant replies.' });
const outputs = input => input.filter(item => item.type === 'function_call_output').map(item => JSON.parse(item.output));

function scriptedMeta(steps) {
  return {
    configured: true, model: 'synthetic-memory-integration', calls: [],
    async respond(input, tools, instructions, options = {}) {
      // Keep callable instrumentation separate from immutable input snapshots.
      this.calls.push(structuredClone({ input, tools, instructions, maxSearchCalls: options.maxSearchCalls }));
      options.onUsage?.({ input_tokens: 31, output_tokens: 9, input_tokens_details: { cached_tokens: 7 } });
      assert.ok(steps.length, 'Unexpected extra model invocation');
      const step = steps.shift();
      return typeof step === 'function' ? await step(input, { tools, instructions, options }) : structuredClone(step);
    },
  };
}

async function close(app) {
  await app.learning.close();
  if (!app.server.listening) return;
  const finished = new Promise((resolve, reject) => app.server.close(error => error ? reject(error) : resolve()));
  app.server.closeAllConnections();
  await finished;
}

async function fixture(t, meta) {
  const directory = await mkdtemp(join(tmpdir(), 'merlin-memory-integration-'));
  const apps = [];
  t.after(async () => {
    await Promise.all(apps.map(close));
    await rm(directory, { recursive: true, force: true });
  });
  const start = async nextMeta => {
    const app = await createApp({ dataDir: directory, meta: nextMeta ?? meta, learningDelayMs: 60000 });
    apps.push(app);
    await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
    const port = app.server.address().port;
    const request = (path, body) => new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port, path, method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'Content-Type': 'application/json' } }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
          catch (error) { reject(error); }
        });
      });
      req.on('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
    return Object.assign(app, { request, post: request });
  };
  return { ...await start(meta), directory, start };
}

test('a standing timer instruction applies before an earlier-listed action in the same batch and survives restart', async (t) => {
  const instruction = 'Always use seconds unless I specify timer units.';
  const meta = scriptedMeta([
    [call('create_timer', { label: 'Tea', duration: 5, unit: 'default' }, 'timer-first'), call('memory_save_rule', savedRule('seconds', instruction), 'save-second')],
    input => {
      const result = outputs(input);
      assert.equal(result[0].result.record.kind, 'timer_default_unit');
      assert.equal(result[1].result.duration_seconds, 5);
      return [reply('Saved. Your five-second tea timer is running.')];
    },
  ]);
  const app = await fixture(t, meta);
  const response = await app.post('/api/chat', chat(`${instruction} Start a tea timer for 5.`));
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.tool_events.map(event => [event.tool, event.status]), [['memory_save_rule', 'completed'], ['create_timer', 'completed']]);
  assert.equal(response.body.timers[0].duration_seconds, 5);
  assert.equal((await app.request('/api/memory')).body.rules[0].value, 'seconds');
  await close(app);
  const nextMeta = scriptedMeta([[call('create_timer', { label: 'Coffee', duration: 7, unit: 'default' })], [reply('Your seven-second coffee timer is running.')]]);
  const restarted = await app.start(nextMeta);
  const following = await restarted.post('/api/chat', chat('Start a coffee timer for 7.'));
  assert.equal(following.status, 200);
  assert.equal(following.body.timers.find(timer => timer.label === 'Coffee').duration_seconds, 7);
  assert.match(nextMeta.calls[0].instructions, /timer_default_unit/);
});

test('conflicts are recorded on save, block a later default-unit timer, allow explicit units, and resolve through the inspector', async (t) => {
  const instruction = 'Always use minutes for timers with no unit.';
  const meta = scriptedMeta([
    [call('memory_save_rule', savedRule('minutes', instruction))], [reply('Saved the instruction and flagged the conflicting default.')],
    [call('create_timer', { label: 'Blocked', duration: 3, unit: 'default' })], [reply('Your timer is set.')],
    [call('create_timer', { label: 'Explicit', duration: 2, unit: 'minutes' })], [reply('Your two-minute timer is running.')],
    [call('create_timer', { label: 'Resolved', duration: 3, unit: 'default' })], [reply('Your three-minute timer is running.')],
  ]);
  const app = await fixture(t, meta);
  assert.equal((await app.post('/api/memory/rule', { kind: 'timer_default_unit', value: 'seconds', scope: 'timers' })).status, 200);
  const saved = await app.post('/api/chat', chat(instruction));
  assert.equal(saved.status, 200);
  assert.equal(saved.body.reply, 'Saved the instruction and flagged the conflicting default.');
  let memory = (await app.request('/api/memory')).body;
  assert.equal(memory.conflicts.length, 1);
  const blocked = await app.post('/api/chat', chat('Start a timer for 3.'));
  assert.equal(blocked.status, 200);
  assert.equal(blocked.body.timers.length, 0);
  assert.equal(blocked.body.tool_events[0].status, 'failed');
  assert.match(blocked.body.reply, /which|clarif|conflict|choose/i);
  assert.equal(blocked.body.conflict, true);
  const explicit = await app.post('/api/chat', chat('Start a timer for 2 minutes.'));
  assert.equal(explicit.status, 200);
  assert.equal(explicit.body.timers[0].duration_seconds, 120);
  memory = (await app.request('/api/memory')).body;
  const minutes = memory.rules.find(rule => rule.value === 'minutes');
  const seconds = memory.rules.find(rule => rule.value === 'seconds');
  const resolved = await app.post('/api/memory/resolve', { keep_id: minutes.id, remove_ids: [seconds.id] });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.body.conflicts.length, 0);
  const after = await app.post('/api/chat', chat('Start a timer for 3.'));
  assert.equal(after.body.timers.find(timer => timer.label === 'Resolved').duration_seconds, 180);
});

test('irreducible semantic meaning stays sourced general guidance and unsupported quotations cannot create facts', async (t) => {
  const instruction = 'Please avoid upsetting animal stories.';
  const meta = scriptedMeta([
    [call('memory_save_fact', { content: 'Prefers avoiding upsetting animal stories.', subject: 'household', kind: 'guidance', source_quote: instruction, reason: 'What is upsetting depends on meaning and cannot be enforced as an exact lexical rule.', supersedes: '' })],
    [reply('Saved as general guidance; it is not a guaranteed code restriction.')],
    [call('memory_save_fact', { content: 'Has a pet tiger.', subject: 'household', kind: 'fact', source_quote: 'I have a pet tiger.', reason: 'Household detail', supersedes: '' })],
    input => { assert.equal(outputs(input).at(-1).ok, false); return [reply('I could not save a fact without supporting evidence.')]; },
  ]);
  const app = await fixture(t, meta);
  assert.equal((await app.post('/api/chat', chat(instruction))).status, 200);
  const rejected = await app.post('/api/chat', chat('What do you remember?'));
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.tool_events[0].status, 'failed');
  const memory = (await app.request('/api/memory')).body;
  assert.equal(memory.rules.length, 0);
  assert.equal(memory.facts.length, 1);
  assert.equal(memory.facts[0].kind, 'guidance');
  assert.equal(memory.facts[0].source_quote, instruction);
  assert.equal(memory.conversations.some(item => 'turn' in item), false);
});

test('lexical violations are repaired once and a repeated violation is replaced with checked fallback text', async (t) => {
  const meta = scriptedMeta([
    [reply('A cat is nearby.')], [reply('An animal is nearby.')],
    [reply('Another CAT is nearby.')], [reply('Still a cat.')],
  ]);
  const app = await fixture(t, meta);
  assert.equal((await app.post('/api/memory/rule', { kind: 'avoid_word', value: 'cat', scope: 'assistant_reply', original: 'Never say the exact word cat in replies.' })).status, 200);
  const repaired = await app.post('/api/chat', chat('Describe the scene.'));
  assert.equal(repaired.status, 200);
  assert.equal(repaired.body.reply, 'An animal is nearby.');
  assert.equal(meta.calls.length, 2);
  assert.ok(meta.calls[1].input.some(item => item.role === 'developer'));
  const blocked = await app.post('/api/chat', chat('Describe another scene.'));
  assert.equal(blocked.status, 200);
  assert.doesNotMatch(blocked.body.reply, /\bcat\b/i);
  assert.equal(meta.calls.length, 4);
  assert.equal(blocked.body.trace.events.filter(event => event.stage === 'output_check').length, 2);
  const transcripts = (await app.request('/api/memory')).body.conversations.filter(item => item.role === 'assistant');
  assert.ok(transcripts.every(item => !/\bcat\b/i.test(item.text)));
  const assistantHistory = app.store.snapshot().conversations.filter(item => item.role === 'assistant')
    .flatMap(item => item.turn ?? []).filter(item => item.role === 'assistant')
    .flatMap(item => item.content ?? []).map(item => item.text ?? '').join('\n');
  assert.doesNotMatch(assistantHistory, /\bcat\b/i, 'Rejected drafts must not survive in protocol history as delivered assistant statements');
});

test('imported documents expose a catalog, search relevant sources, and load bounded exact content', async (t) => {
  let document;
  const meta = scriptedMeta([
    (input, options) => {
      assert.match(options.instructions, /Joe workout routine/);
      assert.equal(options.instructions.includes('UNLOADED_PRIVATE_EXERCISE'), false);
      return [call('memory_search', { query: 'Joe Tuesday workout' })];
    },
    input => {
      const hits = outputs(input).at(-1).result;
      assert.equal(hits.documents[0].id, document.id);
      assert.equal('content' in hits.documents[0], false);
      assert.ok(hits.documents[0].snippet.length <= 800);
      return [call('memory_read_document', { document_id: document.id, query: 'Tuesday' })];
    },
    input => {
      const loaded = outputs(input).at(-1).result;
      assert.equal(loaded.heading, 'Tuesday');
      assert.ok(loaded.content.length <= 12000);
      assert.equal(loaded.content, document.content.slice(loaded.start, loaded.end));
      assert.match(loaded.content, /UNLOADED_PRIVATE_EXERCISE/);
      return [reply('Your Tuesday plan contains the saved exercise.')];
    },
  ]);
  const app = await fixture(t, meta);
  const imported = await app.post('/api/documents', { title: 'Joe workout routine', description: 'Weekly exercise plan', content: `# Monday\nWalking\n# Tuesday\nUNLOADED_PRIVATE_EXERCISE\n${'Exercise details. '.repeat(900)}\n# Wednesday\nRest` });
  assert.equal(imported.status, 200);
  assert.equal('content' in imported.body.documents[0], false);
  document = (await app.request(`/api/documents/${imported.body.documents[0].id}`)).body;
  const answer = await app.post('/api/chat', chat("Read Joe's Tuesday workout."));
  assert.equal(answer.status, 200);
  assert.ok(answer.body.tool_events.every(event => event.status === 'completed'));
  const history = app.store.snapshot().conversations.find(item => item.role === 'assistant');
  assert.ok(history.memory_ids.includes(document.id));
});

test('dependency-aware deletion removes related answers and clear-all removes memory plus queued learning while preserving timers', async (t) => {
  const meta = scriptedMeta([[reply('You prefer oat milk.')], [reply('The sky is blue.')]]);
  meta.extractMemories = async () => ({ facts: [] });
  const app = await fixture(t, meta);
  const created = await app.post('/api/memory/fact', { content: 'Prefers oat milk.', kind: 'preference', subject: 'household' });
  const fact = created.body.facts[0];
  const remember = chat('Which milk do I prefer?');
  assert.equal((await app.post('/api/chat', remember)).status, 200);
  assert.equal((await app.post('/api/chat', chat('What color is the sky?'))).status, 200);
  const before = (await app.request('/api/memory')).body;
  assert.equal(before.learning.pending, 2);
  assert.equal(before.conversations.length, 4);
  const erased = await app.post('/api/memory/delete', { collection: 'facts', id: fact.id });
  assert.equal(erased.status, 200);
  assert.equal(erased.body.facts.length, 0);
  assert.equal(erased.body.conversations.some(item => /oat milk/i.test(item.text)), false);
  assert.equal(erased.body.conversations.some(item => item.text === 'The sky is blue.'), true);
  assert.deepEqual((await app.request(`/api/trace?request_id=${remember.request_id}`)).body, { status: 'pending', events: [] });
  await app.post('/api/documents', { title: 'Delete me', content: 'Synthetic document.' });
  await app.post('/api/memory/rule', { kind: 'timer_default_unit', value: 'seconds', scope: 'timers' });
  assert.equal((await app.post('/api/timers', { label: 'Independent', duration_seconds: 60, time_zone: 'UTC', request_id: randomUUID() })).status, 200);
  const cleared = await app.post('/api/memory/clear', {});
  assert.equal(cleared.status, 200);
  for (const collection of ['facts', 'rules', 'documents', 'conversations', 'events']) assert.deepEqual(cleared.body[collection], []);
  assert.equal(cleared.body.learning.pending, 0);
  assert.equal((await app.request('/api/state')).body.timers.length, 1);
  const persisted = await readFile(join(app.directory, 'memory.json'), 'utf8');
  assert.equal(persisted.includes('oat milk'), false);
  const jobs = JSON.parse(await readFile(join(app.directory, 'memory-learning.json'), 'utf8'));
  assert.deepEqual(jobs.pending, []);
  assert.equal(jobs.prepared, null);
});

test('trace endpoint exposes elapsed stages, selection and measured usage without hidden reasoning', async (t) => {
  const secret = 'SYNTHETIC_HIDDEN_REASONING_DO_NOT_EXPOSE';
  const meta = scriptedMeta([[{ type: 'reasoning', encrypted_content: secret, summary: [{ type: 'summary_text', text: secret }] }, reply('Hello.')]]);
  const app = await fixture(t, meta);
  const body = chat('Hello.');
  const result = await app.post('/api/chat', body);
  assert.equal(result.status, 200);
  const trace = (await app.request(`/api/trace?request_id=${body.request_id}`)).body;
  assert.equal(trace.status, 'complete');
  assert.equal(trace.model_calls, 1);
  assert.deepEqual(trace.usage, { input_tokens: 31, output_tokens: 9, cached_tokens: 7 });
  assert.ok(trace.events.some(event => event.stage === 'context'));
  assert.ok(trace.events.some(event => event.stage === 'output_check'));
  assert.ok(trace.events.every(event => Number.isFinite(event.at_ms)));
  assert.equal(JSON.stringify(trace).includes(secret), false);
  assert.equal(JSON.stringify((await app.request('/api/memory')).body).includes(secret), false);
  assert.equal(JSON.stringify(result.body).includes(secret), false);
});

test('malformed compiler arguments, unknown rule kinds and invented evidence have no saved effects', async (t) => {
  const instruction = 'Use seconds for timers.';
  const meta = scriptedMeta([
    [
      call('memory_save_rule', { ...savedRule('seconds', instruction), execute: 'process.exit()' }),
      call('memory_save_rule', savedRule('arbitrary-program', instruction, 'execute_code', 'tools')),
      call('memory_save_rule', savedRule('days', instruction)),
      call('memory_save_rule', savedRule('seconds', 'This quotation does not exist.')),
      { ...call('memory_save_rule', {}), arguments: '{bad-json' },
    ],
    input => { assert.ok(outputs(input).every(output => output.ok === false)); return [reply('I could not save those invalid instructions.')]; },
  ]);
  const app = await fixture(t, meta);
  const result = await app.post('/api/chat', chat(instruction));
  assert.equal(result.status, 200);
  assert.equal(result.body.tool_events.length, 5);
  assert.ok(result.body.tool_events.every(event => event.status === 'failed'));
  const memory = (await app.request('/api/memory')).body;
  assert.deepEqual(memory.rules, []);
  assert.deepEqual(memory.facts, []);
  assert.deepEqual(result.body.timers, []);
});

test('the manual timer API enforces the same saved duration limit as assistant timer tools', async (t) => {
  const app = await fixture(t, scriptedMeta([]));
  assert.equal((await app.post('/api/memory/rule', { kind: 'timer_max_seconds', value: 30, scope: 'timers' })).status, 200);
  const blocked = await app.post('/api/timers', { label: 'Too long', duration_seconds: 60, time_zone: 'UTC', request_id: randomUUID() });
  assert.equal(blocked.status, 400);
  assert.equal((await app.request('/api/state')).body.timers.length, 0);
  const allowed = await app.post('/api/timers', { label: 'Allowed', duration_seconds: 20, time_zone: 'UTC', request_id: randomUUID() });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.timers.length, 1);
});

test('web search is unavailable until a local preparation succeeds and newly saved bans apply before preparation', async (t) => {
  const instruction = 'Never search the web.';
  const meta = scriptedMeta([
    (_input, { tools }) => {
      assert.equal(tools.some(tool => tool.type === 'web_search'), false);
      assert.ok(tools.some(tool => tool.name === 'prepare_web_search'));
      return [call('prepare_web_search', {})];
    },
    (input, { tools }) => {
      assert.equal(outputs(input).at(-1).ok, true);
      assert.ok(tools.some(tool => tool.type === 'web_search'));
      return [{ type: 'web_search_call', id: 'native-synthetic-search', status: 'completed' }, reply('Search completed.')];
    },
    (_input, { tools }) => {
      assert.equal(tools.some(tool => tool.type === 'web_search'), false, 'Search permission is per request, not inherited from previous requests');
      return [call('prepare_web_search', {}, 'prepare-first'), call('memory_save_rule', savedRule('web_search', instruction, 'tool_deny', 'tools'), 'ban-second')];
    },
    (input, { tools }) => {
      assert.equal(tools.some(tool => tool.type === 'web_search'), false);
      const preparation = input.findLast(item => item.type === 'function_call_output' && item.call_id === 'prepare-first');
      assert.equal(JSON.parse(preparation.output).ok, false);
      return [reply('Saved the rule. Web search is blocked.')];
    },
  ]);
  const app = await fixture(t, meta);
  assert.equal((await app.post('/api/chat', chat('Search for the current weather.'))).status, 200);
  const blocked = await app.post('/api/chat', chat(`${instruction} Search for the weather.`));
  assert.equal(blocked.status, 200);
  assert.equal(blocked.body.tool_events.some(event => event.tool === 'web_search'), false);
  assert.equal((await app.request('/api/memory')).body.rules[0].value, 'web_search');
});

test('output repair has no available tools and ignores malicious tool proposals instead of causing new actions', async (t) => {
  const meta = scriptedMeta([
    [reply('A cat is here.')],
    (_input, { tools }) => {
      assert.deepEqual(tools, []);
      return [call('create_timer', { label: 'Unrequested repair action', duration: 20, unit: 'seconds' }), reply('An animal is here.')];
    },
  ]);
  const app = await fixture(t, meta);
  await app.post('/api/memory/rule', { kind: 'avoid_word', value: 'cat', scope: 'assistant_reply' });
  const result = await app.post('/api/chat', chat('Describe the scene.'));
  assert.equal((await app.request('/api/state')).body.timers.length, 0);
  assert.equal(meta.calls.length, 2);
  assert.doesNotMatch(result.body.reply ?? result.body.error, /\bcat\b/i);
});

test('memory-enabled timer tools reject legacy seconds arguments instead of bypassing default-unit conflict checks', async (t) => {
  const meta = scriptedMeta([
    [call('create_timer', { label: 'Legacy bypass', duration_seconds: 3 })],
    input => { assert.equal(outputs(input).at(-1).ok, false); return [reply('The timer request needs valid duration and unit arguments.')]; },
  ]);
  const app = await fixture(t, meta);
  await app.post('/api/memory/rule', { kind: 'timer_default_unit', value: 'seconds', scope: 'timers' });
  await app.post('/api/memory/rule', { kind: 'timer_default_unit', value: 'minutes', scope: 'timers' });
  const result = await app.post('/api/chat', chat('Set a timer for 3.'));
  assert.equal(result.status, 200);
  assert.equal(result.body.timers.length, 0);
  assert.equal(result.body.tool_events[0].status, 'failed');
});

test('natural forgetting invalidates cached HTTP replies, old traces and prepared background extraction', async (t) => {
  const evidence = 'Remember that I prefer synthetic persimmon.';
  const forget = 'Forget that preference.';
  let id;
  const meta = scriptedMeta([
    [call('memory_save_fact', { content: 'Prefers synthetic persimmon.', subject: 'household', kind: 'preference', source_quote: evidence, reason: 'Explicit remember request.', supersedes: '' })],
    [reply('Saved your preference for synthetic persimmon.')],
    () => [call('memory_forget', { collection: 'facts', id, source_quote: forget })],
  ]);
  meta.extractMemories = async messages => ({ facts: [{ source_id: messages[0].id, source_quote: evidence, content: 'Synthetic persimmon is preferred.', subject: 'household', kind: 'preference', reason: 'Direct evidence.' }] });
  const app = await fixture(t, meta);
  const originalRequest = chat(evidence);
  assert.equal((await app.post('/api/chat', originalRequest)).status, 200);
  id = app.store.snapshot().facts[0].id;
  const save = app.store.putFact.bind(app.store);
  app.store.putFact = (value, operation, ...rest) => {
    if (operation?.startsWith('learning:')) throw new Error('Synthetic disk failure leaves the prepared extraction durable.');
    return save(value, operation, ...rest);
  };
  await app.learning.drain();
  app.store.putFact = save;
  const queuePath = join(app.directory, 'memory-learning.json');
  assert.ok(JSON.parse(await readFile(queuePath, 'utf8')).prepared);
  const forgotten = await app.post('/api/chat', chat(forget, originalRequest.session_id));
  assert.equal(forgotten.status, 200);
  assert.equal(app.store.snapshot().facts.length, 0);
  assert.equal((await app.post('/api/chat', originalRequest)).status, 409, 'The old request must not return cached forgotten information');
  const trace = await app.request(`/api/trace?request_id=${originalRequest.request_id}`);
  assert.equal(JSON.stringify(trace.body).includes('synthetic persimmon'), false);
  assert.equal((await readFile(queuePath, 'utf8')).includes('synthetic persimmon'), false);
  assert.equal((await readFile(queuePath, 'utf8')).includes('Synthetic persimmon'), false);
  await app.learning.drain();
  assert.equal(app.store.snapshot().facts.length, 0);
});

test('chat preflight errors are checked against output instructions before delivery', async (t) => {
  const app = await fixture(t, scriptedMeta([]));
  await app.post('/api/memory/rule', { kind: 'avoid_word', value: 'message', scope: 'assistant_reply' });
  await app.post('/api/memory/rule', { kind: 'address_as', value: 'Captain', scope: 'assistant_reply' });
  const result = await app.post('/api/chat', chat(''));
  assert.equal(result.status, 400);
  assert.doesNotMatch(result.body.error, /\bmessage\b/i);
  assert.match(result.body.error, /^Captain/);
});

test('stale memory errors retain their actionable conflict HTTP status', async (t) => {
  const app = await fixture(t, scriptedMeta([]));
  const save = app.store.putFact;
  app.store.putFact = async () => { const error = new Error('Synthetic stale operation'); error.code = 'MEMORY_STALE_OPERATION'; throw error; };
  const result = await app.post('/api/memory/fact', { content: 'A manual edit.', kind: 'fact', subject: 'household' });
  app.store.putFact = save;
  assert.equal(result.status, 409);
  assert.match(result.body.error, /changed|refresh/i);
});
