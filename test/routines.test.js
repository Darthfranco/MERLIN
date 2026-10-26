import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoutinesStore, RoutineService, matchRoutineActivation, detectRoutineSuggestion, ROUTINE_TOOLS } from '../src/routines.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'merlin-routines-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = Date.parse('2026-10-26T15:00:00.000Z');
  const filePath = join(directory, 'routines.json');
  const clock = () => now;
  const store = await new RoutinesStore({ filePath, now: clock }).init();
  const save = (name, aliases = []) => store.save({ name, aliases, prompt: 'Start a 20 minute exercise timer.', source_id: 'manual', source_quote: '' });
  return { store, save, filePath, clock, advance: milliseconds => { now += milliseconds; } };
}

test('routines persist privately across restart with exact prompt text and versioned edits', async t => {
  const { store, save, filePath, clock } = await fixture(t);
  const saved = await save('workout', ['training']);
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  const reloaded = await new RoutinesStore({ filePath, now: clock }).init();
  assert.deepEqual(reloaded.list(), [saved]);
  const edited = await store.save({ id: saved.id, name: 'workout', aliases: ['training'], prompt: 'Start a 10 minute timer.', source_id: 'manual', source_quote: '' });
  assert.equal(edited.version, 2); assert.equal(edited.created_at, saved.created_at);
  assert.equal(store.list()[0].prompt, 'Start a 10 minute timer.');
});

test('activation matches complete explicit phrases and never routine substrings or information questions', () => {
  const workout = { name: 'workout', aliases: ['training'] };
  for (const message of ['workout', 'WORKOUT!', 'Merlin workout', "I'm going to workout", 'im going to workout', 'I am going to workout.', 'run workout', 'run workout routine', 'Merlin, start my training routine']) {
    assert.ok(matchRoutineActivation(workout, message), message);
  }
  for (const message of ['what to eat before I workout', 'What is a workout?', "I'm going to exercise in the gym", 'I should workout later', 'workout?', 'never workout', 'start workout tomorrow', 'start workout and search for music', 'workoutish']) {
    assert.equal(matchRoutineActivation(workout, message), null, message);
  }
  assert.equal(matchRoutineActivation({ name: 'goodnight' }, 'how get a goodnight of sleep'), null);
  assert.equal(matchRoutineActivation({ name: 'goodnight' }, 'Merlin goodnight'), 'goodnight');
});

test('a direct prose-only proposal can register one suggestion without authorizing execution', () => {
  const routines = [{ id: 'w', name: 'workout', aliases: ['gym time'], version: 1 }, { id: 'g', name: 'goodnight', aliases: [], version: 1 }];
  const message = "I'm going to exercise in the gym";
  for (const reply of [
    'Captain, that sounds like your workout routine — do you want to start it? I can help once you confirm.',
    'Would you like me to start your workout routine?',
    'Did you mean to run your “workout” routine?',
    'Shall I begin gym time?',
    'You have a workout routine. Should I start it?',
  ]) {
    const candidate = detectRoutineSuggestion(routines, { message, reply });
    assert.equal(candidate?.id, 'w', reply); assert.equal(candidate.prompt, undefined); assert.equal(candidate.started, undefined);
  }
  for (const reply of [
    'For example, would you like me to start your workout routine?',
    'Suppose I asked: would you like me to start your workout routine?',
    '"Would you like me to start your workout routine?"',
    "'Would you like me to start your workout routine?'",
    '> Would you like me to start your workout routine?',
    '`Would you like me to start your workout routine?`',
    'Would you like me to start workout or goodnight?',
    'Would you like me to start workout? Shall I begin goodnight?',
    'Would you like me to start the workoutish routine?',
    'Your workout routine is ready whenever you want.',
    'If you decide to ask later, would you like me to start workout?',
  ]) assert.equal(detectRoutineSuggestion(routines, { message, reply }), null, reply);
  assert.equal(detectRoutineSuggestion(routines, { message: 'what to eat before I workout', reply: 'Would you like me to start your workout routine?' }), null);
});

test('similar intent requires separate explicit next-turn confirmation within the same session', async t => {
  const { store, save } = await fixture(t); const routine = await save('workout');
  await store.beginRequest({ session_id: 's', request_id: 'r1', message: "I'm going to exercise in the gym" });
  const suggested = await store.activate({ session_id: 's', request_id: 'r1', routine_id: routine.id, message: "I'm going to exercise in the gym" });
  assert.equal(suggested.started, false); assert.equal(suggested.mode, 'suggest');
  assert.equal(suggested.routine.prompt, undefined);
  const sameTurn = await store.activate({ session_id: 's', request_id: 'r1', routine_id: routine.id, message: 'yes' });
  assert.equal(sameTurn.started, false);
  await store.beginRequest({ session_id: 'other', request_id: 'other-r', message: 'yes' });
  const other = await store.activate({ session_id: 'other', request_id: 'other-r', routine_id: routine.id, message: 'yes' });
  assert.equal(other.started, false);
  await store.beginRequest({ session_id: 's', request_id: 'r2', message: 'yes' });
  const confirmed = await store.activate({ session_id: 's', request_id: 'r2', routine_id: routine.id, message: 'yes' });
  assert.equal(confirmed.started, true); assert.equal(confirmed.confirmed, true); assert.equal(store.getPending('s'), null);
});

test('informational mentions cannot activate or suggest routines and expose no saved prompt', async t => {
  const { store, save } = await fixture(t);
  const workout = await save('workout'); const goodnight = await save('goodnight');
  const service = new RoutineService({ store, memoryStore: { snapshot: () => ({ conversations: [] }) } });
  for (const mode of ['start', 'suggest']) {
    for (const [routine, message] of [[workout, 'what to eat before I workout'], [goodnight, 'how get a goodnight of sleep']]) {
      const result = await service.execute('routine_use', { id: routine.id, mode }, { session_id: 's', request_id: `${mode}-${routine.name}`, message });
      assert.equal(result.started, false); assert.equal(result.mode, 'ignored');
      assert.equal(result.routine.prompt, undefined); assert.equal(store.getPending('s'), null);
    }
  }
});

test('an intervening unrelated request or expiry invalidates stale yes permission', async t => {
  const { store, save, advance } = await fixture(t); const routine = await save('workout');
  await store.suggest({ session_id: 's', request_id: 'r1', routine_id: routine.id });
  await store.beginRequest({ session_id: 's', request_id: 'r2', message: 'What is the weather?' });
  assert.equal(store.getPending('s'), null);
  await store.beginRequest({ session_id: 's', request_id: 'r3', message: 'yes' });
  assert.equal((await store.activate({ session_id: 's', request_id: 'r3', routine_id: routine.id, message: 'yes' })).started, false);
  advance(10 * 60 * 1000 + 1);
  await store.beginRequest({ session_id: 's', request_id: 'r4', message: 'yes please' });
  assert.equal((await store.activate({ session_id: 's', request_id: 'r4', routine_id: routine.id, message: 'yes please' })).started, false);
});

test('generic yes requires beginRequest confirmation tracking and never matches a routine itself', async t => {
  const { store, save } = await fixture(t); const routine = await save('workout');
  await store.suggest({ session_id: 's', request_id: 'r1', routine_id: routine.id });
  assert.equal((await store.activate({ session_id: 's', request_id: 'r2', routine_id: routine.id, message: 'yes' })).started, false);
  await assert.rejects(save('yes'), /generic confirmations/);
});

test('explicit aliases work, ambiguous expanded activation phrases are rejected', async t => {
  const { store, save } = await fixture(t); const routine = await save('workout', ['gym time']);
  assert.equal((await store.activate({ session_id: 's', request_id: 'r', routine_id: routine.id, message: 'gym time' })).started, true);
  await assert.rejects(save('Gym time'), /Another routine/);
  await assert.rejects(save('start workout'), /Another routine/);
  await assert.rejects(save('other', ['MERLIN WORKOUT']), /Another routine/);
});

test('one request cannot activate the same routine twice, including after restart', async t => {
  const { store, save, filePath, clock } = await fixture(t); const routine = await save('workout');
  const input = { session_id: 's', request_id: 'r', routine_id: routine.id, message: 'workout' };
  assert.equal((await store.activate(input)).started, true);
  assert.equal((await store.activate(input)).mode, 'already_started');
  const restarted = await new RoutinesStore({ filePath, now: clock }).init();
  assert.equal((await restarted.activate(input)).started, false);
  assert.equal((await restarted.activate({ ...input, request_id: 'new' })).started, true);
});

test('natural-language saves require exact user provenance and cannot invent actions or aliases', async t => {
  const { store } = await fixture(t);
  const source = { id: 'source', role: 'user', text: 'Save workout with alias training: Start a 20 minute timer.' };
  const input = { name: 'workout', aliases: ['training'], prompt: 'Start a 20 minute timer.', source_id: source.id, source_quote: source.text };
  const saved = await store.save(input, source, 'save-op');
  assert.equal(saved.prompt, input.prompt);
  assert.deepEqual(await store.save(input, source, 'save-op'), saved);
  await assert.rejects(store.save({ ...input, prompt: 'Turn on the oven.' }, source), /exact requested/);
  await assert.rejects(store.save({ ...input, aliases: ['sleep'] }, source), /explicitly present/);
  await assert.rejects(store.save(input, { ...source, role: 'assistant' }), /direct user/);
  await assert.rejects(store.save({ ...input, source_quote: 'invented' }, source), /exact requested/);
});

test('edits, removal, session clear and global clear invalidate pending suggestions', async t => {
  const { store, save } = await fixture(t); const routine = await save('workout');
  await store.suggest({ session_id: 's', request_id: 'r1', routine_id: routine.id });
  await store.save({ id: routine.id, name: 'workout', aliases: [], prompt: 'Start a 10 minute timer.', source_id: 'manual', source_quote: '' });
  assert.equal(store.getPending('s'), null);
  await store.suggest({ session_id: 's', request_id: 'r2', routine_id: routine.id });
  await store.clearSession('s'); assert.equal(store.getPending('s'), null); assert.equal(store.list().length, 1);
  await store.suggest({ session_id: 's', request_id: 'r3', routine_id: routine.id });
  await store.remove(routine.id); assert.equal(store.getPending('s'), null); assert.equal(store.list().length, 0);
  await save('goodnight'); await store.clear(); assert.deepEqual(store.list(), []);
});

test('routine service exports narrow tools, validates direct source and returns decision traces', async t => {
  const { store } = await fixture(t);
  const source = { id: 'source', role: 'user', text: 'Save workout: Start a 20 minute timer.' };
  const service = new RoutineService({ store, memoryStore: { snapshot: () => ({ conversations: [source] }) } });
  const context = { source_id: source.id, message: source.text, session_id: 's', request_id: 'r' };
  const saved = await service.execute('routine_save', { id: '', name: 'workout', aliases: [], prompt: 'Start a 20 minute timer.', source_quote: source.text }, context, 'r:save');
  assert.equal(saved.activated, false); assert.equal(saved.saved, true);
  const decision = await service.execute('routine_use', { id: saved.routine.id, mode: 'start' }, { ...context, message: 'workout', request_id: 'next' }, 'next:use');
  assert.equal(decision.started, true); assert.ok(decision.reason); assert.equal(decision.matched_alias, 'workout');
  assert.equal(service.context('s').routines[0].prompt, undefined);
  assert.equal(service.inspect('s').routines[0].prompt, saved.routine.prompt);
  assert.deepEqual(ROUTINE_TOOLS.map(tool => tool.name), ['routine_save', 'routine_read', 'routine_use', 'routine_delete']);
  await assert.rejects(service.execute('routine_delete', { id: saved.routine.id, source_quote: 'invented' }, context), /exact quotation/);
});

test('corrupt or tampered files are not overwritten', async t => {
  const { filePath } = await fixture(t);
  await writeFile(filePath, '{broken');
  await assert.rejects(new RoutinesStore({ filePath }).init(), /corrupted/);
  assert.equal(await readFile(filePath, 'utf8'), '{broken');
});

test('routine authoring can save an earlier direct user definition with current authorization and persistent provenance', async t => {
  const { store, filePath, clock } = await fixture(t);
  const earlier = { id: 'definition', session_id: 's', role: 'user', text: 'Call the routine tea break, with alias brew time. Start a one-minute tea timer.' };
  const current = { id: 'authorization', session_id: 's', role: 'user', text: 'Save what we said.' };
  const messages = [earlier, { id: 'reply', session_id: 's', role: 'assistant', text: 'I can save that when you ask.' }, current];
  const service = new RoutineService({ store, memoryStore: { snapshot: () => ({ conversations: messages }) } });
  const context = { source_id: current.id, session_id: 's', request_id: 'save-request', message: current.text };
  assert.deepEqual(service.authoringSources('s', current.id), [earlier, current].map(({ id, text }) => ({ id, text })));
  const input = { id: '', name: 'tea break', aliases: ['brew time'], prompt: 'Start a one-minute tea timer.', source_quote: current.text };
  const saved = await service.execute('routine_save', input, context, 'save-request:save');
  assert.equal(saved.activated, false);
  assert.equal(saved.routine.source_id, current.id);
  assert.equal(saved.routine.source_quote, current.text);
  assert.deepEqual(saved.routine.definition_sources, [{ source_id: earlier.id, source_quote: earlier.text }]);
  assert.deepEqual(await service.execute('routine_save', input, context, 'save-request:save'), saved);
  assert.deepEqual((await new RoutinesStore({ filePath, now: clock }).init()).list(), [saved.routine]);
});

test('multi-turn routine prompts preserve exact supported fragments and cannot synthesize new wording', async t => {
  const { store } = await fixture(t);
  const messages = [
    { id: 'name', session_id: 's', role: 'user', text: 'The name is study break and the alias is reset.' },
    { id: 'first', session_id: 's', role: 'user', text: 'Start a two-minute stretch timer.' },
    { id: 'second', session_id: 's', role: 'user', text: 'Search for the local weather.' },
    { id: 'save', session_id: 's', role: 'user', text: 'Save those two steps as my routine.' },
  ];
  const service = new RoutineService({ store, memoryStore: { snapshot: () => ({ conversations: messages }) } });
  const current = messages.at(-1);
  const context = { source_id: current.id, session_id: 's', request_id: 'r', message: current.text };
  const input = { id: '', name: 'study break', aliases: ['reset'], prompt: `${messages[1].text}\n${messages[2].text}`, source_quote: current.text };
  const saved = await service.execute('routine_save', input, context);
  assert.equal(saved.routine.prompt, input.prompt);
  assert.deepEqual(saved.routine.definition_sources.map(item => item.source_id), ['name', 'first', 'second']);
  await assert.rejects(service.execute('routine_save', { ...input, prompt: 'Start a two-minute stretch timer. Then search for the local weather.' }, context), /exact requested/);
  await assert.rejects(service.execute('routine_save', { ...input, prompt: `${input.prompt}\nTurn on the oven.` }, context), /exact requested/);
  await assert.rejects(service.execute('routine_save', { ...input, aliases: ['invented trigger'] }, context), /explicitly present/);
});

test('routine authoring rejects assistant, external, other-session, future and missing source evidence', async t => {
  const { store } = await fixture(t);
  const definition = 'Start a three-minute coffee timer.';
  const current = { id: 'authorization', session_id: 's', role: 'user', text: 'Save coffee break from what we discussed.' };
  const messages = [
    { id: 'other-user', session_id: 'other', role: 'user', text: definition },
    { id: 'assistant', session_id: 's', role: 'assistant', text: definition },
    { id: 'page', session_id: 's', role: 'tool', text: definition },
    current,
    { id: 'future-user', session_id: 's', role: 'user', text: definition },
  ];
  const service = new RoutineService({ store, memoryStore: { snapshot: () => ({ conversations: messages }) } });
  const context = { source_id: current.id, session_id: 's', request_id: 'r', message: current.text };
  const input = { id: '', name: 'coffee break', aliases: [], prompt: definition, source_quote: current.text };
  assert.deepEqual(service.authoringSources('s', current.id), [{ id: current.id, text: current.text }]);
  await assert.rejects(service.execute('routine_save', input, context), /exact requested/);
  await assert.rejects(service.execute('routine_save', { ...input, source_quote: definition }, context), /exact quotation/);
  await assert.rejects(service.execute('routine_save', { ...input, definition_sources: [{ source_id: 'other-user', source_quote: definition }] }, context), /unexpected fields/);
  await assert.rejects(service.execute('routine_save', input, { ...context, session_id: 'other' }), /exact quotation/);
  messages.splice(messages.indexOf(current), 1);
  await assert.rejects(service.execute('routine_save', input, context), /exact quotation/);
  assert.equal(store.list().length, 0);
});

test('authoring evidence is bounded to twenty recent direct messages and 24000 characters', async t => {
  const { store } = await fixture(t);
  const current = { id: 'current', session_id: 's', role: 'user', text: 'Save the old routine.' };
  const messages = Array.from({ length: 25 }, (_, index) => ({ id: `source-${index}`, session_id: 's', role: 'user', text: `Direct message ${index}.` }));
  messages.push(current);
  const service = new RoutineService({ store, memoryStore: { snapshot: () => ({ conversations: messages }) } });
  assert.equal(service.authoringSources('s', current.id).length, 20);
  assert.equal(service.authoringSources('s', current.id)[0].id, 'source-6');
  messages.splice(0, messages.length - 1, ...Array.from({ length: 10 }, (_, index) => ({ id: `large-${index}`, session_id: 's', role: 'user', text: `${index}${'x'.repeat(3999)}` })));
  const bounded = service.authoringSources('s', current.id);
  assert.ok(bounded.reduce((total, item) => total + item.text.length, 0) <= 24000);
  assert.deepEqual(bounded.map(item => item.id), ['large-5', 'large-6', 'large-7', 'large-8', 'large-9', 'current']);
  assert.ok(bounded.every(item => item.text === messages.find(source => source.id === item.id).text), 'Evidence is never silently truncated');
});

test('reading a saved routine returns its real definition without changing activation or pending state', async t => {
  const { store, save } = await fixture(t);
  const routine = await save('workout');
  await store.suggest({ session_id: 's', request_id: 'suggest', routine_id: routine.id });
  const pending = store.getPending('s');
  const service = new RoutineService({ store, memoryStore: { snapshot: () => ({ conversations: [] }) } });
  const result = await service.execute('routine_read', { id: routine.id }, { session_id: 's', message: 'What is my workout?' });
  assert.deepEqual(result, { routine, read: true, activated: false });
  assert.deepEqual(store.getPending('s'), pending);
  assert.equal(service.context('s').routines[0].prompt, undefined);
  await assert.rejects(service.execute('routine_read', { id: 'missing' }, {}), /not found/);
  await assert.rejects(service.execute('routine_read', { id: routine.id, mode: 'start' }, {}), /unexpected fields/);
});

test('tampered definition provenance is rejected on restart without overwriting its file', async t => {
  const { store, filePath } = await fixture(t);
  const source = { id: 'current', session_id: 's', role: 'user', text: 'Save tea break: Start a one-minute timer.' };
  const input = { name: 'tea break', aliases: [], prompt: 'Start a one-minute timer.', source_id: source.id, source_quote: source.text };
  await store.save(input, source, 'save', [source]);
  const stored = JSON.parse(await readFile(filePath, 'utf8'));
  stored.routines[0].definition_sources[0].source_quote = 'Unrelated evidence.';
  const changed = JSON.stringify(stored);
  await writeFile(filePath, changed);
  await assert.rejects(new RoutinesStore({ filePath }).init(), /corrupted/);
  assert.equal(await readFile(filePath, 'utf8'), changed);
});

test('model aliases repeating the primary name add no new trigger or failed save', async t => {
  const { store } = await fixture(t);
  const source = { id: 'current', session_id: 's', role: 'user', text: 'Save tea break with alias brew time: Start a one-minute timer.' };
  const service = new RoutineService({ store, memoryStore: { snapshot: () => ({ conversations: [source] }) } });
  const result = await service.execute('routine_save', { id: '', name: 'tea break', aliases: ['Tea break', 'brew time', 'BREW TIME'], prompt: 'Start a one-minute timer.', source_quote: source.text }, { source_id: source.id, session_id: 's', message: source.text }, 'save');
  assert.equal(result.saved, true);
  assert.deepEqual(result.routine.aliases.map(alias => alias.toLowerCase()), ['brew time']);
  assert.equal(store.list().length, 1);
});
