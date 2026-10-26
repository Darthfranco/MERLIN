import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MemoryStore } from '../src/memory-store.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'merlin-memory-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, 'private', 'memory.json');
  const store = await new MemoryStore({ filePath }).init();
  return { directory, filePath, store };
}

const message = (text = 'I prefer oat milk.', request_id = 'request-1', session_id = 'session-1') => ({
  session_id, request_id, role: 'user', text,
});
const fact = source => ({ content: 'Prefers oat milk.', kind: 'preference', source_id: source.id, source_quote: source.text });
const rule = (value = 'seconds', source_id = 'manual', source_quote = '') => ({
  kind: 'timer_default_unit', value, scope: 'timers', source_id, source_quote,
  original: `Timers default to ${value}.`, explanation: `Unspecified timer durations use ${value}.`,
});

test('memory persists exact conversations, sourced preferences, rules and document versions privately', async (t) => {
  const { store, filePath } = await fixture(t);
  const user = await store.recordMessage(message());
  await store.recordMessage({ ...message(), role: 'assistant', text: 'Understood.', turn: [{ role: 'user', content: user.text }] });
  const preference = await store.putFact(fact(user), 'extract-1');
  const standingRule = await store.putRule(rule(), 'rule-1');
  const document = await store.putDocument({ title: 'Joe workout', description: 'Weekly routine', content: '# Monday\nSquats\n# Tuesday\nRest' }, 'doc-1');
  const restarted = await new MemoryStore({ filePath }).init();
  assert.deepEqual(restarted.snapshot(), store.snapshot());
  assert.equal(restarted.snapshot().facts[0].id, preference.id);
  assert.equal(restarted.snapshot().rules[0].id, standingRule.id);
  assert.equal(restarted.readDocument(document.id).version, 1);
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  const detached = restarted.snapshot();
  detached.facts[0].content = 'Externally changed';
  detached.conversations[1].turn[0].content = 'Externally changed';
  assert.equal(restarted.snapshot().facts[0].content, 'Prefers oat milk.');
  assert.equal(restarted.snapshot().conversations[1].turn[0].content, user.text);
});

test('concurrent writes serialize and operation retries do not duplicate data or revise state', async (t) => {
  const { store, filePath } = await fixture(t);
  const sources = await Promise.all(Array.from({ length: 12 }, (_, index) => store.recordMessage(message(`User fact ${index}`, `request-${index}`))));
  const duplicates = await Promise.all(Array.from({ length: 8 }, () => store.putFact(fact(sources[0]), 'same-operation')));
  assert.equal(new Set(duplicates.map(entry => entry.id)).size, 1);
  const revision = store.snapshot().revision;
  await store.putFact(fact(sources[0]), 'same-operation');
  await store.recordMessage(message('User fact 0', 'request-0'));
  assert.equal(store.snapshot().revision, revision);
  await assert.rejects(store.putFact({ ...fact(sources[0]), content: 'Different' }, 'same-operation'), /different arguments/);
  await assert.rejects(store.recordMessage(message('Different', 'request-0')), /different arguments/);
  const restarted = await new MemoryStore({ filePath }).init();
  assert.equal(restarted.snapshot().conversations.length, 12);
  assert.equal(restarted.snapshot().facts.length, 1);
});

test('only exact user evidence or an explicit manual edit can create memories', async (t) => {
  const { store } = await fixture(t);
  const user = await store.recordMessage(message());
  const assistant = await store.recordMessage({ ...message(), role: 'assistant', text: 'You are vegan.' });
  for (const proposed of [
    { ...fact(user), source_id: 'missing' },
    { ...fact(user), source_quote: 'I am vegan.' },
    { ...fact(user), source_id: assistant.id, source_quote: assistant.text },
    { ...fact(user), source_quote: '' },
  ]) await assert.rejects(store.putFact(proposed), { code: 'INVALID_MEMORY_ARGUMENT' });
  await assert.rejects(store.putRule(rule('seconds', assistant.id, assistant.text)), /stored user message/);
  assert.equal(store.snapshot().facts.length, 0);
  await store.putFact({ content: 'Edited by tester', source_id: 'manual', source_quote: '' });
  await store.putRule(rule('seconds', user.id, 'oat milk'));
  assert.equal(store.snapshot().facts.length, 1);
});

test('corrections exclude superseded facts from recall and stale learning cannot reverse deletion', async (t) => {
  const { store } = await fixture(t);
  const source = await store.recordMessage(message());
  const old = await store.putFact(fact(source));
  const epoch = store.epoch;
  const updated = await store.putFact({ ...fact(source), content: 'Prefers soy milk.', supersedes: old.id });
  assert.equal(store.snapshot().facts.find(entry => entry.id === old.id).status, 'superseded');
  assert.deepEqual(store.search('milk').facts.map(entry => entry.id), [updated.id]);
  await assert.rejects(store.putFact(fact(source), 'stale', epoch), { code: 'MEMORY_STALE_OPERATION' });
  await assert.rejects(store.putFact({ ...fact(source), supersedes: old.id }), /must exist and be active/);
  await store.remove({ collection: 'facts', id: updated.id });
  assert.equal(store.snapshot().facts.length, 0);
  await assert.rejects(store.putFact(fact(source)), /stored user message/);
});

test('forgetting removes source request pair, protocol history and debug evidence without erasing unrelated history', async (t) => {
  const { store, filePath } = await fixture(t);
  const source = await store.recordMessage(message('I prefer oat milk.'));
  await store.recordMessage({ ...message(), role: 'assistant', text: 'Oat milk, understood.', turn: [{ quoted: 'oat milk' }] });
  const saved = await store.putFact(fact(source));
  await store.recordMessage(message('Set a timer.', 'request-2'));
  await store.recordMessage({ ...message('Timer set.', 'request-2'), role: 'assistant', turn: [{ remembered: 'oat milk' }] });
  await store.addEvent({ type: 'memory_saved', message: 'Saved oat milk', details: { source: source.text } });
  const epoch = store.epoch;
  const result = await store.remove({ collection: 'facts', id: saved.id });
  assert.deepEqual(result.cleared_sessions, ['session-1']);
  assert.ok(store.epoch > epoch);
  assert.equal(store.snapshot().conversations.length, 2);
  assert.ok(store.snapshot().conversations.every(entry => !entry.turn));
  assert.equal(store.snapshot().events.length, 0);
  assert.equal((await readFile(filePath, 'utf8')).includes('oat milk'), false);
  await assert.rejects(store.addEvent({ type: 'stale', message: 'oat milk' }, epoch), { code: 'MEMORY_STALE_OPERATION' });
});

test('explicit rule resolution removes selected alternatives and original source evidence', async (t) => {
  const { store } = await fixture(t);
  const source = await store.recordMessage(message('Always use seconds for timers.'));
  const seconds = await store.putRule(rule('seconds', source.id, source.text));
  const minutes = await store.putRule(rule('minutes'));
  await assert.rejects(store.resolveRules({ keep_id: minutes.id, remove_ids: [minutes.id] }), /distinct conflicting/);
  await assert.rejects(store.resolveRules({ keep_id: minutes.id, remove_ids: ['missing'] }), /must exist/);
  await store.resolveRules({ keep_id: minutes.id, remove_ids: [seconds.id] });
  assert.deepEqual(store.snapshot().rules.map(entry => entry.id), [minutes.id]);
  assert.equal(store.snapshot().conversations.length, 0);
});

test('retrieval ranks named documents and returns relevant bounded sections with exact locations', async (t) => {
  const { store } = await fixture(t);
  await store.putDocument({ title: 'Garden', content: '# Garden\nWater tomatoes.' });
  const workout = await store.putDocument({ title: "Joe's workout routine", description: 'Exercise plan by day', content: `# Monday\n${'Squats and walking. '.repeat(120)}\n# Tuesday\nRest and stretch.\n# Wednesday\nSwimming laps.` });
  const source = await store.recordMessage(message('Joe enjoys swimming.'));
  await store.putFact({ ...fact(source), content: 'Joe enjoys swimming.' });
  await store.recordMessage(message('Water tomatoes.', 'request-2', 'another-session'));
  const hits = store.search('Joe workout Tuesday');
  assert.equal(hits.documents[0].id, workout.id);
  assert.ok(!('content' in hits.documents[0]));
  assert.ok(hits.documents[0].snippet.length <= 800);
  assert.equal(hits.documents[0].sections.length, 3);
  const read = store.readDocument(workout.id, { query: 'Tuesday', maxChars: 200 });
  assert.equal(read.heading, 'Tuesday');
  assert.equal(read.content, '# Tuesday\nRest and stretch.\n');
  assert.equal(workout.content.slice(read.start, read.end), read.content);
  assert.equal(read.truncated, true);
  assert.equal(read.section_truncated, false);
  assert.deepEqual(store.search('Galactic penguins'), { facts: [], documents: [], messages: [] });
  assert.deepEqual(store.search('What do you do?'), { facts: [], documents: [], messages: [] });
  assert.equal(store.search('tomatoes', { session_id: 'session-1' }).messages.length, 0);
  assert.equal(store.readDocument(workout.id, { maxChars: 200 }).content.length, 200);
});

test('document edits keep only current content, bump version and purge loaded old protocol and traces', async (t) => {
  const { store, filePath } = await fixture(t);
  const document = await store.putDocument({ title: 'Workout', content: '# Plan\nOld exercise' }, 'upload-1');
  await store.recordMessage({ ...message('Old exercise is on your plan.'), role: 'assistant', turn: [{ content: 'Old exercise' }], memory_ids: [document.id] });
  await store.recordMessage(message('Unrelated household chat.', 'unrelated', 'other-session'));
  await store.addEvent({ type: 'document_read', message: 'Old exercise' });
  const edited = await store.putDocument({ id: document.id, title: 'Workout', content: '# Plan\nNew exercise' }, 'upload-2');
  assert.equal(edited.id, document.id);
  assert.equal(edited.version, 2);
  assert.equal(edited.created_at, document.created_at);
  assert.equal(store.snapshot().documents.length, 1);
  assert.equal(store.snapshot().events.length, 0);
  assert.equal(store.snapshot().conversations.length, 1);
  assert.equal(store.snapshot().conversations[0].text, 'Unrelated household chat.');
  assert.deepEqual(edited.cleared_sessions, ['session-1']);
  assert.equal((await readFile(filePath, 'utf8')).includes('Old exercise'), false);
  assert.equal((await store.putDocument({ id: document.id, title: 'Workout', content: '# Plan\nNew exercise' }, 'upload-2')).version, 2);
  await store.remove({ collection: 'documents', id: document.id });
  await assert.rejects(async () => store.readDocument(document.id), /not found/);
});

test('retrieval finds evidence deep inside a long section and bounds catalog and quote metadata', async (t) => {
  const { store } = await fixture(t);
  const document = await store.putDocument({ title: 'Long plan', content: `# Notes\n${'Routine context. '.repeat(1000)}Needle exercise instructions.\n${'More context. '.repeat(100)}` });
  const loaded = store.readDocument(document.id, { query: 'Needle', maxChars: 300 });
  assert.match(loaded.content, /Needle exercise instructions/);
  assert.equal(loaded.content.length, 300);
  assert.equal(loaded.heading, 'Notes');
  assert.equal(document.content.slice(loaded.start, loaded.end), loaded.content);
  const source = await store.recordMessage(message(`Swimming ${'source detail '.repeat(200)}`));
  await store.putFact({ ...fact(source), content: 'Enjoys swimming.' });
  const quote = store.search('swimming').facts[0];
  assert.equal(quote.source_quote.length, 400);
  assert.equal(quote.source_quote_truncated, true);
  const manySections = await store.putDocument({ title: 'Catalog', content: Array.from({ length: 50 }, (_, index) => `# Section ${index}\nA note`).join('\n') });
  const catalog = store.search('Catalog').documents.find(entry => entry.id === manySections.id);
  assert.equal(catalog.sections.length, 12);
  assert.equal(catalog.section_count, 50);
});

test('forgetting purges dependency-tagged request pairs in other sessions but preserves unrelated conversations', async (t) => {
  const { store, filePath } = await fixture(t);
  const source = await store.recordMessage(message());
  const preference = await store.putFact(fact(source));
  await store.recordMessage(message('Which milk do I use?', 'recalled', 'session-2'));
  await store.recordMessage({ ...message('Oat milk.', 'recalled', 'session-2'), role: 'assistant', memory_ids: [preference.id] });
  await store.recordMessage(message('Weather today?', 'weather', 'session-3'));
  await store.recordMessage({ ...message('Sunny.', 'weather', 'session-3'), role: 'assistant', memory_ids: [], turn: [{ role: 'user', content: 'Weather today?' }] });
  const result = await store.remove({ collection: 'facts', id: preference.id });
  assert.deepEqual(new Set(result.cleared_sessions), new Set(['session-1', 'session-2']));
  assert.deepEqual(store.snapshot().conversations.map(entry => entry.request_id), ['weather', 'weather']);
  assert.ok(store.snapshot().conversations[1].turn);
  assert.equal((await readFile(filePath, 'utf8')).includes('Oat milk'), false);
});

test('supersession prunes prior fact evidence and dependent answers while preserving the correction source', async (t) => {
  const { store } = await fixture(t);
  const source = await store.recordMessage(message());
  const preference = await store.putFact(fact(source));
  await store.recordMessage({ ...message('You use oat milk.', 'recall', 'session-2'), role: 'assistant', memory_ids: [preference.id] });
  const correction = await store.recordMessage(message('I now prefer soy milk.', 'correction', 'session-2'));
  const updated = await store.putFact({ content: 'Prefers soy milk.', kind: 'preference', source_id: correction.id, source_quote: correction.text, supersedes: preference.id });
  assert.deepEqual(new Set(updated.cleared_sessions), new Set(['session-1', 'session-2']));
  assert.deepEqual(store.snapshot().conversations.map(entry => entry.id), [correction.id]);
  assert.deepEqual(store.search('milk').facts.map(entry => entry.content), ['Prefers soy milk.']);
});

test('external routine-reference invalidation removes sources and dependent replies without deleting unrelated records', async (t) => {
  const { store, filePath } = await fixture(t);
  const source = await store.recordMessage(message('Save tea break as a three-minute tea timer.', 'save-routine'));
  await store.recordMessage({ ...message('Routine saved.', 'save-routine'), role: 'assistant', memory_ids: ['external-routine-id'] });
  await store.recordMessage(message('Tea break', 'run-routine', 'session-2'));
  await store.recordMessage({ ...message('Three-minute timer started.', 'run-routine', 'session-2'), role: 'assistant', memory_ids: ['external-routine-id'] });
  await store.recordMessage({ ...message('Unrelated response.', 'unrelated', 'session-2'), role: 'assistant', turn: [{ stale: 'routine context' }] });
  await store.recordMessage(message('Garden conversation.', 'garden', 'session-3'));
  await store.putFact({ content: 'Uses a shared garden.', source_id: 'manual', source_quote: '' });
  await store.addEvent({ type: 'routine', message: 'Stored routine context.' });
  const epoch = store.epoch;
  const invalidated = await store.invalidateReferences({ ids: ['external-routine-id'], source_ids: [source.id] });
  assert.deepEqual(new Set(invalidated.cleared_sessions), new Set(['session-1', 'session-2']));
  assert.ok(store.epoch > epoch);
  assert.deepEqual(store.snapshot().conversations.map(entry => entry.request_id), ['unrelated', 'garden']);
  assert.equal(store.snapshot().conversations[0].turn, undefined);
  assert.equal(store.snapshot().facts.length, 1);
  assert.deepEqual(store.snapshot().events, []);
  assert.equal((await readFile(filePath, 'utf8')).includes('external-routine-id'), false);
  await assert.rejects(store.invalidateReferences({ ids: ['same', 'same'] }), /distinct/);
  await assert.rejects(store.invalidateReferences({ ids: Array.from({ length: 1001 }, (_, index) => `id-${index}`) }), /at most 1000/);
  await assert.rejects(store.invalidateReferences({ ids: [] }), /at least one/);
  await assert.rejects(store.invalidateReferences({ ids: ['external-routine-id'], unsupported: true }), /unexpected/);
});

test('conversation clearing preserves learned facts; full reset deletes everything and invalidates queued learning', async (t) => {
  const { store, filePath } = await fixture(t);
  const user = await store.recordMessage(message());
  await store.putFact(fact(user));
  await store.putRule(rule());
  await store.putDocument({ title: 'Plan', content: 'A useful plan.' });
  await store.addEvent({ type: 'learned', message: 'Preference recorded.' });
  await store.clearConversation(user.session_id);
  assert.equal(store.snapshot().conversations.length, 0);
  assert.equal(store.snapshot().facts.length, 1);
  const before = store.epoch;
  await store.clearAll();
  assert.ok(store.epoch > before);
  for (const collection of ['facts', 'rules', 'documents', 'conversations', 'events']) {
    assert.deepEqual(store.snapshot()[collection], []);
  }
  await assert.rejects(store.putFact({ content: 'Stale', source_id: 'manual', source_quote: '' }, 'late', before), { code: 'MEMORY_STALE_OPERATION' });
  assert.deepEqual((await new MemoryStore({ filePath }).init()).snapshot(), store.snapshot());
});

test('event history is bounded and validation failures do not poison subsequent writes', async (t) => {
  const { store } = await fixture(t);
  await assert.rejects(store.putFact({ content: 'No provenance' }), { code: 'INVALID_MEMORY_ARGUMENT' });
  await assert.rejects(store.putRule({ ...rule(), value: { execute: () => {} } }), /JSON data/);
  await assert.rejects(store.putDocument({ title: 'Too large', content: 'x'.repeat(100001) }), /at most 100000/);
  await assert.rejects(store.recordMessage({ ...message(), role: 'system' }), /role/);
  await assert.rejects(store.recordMessage({ ...message(), turn: [] }), /Only assistant/);
  await assert.rejects(store.recordMessage({ ...message(), memory_ids: ['same', 'same'] }), /distinct memory/);
  await assert.rejects(store.addEvent({ type: 'invalid', message: 'Invalid', details: { x: NaN } }), /JSON data/);
  await Promise.all(Array.from({ length: 105 }, (_, index) => store.addEvent({ type: 'step', message: `Step ${index}` })));
  assert.equal(store.snapshot().events.length, 100);
  assert.equal(store.snapshot().events[0].message, 'Step 5');
});

test('failed persistence leaves state and epoch unchanged, then recovers on a later operation', async (t) => {
  const { store, filePath, directory } = await fixture(t);
  const ruleRecord = await store.putRule(rule());
  const before = store.snapshot();
  const backup = join(directory, 'backup.json');
  await rename(filePath, backup);
  await mkdir(filePath);
  await assert.rejects(store.remove({ collection: 'rules', id: ruleRecord.id }), { code: 'MEMORY_STORAGE_ERROR' });
  assert.deepEqual(store.snapshot(), before);
  await rm(filePath, { recursive: true });
  await rename(backup, filePath);
  await store.remove({ collection: 'rules', id: ruleRecord.id });
  assert.equal(store.snapshot().rules.length, 0);
});

test('corrupt or tampered files fail without overwriting and init must succeed before reads', async (t) => {
  const { store, filePath } = await fixture(t);
  await store.putRule(rule());
  const original = JSON.parse(await readFile(filePath, 'utf8'));
  const tampered = structuredClone(original);
  tampered.rules.push({ ...tampered.rules[0] });
  const invalidStates = ['{broken', JSON.stringify({ ...original, version: 2 }), JSON.stringify(tampered), JSON.stringify({ ...original, revision: -1 }), JSON.stringify({ ...original, conversations: [{}] })];
  for (const content of invalidStates) {
    await writeFile(filePath, content);
    const restarted = new MemoryStore({ filePath });
    await assert.rejects(restarted.init(), { code: 'MEMORY_STORAGE_CORRUPT' });
    assert.throws(() => restarted.snapshot(), /init\(\) must succeed/);
    assert.equal(await readFile(filePath, 'utf8'), content);
  }
});
