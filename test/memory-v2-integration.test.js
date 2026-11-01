import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { selectedEngine } from '../src/memory-engine.js';
import { MemoryLearning } from '../src/memory-learning.js';
import { MemoryStore } from '../src/memory-store.js';
import { MemoryLifecycle } from '../src/memory-v2/lifecycle.js';
import { call, chat, closeApp, contextFor, createAll, currentFacts, deferred, fakeClock, memoryData, publishFact, reply, retrieved, saveFact, scriptedMeta, startApp, tempDir, v2App } from './memory-v2-helpers.js';

const rule = (kind, value, scope, source_quote, explanation = `${kind} ${value}`) => call('memory_save_rule', { kind, value, scope, source_quote, explanation, applies: 'ongoing' });

async function legacySeed(directory) {
  const store = await new MemoryStore({ filePath: join(directory, 'memory.json') }).init();
  const source = await store.recordMessage({ session_id: 'old-session', request_id: 'old-request', role: 'user', text: 'Remember Alex prefers oat milk.' });
  await store.recordMessage({ session_id: 'old-session', request_id: 'old-request', role: 'assistant', text: 'Got it.' });
  const fact = await store.putFact({ content: 'Alex prefers oat milk.', subject: 'Alex', kind: 'preference', source_id: source.id, source_quote: 'Alex prefers oat milk', reason: 'Useful.' });
  const later = await store.recordMessage({ session_id: 'old-session', request_id: 'old-request-2', role: 'user', text: 'Keep replies brief please.' });
  const guidance = await store.putFact({ content: 'Keep replies brief.', subject: 'household', kind: 'guidance', source_id: later.id, source_quote: 'Keep replies brief', reason: 'Not enforceable.' });
  const banned = await store.putRule({ kind: 'avoid_word', value: 'cactus', scope: 'assistant_reply', source_id: later.id, source_quote: 'Keep replies', original: 'Keep replies', explanation: 'Avoid cactus.' });
  const document = await store.putDocument({ title: 'Pool rules', description: 'Opening times for the pool.', content: '# Hours\n\nThe pool opens at nine.' });
  return { fact, guidance, banned, document, source };
}

test('the selector is one clear setting and rejects anything else', () => {
  assert.equal(selectedEngine('v2'), 'v2');
  assert.equal(selectedEngine('legacy'), 'legacy');
  assert.equal(selectedEngine(''), 'legacy', 'legacy remains the default until a real embedding service is verified');
  assert.throws(() => selectedEngine('both'), /must be v2 or legacy/u);
});

test('same-request rules still gate tools and replies, and publish only after close', async t => {
  const message = 'Never start timers. Also start a tea timer for 1 minute.';
  const meta = scriptedMeta([
    [rule('tool_deny', 'create_timer', 'tools', 'Never start timers'), call('create_timer', { label: 'tea', duration: 1, unit: 'minutes' })],
    [reply('Understood, no timers.')],
    [rule('avoid_word', 'cactus', 'assistant_reply', 'Never say cactus')], [reply('A cactus is spiky.')], [reply('It is spiky.')],
    [reply('Okay.')],
  ]);
  const { app, clock } = await v2App(t, { meta });
  const session = randomUUID();
  const blocked = await chat(app, message, session);
  assert.equal(blocked.data.timers.length, 0, 'a same-batch restriction applies before the action');
  assert.equal(blocked.data.tool_events.find(item => item.tool === 'create_timer').status, 'failed');
  assert.equal(app.store.snapshot().rules.length, 0, 'not published yet');

  const repaired = await chat(app, 'Never say cactus. What is a saguaro?', session);
  assert.equal(repaired.data.reply.includes('cactus'), false, 'the output check uses the conversation rule immediately');

  const other = randomUUID();
  const fresh = await chat(app, 'Hello from another room.', other);
  assert.ok(fresh.data.reply);
  assert.equal(JSON.stringify(memoryData(meta.calls.at(-1).instructions).rules).includes('cactus'), false, 'another conversation sees only committed rules');

  clock.advance(120_000);
  await app.learning.drain();
  assert.deepEqual(app.store.snapshot().rules.map(item => item.kind).sort(), ['avoid_word', 'tool_deny']);
  assert.equal(app.memory.rules().length, 2, 'the conversation copy retires once published');
  clock.advance(120_000);
  await app.learning.drain();
  assert.equal(app.store.snapshot().rules.length, 2, 'publication is idempotent');
});

test('timer defaults use the local route, keep duration and unit separate, and flag conflicts without choosing', async t => {
  const meta = scriptedMeta();
  const { app, clock } = await v2App(t, { meta });
  const session = randomUUID();
  const first = await chat(app, 'Default timer is five minutes, set me a timer', session);
  assert.equal(meta.calls.length, 0, 'zero foreground model calls');
  assert.equal(first.data.timers[0].duration_seconds, 300);
  assert.match(first.data.tool_events[0].message, /reviewed for permanent memory after/u);
  assert.equal(app.store.snapshot().rules.length, 0);

  const second = await chat(app, 'Default timer is ten minutes', session);
  assert.equal(meta.calls.length, 0);
  assert.match(second.data.reply, /kept both/u, 'an unresolved conflict stays flagged');
  const blocked = await chat(app, 'Set me a timer', session);
  assert.equal(blocked.data.timers.length, 1, 'no new timer while the default is in conflict');
  assert.match(blocked.data.reply, /Should I use|Which/u);

  clock.advance(120_000);
  await app.learning.drain();
  assert.equal(app.store.snapshot().rules.filter(item => item.kind === 'timer_default_seconds').length, 2, 'both publish, unresolved');
});

test('a do/don\'t saved under one conversation is removed by forgetting before it ever publishes', async t => {
  const meta = scriptedMeta();
  const { app, clock } = await v2App(t, { meta });
  const session = randomUUID();
  meta.steps.push([rule('avoid_word', 'turnip', 'assistant_reply', 'Never say turnip')], [reply('Understood.')]);
  await chat(app, 'Never say turnip.', session);
  const [control] = app.memory.rules();
  meta.steps.push([call('memory_forget', { collection: 'rules', id: control.id, source_quote: 'Forget the turnip instruction' })]);
  await chat(app, 'Forget the turnip instruction.', session);
  clock.advance(120_000);
  await app.learning.drain();
  assert.equal(app.memory.rules().length, 0);
  assert.equal(app.store.snapshot().conversations.some(item => item.text.includes('turnip')), false);
});

test('routines save now, publish no duplicate, and never run on discovery, explanation or consolidation', async t => {
  const meta = scriptedMeta();
  const { app, clock } = await v2App(t, { meta });
  const session = randomUUID();
  const saved = await chat(app, 'If I say tea, start a tea timer and suggest a tea', session);
  assert.equal(meta.calls.length, 0, 'the existing local path saves it');
  assert.equal(app.routineStore.list().length, 1, 'operational state is saved during the discussion');
  assert.equal(saved.data.timers.length, 0);

  const [card] = (await retrieved(app, 'what do you know about tea', randomUUID())).filter(item => item.kind === 'routine');
  assert.equal(card.name, 'tea', 'discoverable before the conversation closes');
  assert.equal(card.version, 1);
  assert.equal(card.activation_requires_user_intent, true);

  meta.steps.push([reply('Your tea routine starts a timer and suggests a tea.')]);
  const explained = await chat(app, 'What does my tea routine do?', session);
  assert.equal(explained.data.timers.length, 0, 'explaining does not run it');

  meta.extract = async exchange => ({ candidates: [{ type: 'episodic', text: 'Created the tea routine.', subject: 'household', attribute: 'tea routine', conditions: '', exceptions: '', event_time: '', temporal: 'ongoing', is_correction: false, evidence_kind: 'direct', source_ids: [exchange.user.id], source_quote: exchange.user.text }] });
  clock.advance(120_000);
  await app.learning.drain();
  assert.equal(app.routineStore.list().length, 1, 'consolidation does not save it again');
  assert.equal(app.routineStore.list()[0].version, 1);
  assert.equal((await app.timers.list()).length, 0, 'consolidation does not run it');
  const edit = await chat(app, 'If I say tea, start a coffee timer and suggest a coffee', session);
  assert.ok(edit.data.reply);
  assert.equal(app.routineStore.list()[0].version, 2);
  const [updated] = (await retrieved(app, 'tea routine', randomUUID())).filter(item => item.kind === 'routine');
  assert.equal(updated.version, 2, 'routine edits are discoverable promptly');
});

test('a buried exception is found in the original passage, with version and location, though its description omits it', async t => {
  const meta = scriptedMeta();
  const { app, embedder } = await v2App(t, { meta });
  const filler = Array.from({ length: 40 }, (_, index) => `Paragraph ${index} covers general household notes about nothing in particular.`).join('\n\n');
  const content = `# House manual\n\n${filler}\n\n## Pool\n\nThe pool is open every day from nine until six.\n\nExcept on public holidays, when the lifeguard requires forty-eight hours notice.\n\n## Garden\n\nWater the beds on Fridays.`;
  const document = await app.memory.putDocument({ title: 'House manual', description: 'General household guide.', content });

  const pending = await contextFor(app, 'lifeguard holiday notice');
  const before = JSON.parse(pending.text);
  assert.equal(before.documents_not_yet_indexed?.length ?? 0, 0, 'not yet seen by the worker');
  assert.equal(before.retrieved.length, 0);

  // Indexing is background: the foreground path above did not chunk or embed anything.
  assert.equal(embedder.calls.filter(item => item.kind === 'document').length, 0);
  await app.learning.drain();
  assert.equal(app.learning.status().documents[0].status, 'ready');

  const results = await retrieved(app, 'how much lifeguard notice is required on holidays');
  const passage = results.find(item => item.kind === 'passage' && item.text.includes('forty-eight hours'));
  assert.ok(passage, 'the original passage is retrieved directly');
  assert.equal(passage.document_title, 'House manual');
  assert.equal(passage.section, 'Pool');
  assert.equal(passage.version, 1);
  assert.equal(content.slice(passage.start, passage.end), passage.text, 'the location reopens the exact source');
  assert.ok(embedder.embeddedTexts().some(text => text.includes('forty-eight hours')), 'original passages get vectors in the background');

  // A separated qualification still travels with its neighbour.
  const hours = (await retrieved(app, 'what time does the pool open every day')).find(item => item.kind === 'passage' && item.section === 'Pool');
  assert.ok(hours.text.includes('forty-eight') || hours.nearby_qualification?.includes('forty-eight'));

  // Replacing the document stops old text immediately and reindexes in the background.
  await app.memory.putDocument({ id: document.id, title: 'House manual', description: 'General household guide.', content: '# Pool\n\nThe pool is closed for repairs.' });
  await app.learning.clear();
  assert.equal((await retrieved(app, 'lifeguard forty-eight hours')).length, 0, 'no stale passage');
  assert.equal(app.learning.status().documents[0].status, 'pending');
  const notReady = JSON.parse((await contextFor(app, 'pool repairs')).text);
  assert.equal(notReady.documents_not_yet_indexed[0].id, document.id, 'exact reads remain available while pending');
  await app.learning.drain();
  assert.equal((await retrieved(app, 'closed for repairs'))[0].version, 2);
});

test('legacy data imports once into separate storage, and the rollback file stays untouched by v2 learning', async t => {
  const directory = await tempDir(t);
  const seeded = await legacySeed(directory);
  const legacyBefore = await readFile(join(directory, 'memory.json'), 'utf8');
  const clock = fakeClock();
  const meta = scriptedMeta();
  const first = await startApp(t, directory, { meta, clock });
  const imported = first.app.memory.inspect();
  assert.equal(imported.engine.selected, 'v2');
  assert.deepEqual(imported.engine.migration && [imported.engine.migration.facts, imported.engine.migration.rules, imported.engine.migration.documents], [2, 1, 1]);
  const fact = imported.facts.find(item => item.id === seeded.fact.id);
  assert.equal(fact.content, 'Alex prefers oat milk.');
  assert.deepEqual(fact.source_ids, [seeded.source.id], 'legacy IDs map deterministically and keep their evidence');
  assert.equal(fact.provenance_gap, false);
  assert.ok(first.app.store.snapshot().conversations.some(item => item.id === seeded.source.id));
  assert.ok(first.app.memory.rules().some(item => item.id === seeded.banned.id));
  const manifest = JSON.parse(await readFile(join(directory, 'memory-v2', 'backup', 'manifest.json'), 'utf8'));
  assert.equal(manifest.counts.facts, 2);
  assert.equal((await stat(join(directory, 'memory-v2', 'backup', 'memory.json'))).mode & 0o777, 0o600);
  assert.equal(first.app.learning.status().capture_backlog, 0, 'the old archive is not reinterpreted');
  await first.app.learning.drain();
  assert.equal(meta.extractions.length, 0);
  assert.ok((await retrieved(first.app, 'oat milk')).some(item => item.id === seeded.fact.id));
  // Guidance stays always-read and separately governed.
  assert.ok(JSON.parse((await contextFor(first.app, 'unrelated zeppelin')).text).guidance.some(item => item.id === seeded.guidance.id));

  await publishFact({ app: first.app, meta, clock }, 'Sam prefers green tea.', { subject: 'Sam', attribute: 'tea', content: 'Sam prefers green tea.' });
  assert.equal(await readFile(join(directory, 'memory.json'), 'utf8'), legacyBefore, 'normal v2 learning never touches the legacy file');
  await closeApp(first.app);

  // Restart does not import again.
  const second = await startApp(t, directory, { meta, clock });
  assert.equal(second.app.memory.inspect().facts.filter(item => item.content === 'Alex prefers oat milk.').length, 1);
  await closeApp(second.app);

  // One setting rolls back; only the selected worker runs.
  const legacy = await startApp(t, directory, { meta, clock, engine: 'legacy' });
  assert.ok(legacy.app.learning instanceof MemoryLearning);
  assert.equal(legacy.app.memory.kind, 'legacy');
  assert.equal(legacy.app.store.snapshot().facts.some(item => item.id === seeded.fact.id), true);
  assert.equal(legacy.app.store.snapshot().facts.some(item => item.content === 'Sam prefers green tea.'), false, 'post-migration learning is not dual-written');
  await closeApp(legacy.app);

  // v2 state survives the switch and can be reenabled.
  const back = await startApp(t, directory, { meta, clock });
  assert.ok(back.app.learning instanceof MemoryLifecycle);
  assert.ok(currentFacts(back.app).some(item => item.content === 'Sam prefers green tea.'));
  assert.equal(back.app.memory.inspect().facts.filter(item => item.content === 'Alex prefers oat milk.').length, 1);
});

test('a corrupt v2 database is preserved and the failure says how to roll back; legacy still starts', async t => {
  const directory = await tempDir(t);
  await legacySeed(directory);
  const path = join(directory, 'memory-v2');
  const first = await startApp(t, directory);
  await closeApp(first.app);
  const database = join(path, 'memory.sqlite');
  const damaged = Buffer.from('this is not a database at all, and it must not be overwritten');
  await writeFile(database, damaged);
  await assert.rejects(startApp(t, directory), /MERLIN_MEMORY_ENGINE=legacy/u);
  assert.deepEqual(await readFile(database), damaged);
  const legacy = await startApp(t, directory, { engine: 'legacy' });
  assert.equal(legacy.app.memory.kind, 'legacy');
});

test('deleting during an in-flight job leaves no late write, stale index, or draft', async t => {
  const meta = scriptedMeta();
  const { app, clock, embedder } = await v2App(t, { meta });
  await publishFact({ app, meta, clock }, 'Our gate code is written on the shed door.', { attribute: 'gate code', content: 'The gate code is written on the shed door.' });
  const record = currentFacts(app).find(item => item.attribute === 'gate code');
  assert.ok((await retrieved(app, 'gate code shed')).some(item => item.id === record.id));

  // A held consolidation holds an equivalent note on the same point, from a later message.
  const message = 'The gate code is still on the shed door.';
  meta.steps.push([saveFact({ content: 'The gate code is written on the shed door.', attribute: 'gate code', source_quote: message })], [reply('Okay.')]);
  await chat(app, message);
  const hold = deferred();
  meta.consolidate = async batch => { await hold.promise; return createAll(batch); };
  clock.advance(120_000);
  const inflight = app.learning.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(meta.consolidations.length, 2);

  await app.memory.removeRecord({ collection: 'facts', id: record.id });
  hold.resolve();
  await inflight;
  clock.advance(700_000);
  await app.learning.drain();

  assert.equal(app.memory.inspect().facts.filter(item => /gate code/iu.test(item.content) && item.kind !== 'summary').length, 0, 'no late write restored it');
  assert.equal((await retrieved(app, 'gate code shed door')).filter(item => /gate code/iu.test(item.text)).length, 0, 'no stale index');
  assert.equal(app.learning.status().candidates.pending, 0, 'no surviving draft');
  assert.equal(app.store.snapshot().conversations.some(item => item.id === record.source_ids[0]), false, 'the cited source is gone');
  const vectors = app.engine.db.prepare('SELECT COUNT(*) AS n FROM item_vectors JOIN search_items ON search_items.key = item_vectors.key WHERE search_items.text LIKE ?').get('%gate code%').n;
  assert.equal(vectors, 0);
  assert.ok(embedder.calls.length > 0);
  // A new statement after the deletion is new evidence, not resurrection.
  meta.consolidate = createAll;
  await publishFact({ app, meta, clock }, 'I am telling you again that the gate code is written on the shed door.', { attribute: 'gate code', content: 'The gate code is written on the shed door.' });
  assert.equal(currentFacts(app).filter(item => item.attribute === 'gate code').length, 1);
});

test('capture output from before a deletion is discarded', async t => {
  const meta = scriptedMeta([[reply('Okay.')]]);
  const { app } = await v2App(t, { meta });
  const message = 'Our alarm code hint is the blue book.';
  const hold = deferred();
  meta.extract = async exchange => { await hold.promise; return { candidates: [{ type: 'semantic', text: message, subject: 'household', attribute: 'alarm hint', conditions: '', exceptions: '', event_time: '', temporal: 'ongoing', is_correction: false, evidence_kind: 'direct', source_ids: [exchange.user.id], source_quote: message }] }; };
  const session = randomUUID();
  await chat(app, message, session);
  const inflight = app.learning.tick();
  await new Promise(resolve => setImmediate(resolve));
  await app.memory.clearConversation(session);
  hold.resolve();
  await inflight;
  await app.learning.drain();
  assert.equal(app.learning.status().candidates.pending, 0);
  assert.equal(app.learning.status().capture_backlog, 0);
  assert.equal(app.store.snapshot().conversations.length, 0);
});

test('forgetting under v2 reaches rollback copies, so neither a mode switch nor a restart restores it', async t => {
  const directory = await tempDir(t);
  const seeded = await legacySeed(directory);
  const first = await startApp(t, directory);
  await first.app.memory.removeRecord({ collection: 'facts', id: seeded.fact.id });
  await first.app.memory.removeRecord({ collection: 'rules', id: seeded.banned.id });
  for (const copy of [join(directory, 'memory.json'), join(directory, 'memory-v2', 'backup', 'memory.json')]) {
    const contents = await readFile(copy, 'utf8');
    assert.equal(contents.includes('oat milk'), false, `${copy} still holds the forgotten text`);
    assert.equal(contents.includes('cactus'), false, `${copy} still holds the forgotten rule`);
  }
  await closeApp(first.app);
  const legacy = await startApp(t, directory, { engine: 'legacy' });
  assert.equal(legacy.app.store.snapshot().facts.some(item => item.id === seeded.fact.id), false);
  await closeApp(legacy.app);
  const again = await startApp(t, directory);
  assert.equal(again.app.memory.inspect().facts.some(item => item.id === seeded.fact.id), false, 'no re-import');
});

test('a fence entry interrupted before reaching the legacy file is finished at legacy startup', async t => {
  const directory = await tempDir(t);
  const seeded = await legacySeed(directory);
  const first = await startApp(t, directory);
  await closeApp(first.app);
  const fencePath = join(directory, 'memory-v2', 'fence.json');
  await writeFile(fencePath, JSON.stringify({ version: 1, entries: [{ seq: 1, origin: 'v2', collection: 'facts', ids: [seeded.fact.id], source_ids: [seeded.source.id], applied_legacy: false, applied_backup: false, applied_v2: true }] }), { mode: 0o600 });
  const legacy = await startApp(t, directory, { engine: 'legacy' });
  assert.equal(legacy.app.store.snapshot().facts.some(item => item.id === seeded.fact.id), false);
});

test('a pending address rule goes when the user asks, before it can ever publish', async t => {
  const meta = scriptedMeta([[call('memory_save_rule', { kind: 'address_as', value: 'captain', scope: 'assistant_reply', source_quote: 'title here is captain', explanation: 'Address the user as captain.', applies: 'ongoing' })], [reply('Certainly, captain.')]]);
  const { app, clock } = await v2App(t, { meta });
  const session = randomUUID();
  await chat(app, 'My title here is captain, use it in replies.', session);
  assert.ok(app.memory.rules().some(rule => rule.kind === 'address_as'));
  await chat(app, 'Stop calling me captain.', session);
  assert.equal(meta.calls.length, 2, 'only the first turn used the model; the existing local style path handled this one');
  clock.advance(120_000);
  await app.learning.drain();
  assert.equal(app.store.snapshot().rules.some(rule => rule.kind === 'address_as'), false);
});

test('a routine edit that invalidates old sources under v2 also clears them from rollback copies', async t => {
  const directory = await tempDir(t);
  const seeded = await legacySeed(directory);
  const { app } = await startApp(t, directory);
  await app.store.invalidateReferences({ source_ids: [seeded.source.id] });
  await app.learning.clear();
  await app.memory.syncRollbackSources();
  for (const copy of [join(directory, 'memory.json'), join(directory, 'memory-v2', 'backup', 'memory.json')]) {
    assert.equal((await readFile(copy, 'utf8')).includes('Remember Alex prefers oat milk.'), false, copy);
  }
});

test('forgetting under legacy reaches the private backup at once, even if v2 is never reenabled', async t => {
  const directory = await tempDir(t);
  const seeded = await legacySeed(directory);
  await closeApp((await startApp(t, directory)).app);
  const legacy = await startApp(t, directory, { engine: 'legacy' });
  await legacy.app.memory.removeRecord({ collection: 'facts', id: seeded.fact.id });
  assert.equal((await readFile(join(directory, 'memory-v2', 'backup', 'memory.json'), 'utf8')).includes('oat milk'), false);
});

test('forgetting and clearing under legacy are honored when v2 is reenabled', async t => {
  const directory = await tempDir(t);
  const seeded = await legacySeed(directory);
  const clock = fakeClock();
  const meta = scriptedMeta();
  const first = await startApp(t, directory, { meta, clock });
  await publishFact({ app: first.app, meta, clock }, 'Sam prefers green tea.', { subject: 'Sam', attribute: 'tea', content: 'Sam prefers green tea.' });
  await closeApp(first.app);

  const legacy = await startApp(t, directory, { engine: 'legacy' });
  await legacy.app.memory.removeRecord({ collection: 'facts', id: seeded.fact.id });
  await closeApp(legacy.app);

  const back = await startApp(t, directory, { meta, clock });
  assert.equal(back.app.memory.inspect().facts.some(item => item.id === seeded.fact.id), false, 'deleted by absence from the rollback file');
  assert.equal(back.app.store.snapshot().conversations.some(item => item.id === seeded.source.id), false);
  assert.ok(currentFacts(back.app).some(item => item.content === 'Sam prefers green tea.'), 'unrelated v2 learning survives');
  await closeApp(back.app);

  const legacyAgain = await startApp(t, directory, { engine: 'legacy' });
  await legacyAgain.app.memory.clearAll(legacyAgain.app.learning);
  await closeApp(legacyAgain.app);
  const cleared = await startApp(t, directory, { meta, clock });
  assert.equal(cleared.app.memory.inspect().facts.length, 0, 'Delete all memory under legacy also clears v2');
  assert.equal(cleared.app.store.snapshot().conversations.length, 0);
});

test('Delete all memory removes every v2 layer and the private backup', async t => {
  const directory = await tempDir(t);
  await legacySeed(directory);
  const clock = fakeClock();
  const meta = scriptedMeta();
  const { app } = await startApp(t, directory, { meta, clock });
  await publishFact({ app, meta, clock }, 'Sam prefers green tea.', { subject: 'Sam', attribute: 'tea', content: 'Sam prefers green tea.' });
  meta.steps.push([reply('Okay.')]);
  await chat(app, 'Never mind that.');
  await app.memory.clearAll(app.learning);
  const inspect = app.memory.inspect();
  assert.equal(inspect.facts.length, 0);
  assert.equal(inspect.rules.length, 0);
  assert.equal(inspect.documents.length, 0);
  assert.equal(inspect.conversations.length, 0);
  assert.equal(app.learning.status().capture_backlog, 0);
  assert.deepEqual((await retrieved(app, 'green tea')), []);
  assert.equal(existsSync(join(directory, 'memory-v2', 'backup')), false);
  assert.equal((await readFile(join(directory, 'memory.json'), 'utf8')).includes('oat milk'), false);
});

test('ordinary publication does not clear other conversations\' drafts or bump the deletion epoch', async t => {
  const meta = scriptedMeta();
  const clock = fakeClock();
  const { app } = await v2App(t, { meta, clock });
  const first = randomUUID();
  meta.extract = async exchange => ({ candidates: [{ type: 'semantic', text: exchange.user.text, subject: 'household', attribute: exchange.user.text, conditions: '', exceptions: '', event_time: '', temporal: 'ongoing', is_correction: false, evidence_kind: 'direct', source_ids: [exchange.user.id], source_quote: exchange.user.text }] });
  meta.steps.push([reply('A.')]);
  await chat(app, 'The hallway rug is blue.', first);
  clock.advance(100_000);
  const second = randomUUID();
  meta.steps.push([reply('B.')]);
  await chat(app, 'The attic stays locked.', second);
  const epoch = app.store.epoch;
  clock.advance(20_000);
  await app.learning.drain();
  assert.ok(currentFacts(app).some(item => item.content === 'The hallway rug is blue.'));
  assert.equal(app.learning.status().candidates.pending, 1, 'the other conversation keeps its pending draft');
  assert.equal(app.store.epoch, epoch);
  clock.advance(120_000);
  await app.learning.drain();
  assert.ok(currentFacts(app).some(item => item.content === 'The attic stays locked.'));
});

test('deeper reads open exact sources on request, and a forgotten name leaves the entity tables', async t => {
  const meta = scriptedMeta();
  const { app, clock } = await v2App(t, { meta });
  const message = 'Priya looks after the greenhouse on Sundays.';
  await publishFact({ app, meta, clock }, message, { subject: 'Priya', attribute: 'greenhouse', content: 'Priya looks after the greenhouse on Sundays.' });
  const [record] = (await retrieved(app, 'who looks after the greenhouse')).filter(item => item.kind === 'record' && item.subject === 'Priya');
  const read = await app.memory.execute('memory_read_sources', { source_ids: [...record.source_ids, 'missing-id'], query: '' }, { message: '', session_id: randomUUID() });
  assert.equal(read.sources[0].text, message);
  assert.deepEqual(read.missing_ids, ['missing-id']);
  const archive = await app.memory.execute('memory_read_sources', { source_ids: [], query: 'greenhouse' }, { message: '', session_id: randomUUID() });
  assert.ok(archive.archive_matches.some(item => item.text.includes('greenhouse')));
  assert.equal(app.engine.db.prepare('SELECT COUNT(*) AS n FROM entity_aliases WHERE alias = ?').get('priya').n, 1);
  await app.memory.removeRecord({ collection: 'facts', id: record.id });
  assert.equal(app.engine.db.prepare('SELECT COUNT(*) AS n FROM entity_aliases WHERE alias = ?').get('priya').n, 0);
});

test('the HTTP inspector and owner controls work against v2', async t => {
  const meta = scriptedMeta();
  const { app, clock } = await v2App(t, { meta });
  await publishFact({ app, meta, clock }, 'Our recycling goes out on Tuesdays.', { attribute: 'recycling day', content: 'Recycling goes out on Tuesdays.' });
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const send = (path, body) => fetch(`${origin}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  const inspect = await (await fetch(`${origin}/api/memory`)).json();
  assert.equal(inspect.memory_engine, 'v2');
  assert.equal(inspect.engine.selected, 'v2');
  assert.equal(inspect.engine.semantic_cutoff.calibrated, false);
  for (const key of ['capture_backlog', 'candidates', 'segments', 'semantic', 'index', 'retry']) assert.ok(key in inspect.learning, key);
  assert.equal(inspect.learning.semantic.state, 'ready');
  assert.equal(JSON.stringify(inspect.learning).includes('recycling'), false, 'status carries no household content');
  const fact = inspect.facts.find(item => item.attribute === 'recycling day');
  assert.equal(fact.record_status, 'current');
  assert.equal(fact.evidence_kind, 'direct');

  // Owner edits keep history, and do not trigger deletion cleanup.
  const epoch = app.store.epoch;
  assert.equal((await send('/api/memory/fact', { id: fact.id, content: 'Recycling goes out on Wednesdays.', subject: 'household', kind: 'fact' })).status, 200);
  assert.equal(app.store.epoch, epoch);
  assert.deepEqual(app.memory.inspect().facts.filter(item => item.id === fact.id).map(item => [item.version, item.status]).sort(), [[1, 'superseded'], [2, 'active']]);

  const session = randomUUID();
  assert.equal((await send('/api/session/close', { session_id: session })).status, 200);
  assert.equal((await send('/api/memory/delete', { collection: 'facts', id: fact.id })).status, 200);
  assert.equal(app.memory.inspect().facts.some(item => item.id === fact.id), false);
  assert.equal((await send('/api/memory/delete', { collection: 'facts', id: 'missing' })).status, 500 - 100, 'unknown record');
  assert.equal((await send('/api/memory/clear', {})).status, 200);
});

test('legacy still publishes immediately, ignores the new boundary, and keeps its own worker', async t => {
  const meta = scriptedMeta([[call('memory_save_fact', { content: 'Alex prefers oat milk.', subject: 'Alex', kind: 'preference', source_quote: 'Alex prefers oat milk', reason: 'Useful.', supersedes: '' })], [reply('Got it.')]]);
  const directory = await tempDir(t);
  const { app } = await startApp(t, directory, { meta, engine: 'legacy' });
  await chat(app, 'Remember Alex prefers oat milk.');
  assert.equal(app.store.snapshot().facts.length, 1, 'the backup engine keeps its original behavior');
  assert.ok(app.learning instanceof MemoryLearning);
  assert.equal(existsSync(join(directory, 'memory-v2')), false, 'legacy creates no v2 storage');
  assert.equal(app.memory.tools.find(tool => tool.name === 'memory_save_fact').description.startsWith('Immediately save'), true);
});
