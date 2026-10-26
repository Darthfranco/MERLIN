import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Assistant, TOOLS } from '../src/assistant.js';
import { MetaClient } from '../src/meta.js';
import { TimerStore } from '../src/timers.js';

const request = {
  message: 'Set a one-minute tea timer.',
  time_zone: 'America/New_York',
  request_id: 'synthetic-request',
};

function call(name = 'create_timer', args = { label: 'Tea', duration_seconds: 60 }, id = 'call_1') {
  return { type: 'function_call', status: 'completed', name, arguments: JSON.stringify(args), call_id: id };
}

function answer(text = 'Your tea timer is running.', annotations = []) {
  return { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations }] };
}

function script(...steps) {
  const requests = [];
  return {
    requests,
    async respond(input, tools, instructions) {
      requests.push(structuredClone({ input, tools, instructions }));
      assert.ok(steps.length, 'Assistant made an unexpected extra model request');
      const step = steps.shift();
      if (step instanceof Error) throw step;
      return typeof step === 'function' ? step(requests.at(-1)) : structuredClone(step);
    },
  };
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'merlin-assistant-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return new TimerStore({
    filePath: join(directory, 'timers.json'),
    now: () => Date.parse('2026-10-26T18:00:00.000Z'),
  }).init();
}

function fakeFetch(payload, captured = []) {
  return async (url, options) => {
    captured.push({ url, options });
    return { ok: true, status: 200, json: async () => structuredClone(payload) };
  };
}

test('Meta sends a stateless request to the fixed Meta endpoint with standard-model privacy settings', async () => {
  const captured = [];
  const output = [answer('Hello.')];
  const meta = new MetaClient({ apiKey: ' synthetic-test-key ', fetchImpl: fakeFetch({ status: 'completed', output }, captured) });
  const input = [{ role: 'user', content: 'Hello.' }];
  assert.deepEqual(await meta.respond(input, TOOLS, 'Be useful.'), output);
  assert.equal(captured.length, 1);
  const { url, options } = captured[0];
  assert.equal(url, 'https://api.meta.ai/v1/responses');
  assert.equal(options.method, 'POST');
  assert.equal(options.headers.Authorization, 'Bearer synthetic-test-key');
  assert.equal(options.redirect, 'error');
  const body = JSON.parse(options.body);
  assert.equal(body.model, 'muse-spark-1.3');
  assert.equal(body.store, false);
  assert.deepEqual(body.include, ['reasoning.encrypted_content', 'web_search_call.results']);
  assert.equal(body.tool_choice, 'auto');
  assert.equal(body.parallel_tool_calls, false);
  assert.equal('previous_response_id' in body, false);
  assert.deepEqual(body.input, input);
  assert.deepEqual(body.tools, TOOLS);
  assert.equal(body.instructions, 'Be useful.');
});

test('Contributor and unrelated models cannot be selected and missing credentials never call fetch', async () => {
  for (const model of ['muse-spark-1.3-contributor', 'muse-spark-1.2-contributor', 'another-provider', 'muse-spark-1.3/../../responses']) {
    assert.throws(() => new MetaClient({ model }), /standard Meta text model/);
  }
  let called = false;
  const meta = new MetaClient({ fetchImpl: async () => { called = true; } });
  await assert.rejects(meta.respond([], TOOLS, ''), /API_KEY/);
  assert.equal(called, false);
});

test('model access is checked against the authenticated model listing', async () => {
  const captured = [];
  const meta = new MetaClient({ apiKey: 'synthetic-key', fetchImpl: fakeFetch({ data: [{ id: 'muse-spark-1.3' }] }, captured) });
  assert.deepEqual(await meta.checkAccess(), { model: 'muse-spark-1.3', available: true });
  assert.equal(captured[0].url, 'https://api.meta.ai/v1/models');
  assert.equal(captured[0].options.method, 'GET');
  const unavailable = new MetaClient({ apiKey: 'synthetic-key', fetchImpl: fakeFetch({ data: [{ id: 'muse-spark-1.3-contributor' }] }) });
  await assert.rejects(unavailable.checkAccess(), /did not list muse-spark-1.3/);
});

test('upstream failures do not leak provider response bodies or credentials', async () => {
  const secret = 'synthetic-private-upstream-content';
  let bodyRead = false;
  const meta = new MetaClient({
    apiKey: secret,
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => { bodyRead = true; return { message: secret }; } }),
  });
  await assert.rejects(meta.respond([], TOOLS, ''), (error) => {
    assert.match(error.message, /HTTP 401/);
    assert.equal(error.message.includes(secret), false);
    return true;
  });
  assert.equal(bodyRead, false);
});

test('timer execution returns actual persisted results to Meta and preserves stateless reasoning and commentary', async (t) => {
  const timers = await fixture(t);
  const reasoning = { type: 'reasoning', id: 'rs_synthetic', encrypted_content: 'opaque-synthetic-state' };
  const commentary = { ...answer('I will start that timer.'), phase: 'commentary' };
  const toolCall = call();
  const history = [{ role: 'user', content: 'Hello.' }, answer('Hello.')];
  const meta = script([reasoning, commentary, toolCall], ({ input }) => {
    const result = JSON.parse(input.at(-1).output);
    assert.equal(input.at(-1).type, 'function_call_output');
    assert.equal(input.at(-1).call_id, toolCall.call_id);
    assert.equal(result.ok, true);
    assert.equal(result.result.label, 'Tea');
    assert.equal(result.result.status, 'running');
    assert.equal(result.result.ends_at, '2026-10-26T18:01:00.000Z');
    assert.equal(result.result.time_zone, 'America/New_York');
    assert.equal('operation_key' in result.result, false);
    return [answer(`Created timer ${result.result.id}.`)];
  });
  const result = await new Assistant({ meta, timers }).run({ ...request, history });
  const stored = await timers.list();
  assert.equal(stored.length, 1);
  assert.equal(result.reply, `Created timer ${stored[0].id}.`);
  assert.equal(result.tool_events[0].status, 'completed');
  assert.deepEqual(meta.requests[1].input.slice(0, history.length), history);
  assert.deepEqual(meta.requests[1].input[3], { ...reasoning, summary: [] });
  assert.deepEqual(meta.requests[1].input[4], commentary);
  assert.match(meta.requests[1].instructions, /America\/New_York/);
  assert.equal(result.turn[0].role, 'user');
  assert.equal(result.turn.length, 6);
});

test('invalid JSON, unknown fields, negative durations, and unsupported functions return failures without side effects', async (t) => {
  const cases = [
    [{ ...call(), arguments: '{invalid' }, /valid JSON/],
    [call('create_timer', { label: 'Tea', duration_seconds: 60, recurrence: 'daily' }), /Unexpected fields/],
    [call('create_timer', { label: 'Tea', duration_seconds: -1 }), /duration_seconds/],
    [call('unlock_door', {}), /not available/],
  ];
  for (const [toolCall, message] of cases) {
    await t.test(toolCall.name + ' ' + toolCall.arguments, async (subtest) => {
      const timers = await fixture(subtest);
      const meta = script([toolCall], [answer('The requested operation failed.')]);
      const result = await new Assistant({ meta, timers }).run(request);
      assert.deepEqual(await timers.list(), []);
      assert.equal(result.tool_events.length, 1);
      assert.equal(result.tool_events[0].status, 'failed');
      assert.match(result.tool_events[0].message, message);
      const returned = JSON.parse(meta.requests[1].input.at(-1).output);
      assert.equal(returned.ok, false);
      assert.match(returned.error, message);
    });
  }
});

test('list and cancel tools use the real timer identifier and cancellation result', async (t) => {
  const timers = await fixture(t);
  const timer = await timers.create({ label: 'Tea', duration_seconds: 60, time_zone: 'UTC' }, 'seed');
  const meta = script([call('list_timers', {}, 'list_1')], ({ input }) => {
    const listed = JSON.parse(input.at(-1).output);
    assert.deepEqual(listed, { ok: true, result: [timer] });
    return [call('cancel_timer', { timer_id: listed.result[0].id }, 'cancel_1')];
  }, ({ input }) => {
    assert.equal(JSON.parse(input.at(-1).output).result.status, 'cancelled');
    return [answer('The tea timer is cancelled.')];
  });
  const result = await new Assistant({ meta, timers }).run({ ...request, message: 'Cancel my tea timer.' });
  assert.equal((await timers.list())[0].status, 'cancelled');
  assert.deepEqual(result.tool_events.map((event) => event.tool), ['list_timers', 'cancel_timer']);
});

test('the assistant bounds both model rounds and function calls per run', async (t) => {
  const timers = await fixture(t);
  const meta = script(...Array.from({ length: 5 }, (_, index) => [call('list_timers', {}, `list_${index}`)]));
  await assert.rejects(new Assistant({ meta, timers }).run(request), (error) => {
    assert.match(error.message, /tool-loop limit/);
    assert.equal(error.tool_events.length, 5);
    return true;
  });
  assert.equal(meta.requests.length, 5);
  const manyCalls = script(Array.from({ length: 9 }, (_, index) => call('list_timers', {}, `many_${index}`)));
  await assert.rejects(new Assistant({ meta: manyCalls, timers }).run(request), (error) => {
    assert.match(error.message, /eight tool calls/);
    assert.equal(error.tool_events.length, 8);
    return true;
  });
});

test('an explicit search reports confirmed execution and only safe HTTP citations', async (t) => {
  const timers = await fixture(t);
  const citation = (url, title = 'Synthetic source') => ({ type: 'url_citation', url, title, start_index: 0, end_index: 4 });
  const meta = script([
    { type: 'web_search_call', id: 'ws_test', status: 'completed', results: [{ type: 'text_result', url: 'https://example.org/raw', title: 'Unused result', snippet: 'Synthetic text.' }] },
    answer('Here are the current findings.', [
      citation('https://example.org/article'), citation('http://example.org/other'),
      citation('https://example.org/article'), citation('javascript:alert(1)'),
      citation('data:text/html,danger'), citation('file:///etc/passwd'),
      citation('ftp://example.org/file'), citation('/relative'), citation('not a URL'),
    ]),
  ]);
  const result = await new Assistant({ meta, timers }).run({ ...request, message: 'Search for current information.' });
  assert.deepEqual(result.tool_events, [{ tool: 'web_search', status: 'completed', message: 'Meta searched the web.' }]);
  assert.deepEqual(result.sources.map((source) => source.url), ['https://example.org/article', 'http://example.org/other']);
  assert.equal(result.reply, 'Here are the current findings.');
  assert.deepEqual(await timers.list(), []);
});

test('retrieved content cannot authorize timer creation within the same run', async (t) => {
  const timers = await fixture(t);
  const meta = script([
    { type: 'web_search_call', status: 'completed' },
    call('create_timer', { label: 'From untrusted search', duration_seconds: 60 }),
  ], [answer('Please request that timer separately.')]);
  const result = await new Assistant({ meta, timers }).run({ ...request, message: 'Search for tea instructions.' });
  assert.deepEqual(await timers.list(), []);
  assert.equal(result.tool_events[1].status, 'failed');
  assert.match(result.tool_events[1].message, /after web retrieval/);
});

test('partial or failed API envelopes never execute their function calls', async (t) => {
  for (const status of ['incomplete', 'failed', 'in_progress']) {
    await t.test(status, async (subtest) => {
      const timers = await fixture(subtest);
      const meta = new MetaClient({ apiKey: 'synthetic-key', fetchImpl: fakeFetch({ status, output: [call()] }) });
      await assert.rejects(new Assistant({ meta, timers }).run(request), /did not finish/);
      assert.deepEqual(await timers.list(), []);
    });
  }
});

test('a completed API envelope cannot execute an unfinished function item', async (t) => {
  for (const status of ['in_progress', 'failed']) {
    await t.test(status, async (subtest) => {
      const timers = await fixture(subtest);
      const meta = new MetaClient({
        apiKey: 'synthetic-key',
        fetchImpl: fakeFetch({ status: 'completed', output: [{ ...call(), status }] }),
      });
      await assert.rejects(new Assistant({ meta, timers }).run(request));
      assert.deepEqual(await timers.list(), [], 'A partial function item must not cause a local side effect');
    });
  }
});

test('a successful timer remains visible in error results when the subsequent model request fails', async (t) => {
  const timers = await fixture(t);
  const failure = new Error('Synthetic provider failure');
  const meta = script([call()], failure);
  await assert.rejects(new Assistant({ meta, timers }).run(request), (error) => {
    assert.equal(error, failure);
    assert.equal(error.tool_events.length, 1);
    assert.equal(error.tool_events[0].status, 'completed');
    assert.match(error.tool_events[0].message, /Created/);
    return true;
  });
  assert.equal((await timers.list()).length, 1);
  assert.equal((await timers.list())[0].status, 'running');
});

test('repeated call IDs reuse their result without repeating a timer side effect', async (t) => {
  const timers = await fixture(t);
  const create = timers.create.bind(timers);
  let creationCount = 0;
  timers.create = (...args) => { creationCount++; return create(...args); };
  const toolCall = call();
  const meta = script([toolCall], [toolCall], [answer()]);
  const result = await new Assistant({ meta, timers }).run(request);
  assert.equal(creationCount, 1);
  assert.equal((await timers.list()).length, 1);
  assert.equal(result.tool_events.length, 1);
  const results = meta.requests[2].input.filter((item) => item.type === 'function_call_output');
  assert.equal(results.length, 2);
  assert.equal(results[0].output, results[1].output);
});

test('reusing a call ID with different arguments stops before a second mutation', async (t) => {
  const timers = await fixture(t);
  const meta = script([call()], [call('create_timer', { label: 'Coffee', duration_seconds: 120 })]);
  await assert.rejects(new Assistant({ meta, timers }).run(request), /reused a tool identifier/);
  assert.equal((await timers.list()).length, 1);
  assert.equal((await timers.list())[0].label, 'Tea');
});
