import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/memory-store.js';
import { MemoryLearning } from '../src/memory-learning.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function extracted(message, content = 'The household likes tea.') {
  return { source_id: message.id, source_quote: message.text, content, subject: 'household', kind: 'preference', reason: 'Useful for requested drinks.', supersedes: '' };
}
async function setup(t, meta, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'merlin-learning-'));
  const store = await new MemoryStore({ filePath: join(directory, 'memory.json') }).init();
  const filePath = join(directory, 'learning.json');
  const worker = await new MemoryLearning({ store, meta, filePath, delayMs: 60000, ...options }).init();
  t.after(async () => { await worker.close(); await rm(directory, { recursive: true, force: true }); });
  const source = await store.recordMessage({ session_id: 'synthetic-session', request_id: 'synthetic-request', role: 'user', text: 'I like tea.' });
  return { directory, filePath, store, worker, source };
}

test('enqueue is durable and deferred, with exact evidence and inspectable learning events', async t => {
  let calls = 0;
  const { worker, source, filePath, store } = await setup(t, { extractMemories: async messages => {
    calls++; return { facts: [extracted(messages[0])], usage: { input_tokens: 25, output_tokens: 8, secret: 'not kept' } };
  } });
  await worker.enqueue(source);
  assert.equal(calls, 0);
  assert.equal(JSON.parse(await readFile(filePath, 'utf8')).pending[0].source_id, source.id);
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  await worker.drain();
  assert.equal(calls, 1);
  assert.equal(store.snapshot().facts[0].source_quote, source.text);
  assert.deepEqual(worker.status(), { pending: 0, running: false, error: null });
  assert.deepEqual(store.snapshot().events.map(event => event.type), ['learning_started', 'learning_completed']);
  assert.deepEqual(store.snapshot().events[1].details.usage, { input_tokens: 25, output_tokens: 8 });
});

test('queued source IDs survive restart without copying message text into pending jobs', async t => {
  let calls = 0;
  const meta = { extractMemories: async messages => { calls++; return { facts: [extracted(messages[0])] }; } };
  const { worker, source, filePath, store } = await setup(t, meta);
  await worker.enqueue(source); await worker.close();
  const queued = JSON.parse(await readFile(filePath, 'utf8'));
  assert.deepEqual(Object.keys(queued.pending[0]).sort(), ['epoch', 'source_id']);
  const restarted = await new MemoryLearning({ store, meta, filePath, delayMs: 60000 }).init();
  t.after(() => restarted.close());
  await restarted.drain();
  assert.equal(calls, 1); assert.equal(store.snapshot().facts.length, 1);
});

test('sources removed before extraction are discarded without a model call', async t => {
  let calls = 0;
  const { worker, source, store } = await setup(t, { extractMemories: async () => { calls++; return { facts: [] }; } });
  await worker.enqueue(source);
  await store.clearConversation(source.session_id);
  await worker.drain();
  assert.equal(calls, 0); assert.equal(worker.status().pending, 0);
});

test('forgetting while a model call is pending cannot recreate memories or stale traces', async t => {
  const started = deferred(); const finish = deferred();
  const { worker, source, store } = await setup(t, { extractMemories: async messages => {
    started.resolve(); await finish.promise; return { facts: [extracted(messages[0])] };
  } });
  await worker.enqueue(source);
  const draining = worker.drain(); await started.promise;
  await store.clearAll(); finish.resolve(); await draining;
  assert.equal(store.snapshot().facts.length, 0);
  assert.equal(store.snapshot().events.length, 0);
  assert.equal(worker.status().pending, 0);
});

test('clearing the queue invalidates an in-flight extraction even without changing store epoch', async t => {
  const started = deferred(); const finish = deferred();
  const { worker, source, store, filePath } = await setup(t, { extractMemories: async messages => {
    started.resolve(); await finish.promise; return { facts: [extracted(messages[0])] };
  } });
  await worker.enqueue(source);
  const draining = worker.drain(); await started.promise;
  await worker.clear(); finish.resolve(); await draining;
  assert.equal(store.snapshot().facts.length, 0);
  assert.equal(JSON.parse(await readFile(filePath, 'utf8')).generation, 1);
  assert.equal(worker.status().pending, 0);
});

test('failures stay visible and durable without automatic retry or raw upstream details', async t => {
  let calls = 0; let fail = true;
  const meta = { extractMemories: async messages => {
    calls++; if (fail) throw new Error('SECRET-PRIVATE-UPSTREAM-DATA'); return { facts: [extracted(messages[0])] };
  } };
  const { worker, source, store, filePath } = await setup(t, meta);
  await worker.enqueue(source); await worker.drain(); await worker.drain();
  assert.equal(calls, 1); assert.equal(worker.status().pending, 1); assert.ok(worker.status().error);
  assert.equal(JSON.stringify(store.snapshot().events).includes('SECRET'), false);
  assert.equal((await readFile(filePath, 'utf8')).includes('SECRET'), false);
  fail = false; await worker.retry(); await worker.drain();
  assert.equal(calls, 2); assert.equal(worker.status().error, null); assert.equal(store.snapshot().facts.length, 1);
});

test('automatic learning cannot create rules, fake source evidence, or replace explicit facts', async t => {
  let response;
  const { worker, source, store } = await setup(t, { extractMemories: async () => response });
  const unsafe = [
    { facts: [], rules: [{ kind: 'tool_deny', value: 'web_search' }] },
    { facts: [{ ...extracted(source), kind: 'tool_deny' }] },
    { facts: [{ ...extracted(source), source_quote: 'Fabricated quotation' }] },
    { facts: [{ ...extracted(source), source_id: 'manual' }] },
    { facts: [{ ...extracted(source), supersedes: 'an-existing-fact' }] },
  ];
  await worker.enqueue(source);
  for (response of unsafe) {
    await worker.retry(); await worker.drain();
    assert.ok(worker.status().error);
    assert.equal(store.snapshot().facts.length, 0); assert.equal(store.snapshot().rules.length, 0);
  }
});

test('prepared facts resume after a partial save without re-extraction or duplicate writes', async t => {
  let calls = 0;
  const { worker, source, store } = await setup(t, { extractMemories: async messages => {
    calls++; return { facts: [extracted(messages[0]), extracted(messages[0], 'The household prefers tea to be available.')] };
  } });
  const realPut = store.putFact.bind(store); let writes = 0;
  store.putFact = async (...args) => { if (++writes === 2) throw new Error('temporary disk issue'); return realPut(...args); };
  await worker.enqueue(source); await worker.drain();
  assert.equal(store.snapshot().facts.length, 1); assert.ok(worker.status().error);
  await worker.retry(); await worker.drain();
  assert.equal(calls, 1); assert.equal(store.snapshot().facts.length, 2); assert.equal(worker.status().pending, 0);
});

test('batches have at most four sources and model calls run serially', async t => {
  let concurrent = 0; let maximum = 0; const sizes = [];
  const { worker, source, store } = await setup(t, { extractMemories: async messages => {
    concurrent++; maximum = Math.max(maximum, concurrent); sizes.push(messages.length);
    await Promise.resolve(); concurrent--; return { facts: [] };
  } });
  await worker.enqueue(source);
  for (let index = 0; index < 8; index++) {
    const next = await store.recordMessage({ session_id: 's', request_id: `r-${index}`, role: 'user', text: `Synthetic fact ${index}.` });
    await worker.enqueue(next);
  }
  await worker.drain();
  assert.deepEqual(sizes, [4, 4, 1]); assert.equal(maximum, 1);
});

test('closing does not let an in-flight call write new memories and retains its job for restart', async t => {
  const started = deferred(); const finish = deferred();
  const { worker, source, store, filePath } = await setup(t, { extractMemories: async messages => {
    started.resolve(); await finish.promise; return { facts: [extracted(messages[0])] };
  } });
  await worker.enqueue(source); const draining = worker.drain(); await started.promise;
  const closing = worker.close(); finish.resolve(); await closing; await draining;
  assert.equal(store.snapshot().facts.length, 0);
  assert.equal(JSON.parse(await readFile(filePath, 'utf8')).pending.length, 1);
  await assert.rejects(worker.enqueue(source), /closed/);
});

test('scripted clients without extraction are skipped and corrupt queue files are preserved', async t => {
  const { worker, source, filePath, store } = await setup(t, {});
  assert.equal((await worker.enqueue(source)).queued, false);
  assert.equal(worker.status().pending, 0);
  await worker.close(); await writeFile(filePath, 'corrupted input');
  const replacement = new MemoryLearning({ store, meta: {}, filePath });
  await assert.rejects(replacement.init(), /corrupted/);
  assert.equal(await readFile(filePath, 'utf8'), 'corrupted input');
});
