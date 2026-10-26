import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../src/server.js';

const call = (name, args, call_id = randomUUID()) => ({
  type: 'function_call', status: 'completed', name, arguments: JSON.stringify(args), call_id,
});
const reply = text => ({ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text, annotations: [] }] });
const chat = (message, session_id = randomUUID()) => ({ message, session_id, request_id: randomUUID(), time_zone: 'America/New_York' });
const save = (name, prompt, source_quote) => call('routine_save', { id: '', name, aliases: [], prompt, source_quote });
const timer = (duration = 20) => call('create_timer', { label: 'Synthetic tea', duration, unit: 'seconds' });
const outputs = input => input.filter(item => item.type === 'function_call_output').map(item => JSON.parse(item.output));

function scriptedMeta(steps) {
  return {
    configured: true, model: 'synthetic-routine-authoring', calls: [],
    async respond(input, tools, instructions, options = {}) {
      this.calls.push(structuredClone({ input, tools, instructions }));
      options.onUsage?.({ input_tokens: 20, output_tokens: 10 });
      assert.ok(steps.length, 'Unexpected model invocation in the scripted authoring test');
      const step = steps.shift();
      return typeof step === 'function' ? await step(input, { tools, instructions }) : structuredClone(step);
    },
  };
}

async function close(app) {
  await app.learning.close();
  if (!app.server.listening) return;
  const closed = new Promise((resolve, reject) => app.server.close(error => error ? reject(error) : resolve()));
  app.server.closeAllConnections();
  await closed;
}

async function fixture(t, meta) {
  const directory = await mkdtemp(join(tmpdir(), 'merlin-routine-authoring-'));
  const apps = [];
  t.after(async () => {
    await Promise.all(apps.map(close));
    await rm(directory, { recursive: true, force: true });
  });
  const start = async nextMeta => {
    const app = await createApp({ dataDir: directory, meta: nextMeta ?? meta, learningDelayMs: 60000 });
    apps.push(app);
    await new Promise((resolve, reject) => {
      app.server.once('error', reject);
      app.server.listen(0, '127.0.0.1', resolve);
    });
    const request = (path, body) => new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port: app.server.address().port, path,
        method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'Content-Type': 'application/json' } }, res => {
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

async function assertNoActions(app, response, meta) {
  assert.equal((await app.request('/api/state')).body.timers.length, 0, 'Routine authoring/lookup must not start a timer');
  assert.ok(!(response.body.tool_events ?? []).some(event =>
    ['create_timer', 'cancel_timer', 'prepare_web_search', 'web_search'].includes(event.tool) && event.status === 'completed'), 'No action/search preparation may complete');
  assert.ok(meta.calls.every(item => !item.tools.some(tool => tool.type === 'web_search')), 'Native search must remain unavailable');
}

for (const wording of ['should', 'shoudl']) {
  test(`a named routine definition using “${wording}” saves its exact body without running the timer or search`, async t => {
    const prompt = 'set a 45-second tea timer and search for the latest public astronomy news.';
    const message = `Bedtime ${wording} ${prompt}`;
    const meta = scriptedMeta([
      [save('Bedtime', prompt, message)],
      input => {
        assert.equal(outputs(input).at(-1).ok, true);
        return [reply('Your Bedtime routine is saved.')];
      },
    ]);
    const app = await fixture(t, meta);
    const response = await app.post('/api/chat', chat(message));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const snapshot = (await app.request('/api/memory')).body;
    assert.equal(snapshot.routines.length, 1);
    assert.equal(snapshot.routines[0].name, 'Bedtime');
    assert.equal(snapshot.routines[0].prompt, prompt);
    assert.equal(snapshot.routines[0].source_quote, message);
    assert.ok(response.body.tool_events.some(event => event.tool === 'routine_save' && event.status === 'completed'));
    await assertNoActions(app, response, meta);
  });
}

test('a follow-up save can use an exact previous same-session user prompt, and the saved definition survives restart', async t => {
  const session = randomUUID();
  const prompt = 'set a 20-second tea timer.';
  const earlier = `Here are the steps I wrote for Tea: ${prompt}`;
  const authorization = 'Set Tea as a routine then.';
  const meta = scriptedMeta([
    [reply('I can use those steps for Tea.')],
    [save('Tea', prompt, authorization)],
    [reply('Your Tea routine is saved.')],
  ]);
  const app = await fixture(t, meta);
  assert.equal((await app.post('/api/chat', chat(earlier, session))).status, 200);
  const response = await app.post('/api/chat', chat(authorization, session));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const snapshot = (await app.request('/api/memory')).body;
  assert.equal(snapshot.routines.length, 1);
  const routine = snapshot.routines[0];
  assert.equal(routine.prompt, prompt);
  assert.equal(routine.source_quote, authorization, 'Current save authorization must remain the primary quote');
  await assertNoActions(app, response, meta);

  await close(app);
  const restarted = await app.start(scriptedMeta([]));
  const restored = (await restarted.request('/api/memory')).body.routines;
  assert.equal(restored.length, 1);
  assert.equal(restored[0].id, routine.id);
  assert.equal(restored[0].prompt, prompt);
  assert.equal(restored[0].source_quote, authorization);
});

test('“what we already said” after an authoring clarification saves prior direct user steps rather than executing them', async t => {
  const session = randomUUID();
  const prompt = 'set a 25-second tea timer.';
  const definition = `Create a routine named Tea using these steps: ${prompt}`;
  const followup = 'What we already said.';
  const meta = scriptedMeta([
    [reply('What should the Tea routine do?')],
    [save('Tea', prompt, followup)],
    [reply('Your Tea routine is saved.')],
  ]);
  const app = await fixture(t, meta);
  assert.equal((await app.post('/api/chat', chat(definition, session))).status, 200);
  const response = await app.post('/api/chat', chat(followup, session));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const routine = (await app.request('/api/memory')).body.routines[0];
  assert.ok(routine, 'The connected clarification must complete authoring');
  assert.equal(routine.prompt, prompt);
  await assertNoActions(app, response, meta);
});

test('a quoted body supplied after a routine-name clarification is saved, not executed', async t => {
  const session = randomUUID();
  const prompt = 'set a 30-second tea timer and search for public space news.';
  const body = `“${prompt}”`;
  const meta = scriptedMeta([
    [reply('What should the Tea routine do?')],
    [save('Tea', prompt, body)],
    [reply('Your Tea routine is saved.')],
  ]);
  const app = await fixture(t, meta);
  assert.equal((await app.post('/api/chat', chat('Create a routine named Tea. I will give you its steps next.', session))).status, 200);
  const response = await app.post('/api/chat', chat(body, session));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const routines = (await app.request('/api/memory')).body.routines;
  assert.equal(routines.length, 1);
  assert.equal(routines[0].prompt, prompt);
  await assertNoActions(app, response, meta);
});

test('a successful save-only request does not release timer or search permissions in a later model round', async t => {
  const prompt = 'set a 20-second tea timer and search for public astronomy news.';
  const message = `Save Tea as a routine: ${prompt}`;
  const meta = scriptedMeta([
    [save('Tea', prompt, message)],
    input => {
      assert.equal(outputs(input).at(-1).ok, true);
      return [timer(), call('prepare_web_search', {})];
    },
    [reply('Your Tea routine is saved.')],
  ]);
  const app = await fixture(t, meta);
  const response = await app.post('/api/chat', chat(message));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal((await app.request('/api/memory')).body.routines[0]?.prompt, prompt);
  await assertNoActions(app, response, meta);
});

test('looking up an actually saved routine reads its full contents without performing its actions or searching the web', async t => {
  const prompt = 'set a 35-second tea timer and search for public astronomy news.';
  let routine;
  const meta = scriptedMeta([
    (_input, options) => {
      assert.ok(options.tools.some(tool => tool.name === 'routine_read'));
      return [call('routine_read', { id: routine.id })];
    },
    input => {
      const result = outputs(input).at(-1);
      assert.equal(result.ok, true);
      assert.equal(result.result.read, true);
      assert.equal(result.result.activated, false);
      assert.equal(result.result.routine.prompt, prompt);
      return [timer(35), call('prepare_web_search', {})];
    },
    input => {
      assert.ok(outputs(input).slice(-2).every(result => result.ok === false), 'Reading saved steps must not authorize executing them');
      return [reply(`Your Tea routine is: ${prompt}`)];
    },
  ]);
  const app = await fixture(t, meta);
  const created = await app.post('/api/routines', { name: 'Tea', aliases: [], prompt });
  assert.equal(created.status, 200);
  routine = created.body.routines[0];
  const response = await app.post('/api/chat', chat('Show me my saved Tea routine.'));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.match(response.body.reply, /35-second tea timer/);
  assert.ok(response.body.tool_events.some(event => event.tool === 'routine_read' && event.status === 'completed'));
  assert.equal((await app.request('/api/memory')).body.routines[0].id, routine.id);
  await assertNoActions(app, response, meta);
});

test('explicit save-and-run allows a timer only after the exact routine has been persisted', async t => {
  const prompt = 'set a 20-second tea timer.';
  const message = `Save Tea as a routine: ${prompt} Also run it now.`;
  let app;
  let verifiedPersistence = false;
  const meta = scriptedMeta([
    [save('Tea', prompt, message)],
    async input => {
      assert.equal(outputs(input).at(-1).ok, true);
      const disk = JSON.parse(await readFile(join(app.directory, 'routines.json'), 'utf8'));
      assert.equal(disk.routines.length, 1);
      assert.equal(disk.routines[0].prompt, prompt);
      verifiedPersistence = true;
      assert.equal((await app.request('/api/state')).body.timers.length, 0);
      return [timer()];
    },
    [reply('Your Tea routine is saved and its timer is running.')],
  ]);
  app = await fixture(t, meta);
  const response = await app.post('/api/chat', chat(message));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(verifiedPersistence, true);
  assert.equal(response.body.timers.length, 1);
  assert.equal(response.body.timers[0].duration_seconds, 20);
  const events = response.body.tool_events.filter(event => event.status === 'completed');
  assert.ok(events.findIndex(event => event.tool === 'routine_save') < events.findIndex(event => event.tool === 'create_timer'));
});

test('save-and-run defers actions emitted before the save in the same model response', async t => {
  const prompt = 'set a 20-second tea timer.';
  const message = `Save Tea as a routine: ${prompt} Also run it now.`;
  let app;
  const meta = scriptedMeta([
    [timer(999), save('Tea', prompt, message)],
    async input => {
      const results = outputs(input);
      assert.ok(results.some(result => result.ok && result.result?.saved));
      assert.ok(results.some(result => result.ok === false), 'An action planned before saving must be deferred');
      assert.equal((await app.request('/api/state')).body.timers.length, 0);
      const disk = JSON.parse(await readFile(join(app.directory, 'routines.json'), 'utf8'));
      assert.equal(disk.routines[0]?.prompt, prompt);
      return [timer()];
    },
    [reply('Your Tea routine is saved and its timer is running.')],
  ]);
  app = await fixture(t, meta);
  const response = await app.post('/api/chat', chat(message));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.timers.length, 1);
  assert.equal(response.body.timers[0].duration_seconds, 20, 'Only the action planned from the persisted prompt may run');
});

for (const invalidPrompt of ['set a 999-second tea timer.', { action: 'set a 20-second tea timer.' }]) {
  test(`a ${typeof invalidPrompt === 'string' ? 'fabricated' : 'malformed'} saved body cannot authorize timer or search actions in the same batch`, async t => {
    const message = 'Save Tea as a routine: set a 20-second tea timer. Also run it now.';
    const meta = scriptedMeta([
      [timer(999), call('prepare_web_search', {}), save('Tea', invalidPrompt, message)],
      [reply('The routine was not saved or started. Please confirm its steps.')],
    ]);
    const app = await fixture(t, meta);
    const response = await app.post('/api/chat', chat(message));
    assert.ok([200, 400, 502].includes(response.status), JSON.stringify(response.body));
    assert.equal((await app.request('/api/memory')).body.routines.length, 0);
    await assertNoActions(app, response, meta);
  });
}

test('a failed routine save cannot release action permissions in a later model round', async t => {
  const message = 'Save Tea as a routine: set a 20-second tea timer. Also run it now.';
  const meta = scriptedMeta([
    [save('Tea', 'set a 999-second tea timer.', message)],
    [timer(999), call('prepare_web_search', {})],
    [reply('The routine was not saved or started.')],
  ]);
  const app = await fixture(t, meta);
  const response = await app.post('/api/chat', chat(message));
  assert.ok([200, 400, 502].includes(response.status), JSON.stringify(response.body));
  assert.equal((await app.request('/api/memory')).body.routines.length, 0);
  await assertNoActions(app, response, meta);
});

test('a definition cannot borrow a routine prompt from another conversation', async t => {
  const original = 'For Tea, the steps I wrote are: set a 20-second tea timer.';
  const authorization = 'Set Tea as a routine then.';
  const meta = scriptedMeta([
    [reply('Those are the Tea steps you described.')],
    [save('Tea', 'set a 20-second tea timer.', authorization)],
    [reply('Please give me the Tea steps in this conversation.')],
  ]);
  const app = await fixture(t, meta);
  assert.equal((await app.post('/api/chat', chat(original))).status, 200);
  const response = await app.post('/api/chat', chat(authorization));
  assert.ok([200, 400, 502].includes(response.status), JSON.stringify(response.body));
  assert.equal((await app.request('/api/memory')).body.routines.length, 0);
  await assertNoActions(app, response, meta);
});

for (const [kind, message] of [
  ['question', 'Is “Tea should set a 20-second tea timer.” an example of a routine definition?'],
  ['quoted example', 'For example, someone might say “Tea should set a 20-second tea timer.” Explain what that means.'],
  ['standalone quotation', '“Tea should set a 20-second tea timer.”'],
]) {
  test(`an informational example grants no save or execution permission: ${kind}`, async t => {
    const meta = scriptedMeta([
      [save('Tea', 'set a 20-second tea timer.', message), timer()],
      [reply('That is an example description, not a request to save or start it.')],
    ]);
    const app = await fixture(t, meta);
    const response = await app.post('/api/chat', chat(message));
    assert.ok([200, 400, 502].includes(response.status), JSON.stringify(response.body));
    assert.equal((await app.request('/api/memory')).body.routines.length, 0);
    await assertNoActions(app, response, meta);
  });
}

test('an unrelated yes cannot authorize saving a stale earlier routine definition', async t => {
  const session = randomUUID();
  const prompt = 'set a 20-second tea timer.';
  const meta = scriptedMeta([
    [reply('Should I save those steps as a routine?')],
    [reply('Hello.')],
    [save('Tea', prompt, 'yes'), timer()],
    [reply('No routine was saved or started.')],
  ]);
  const app = await fixture(t, meta);
  assert.equal((await app.post('/api/chat', chat(`Tea should ${prompt}`, session))).status, 200);
  assert.equal((await app.post('/api/chat', chat('Hello.', session))).status, 200);
  const response = await app.post('/api/chat', chat('yes', session));
  assert.equal(response.status, 200);
  assert.equal((await app.request('/api/memory')).body.routines.length, 0);
  assert.equal(response.body.tool_events.find(event => event.tool === 'routine_save').status, 'failed');
  await assertNoActions(app, response, meta);
});

test('yes immediately confirming unfinished routine setup still saves the evidenced steps', async t => {
  const session = randomUUID();
  const prompt = 'set a 20-second tea timer.';
  const meta = scriptedMeta([
    [reply('Should I save those steps as a routine?')],
    [save('Tea', prompt, 'yes')],
    [reply('Your Tea routine is saved.')],
  ]);
  const app = await fixture(t, meta);
  assert.equal((await app.post('/api/chat', chat(`Tea should ${prompt}`, session))).status, 200);
  const response = await app.post('/api/chat', chat('yes', session));
  assert.equal(response.status, 200);
  assert.equal((await app.request('/api/memory')).body.routines[0].prompt, prompt);
  assert.equal(response.body.tool_events.find(event => event.tool === 'routine_save').status, 'completed');
  await assertNoActions(app, response, meta);
});

for (const followup of ['"set a 40-second tea timer."', 'yes', 'save it', 'use that']) {
  test(`a completed routine save cannot be reopened by ${followup}`, async t => {
    const session = randomUUID();
    const prompt = 'set a 20-second tea timer.';
    const definition = `Tea should ${prompt}`;
    let original;
    const meta = scriptedMeta([
      [save('Tea', prompt, definition)],
      // A redundant model confirmation cannot override the persisted save receipt.
      [reply('Should I save those steps as a routine?')],
      () => [call('routine_save', { id: original.id, name: 'Tea', aliases: [], prompt: followup.startsWith('"') ? 'set a 40-second tea timer.' : prompt, source_quote: followup }), timer()],
      [reply('The saved routine is unchanged.')],
    ]);
    const app = await fixture(t, meta);
    assert.equal((await app.post('/api/chat', chat(definition, session))).status, 200);
    original = (await app.request('/api/memory')).body.routines[0];
    const response = await app.post('/api/chat', chat(followup, session));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual((await app.request('/api/memory')).body.routines, [original]);
    assert.equal(response.body.tool_events.find(event => event.tool === 'routine_save').status, 'failed');
    await assertNoActions(app, response, meta);
  });
}
