import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { TimerStore } from '../src/timers.js';

const args = { label: 'Tea', duration_seconds: 60, time_zone: 'America/New_York' };

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'merlin-timers-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let time = Date.parse('2026-11-01T05:59:30.000Z');
  const filePath = join(directory, 'private', 'timers.json');
  const now = () => time;
  const store = await new TimerStore({ filePath, now }).init();
  return { store, filePath, directory, now, advance: (ms) => { time += ms; } };
}

test('duration uses an absolute deadline across daylight saving changes and completes only once', async (t) => {
  const { store, advance } = await fixture(t);
  const timer = await store.create(args, 'tea-1');
  assert.equal(timer.ends_at, '2026-11-01T06:00:30.000Z');
  assert.equal(timer.time_zone, 'America/New_York');
  assert.equal(timer.status, 'running');
  assert.equal('operation_key' in timer, false);
  advance(59_999);
  assert.deepEqual(await store.tick(), []);
  advance(1);
  assert.deepEqual(await store.tick(), [{ ...timer, status: 'completed', completed_at: timer.ends_at }]);
  assert.deepEqual(await store.tick(), []);
  assert.equal((await store.list())[0].status, 'completed');
});

test('persistence restores running timers, reconciles offline expiry, and does not repeat completion', async (t) => {
  const { store, filePath, now, advance } = await fixture(t);
  const timer = await store.create(args, 'tea-1');
  const runningRestart = await new TimerStore({ filePath, now }).init();
  assert.deepEqual(await runningRestart.list(), [timer]);
  advance(120_000);
  const expiredRestart = await new TimerStore({ filePath, now }).init();
  assert.equal((await expiredRestart.list())[0].status, 'completed');
  assert.deepEqual(await expiredRestart.tick(), []);
  const laterRestart = await new TimerStore({ filePath, now }).init();
  assert.deepEqual(await laterRestart.tick(), []);
  assert.equal((await laterRestart.list())[0].completed_at, timer.ends_at);
});

test('cancellation and dismissal persist, and dismissing cannot recreate a retried operation', async (t) => {
  const { store, filePath, now, advance } = await fixture(t);
  const timer = await store.create(args, 'tea-1');
  await assert.rejects(store.dismiss(timer.id), /Cancel a running timer/);
  assert.equal((await store.cancel(timer.id)).status, 'cancelled');
  assert.equal((await store.cancel(timer.id)).status, 'cancelled');
  advance(120_000);
  assert.deepEqual(await store.tick(), []);
  await store.dismiss(timer.id);
  assert.deepEqual(await store.list(), []);
  const restart = await new TimerStore({ filePath, now }).init();
  assert.equal((await restart.create(args, 'tea-1')).id, timer.id);
  assert.equal((await restart.create(args, 'tea-1')).status, 'cancelled');
  assert.deepEqual(await restart.list(), []);
  await assert.rejects(restart.create({ ...args, label: 'Coffee' }, 'tea-1'), /different arguments/);
});

test('an elapsed timer is completed instead of cancelled even before the next tick', async (t) => {
  const { store, advance } = await fixture(t);
  const timer = await store.create(args, 'tea-1');
  advance(60_000);
  assert.equal((await store.cancel(timer.id)).status, 'completed');
  await store.dismiss(timer.id);
  assert.deepEqual(await store.list(), []);
});

test('concurrent operations serialize and duplicate create keys make only one timer', async (t) => {
  const { store, filePath, now } = await fixture(t);
  const duplicateTimers = await Promise.all(Array.from({ length: 12 }, () => store.create(args, 'same-key')));
  assert.equal(new Set(duplicateTimers.map((timer) => timer.id)).size, 1);
  const additional = await Promise.all(Array.from({ length: 12 }, (_, index) => store.create({ ...args, label: `Timer ${index}` }, `key-${index}`)));
  await Promise.all(additional.slice(0, 6).map((timer) => store.cancel(timer.id)));
  const restart = await new TimerStore({ filePath, now }).init();
  const timers = await restart.list();
  assert.equal(timers.length, 13);
  assert.equal(timers.filter((timer) => timer.status === 'cancelled').length, 6);
  timers[0].label = 'Mutated externally';
  assert.equal((await restart.list())[0].label, 'Tea');
});

test('validates arguments without coercion and allows recovery after rejected operations', async (t) => {
  const { store } = await fixture(t);
  const invalidArgs = [
    null, [], {}, { ...args, label: '' }, { ...args, label: '  ' },
    { ...args, label: 'a'.repeat(81) }, { ...args, duration_seconds: 0 },
    { ...args, duration_seconds: -1 }, { ...args, duration_seconds: 1.5 },
    { ...args, duration_seconds: '60' }, { ...args, duration_seconds: Infinity },
    { ...args, duration_seconds: 604801 }, { ...args, time_zone: '' },
    { ...args, time_zone: 'America/Atlantis' }, { ...args, time_zone: '+04:00' },
    { ...args, recurrence: 'daily' },
  ];
  for (const value of invalidArgs) {
    await assert.rejects(store.create(value, 'invalid'), { code: 'INVALID_TIMER_ARGUMENT' });
  }
  for (const key of [undefined, null, '', '  ', 123, 'x'.repeat(257)]) {
    await assert.rejects(store.create(args, key), { code: 'INVALID_TIMER_ARGUMENT' });
  }
  await assert.rejects(store.cancel('missing'), { code: 'TIMER_NOT_FOUND' });
  await assert.rejects(store.dismiss(null), { code: 'INVALID_TIMER_ARGUMENT' });
  assert.deepEqual(await store.list(), []);
  assert.equal((await store.create({ ...args, label: ' Tea ', time_zone: 'UTC' }, 'valid')).label, 'Tea');
});

test('running timer cap is enforced and expiry frees capacity', async (t) => {
  const { store, advance } = await fixture(t);
  await Promise.all(Array.from({ length: 50 }, (_, index) => store.create(args, `timer-${index}`)));
  await assert.rejects(store.create(args, 'overflow'), /At most 50/);
  // Retrying an existing operation is allowed even at capacity.
  assert.ok((await store.create(args, 'timer-0')).id);
  advance(60_000);
  await store.create(args, 'after-expiry');
  assert.equal((await store.list()).filter((timer) => timer.status === 'running').length, 1);
});

test('failed disk persistence leaves memory unchanged and later writes recover', async (t) => {
  const { store, filePath, directory } = await fixture(t);
  const timer = await store.create(args, 'tea-1');
  const backup = join(directory, 'backed-up-timers.json');
  await rename(filePath, backup);
  await mkdir(filePath);
  await assert.rejects(store.cancel(timer.id), { code: 'TIMER_STORAGE_ERROR' });
  assert.equal((await store.list())[0].status, 'running');
  await assert.rejects(store.create(args, 'tea-2'), { code: 'TIMER_STORAGE_ERROR' });
  assert.equal((await store.list()).length, 1);
  await rm(filePath, { recursive: true });
  await rename(backup, filePath);
  assert.equal((await store.cancel(timer.id)).status, 'cancelled');
  assert.equal(JSON.parse(await readFile(filePath, 'utf8')).timers[0].status, 'cancelled');
});

test('corrupt and unsupported files fail clearly without overwriting their contents', async (t) => {
  const { filePath, now } = await fixture(t);
  for (const content of ['{broken', '{"version":2,"timers":[]}', '{"version":1,"timers":[{}]}']) {
    await writeFile(filePath, content);
    const store = new TimerStore({ filePath, now });
    await assert.rejects(store.init(), { code: 'TIMER_STORAGE_CORRUPT' });
    await assert.rejects(store.create(args, 'tea-1'), /init\(\) must succeed/);
    assert.equal(await readFile(filePath, 'utf8'), content);
  }
});

test('failed expiry persistence is retried once without reporting an uncommitted completion', async (t) => {
  const { store, filePath, directory, advance } = await fixture(t);
  const timer = await store.create(args, 'tea-1');
  advance(60_000);
  const backup = join(directory, 'before-expiry.json');
  await rename(filePath, backup);
  await mkdir(filePath);
  await assert.rejects(store.tick(), { code: 'TIMER_STORAGE_ERROR' });
  assert.equal((await store.list())[0].status, 'running');
  await rm(filePath, { recursive: true });
  await rename(backup, filePath);
  const completed = await store.tick();
  assert.equal(completed.length, 1);
  assert.equal(completed[0].id, timer.id);
  assert.deepEqual(await store.tick(), []);
});

test('tampered records and duplicate operation keys are rejected on restart', async (t) => {
  const { store, filePath, now } = await fixture(t);
  await store.create(args, 'tea-1');
  const original = JSON.parse(await readFile(filePath, 'utf8'));
  const mutations = [
    (state) => { state.timers[0].ends_at = state.timers[0].created_at; },
    (state) => { state.timers[0].status = 'completed'; },
    (state) => { state.timers[0].dismissed = true; },
    (state) => { state.timers.push({ ...state.timers[0], id: 'different-id' }); },
  ];
  for (const mutate of mutations) {
    const state = structuredClone(original);
    mutate(state);
    const content = JSON.stringify(state);
    await writeFile(filePath, content);
    await assert.rejects(new TimerStore({ filePath, now }).init(), { code: 'TIMER_STORAGE_CORRUPT' });
    assert.equal(await readFile(filePath, 'utf8'), content);
  }
});
