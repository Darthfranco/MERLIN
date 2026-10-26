import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../src/server.js';
import { TimerStore } from '../src/timers.js';
import { RequestLedger } from '../src/requests.js';
import { MetaClient } from '../src/meta.js';
import { AppError } from '../src/errors.js';

const timerBody = (overrides = {}) => ({
  label: 'Tea', duration_seconds: 60, time_zone: 'America/New_York',
  request_id: randomUUID(), ...overrides,
});
const chatBody = (overrides = {}) => ({
  message: 'Start a 60 second tea timer.', time_zone: 'America/New_York',
  request_id: randomUUID(), session_id: randomUUID(), ...overrides,
});
const call = (name, args, callId = 'call-1') => ({
  type: 'function_call', status: 'completed', name, arguments: JSON.stringify(args), call_id: callId,
});
const reply = (text) => ({
  type: 'message', role: 'assistant', phase: 'final_answer',
  content: [{ type: 'output_text', text, annotations: [] }],
});

function scriptedMeta(steps) {
  return {
    configured: true, model: 'scripted-meta-test', calls: [],
    async respond(input, tools, instructions) {
      this.calls.push(structuredClone({ input, tools, instructions }));
      assert.ok(steps.length, 'Unexpected extra Meta invocation');
      const step = steps.shift();
      if (step instanceof Error) throw step;
      return typeof step === 'function' ? step(input) : structuredClone(step);
    },
  };
}

async function closeServer(server) {
  if (!server.listening) return;
  const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  server.closeAllConnections();
  await closed;
}

async function fixture(t, { meta = new MetaClient({ apiKey: '' }), clock } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'merlin-server-'));
  const servers = [];
  t.after(async () => {
    await Promise.all(servers.map(closeServer));
    await rm(directory, { recursive: true, force: true });
  });
  const start = async (nextMeta = meta) => {
    const timers = clock ? await new TimerStore({ filePath: join(directory, 'timers.json'), now: clock }).init() : undefined;
    const app = await createApp({ dataDir: directory, meta: nextMeta, timers });
    servers.push(app.server);
    await new Promise((resolve, reject) => {
      app.server.once('error', reject);
      app.server.listen(0, '127.0.0.1', resolve);
    });
    const port = app.server.address().port;
    const request = (path, { method = 'GET', body, raw, headers = {} } = {}) => new Promise((resolve, reject) => {
      const req = httpRequest({
        hostname: '127.0.0.1', port, path, method,
        headers: { ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}), ...headers },
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(text) });
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end(raw ?? (body === undefined ? undefined : JSON.stringify(body)));
    });
    return { ...app, port, request, post: (path, body, extra = {}) => request(path, { method: 'POST', body, ...extra }) };
  };
  return { ...await start(), directory, start };
}

test('HTTP manual timers create, cancel, expire, and dismiss without a Meta key', async (t) => {
  let now = Date.parse('2026-10-26T16:00:00.000Z');
  const app = await fixture(t, { clock: () => now });
  const initial = await app.request('/api/state');
  assert.equal(initial.status, 200);
  assert.equal(initial.body.configured, false);
  assert.deepEqual(initial.body.timers, []);
  assert.equal(initial.headers['cache-control'], 'no-store');
  assert.equal(initial.headers['x-content-type-options'], 'nosniff');
  const created = await app.post('/api/timers', timerBody());
  assert.equal(created.status, 200);
  const first = created.body.timers[0];
  assert.equal(first.label, 'Tea');
  assert.equal(first.status, 'running');
  assert.equal(first.ends_at, '2026-10-26T16:01:00.000Z');
  assert.equal((await app.post(`/api/timers/${first.id}/dismiss`, {})).status, 400);
  const cancelled = await app.post(`/api/timers/${first.id}/cancel`, {});
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.timers[0].status, 'cancelled');
  assert.deepEqual((await app.post(`/api/timers/${first.id}/dismiss`, {})).body.timers, []);
  const second = (await app.post('/api/timers', timerBody({ label: 'Pasta', duration_seconds: 1 }))).body.timers[0];
  now += 1000;
  const expired = await app.request('/api/state');
  assert.equal(expired.body.timers[0].status, 'completed');
  assert.equal(expired.body.timers[0].completed_at, second.ends_at);
  assert.deepEqual((await app.post(`/api/timers/${second.id}/dismiss`, {})).body.timers, []);
  assert.equal((await app.post(`/api/timers/${randomUUID()}/cancel`, {})).status, 404);
});

test('HTTP rejects malformed timer input, extra fields, content types, and oversized bodies', async (t) => {
  const app = await fixture(t);
  const badBodies = [
    null, [], {}, timerBody({ duration_seconds: '60' }), timerBody({ duration_seconds: 0 }),
    timerBody({ label: 'x'.repeat(81) }), timerBody({ time_zone: 'Invalid/Zone' }),
    timerBody({ time_zone: '+04:00' }), timerBody({ request_id: 'not-a-uuid' }),
    { ...timerBody(), recurrence: 'daily' },
  ];
  for (const body of badBodies) {
    assert.equal((await app.post('/api/timers', body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await app.post('/api/timers', undefined, { raw: '{broken' })).status, 400);
  assert.equal((await app.post('/api/timers', timerBody(), { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await app.post('/api/timers', undefined, { raw: JSON.stringify({ label: 'x'.repeat(17000) }) })).status, 413);
  assert.deepEqual((await app.request('/api/state')).body.timers, []);
});

test('HTTP accepts local host/origin and rejects foreign host, origin, and cross-site requests', async (t) => {
  const app = await fixture(t);
  const local = await app.request('/api/state', { headers: { Host: `localhost:${app.port}`, Origin: `http://localhost:${app.port}` } });
  assert.equal(local.status, 200);
  for (const headers of [
    { Host: `attacker.example:${app.port}` },
    { Host: 'localhost' },
    { Origin: 'https://attacker.example' },
    { Origin: `http://localhost:${app.port + 1}` },
    { 'Sec-Fetch-Site': 'cross-site' },
  ]) {
    assert.equal((await app.post('/api/timers', timerBody(), { headers })).status, 403);
  }
  assert.deepEqual((await app.request('/api/state')).body.timers, []);
});

test('HTTP retries deduplicate timer creation, reject changed input, and block replay after restart', async (t) => {
  const app = await fixture(t);
  const body = timerBody();
  const responses = await Promise.all([app.post('/api/timers', body), app.post('/api/timers', body)]);
  assert.ok(responses.every((response) => response.status === 200));
  assert.equal(responses[0].body.timers[0].id, responses[1].body.timers[0].id);
  assert.equal((await app.request('/api/state')).body.timers.length, 1);
  const conflict = await app.post('/api/timers', { ...body, label: 'Different timer' });
  assert.equal(conflict.status, 409);
  assert.match(conflict.body.error, /different input/);
  await closeServer(app.server);
  const restarted = await app.start();
  const replay = await restarted.post('/api/timers', body);
  assert.equal(replay.status, 409);
  assert.match(replay.body.error, /restart/);
  assert.equal((await restarted.request('/api/state')).body.timers.length, 1);
});

test('HTTP chat executes a timer, supplies factual output to Meta, and preserves whole follow-up turns', async (t) => {
  const meta = scriptedMeta([
    [call('create_timer', { label: 'Tea', duration_seconds: 60 })],
    (input) => {
      const result = JSON.parse(input.at(-1).output);
      assert.equal(result.ok, true);
      assert.equal(result.result.label, 'Tea');
      assert.equal(result.result.status, 'running');
      return [reply('Your tea timer is running for 60 seconds.')];
    },
    [call('list_timers', {}, 'list-1')],
    (input) => {
      const result = JSON.parse(input.at(-1).output);
      assert.equal(result.result.length, 1);
      return [reply('You have one tea timer running.')];
    },
  ]);
  const app = await fixture(t, { meta });
  const body = chatBody();
  const created = await app.post('/api/chat', body);
  assert.equal(created.status, 200);
  assert.equal(created.body.reply, 'Your tea timer is running for 60 seconds.');
  assert.deepEqual(created.body.tool_events, [{ tool: 'create_timer', status: 'completed', message: 'Created “Tea” for 60 seconds.' }]);
  assert.equal(created.body.timers.length, 1);
  assert.equal('turn' in created.body, false);
  const followup = await app.post('/api/chat', chatBody({ session_id: body.session_id, message: 'Which timers are running?' }));
  assert.equal(followup.status, 200);
  assert.equal(followup.body.reply, 'You have one tea timer running.');
  assert.ok(meta.calls[2].input.some((item) => item.type === 'function_call_output' && item.call_id === 'call-1'));
  assert.ok(meta.calls[2].input.some((item) => item.role === 'assistant' && item.content[0].text === created.body.reply));
  assert.match(meta.calls[0].instructions, /America\/New_York/);
  assert.ok(meta.calls[0].tools.some((tool) => tool.type === 'web_search'));
});

test('HTTP concurrent retries share one chat execution and restart cannot replay it', async (t) => {
  let release;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  const meta = scriptedMeta([
    async () => {
      entered();
      await blocked;
      return [call('create_timer', { label: 'Tea', duration_seconds: 60 })];
    },
    [reply('Tea timer started.')],
  ]);
  const app = await fixture(t, { meta });
  const body = chatBody();
  const first = app.post('/api/chat', body);
  await started;
  const second = app.post('/api/chat', body);
  release();
  const results = await Promise.all([first, second]);
  assert.ok(results.every((result) => result.status === 200));
  assert.equal(meta.calls.length, 2);
  assert.equal(results[0].body.timers[0].id, results[1].body.timers[0].id);
  assert.equal((await app.post('/api/chat', { ...body, message: 'Different message' })).status, 409);
  await closeServer(app.server);
  const restartMeta = scriptedMeta([]);
  const restarted = await app.start(restartMeta);
  assert.equal((await restarted.post('/api/chat', body)).status, 409);
  assert.equal(restartMeta.calls.length, 0);
  assert.equal((await restarted.request('/api/state')).body.timers.length, 1);
});

test('HTTP retains actual tool outcomes and timer when Meta fails after successful execution', async (t) => {
  const meta = scriptedMeta([
    [call('create_timer', { label: 'Tea', duration_seconds: 60 })],
    new AppError('Meta is temporarily unavailable.', 502),
  ]);
  const app = await fixture(t, { meta });
  const body = chatBody();
  const failed = await app.post('/api/chat', body);
  assert.equal(failed.status, 502);
  assert.match(failed.body.error, /temporarily unavailable/);
  assert.equal(failed.body.tool_events[0].tool, 'create_timer');
  assert.equal(failed.body.tool_events[0].status, 'completed');
  assert.equal(failed.body.timers.length, 1);
  assert.equal(failed.body.timers[0].status, 'running');
  const retry = await app.post('/api/chat', body);
  assert.equal(retry.status, 502);
  assert.deepEqual(retry.body.tool_events, failed.body.tool_events);
  assert.equal(meta.calls.length, 2);
  assert.equal((await app.request('/api/state')).body.timers.length, 1);
});

test('HTTP unconfigured Meta returns a clear error and does not create a timer', async (t) => {
  const app = await fixture(t);
  const response = await app.post('/api/chat', chatBody());
  assert.equal(response.status, 503);
  assert.match(response.body.error, /META_API_KEY/);
  assert.deepEqual((await app.request('/api/state')).body.timers, []);
});

test('HTTP malformed chat input is rejected before invoking Meta', async (t) => {
  const meta = scriptedMeta([]);
  const app = await fixture(t, { meta });
  for (const body of [
    chatBody({ message: '' }), chatBody({ message: ' ' }), chatBody({ message: 'x'.repeat(4001) }),
    chatBody({ session_id: 'invalid' }), chatBody({ request_id: 'invalid' }),
    chatBody({ time_zone: 'Invalid/Zone' }), chatBody({ time_zone: '+04:00' }),
    { ...chatBody(), command: 'create_timer' },
  ]) {
    assert.equal((await app.post('/api/chat', body)).status, 400, JSON.stringify(body));
  }
  assert.equal(meta.calls.length, 0);
});

test('RequestLedger persists only hashes before work, deduplicates concurrently, and refuses restart replay', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'merlin-ledger-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, 'requests.jsonl');
  const ledger = await new RequestLedger(filePath).init();
  const body = { message: 'Synthetic private request that must not be stored.' };
  let executions = 0;
  const work = async () => {
    executions++;
    const contents = await readFile(filePath, 'utf8');
    assert.equal(contents.includes(body.message), false);
    assert.equal(contents.includes('synthetic-id'), false);
    const receipt = JSON.parse(contents.trim());
    assert.match(receipt.id, /^[a-f0-9]{64}$/);
    assert.match(receipt.fingerprint, /^[a-f0-9]{64}$/);
    return { result: 'done' };
  };
  const results = await Promise.all([
    ledger.run('synthetic-id', body, work), ledger.run('synthetic-id', body, work),
  ]);
  assert.deepEqual(results, [{ result: 'done' }, { result: 'done' }]);
  assert.equal(executions, 1);
  await assert.rejects(ledger.run('synthetic-id', { message: 'Changed' }, work), { status: 409 });
  const restarted = await new RequestLedger(filePath).init();
  await assert.rejects(restarted.run('synthetic-id', body, work), { status: 409 });
  assert.equal(executions, 1);
});

test('RequestLedger write failure never starts work and corrupt receipts are preserved', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'merlin-ledger-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, 'requests.jsonl');
  const ledger = await new RequestLedger(filePath).init();
  await mkdir(filePath);
  let executions = 0;
  const work = () => { executions++; return 'done'; };
  await assert.rejects(ledger.run('attempt-1', {}, work));
  assert.equal(executions, 0);
  await rm(filePath, { recursive: true });
  assert.equal(await ledger.run('attempt-1', {}, work), 'done');
  assert.equal(executions, 1);
  const corrupt = '{"id":"invalid","fingerprint":"invalid"}\n';
  await writeFile(filePath, corrupt);
  await assert.rejects(new RequestLedger(filePath).init(), /receipt storage is unreadable/);
  assert.equal(await readFile(filePath, 'utf8'), corrupt);
});
