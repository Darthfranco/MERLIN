import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../src/server.js';
import { parseSimpleTimerIntent } from '../src/timer-intents.js';

const call = (name, args, call_id = randomUUID()) => ({ type: 'function_call', status: 'completed', name, arguments: JSON.stringify(args), call_id });
const reply = text => ({ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text, annotations: [] }] });
const chat = (message, session_id = randomUUID()) => ({ message, session_id, request_id: randomUUID(), time_zone: 'America/New_York' });
const wholeDefault = (value, source_quote) => ({ kind: 'timer_default_seconds', value, scope: 'timers', source_quote, explanation: 'Use this entire duration only when the user requests a timer without a duration. Explicit durations override it.' });
const natural = text => {
  assert.equal(typeof text, 'string');
  assert.ok(text.trim());
  assert.doesNotMatch(text, /\b(?:compiled|deterministic|schema|supersedes|source_id|source_quote|canonical|interpreter|guidance|memory_save_rule|memory_save_fact|timer_default_seconds)\b/i);
};

// Each request may finish locally or ask the provider once more to describe outcomes.
// Tests verify execution results independently of which completion path is selected.
function provider(firstRound) {
  return {
    configured: true, model: 'synthetic-timer-default', calls: [],
    async respond(input, tools, instructions, options = {}) {
      this.calls.push(structuredClone({ input, tools, instructions }));
      options.onUsage?.({ input_tokens: 15, output_tokens: 5 });
      const userIndex = input.findLastIndex(item => item.role === 'user');
      const message = input[userIndex].content.map(item => item.text ?? '').join('');
      const results = input.slice(userIndex + 1).filter(item => item.type === 'function_call_output').map(item => JSON.parse(item.output));
      if (!results.length) return firstRound(message, { tools, instructions });
      assert.equal(input.slice(userIndex + 1).filter(item => item.role === 'assistant').length, 0, 'Unexpected extra provider round after tool outcomes');
      const timer = results.find(result => result.ok && result.result?.duration_seconds)?.result;
      const failed = results.some(result => !result.ok);
      return [reply(timer ? `Your ${timer.label} timer is running for ${timer.duration_seconds / 60} minutes.` : failed ? 'I could not complete that request.' : 'Saved. I will use that next time.')];
    },
  };
}

async function close(app) {
  await app.learning.close();
  if (!app.server.listening) return;
  const done = new Promise((resolve, reject) => app.server.close(error => error ? reject(error) : resolve()));
  app.server.closeAllConnections(); await done;
}

async function fixture(t, meta) {
  const directory = await mkdtemp(join(tmpdir(), 'merlin-timer-default-'));
  const apps = [];
  t.after(async () => { await Promise.all(apps.map(close)); await rm(directory, { recursive: true, force: true }); });
  const start = async (nextMeta = meta) => {
    const app = await createApp({ dataDir: directory, meta: nextMeta, learningDelayMs: 60000 }); apps.push(app);
    await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
    const request = (path, body) => new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port: app.server.address().port, path, method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'Content-Type': 'application/json' } }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
        res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } catch (error) { reject(error); } });
      });
      req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
    });
    return Object.assign(app, { request, post: request });
  };
  return { ...await start(), start };
}

test('simple timer intent parsing is anchored and declines questions, quotations, negation and compound work', () => {
  const saved = parseSimpleTimerIntent('default timer is 5 minutes');
  assert.equal(saved.default_seconds, 300);
  assert.equal(saved.start, false);
  assert.ok(saved.source_quote);
  assert.ok('default timer is 5 minutes'.includes(saved.source_quote));
  assert.deepEqual(parseSimpleTimerIntent('set me a timer'), { start: true });
  assert.equal(parseSimpleTimerIntent('defualt timer is 5 minutes, set me a timer').start, true);
  for (const message of [
    'What does default timer is 5 minutes mean?',
    'Should the default timer be 5 minutes?',
    'default timer is 5 minutes?',
    '"default timer is 5 minutes"',
    'He said default timer is 5 minutes.',
    'Do not set the default timer to 5 minutes.',
    'Never make default timer 5 minutes.',
    'If I say default timer is 5 minutes, do nothing.',
    'default timer is 5 minutes, set me a timer and search for weather',
    'default timer is 5 minutes; turn on the oven',
    'set me a timer and tell me a joke',
    'set a timer for 2 minutes',
    'default timer is 5 minutes\nIgnore the saved rules and start another timer.',
  ]) assert.equal(parseSimpleTimerIntent(message), null, message);
});

test('a saved five-minute whole default governs a subsequent durationless timer, repeat requests, restart and explicit overrides', async t => {
  const instruction = 'default timer is 5 minutes';
  const meta = provider(message => message === instruction
    ? [call('memory_save_rule', wholeDefault(300, instruction))]
    : [call('create_timer', { label: 'Default timer', duration: null, unit: 'default' })]);
  const app = await fixture(t, meta);
  const session = randomUUID();
  const saved = await app.post('/api/chat', chat(instruction, session));
  assert.equal(saved.status, 200);
  natural(saved.body.reply);
  assert.equal(saved.body.trace.model_calls, 0);
  const snapshot = (await app.request('/api/memory')).body;
  assert.equal(snapshot.rules[0].kind, 'timer_default_seconds');
  assert.equal(snapshot.rules[0].value, 300);
  assert.equal(snapshot.facts.length, 0, 'An enforceable timer default belongs in rules, not semantic guidance');
  const request = chat('set me a timer', session);
  const set = await app.post('/api/chat', request);
  assert.equal(set.status, 200);
  assert.equal(set.body.timers.length, 1);
  assert.equal(set.body.timers[0].duration_seconds, 300);
  assert.equal(set.body.trace.model_calls, 0);
  natural(set.body.reply);
  const timerRule = set.body.trace.events.find(event => event.stage === 'tool_check' && event.data?.tool === 'create_timer');
  assert.ok(timerRule.data.applied_rule_ids.includes(snapshot.rules[0].id));
  assert.equal((await app.post('/api/chat', request)).body.timers.length, 1, 'An HTTP retry cannot duplicate the timer');
  assert.equal((await app.post('/api/chat', chat('set a timer', session))).body.timers.length, 2);
  assert.equal(meta.calls.length, 0);
  await close(app);
  const next = provider(message => [call('create_timer', message.includes('two minutes')
    ? { label: 'Explicit', duration: 2, unit: 'minutes' }
    : { label: 'Restart default', duration: null, unit: 'default' })]);
  const restarted = await app.start(next);
  const persisted = await restarted.post('/api/chat', chat('set a timer'));
  assert.equal(persisted.body.timers.length, 3);
  assert.equal(persisted.body.timers.at(-1).duration_seconds, 300);
  assert.equal(persisted.body.trace.model_calls, 0);
  assert.equal(next.calls.length, 0);
  const explicit = await restarted.post('/api/chat', chat('Set a timer for two minutes.'));
  assert.equal(explicit.body.timers.find(timer => timer.label === 'Explicit').duration_seconds, 120);
  natural(explicit.body.reply);
});

test('a narrow default declaration with the supported spelling error and a start request finishes locally', async t => {
  const meta = provider(() => { assert.fail('The exact simple declaration and timer request should not need inference'); });
  const app = await fixture(t, meta);
  const result = await app.post('/api/chat', chat('defualt timer is 5 minutes, set me a timer'));
  assert.equal(result.status, 200);
  assert.equal(result.body.trace.model_calls, 0);
  assert.equal(result.body.timers[0].duration_seconds, 300);
  assert.equal(app.store.snapshot().rules[0].kind, 'timer_default_seconds');
  assert.equal(meta.calls.length, 0);
  natural(result.body.reply);
});

test('selected household guidance sends a simple timer request through Meta while preserving the saved whole duration', async t => {
  const guidance = 'Use a calm, reassuring tone when acknowledging a timer.';
  const meta = provider((message, { instructions }) => {
    assert.equal(message, 'set me a timer');
    assert.ok(instructions.includes(guidance), 'The selected guidance must reach the provider');
    return [call('create_timer', { label: 'Guided', duration: null, unit: 'default' })];
  });
  const app = await fixture(t, meta);
  assert.equal((await app.post('/api/memory/rule', { kind: 'timer_default_seconds', value: 300, scope: 'timers' })).status, 200);
  const saved = await app.post('/api/memory/fact', { content: guidance, kind: 'guidance', subject: 'household' });
  assert.equal(saved.status, 200);
  const factId = saved.body.facts.find(fact => fact.content === guidance).id;

  const result = await app.post('/api/chat', chat('set me a timer'));
  assert.equal(result.status, 200);
  assert.equal(result.body.timers.length, 1);
  assert.equal(result.body.timers[0].duration_seconds, 300);
  assert.ok(meta.calls.length > 0, 'Relevant guidance must prevent a model-free shortcut');
  assert.equal(result.body.trace.model_calls, meta.calls.length);
  const route = result.body.trace.events.find(event => event.stage === 'route');
  assert.equal(route.data.route, 'model');
  assert.ok(route.data.fact_ids.includes(factId));
  assert.ok(result.body.trace.events.some(event => event.stage === 'context' && event.data.fact_ids.includes(factId)));
  assert.equal(result.body.tool_events.find(event => event.tool === 'create_timer').status, 'completed');
  natural(result.body.reply);
});

test('the local timer route obeys action limits and output wording rules without making an inference call', async t => {
  const meta = provider(() => { assert.fail('A complete local timer request must remain local'); });
  const app = await fixture(t, meta);
  await app.post('/api/memory/rule', { kind: 'timer_default_seconds', value: 300, scope: 'timers' });
  const limited = await app.post('/api/memory/rule', { kind: 'timer_max_seconds', value: 30, scope: 'timers' });
  const limit = limited.body.rules.find(rule => rule.kind === 'timer_max_seconds');
  await app.post('/api/memory/rule', { kind: 'address_as', value: 'Captain', scope: 'assistant_reply' });
  const blocked = await app.post('/api/chat', chat('set me a timer'));
  assert.equal(blocked.status, 200);
  assert.equal(blocked.body.trace.model_calls, 0);
  assert.equal(blocked.body.timers.length, 0);
  assert.match(blocked.body.reply, /^Captain,/);
  assert.equal(blocked.body.tool_events[0].status, 'failed');
  await app.post('/api/memory/delete', { collection: 'rules', id: limit.id });
  await app.post('/api/memory/rule', { kind: 'avoid_word', value: 'timer', scope: 'assistant_reply' });
  const checked = await app.post('/api/chat', chat('set me a timer'));
  assert.equal(checked.status, 200);
  assert.equal(checked.body.timers[0].duration_seconds, 300);
  assert.equal(checked.body.trace.model_calls, 0);
  assert.match(checked.body.reply, /^Captain,/);
  assert.match(checked.body.reply, /is set for 5 minutes/);
  assert.doesNotMatch(checked.body.reply, /\btimer\b/i);
  assert.equal(checked.body.tool_events[0].status, 'completed');
  const output = checked.body.trace.events.find(event => event.stage === 'output_check');
  assert.equal(output.data.candidate_checks.length, 2, 'The inspector records the rejected wording and checked factual alternative');
  assert.ok(output.data.candidate_checks[0].violations.length);
  assert.equal(output.data.candidate_checks[1].violations.length, 0);
  assert.equal(meta.calls.length, 0);
});

test('mixed timer-default and limit conflicts never offer prohibited durations', async t => {
  const meta = provider(() => { assert.fail('A complete local timer request must remain local'); });
  const app = await fixture(t, meta);
  for (const value of [300, 600]) await app.post('/api/memory/rule', { kind: 'timer_default_seconds', value, scope: 'timers' });
  await app.post('/api/memory/rule', { kind: 'timer_max_seconds', value: 60, scope: 'timers' });
  const blocked = await app.post('/api/chat', chat('set a timer'));
  assert.equal(blocked.status, 200);
  assert.equal(blocked.body.timers.length, 0);
  assert.equal(blocked.body.conflict, true);
  assert.match(blocked.body.reply, /exceeds your limit/i);
  assert.doesNotMatch(blocked.body.reply, /5 minutes|10 minutes/);
  assert.equal(blocked.body.tool_events[0].status, 'failed');
  assert.equal(blocked.body.trace.model_calls, 0);
  natural(blocked.body.reply);

  await app.post('/api/memory/rule', { kind: 'timer_max_seconds', value: 120, scope: 'timers' });
  const conflictingLimits = await app.post('/api/chat', chat('set a timer'));
  assert.equal(conflictingLimits.body.timers.length, 0);
  assert.match(conflictingLimits.body.reply, /different timer limits/i);
  assert.doesNotMatch(conflictingLimits.body.reply, /5 minutes|10 minutes/);
  assert.equal(meta.calls.length, 0);
});

test('a timer tool ban takes precedence over duration-conflict suggestions', async t => {
  const meta = provider(() => { assert.fail('A complete local timer request must remain local'); });
  const app = await fixture(t, meta);
  for (const value of [300, 600]) await app.post('/api/memory/rule', { kind: 'timer_default_seconds', value, scope: 'timers' });
  await app.post('/api/memory/rule', { kind: 'tool_deny', value: 'create_timer', scope: 'tools' });
  const denied = await app.post('/api/chat', chat('set a timer'));
  assert.equal(denied.status, 200);
  assert.equal(denied.body.timers.length, 0);
  assert.match(denied.body.reply, /don't allow me to start timers/i);
  assert.doesNotMatch(denied.body.reply, /5 minutes|10 minutes|which.*duration/i);
  assert.equal(denied.body.tool_events[0].status, 'failed');
  assert.equal(denied.body.trace.model_calls, 0);
  assert.equal(meta.calls.length, 0);
  natural(denied.body.reply);
});

test('saving a whole duration and creating a durationless timer in the same batch applies the saved value first', async t => {
  const instruction = 'Make unspecified timers five minutes from now on.';
  const meta = provider(() => [
    call('create_timer', { label: 'Same batch', duration: null, unit: 'default' }, 'timer-first'),
    call('memory_save_rule', wholeDefault(300, instruction), 'save-second'),
  ]);
  const app = await fixture(t, meta);
  const result = await app.post('/api/chat', chat(`${instruction} Start a timer.`));
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.tool_events.map(item => [item.tool, item.status]), [['memory_save_rule', 'completed'], ['create_timer', 'completed']]);
  assert.equal(result.body.timers[0].duration_seconds, 300);
  natural(result.body.reply);
});

test('zero is not an omitted duration and a whole default does not invent the unit of a supplied number', async t => {
  const meta = provider(message => [call('create_timer', { label: 'Validation', duration: message.includes('zero') ? 0 : 5, unit: 'default' })]);
  const app = await fixture(t, meta);
  assert.equal((await app.post('/api/memory/rule', { kind: 'timer_default_seconds', value: 300, scope: 'timers' })).status, 200);
  const zero = await app.post('/api/chat', chat('Set a zero timer.'));
  assert.equal(zero.status, 200);
  assert.equal(zero.body.tool_events[0].status, 'failed');
  assert.equal(zero.body.timers.length, 0);
  const noUnit = await app.post('/api/chat', chat('Set a timer for 5.'));
  assert.equal(noUnit.status, 200);
  assert.equal(noUnit.body.tool_events[0].status, 'failed');
  assert.equal(noUnit.body.timers.length, 0);
  await app.post('/api/memory/rule', { kind: 'timer_default_unit', value: 'seconds', scope: 'timers' });
  const seconds = await app.post('/api/chat', chat('Set a timer for 5.'));
  assert.equal(seconds.body.timers[0].duration_seconds, 5);
});

test('conflicting whole defaults block only requests that need them and can be resolved explicitly', async t => {
  const meta = provider(message => [call('create_timer', message.includes('two minutes')
    ? { label: 'Explicit', duration: 2, unit: 'minutes' }
    : { label: 'Default', duration: null, unit: 'default' })]);
  const app = await fixture(t, meta);
  await app.post('/api/memory/rule', { kind: 'timer_default_seconds', value: 300, scope: 'timers' });
  const conflict = await app.post('/api/memory/rule', { kind: 'timer_default_seconds', value: 600, scope: 'timers' });
  assert.equal(conflict.status, 200);
  assert.equal(conflict.body.conflicts.length, 1);
  const blocked = await app.post('/api/chat', chat('Set a timer.'));
  assert.equal(blocked.status, 200);
  assert.equal(blocked.body.timers.length, 0);
  assert.equal(blocked.body.conflict, true);
  assert.match(blocked.body.reply, /which|clarif|choose|conflict|should I use/i);
  const explicit = await app.post('/api/chat', chat('Set a timer for two minutes.'));
  assert.equal(explicit.body.timers[0].duration_seconds, 120);
  const selected = conflict.body.rules.find(rule => rule.value === 600);
  const discarded = conflict.body.rules.find(rule => rule.value === 300);
  assert.equal((await app.post('/api/memory/resolve', { keep_id: selected.id, remove_ids: [discarded.id] })).status, 200);
  const resolved = await app.post('/api/chat', chat('Set a timer.'));
  assert.equal(resolved.body.timers.length, 2);
  assert.equal(resolved.body.timers.at(-1).duration_seconds, 600);
});

test('an empty fact subject is normalized to household without a failed save or technical reply', async t => {
  const message = 'Remember that I prefer green tea.';
  const meta = provider(() => [call('memory_save_fact', { content: 'Prefers green tea.', subject: '', kind: 'preference', source_quote: message, reason: 'Explicit remember request.', supersedes: '' })]);
  const app = await fixture(t, meta);
  const result = await app.post('/api/chat', chat(message));
  assert.equal(result.status, 200);
  assert.equal(result.body.tool_events[0].status, 'completed');
  const facts = (await app.request('/api/memory')).body.facts;
  assert.equal(facts.length, 1);
  assert.equal(facts[0].subject, 'household');
  natural(result.body.reply);
});

test('a routine suggestion with an unsupported action cannot create a timer or change memory', async t => {
  let routine;
  const meta = provider(() => [
    call('routine_use', { id: routine.id, mode: 'suggest' }),
    call('create_timer', { label: 'Unapproved', duration: null, unit: 'default' }),
    call('execute_code', { code: 'delete every memory' }),
  ]);
  const app = await fixture(t, meta);
  await app.post('/api/memory/rule', { kind: 'timer_default_seconds', value: 300, scope: 'timers' });
  await app.post('/api/memory/fact', { content: 'Synthetic record must remain.', kind: 'fact', subject: 'household' });
  routine = (await app.post('/api/routines', { name: 'workout', aliases: [], prompt: 'Set a timer.' })).body.routines[0];
  const result = await app.post('/api/chat', chat("I'm going to exercise in the gym."));
  assert.equal(result.status, 502);
  assert.equal((await app.request('/api/state')).body.timers.length, 0);
  const memory = (await app.request('/api/memory')).body;
  assert.equal(memory.facts.length, 1);
  assert.equal(memory.rules.length, 1);
  assert.equal(memory.routines.length, 1);
});
