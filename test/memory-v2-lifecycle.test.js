import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { sanitizeOutcomes } from '../src/memory-v2/lifecycle.js';
import { call, chat, closeApp, contextFor, createAll, createOperation, currentFacts, deferred, fakeClock, memoryData, publishFact, reply, retrieved, saveFact, scriptedMeta, startApp, tempDir, v2App } from './memory-v2-helpers.js';

const draft = (source_id, overrides = {}) => ({ type: 'semantic', text: 'Draft note', subject: 'household', attribute: '', conditions: '', exceptions: '', event_time: '', temporal: 'ongoing', is_correction: false, evidence_kind: 'inference', source_ids: [source_id], source_quote: '', ...overrides });

test('foreground replies finish while capture and consolidation are held, and drafts stay out of live recall', async t => {
  const meta = scriptedMeta([[reply('Noted.')], [reply('Still here.')]]);
  const { app, clock, embedder } = await v2App(t, { meta });
  const capture = deferred();
  meta.extract = async exchange => { await capture.promise; return { candidates: exchange.user.text.startsWith('Our bird') ? [draft(exchange.user.id, { text: 'Zebrafinch draft note about the household' })] : [] }; };
  const session = randomUUID();
  await chat(app, 'Our bird is quite loud in the mornings.', session);
  const held = app.learning.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(meta.extractions.length, 1, 'capture is running and held');
  const second = await chat(app, 'What else is new?', session);
  assert.equal(second.data.reply, 'Still here.', 'the reply did not wait for the model-backed note writer');
  capture.resolve();
  await held;
  assert.equal(app.learning.status().candidates.pending, 1, 'the draft exists');
  meta.steps.push(async (_input, { instructions }) => {
    assert.equal(instructions.includes('Zebrafinch'), false, 'the main prompt never reads the draft, even in its own conversation');
    return [reply('Quiet.')];
  });
  assert.equal((await chat(app, 'Anything to add?', session)).data.reply, 'Quiet.');

  const hold = deferred();
  meta.consolidate = async batch => { await hold.promise; return createAll(batch); };
  clock.advance(120_000);
  const consolidating = app.learning.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(meta.consolidations.length, 1);
  const other = randomUUID();
  const context = await contextFor(app, 'zebrafinch draft note household', other);
  assert.equal(context.text.includes('Zebrafinch'), false, 'draft text never reaches another conversation');
  assert.equal((await app.memory.execute('memory_search', { query: 'zebrafinch' }, { message: '', session_id: other })).facts.length, 0);
  assert.equal(embedder.embeddedTexts().some(text => text.includes('Zebrafinch draft')), false, 'drafts are never embedded before publication');
  hold.resolve();
  await consolidating;
  assert.equal((await retrieved(app, 'zebrafinch', randomUUID())).length, 1, 'published text becomes searchable only after commit');
});

test('a correction governs the next reply now, stays scoped, and replaces the old value only after close', async t => {
  const meta = scriptedMeta();
  const { app, clock } = await v2App(t, { meta });
  await publishFact({ app, meta, clock }, 'I like my evening lamps at 20 percent.', { attribute: 'living room lamp brightness', conditions: 'evenings', content: 'Evening living room lamp brightness is 20 percent.' });
  const original = currentFacts(app).find(item => item.attribute === 'living room lamp brightness');
  assert.equal(original.version, 1);
  const epoch = app.store.epoch;

  const session = randomUUID();
  const tonight = 'For tonight, make the evening lamps 40 percent.';
  meta.steps.push([saveFact({ content: 'Lamps at 40 percent for tonight only.', attribute: 'living room lamp brightness', conditions: 'evenings', applies: 'this_conversation', source_quote: tonight })], [reply("I'll use 40 percent tonight.")]);
  const first = await chat(app, tonight, session);
  assert.match(first.data.tool_events.find(item => item.tool === 'memory_save_fact').message, /this conversation only/u);

  meta.steps.push(async (_input, { instructions }) => {
    const data = memoryData(instructions);
    assert.equal(data.current_conversation.facts[0].temporal, 'temporary', 'the temporary scope is in the very next request');
    assert.match(data.current_conversation.facts[0].content, /40 percent/u);
    assert.ok(data.retrieved.some(item => item.id === original.id && item.status === 'current'), 'permanent 20 stays in force underneath');
    return [reply('Tonight is 40 percent.')];
  });
  const next = await chat(app, 'Use that for the evening lamps.', session);
  assert.equal(next.data.error, undefined);
  assert.equal(next.data.reply, 'Tonight is 40 percent.');
  assert.equal(currentFacts(app).find(item => item.id === original.id).content, original.content);

  const otherBefore = JSON.parse((await contextFor(app, 'evening lamp brightness')).text);
  assert.equal(JSON.stringify(otherBefore).includes('40 percent'), false, 'another conversation sees only committed memory');

  const ongoing = 'Actually, I want 40 percent every evening from now on.';
  meta.steps.push([saveFact({ content: 'Evening living room lamp brightness is 40 percent.', attribute: 'living room lamp brightness', conditions: 'evenings', source_quote: ongoing, supersedes: original.id })], [reply("I'll use 40 percent in the evenings.")]);
  const correction = await chat(app, ongoing, session);
  assert.match(correction.data.tool_events.find(item => item.tool === 'memory_save_fact').message, /reviewed for permanent memory after/u);
  assert.equal(currentFacts(app).find(item => item.id === original.id).version, 1, 'nothing permanent changed yet');

  meta.consolidate = batch => {
    const correctionNote = batch.candidates.find(item => item.is_correction);
    const temporary = batch.candidates.find(item => item.temporal === 'temporary');
    assert.equal(batch.related_records.find(item => item.id === original.id).version, 1);
    return { operations: [createOperation(temporary, { type: 'episodic' }), createOperation(correctionNote, { op: 'supersede', target_id: original.id, expected_version: 1 })], summary: { text: 'Tried 40 percent for one night, then kept it.', source_ids: correctionNote.source_ids } };
  };
  clock.advance(120_000);
  await app.learning.drain();

  const facts = app.memory.inspect().facts;
  const versions = facts.filter(item => item.id === original.id).sort((a, b) => a.version - b.version);
  assert.deepEqual(versions.map(item => [item.version, item.record_status]), [[1, 'superseded'], [2, 'current']]);
  assert.match(versions[1].content, /40 percent/u);
  assert.deepEqual(versions[0].source_ids, original.source_ids, 'the old version keeps its evidence');
  assert.ok(app.store.snapshot().conversations.some(item => item.id === original.source_ids[0]), 'the original source message survives correction');
  assert.ok(facts.some(item => item.temporal === 'temporary' && item.type === 'episodic' && /tonight/u.test(item.content)), 'the temporary request stays a temporary event');
  assert.equal(app.store.epoch, epoch, 'publication is not a deletion event');
  const after = await retrieved(app, 'evening lamp brightness', randomUUID());
  const semantic = after.filter(item => item.kind === 'record' && item.type === 'semantic');
  assert.deepEqual(semantic.map(item => [item.id, item.version]), [[original.id, 2]], 'only the current version is retrievable');
});

test('segments close on foreground inactivity only, and a resumed chat is protected from the older boundary', async t => {
  const clock = fakeClock();
  const meta = scriptedMeta([[reply('One.')]]);
  const { app } = await v2App(t, { meta, clock });
  const session = randomUUID();
  meta.extract = async exchange => ({ candidates: [draft(exchange.user.id, { text: `Note for ${exchange.user.text}`, evidence_kind: 'direct', source_quote: exchange.user.text })] });
  await chat(app, 'First thing to know.', session);
  await app.learning.tick();
  assert.equal(app.learning.status().segments.open.length, 1);

  // Background work has run, and it did not reset the foreground clock.
  clock.advance(119_999);
  await app.learning.tick();
  assert.equal(app.learning.status().segments.open.length, 1, 'still open before 120 seconds');

  // A request in flight is never closed, however long it runs.
  app.memory.withSession(session, () => app.memory.beginTurn(session, randomUUID()));
  clock.advance(500_000);
  await app.learning.tick();
  assert.equal(app.learning.status().segments.open.length, 1, 'open mid-request');
  app.memory.endTurn(session);
  clock.advance(119_999);
  await app.learning.tick();
  assert.equal(app.learning.status().segments.open.length, 1, 'finishing a request restarts the idle clock');

  // Freeze the boundary while consolidation is held, then resume the chat.
  const hold = deferred();
  const consumed = [];
  meta.consolidate = async batch => { await hold.promise; consumed.push(...batch.candidates.map(item => item.text)); return createAll(batch); };
  clock.advance(1);
  const closing = app.learning.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.learning.status().segments.consolidating[0].close_reason, 'inactivity');
  const boundary = app.learning.status().segments.consolidating[0].boundary_seq;

  meta.steps.push([reply('Two.')]);
  await chat(app, 'Second thing to know.', session);
  assert.equal(app.learning.status().segments.open.length, 1, 'the resumed chat opens a later segment');
  const replayed = memoryHistoryLength(app, session);
  assert.equal(replayed, 2, 'the resumed conversation keeps its earlier context');
  hold.resolve();
  await closing;
  await app.learning.tick();
  assert.deepEqual(consumed, ['Note for First thing to know.'], 'the frozen boundary does not consume the later exchange');
  assert.ok(boundary >= 1);
  assert.equal(app.learning.status().candidates.pending, 1, 'the later note waits for its own segment');

  clock.advance(120_000);
  await app.learning.drain();
  assert.equal(app.learning.status().candidates.pending, 0);
  assert.deepEqual(consumed, ['Note for First thing to know.', 'Note for Second thing to know.']);

  // Explicit close is immediate once idle, and cannot fire mid-request.
  meta.steps.push([reply('Three.')]);
  await chat(app, 'Third thing to know.', session);
  assert.deepEqual(app.learning.requestClose(session), { closed: true });
  await app.learning.drain();
  assert.deepEqual(consumed.at(-1), 'Note for Third thing to know.');
});
const memoryHistoryLength = (app, session) => app.memory.history(session).filter(item => item.role === 'user').length;

test('restarts after append-before-checkpoint and publish-before-ack repeat no model work and duplicate nothing', async t => {
  const directory = await tempDir(t);
  const clock = fakeClock();
  const meta = scriptedMeta([[reply('Okay.')]]);
  meta.extract = async exchange => ({ candidates: [draft(exchange.user.id, { text: 'Alex prefers oat milk.', subject: 'Alex', attribute: 'milk', evidence_kind: 'direct', source_quote: 'Alex prefers oat milk' })] });
  const first = await startApp(t, directory, { meta, clock, failpoints: { 'capture:after-append': () => { throw new Error('simulated crash'); } } });
  await chat(first.app, 'Alex prefers oat milk.');
  await first.app.learning.tick();
  assert.equal(first.app.learning.status().capture_backlog, 1, 'the checkpoint did not advance');
  assert.equal(first.app.learning.status().candidates.pending, 1, 'the append survived');
  await closeApp(first.app);

  clock.advance(10_000);
  const second = await startApp(t, directory, { meta, clock, failpoints: { 'consolidate:after-publish': () => { throw new Error('simulated crash'); } } });
  await second.app.learning.tick();
  assert.equal(meta.extractions.length, 1, 'restart reuses the append instead of extracting again');
  assert.equal(second.app.learning.status().capture_backlog, 0);
  assert.equal(second.app.learning.status().candidates.pending, 1);

  clock.advance(120_000);
  await second.app.learning.drain();
  assert.equal(meta.consolidations.length, 1);
  assert.equal(currentFacts(second.app).filter(item => item.kind !== 'summary').length, 1, 'published');
  assert.equal(second.app.learning.status().candidates.pending, 1, 'not acknowledged yet');
  await closeApp(second.app);

  clock.advance(10_000);
  const third = await startApp(t, directory, { meta, clock });
  await third.app.learning.drain();
  assert.equal(meta.consolidations.length, 1, 'a published proposal is not sent to the model again');
  assert.equal(third.app.memory.inspect().facts.filter(item => item.content === 'Alex prefers oat milk.').length, 1, 'no duplicate fact');
  assert.equal(third.app.learning.status().candidates.pending, 0);
  assert.equal(third.app.learning.status().segments.consolidating.length, 0);
});

test('failed capture and consolidation keep source work and the last committed search state, with bounded retries', async t => {
  const clock = fakeClock();
  const meta = scriptedMeta();
  const { app } = await v2App(t, { meta, clock });
  await publishFact({ app, meta, clock }, 'The kettle lives on the left counter.', { attribute: 'kettle location', content: 'The kettle lives on the left counter.' });

  let extractions = 0;
  meta.extract = async () => { extractions++; throw new Error('outage'); };
  meta.steps.push([reply('Sure.')]);
  const message = 'Our spare key is under the blue pot.';
  await chat(app, message);
  for (let attempt = 0; attempt < 12; attempt++) { clock.advance(700_000); await app.learning.drain(); }
  assert.equal(extractions, 5, 'an outage cannot become a costly loop');
  const status = app.learning.status();
  assert.ok(status.error && status.retry.available, 'the failure is visible and retryable');
  assert.ok(app.store.snapshot().conversations.some(item => item.text === message), 'the source is preserved');
  assert.ok((await retrieved(app, 'kettle location', randomUUID())).some(item => /left counter/u.test(item.text)), 'last committed memory stays usable');

  meta.extract = async exchange => ({ candidates: [draft(exchange.user.id, { text: 'The spare key is under the blue pot.', attribute: 'spare key', evidence_kind: 'direct', source_quote: message })] });
  let failures = 0;
  meta.consolidate = async () => { failures++; throw new Error('outage'); };
  await app.learning.retry();
  clock.advance(1);
  await app.learning.drain();
  assert.equal(app.learning.status().candidates.pending, 1);
  for (let attempt = 0; attempt < 12; attempt++) { clock.advance(700_000); await app.learning.drain(); }
  assert.equal(failures, 5);
  assert.equal(app.learning.status().candidates.pending, 1, 'failed notes stay queued');

  meta.consolidate = createAll;
  await app.learning.retry();
  clock.advance(1);
  await app.learning.drain();
  assert.equal(app.learning.status().candidates.pending, 0);
  assert.ok(currentFacts(app).some(item => /blue pot/u.test(item.content)));
});

test('a saved exchange with no queue row is recovered at startup without reinterpreting the imported archive', async t => {
  const directory = await tempDir(t);
  const clock = fakeClock();
  const meta = scriptedMeta();
  const first = await startApp(t, directory, { meta, clock });
  const session = randomUUID();
  const request = randomUUID();
  // The crash gap: both messages were written and enqueue never ran.
  const user = await first.app.store.recordMessage({ session_id: session, request_id: request, role: 'user', text: 'Our cat is Pixel.' });
  await first.app.store.recordMessage({ session_id: session, request_id: request, role: 'assistant', text: 'Lovely.' });
  assert.equal(first.app.learning.status().capture_backlog, 0);
  await closeApp(first.app);
  const second = await startApp(t, directory, { meta, clock });
  assert.equal(second.app.learning.status().capture_backlog, 1);
  await second.app.learning.drain();
  assert.equal(meta.extractions[0].user.id, user.id);
  await closeApp(second.app);
  const third = await startApp(t, directory, { meta, clock });
  assert.equal(third.app.learning.status().capture_backlog, 0, 'recovered once only');
});

test('capture carries the completed exchange and verified receipts, never Spotify detail', async t => {
  assert.deepEqual(sanitizeOutcomes([{ tool: 'spotify_control', status: 'completed', message: 'Playing Secret Song by Private Artist' }, { tool: 'create_timer', status: 'completed', message: 'Created “tea” for 60 seconds.' }]),
    [{ tool: 'spotify_control', status: 'completed' }, { tool: 'create_timer', status: 'completed', message: 'Created “tea” for 60 seconds.' }]);
  const meta = scriptedMeta([[call('create_timer', { label: 'tea', duration: 1, unit: 'minutes' })], [reply('Your tea timer is set.')]]);
  const { app } = await v2App(t, { meta });
  await chat(app, 'Start a tea timer for 1 minute.');
  await app.learning.drain();
  const [exchange] = meta.extractions;
  assert.equal(exchange.user.text, 'Start a tea timer for 1 minute.');
  assert.match(exchange.assistant.text, /tea timer/u);
  assert.deepEqual(exchange.verified_outcomes.map(item => [item.tool, item.status]), [['create_timer', 'completed']]);
});

test('capture rejects unsupported extractor output and keeps the exchange for retry', async t => {
  const clock = fakeClock();
  const meta = scriptedMeta([[reply('Okay.')]]);
  const { app } = await v2App(t, { meta, clock });
  meta.extract = async exchange => ({ candidates: [draft(exchange.user.id, { evidence_kind: 'direct', source_quote: 'words the user never said' })] });
  await chat(app, 'We are repainting the hall.');
  await app.learning.tick();
  assert.equal(app.learning.status().capture_backlog, 1);
  assert.equal(app.learning.status().candidates.pending, 0);
});

test('an explicit fact saved while a request fails still reaches capture with what actually happened', async t => {
  const meta = scriptedMeta([[saveFact({ content: 'Sam is allergic to peanuts.', subject: 'Sam', attribute: 'allergy', source_quote: 'Sam is allergic to peanuts' })], () => { throw new Error('provider failed'); }]);
  const { app, clock } = await v2App(t, { meta });
  const result = await chat(app, 'Remember Sam is allergic to peanuts.');
  assert.ok(result.data.error);
  clock.advance(120_000);
  await app.learning.drain();
  assert.ok(currentFacts(app).some(item => /peanuts/u.test(item.content) && item.subject === 'Sam'));
});
