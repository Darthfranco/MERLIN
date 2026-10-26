import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Assistant } from '../src/assistant.js';
import { MemoryService } from '../src/memory.js';
import { MemoryStore } from '../src/memory-store.js';
import { TimerStore } from '../src/timers.js';

async function fixture(t, message) {
  const directory = await mkdtemp(join(tmpdir(), 'merlin-provider-arguments-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await new MemoryStore({ filePath: join(directory, 'memory.json') }).init();
  const timers = await new TimerStore({ filePath: join(directory, 'timers.json') }).init();
  const memory = new MemoryService(store);
  const source = await store.recordMessage({ text: message, role: 'user', session_id: 'test-session', request_id: 'test-request' });
  const context = { message, source_id: source.id, session_id: source.session_id, request_id: source.request_id, epoch: store.epoch };
  return { store, timers, memory, context };
}
const rule = (value, source_quote) => ({ kind: 'timer_default_seconds', value, scope: 'timers', source_quote, explanation: 'Use this whole duration only when no duration is supplied.' });
const call = (name, args, call_id) => ({ type: 'function_call', name, arguments: JSON.stringify(args), call_id, status: 'completed' });

test('actual provider decimal-text and string-null formats save a numeric default and start a timer without a repair round', async t => {
  const message = 'Please make my usual timer length seven minutes and start one now.';
  const { store, timers, memory, context } = await fixture(t, message);
  let calls = 0;
  const meta = { async respond(input) {
    if (++calls === 1) return [
      call('create_timer', { label: 'usual timer', duration: 'null', unit: 'default' }, 'start'),
      call('memory_save_rule', rule('420.0', message), 'save'),
    ];
    const results = input.filter(item => item.type === 'function_call_output').map(item => JSON.parse(item.output));
    assert.ok(results.every(item => item.ok));
    assert.equal(results[0].result.record.value, 420);
    assert.equal(results[1].result.duration_seconds, 420);
    return [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Your timer is set for 7 minutes. I will use that by default.' }] }];
  } };
  const result = await new Assistant({ meta, timers, memory }).run({ ...context, time_zone: 'America/New_York' });
  assert.equal(calls, 2);
  assert.ok(result.tool_events.every(event => event.status === 'completed'));
  assert.equal(store.snapshot().rules[0].value, 420);
  assert.equal((await timers.list())[0].duration_seconds, 420);
});

test('provider rule conversion rejects units, fractions, expressions, zero and out-of-range values', async t => {
  const message = 'Make my default timer five minutes.';
  const { store, memory, context } = await fixture(t, message);
  for (const value of ['300 seconds', '5 * 60', '0', '3.5', 'NaN', 'Infinity', '', '604801', '1e3', true, null, {}]) {
    await assert.rejects(memory.execute('memory_save_rule', rule(value, message), context));
  }
  assert.equal(store.snapshot().rules.length, 0);
  const result = await memory.execute('memory_save_rule', rule('300', message), context);
  assert.equal(result.record.value, 300);
});

test('string null is not accepted as an explicit duration and cannot bypass missing-default checks', async t => {
  const message = 'Start my usual timer please.';
  const { timers, memory, context } = await fixture(t, message);
  let calls = 0;
  const meta = { async respond(input) {
    if (++calls === 1) return [
      call('create_timer', { label: 'bad explicit', duration: 'null', unit: 'minutes' }, 'explicit'),
      call('create_timer', { label: 'missing default', duration: 'null', unit: 'default' }, 'missing'),
      call('create_timer', { label: 'bad numeric string', duration: '5', unit: 'minutes' }, 'numeric'),
    ];
    const results = input.filter(item => item.type === 'function_call_output').map(item => JSON.parse(item.output));
    assert.ok(results.every(item => !item.ok));
    return [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'How long should I set it for?' }] }];
  } };
  await new Assistant({ meta, timers, memory }).run({ ...context, time_zone: 'America/New_York' });
  assert.equal((await timers.list()).length, 0);
});
