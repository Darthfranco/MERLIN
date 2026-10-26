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
const latestResult = input => JSON.parse(input.findLast(item => item.type === 'function_call_output').output);

function scripted(steps) {
  return {
    configured: true, model: 'synthetic-routine-integration', calls: [],
    async respond(input, tools, instructions, options = {}) {
      this.calls.push(structuredClone({ input, tools, instructions }));
      options.onUsage?.({ input_tokens: 12, output_tokens: 4 });
      assert.ok(steps.length, 'Unexpected model invocation');
      const next = steps.shift();
      return typeof next === 'function' ? await next(input, { tools, instructions }) : structuredClone(next);
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
  const directory = await mkdtemp(join(tmpdir(), 'merlin-routine-integration-'));
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
  return { ...await start(), directory, start };
}

test('exact workout, intent wrapper and Merlin goodnight expand before inference and persist across restart', async t => {
  const workoutPrompt = 'Start a 40-second recovery timer.';
  const goodnightPrompt = 'Start a 20-second bedtime timer.';
  const steps = [];
  for (const [prompt, label, duration] of [[workoutPrompt, 'Recovery', 40], [workoutPrompt, 'Recovery again', 40], [goodnightPrompt, 'Bedtime', 20]]) {
    steps.push((input, { tools }) => {
      assert.match(input.at(-1).content[0].text, /activated my saved routine/);
      assert.ok(input.at(-1).content[0].text.includes(prompt));
      assert.equal(tools.some(tool => tool.name === 'routine_use'), false);
      return [call('create_timer', { label, duration, unit: 'seconds' })];
    }, [reply('Your timer is running.')]);
  }
  const meta = scripted(steps); const app = await fixture(t, meta);
  assert.equal((await app.post('/api/routines', { name: 'workout', aliases: ['training time'], prompt: workoutPrompt })).status, 200);
  assert.equal((await app.post('/api/routines', { name: 'goodnight', aliases: [], prompt: goodnightPrompt })).status, 200);
  let firstRequest;
  for (const command of ['workout', "I'm going to workout", 'Merlin goodnight']) {
    const body = chat(command); firstRequest ??= body;
    const result = await app.post('/api/chat', body);
    assert.equal(result.status, 200);
    assert.equal(result.body.tool_events[0].tool, 'routine_use');
    assert.equal(result.body.tool_events[0].status, 'completed');
    assert.equal(result.body.trace.model_calls, 2, 'Exact expansion must not add a model gate round');
    assert.ok(result.body.trace.events.findIndex(event => event.stage === 'routine') < result.body.trace.events.findIndex(event => event.stage === 'model'));
  }
  assert.equal(meta.calls.length, 6);
  assert.equal((await app.request('/api/state')).body.timers.length, 3);
  await close(app);
  const restartMeta = scripted([input => {
    assert.ok(input.at(-1).content[0].text.includes(workoutPrompt));
    return [call('create_timer', { label: 'Restarted', duration: 40, unit: 'seconds' })];
  }, [reply('Your restarted routine timer is running.')]]);
  const restarted = await app.start(restartMeta);
  assert.equal((await restarted.request('/api/memory')).body.routines.length, 2);
  assert.equal((await restarted.post('/api/chat', firstRequest)).status, 409);
  assert.equal(restartMeta.calls.length, 0);
  const result = await restarted.post('/api/chat', chat('training time'));
  assert.equal(result.status, 200);
  assert.equal(result.body.timers.length, 4);
});

test('informational workout and sleep questions cannot activate routines even if the model proposes routine actions', async t => {
  let workout; let goodnight;
  const questions = ['What should I eat before I workout?', 'How do I get a goodnight of sleep?', 'Tell me about workout'];
  const steps = [];
  for (const question of questions) {
    steps.push(input => {
      assert.equal(input.at(-1).content[0].text, question);
      return [call('create_timer', { label: 'Unwanted', duration: 60, unit: 'seconds' }), call('routine_use', { id: question.includes('goodnight') ? goodnight.id : workout.id, mode: 'start' })];
    }, input => {
      const results = input.filter(item => item.type === 'function_call_output').map(item => JSON.parse(item.output));
      assert.equal(results[0].result.mode, 'ignored');
      assert.equal(results[1].ok, false);
      return [reply('Here is information without starting a routine.')];
    });
  }
  const app = await fixture(t, scripted(steps));
  workout = (await app.post('/api/routines', { name: 'workout', aliases: [], prompt: 'Start a 60-second workout timer.' })).body.routines[0];
  goodnight = (await app.post('/api/routines', { name: 'goodnight', aliases: [], prompt: 'Start a 60-second bedtime timer.' })).body.routines.find(item => item.name === 'goodnight');
  for (const question of questions) {
    const body = chat(question); const result = await app.post('/api/chat', body);
    assert.equal(result.status, 200);
    assert.equal(result.body.timers.length, 0);
    assert.equal((await app.request(`/api/memory?session_id=${body.session_id}`)).body.pending_routine, null);
  }
});

test('a near match skips same-batch actions and requires the next explicit yes in the same session', async t => {
  let routine;
  const prompt = 'Start a 45-second exercise timer.';
  const meta = scripted([
    () => [call('create_timer', { label: 'Premature', duration: 1, unit: 'seconds' }), call('routine_use', { id: routine.id, mode: 'suggest' })],
    [reply('There is no pending routine in this conversation.')],
    input => { assert.ok(input.at(-1).content[0].text.includes(prompt)); return [call('create_timer', { label: 'Confirmed', duration: 45, unit: 'seconds' })]; },
    [reply('Your exercise timer is running.')],
  ]);
  const app = await fixture(t, meta);
  routine = (await app.post('/api/routines', { name: 'workout', aliases: [], prompt })).body.routines[0];
  const near = chat("I'm going to exercise in the gym.");
  const proposed = await app.post('/api/chat', near);
  assert.equal(proposed.status, 200);
  assert.equal(proposed.body.routine_confirmation, true);
  assert.match(proposed.body.reply, /did you mean/i);
  assert.equal(proposed.body.timers.length, 0);
  assert.equal(meta.calls.length, 1);
  assert.ok((await app.request(`/api/memory?session_id=${near.session_id}`)).body.pending_routine);
  assert.equal((await app.post('/api/chat', chat('yes'))).body.timers.length, 0);
  assert.ok((await app.request(`/api/memory?session_id=${near.session_id}`)).body.pending_routine);
  const confirmed = await app.post('/api/chat', chat('yes please', near.session_id));
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.timers.length, 1);
  assert.equal(confirmed.body.timers[0].duration_seconds, 45);
  assert.equal((await app.request(`/api/memory?session_id=${near.session_id}`)).body.pending_routine, null);
});

test('an unrelated intervening message invalidates a proposed routine before a later yes', async t => {
  let routine;
  const meta = scripted([() => [call('routine_use', { id: routine.id, mode: 'suggest' })], [reply('Hello.')], [reply('There is no pending routine to confirm.')]]);
  const app = await fixture(t, meta);
  routine = (await app.post('/api/routines', { name: 'workout', prompt: 'Start a one-minute exercise timer.', aliases: [] })).body.routines[0];
  const session = randomUUID();
  assert.equal((await app.post('/api/chat', chat('Time to exercise.', session))).body.routine_confirmation, true);
  assert.equal((await app.post('/api/chat', chat('Hello.', session))).status, 200);
  assert.equal((await app.request(`/api/memory?session_id=${session}`)).body.pending_routine, null);
  assert.equal((await app.post('/api/chat', chat('yes', session))).body.timers.length, 0);
  assert.equal(meta.calls.length, 3);
});

test('routine expansion preserves current timer restrictions and checked response wording', async t => {
  const meta = scripted([
    [call('create_timer', { label: 'Too long', duration: 60, unit: 'seconds' })],
    input => { assert.equal(latestResult(input).ok, false); return [reply('The timer was blocked by your limit.')]; },
  ]);
  const app = await fixture(t, meta);
  await app.post('/api/routines', { name: 'tea break', aliases: [], prompt: 'Start a 60-second tea timer.' });
  await app.post('/api/memory/rule', { kind: 'timer_max_seconds', value: 30, scope: 'timers' });
  await app.post('/api/memory/rule', { kind: 'address_as', value: 'Captain', scope: 'assistant_reply' });
  const result = await app.post('/api/chat', chat('tea break'));
  assert.equal(result.status, 200);
  assert.equal(result.body.timers.length, 0);
  assert.match(result.body.reply, /^Captain,/);
  assert.equal(result.body.tool_events.find(event => event.tool === 'create_timer').status, 'failed');
});

test('natural routine save copies exact user request text and rejects invented prompt additions', async t => {
  const prompt = 'Start a three-minute tea timer.';
  const message = `Save a routine named tea break with alias brew time: ${prompt}`;
  const altered = 'Save a routine named coffee break: Start a one-minute coffee timer.';
  const meta = scripted([
    [call('routine_save', { id: '', name: 'tea break', aliases: ['brew time'], prompt, source_quote: message })],
    input => { assert.equal(latestResult(input).result.activated, false); return [reply('Saved the tea routine.')]; },
    [call('routine_save', { id: '', name: 'coffee break', aliases: [], prompt: 'Start a one-minute coffee timer and search the web.', source_quote: altered })],
    input => { assert.equal(latestResult(input).ok, false); return [reply('The saved request must match your exact instructions.')]; },
  ]);
  const app = await fixture(t, meta);
  const saved = await app.post('/api/chat', chat(message));
  assert.equal(saved.status, 200);
  assert.equal(saved.body.timers.length, 0);
  const original = app.routineStore.list()[0];
  assert.equal(original.prompt, prompt);
  assert.deepEqual(original.aliases, ['brew time']);
  assert.equal(original.source_quote, message);
  assert.ok(app.store.snapshot().conversations.some(item => item.id === original.source_id));
  const rejected = await app.post('/api/chat', chat(altered));
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.tool_events[0].status, 'failed');
  assert.equal(app.routineStore.list().length, 1);
});

test('routine edits and deletes invalidate dependent history, cached responses and deferred learning; clear all deletes saved routines', async t => {
  const oldPrompt = 'Reply with synthetic amber lantern.';
  const newPrompt = 'Reply with synthetic blue lantern.';
  const meta = scripted([[reply('synthetic amber lantern')], [reply('synthetic blue lantern')]]);
  meta.extractMemories = async () => ({ facts: [] });
  const app = await fixture(t, meta);
  const created = await app.post('/api/routines', { name: 'lantern', aliases: [], prompt: oldPrompt });
  const routine = created.body.routines[0];
  const originalRequest = chat('lantern');
  assert.equal((await app.post('/api/chat', originalRequest)).status, 200);
  assert.equal(app.learning.status().pending, 1);
  assert.ok(app.store.snapshot().conversations.some(item => item.memory_ids?.includes(routine.id)));
  const edited = await app.post('/api/routines', { id: routine.id, name: 'lantern', aliases: [], prompt: newPrompt });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.routines[0].version, 2);
  assert.equal(app.learning.status().pending, 0);
  assert.equal(app.store.snapshot().conversations.length, 0);
  assert.equal((await app.post('/api/chat', originalRequest)).status, 409);
  assert.equal(JSON.stringify((await app.request(`/api/trace?request_id=${originalRequest.request_id}`)).body).includes('amber lantern'), false);
  const changedRequest = chat('lantern');
  assert.equal((await app.post('/api/chat', changedRequest)).body.reply, 'synthetic blue lantern');
  const deleted = await app.post('/api/routines/delete', { id: routine.id });
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.body.routines, []);
  assert.equal(app.learning.status().pending, 0);
  assert.equal(app.store.snapshot().conversations.length, 0);
  assert.equal((await app.post('/api/chat', changedRequest)).status, 409);
  assert.equal((await readFile(join(app.directory, 'memory.json'), 'utf8')).includes('lantern'), false);
  await app.post('/api/routines', { name: 'another', aliases: [], prompt: 'Say hello.' });
  assert.equal((await app.post('/api/memory/clear', {})).status, 200);
  assert.deepEqual(app.routineStore.list(), []);
  assert.deepEqual(JSON.parse(await readFile(join(app.directory, 'routines.json'), 'utf8')).routines, []);
});

test('a natural forget command containing the deleted personal detail is itself removed from retained history and background learning', async t => {
  const secret = 'synthetic chartreuse marmalade';
  const evidence = `Remember that I prefer ${secret}.`;
  const deletion = `Forget that I prefer ${secret}.`;
  let id;
  const meta = scripted([
    [call('memory_save_fact', { content: `Prefers ${secret}.`, subject: 'household', kind: 'preference', source_quote: evidence, reason: 'Explicit request', supersedes: '' })],
    [reply(`Saved your preference for ${secret}.`)],
    () => [call('memory_forget', { collection: 'facts', id, source_quote: deletion })],
  ]);
  meta.extractMemories = async messages => ({ facts: messages.filter(message => message.text.includes(secret)).map(message => ({ source_id: message.id, source_quote: message.text, content: `Prefers ${secret}.`, subject: 'household', kind: 'preference', reason: 'A deliberately faulty extractor must never receive forgotten deletion text.' })) });
  const app = await fixture(t, meta);
  const saved = chat(evidence); assert.equal((await app.post('/api/chat', saved)).status, 200);
  id = app.store.snapshot().facts[0].id;
  const forgotten = await app.post('/api/chat', chat(deletion, saved.session_id));
  assert.equal(forgotten.status, 200);
  assert.equal(app.store.snapshot().facts.length, 0);
  assert.equal(JSON.stringify(app.store.snapshot()).includes(secret), false);
  await app.learning.drain();
  assert.equal(app.store.snapshot().facts.length, 0);
  assert.equal((await readFile(join(app.directory, 'memory.json'), 'utf8')).includes(secret), false);
  assert.equal((await app.post('/api/chat', saved)).status, 409);
});

test('a checked prose-only routine proposal records pending confirmation in the same model round and next yes activates it', async t => {
  const prompt = 'Start a 35-second exercise timer.';
  const meta = scripted([
    [reply('Would you like me to start your workout routine?')],
    input => {
      assert.ok(input.at(-1).content[0].text.includes(prompt));
      return [call('create_timer', { label: 'Confirmed workout', duration: 35, unit: 'seconds' })];
    },
    [reply('Your exercise timer is running.')],
  ]);
  const app = await fixture(t, meta);
  const saved = await app.post('/api/routines', { name: 'workout', aliases: [], prompt });
  const near = chat("I'm going to exercise in the gym.");
  const proposed = await app.post('/api/chat', near);
  assert.equal(proposed.status, 200);
  assert.equal(proposed.body.reply, 'Would you like me to start your workout routine?');
  assert.equal(proposed.body.routine_confirmation, true);
  assert.equal(proposed.body.trace.model_calls, 1);
  assert.equal(meta.calls.length, 1);
  assert.equal(proposed.body.timers.length, 0);
  assert.equal(proposed.body.tool_events.length, 0, 'A prose fallback records consent state without claiming a model tool invocation');
  const stages = proposed.body.trace.events.map(event => event.stage);
  assert.ok(stages.indexOf('output_check') < stages.indexOf('routine'));
  const pending = (await app.request(`/api/memory?session_id=${near.session_id}`)).body.pending_routine;
  assert.equal(pending.routine_id, saved.body.routines[0].id);
  const confirmed = await app.post('/api/chat', chat('yes', near.session_id));
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.timers[0].duration_seconds, 35);
  assert.equal(confirmed.body.trace.model_calls, 2);
  assert.equal((await app.request(`/api/memory?session_id=${near.session_id}`)).body.pending_routine, null);
});

test('a prohibited undelivered routine question cannot register pending activation after wording fallback', async t => {
  const meta = scripted([
    [reply('Would you like me to start your workout routine?')],
    (_input, { tools }) => { assert.deepEqual(tools, []); return [reply('Should I start your workout routine?')]; },
    [reply('There is no pending activation.')],
  ]);
  const app = await fixture(t, meta);
  await app.post('/api/routines', { name: 'workout', aliases: [], prompt: 'Start a 35-second exercise timer.' });
  await app.post('/api/memory/rule', { kind: 'avoid_word', value: 'workout', scope: 'assistant_reply' });
  const near = chat("I'm going to exercise in the gym.");
  const rejected = await app.post('/api/chat', near);
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.trace.model_calls, 2);
  assert.doesNotMatch(rejected.body.reply, /\bworkout\b/i);
  assert.notEqual(rejected.body.routine_confirmation, true);
  assert.equal((await app.request(`/api/memory?session_id=${near.session_id}`)).body.pending_routine, null);
  const confirmation = await app.post('/api/chat', chat('yes', near.session_id));
  assert.equal(confirmation.status, 200);
  assert.equal(confirmation.body.timers.length, 0);
  assert.equal(confirmation.body.tool_events.some(event => event.tool === 'routine_use'), false);
});

test('a 12000-character manual routine activates without exceeding the memory-search query limit', async t => {
  const prefix = 'Say that the saved request was loaded. ';
  const prompt = `${prefix}${'x'.repeat(12000 - prefix.length)}`;
  const meta = scripted([input => {
    assert.ok(input.at(-1).content[0].text.endsWith(prompt));
    return [reply('The saved request was loaded.')];
  }]);
  const app = await fixture(t, meta);
  const saved = await app.post('/api/routines', { name: 'long plan', aliases: [], prompt });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.routines[0].prompt.length, 12000);
  const activated = await app.post('/api/chat', chat('long plan'));
  assert.equal(activated.status, 200);
  assert.equal(activated.body.reply, 'The saved request was loaded.');
  assert.equal(activated.body.trace.model_calls, 1);
  assert.equal(activated.body.tool_events[0].tool, 'routine_use');
  assert.equal(activated.body.tool_events[0].status, 'completed');
});
