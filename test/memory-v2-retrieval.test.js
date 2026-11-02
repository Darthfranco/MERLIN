import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ensureEntity, openDatabase, transaction, upsertSearchItem } from '../src/memory-v2/db.js';
import { EmbeddingGate, encodeVector, OllamaEmbedder } from '../src/memory-v2/embeddings.js';
import { chunkDocument } from '../src/memory-v2/documents.js';
import { Retriever, fuseRanks } from '../src/memory-v2/retrieval.js';
import { validateCandidates, validateProposal } from '../src/memory-v2/validation.js';
import { call, chat, contextFor, createOperation, currentFacts, deferred, fakeEmbedder, memoryData, publishFact, reply, retrieved, saveFact, scriptedMeta, v2App } from './memory-v2-helpers.js';

const NOW = '2026-11-01T00:00:00.000Z';
function seed(db, key, fields = {}, entityIds = []) {
  upsertSearchItem(db, { key, kind: 'record', ref_id: key, ref_version: 1, subject: 'household', text: key, updated_at: NOW, location: { type: 'semantic' }, ...fields }, entityIds);
}
function retriever({ embedder = fakeEmbedder() } = {}) {
  const db = openDatabase(':memory:');
  return { db, embedder, retriever: new Retriever({ db, gate: new EmbeddingGate(embedder) }) };
}
async function vectorize(db, embedder, key, text) {
  const { model, vectors } = await embedder.embed([text]);
  const hash = db.prepare('SELECT text_hash FROM search_items WHERE key = ?').get(key).text_hash;
  db.prepare('INSERT INTO item_vectors (key, model, text_hash, dimensions, vector) VALUES (?, ?, ?, ?, ?)').run(key, model, hash, vectors[0].length, encodeVector(vectors[0]));
}

test('reciprocal rank fusion sums 1/(60+rank) with equal branch weights', () => {
  const fused = fuseRanks({ semantic: ['a', 'b'], keyword: ['b', 'c'], entity: ['c'], recent: [] });
  assert.deepEqual(fused.map(item => item.key), ['b', 'c', 'a']);
  assert.equal(fused[0].score, 1 / 62 + 1 / 61);
  assert.equal(fused[1].score, 1 / 62 + 1 / 61);
  assert.deepEqual(fused[0].branches, ['semantic', 'keyword']);
  assert.equal(fused[2].score, 1 / 61);
});

test('each branch contributes on its own, including an indirect-wording match no keyword could find', async () => {
  const { db, embedder, retriever: search } = retriever();
  ensureEntity(db, { name: 'Alex', type: 'person' });
  const lounge = ensureEntity(db, { name: 'Living room', type: 'room', aliases: ['lounge'] });
  seed(db, 'semantic-only', { text: 'The thermostat stays at 72 degrees overnight.' });
  seed(db, 'keyword-only', { text: 'The sourdough starter lives in the fridge.' });
  seed(db, 'entity-only', { text: 'Curtains stay open until noon.' }, [lounge]);
  seed(db, 'recent-only', { subject: 'Alex', text: 'Leaves for work early on Tuesdays.' });
  await vectorize(db, embedder, 'semantic-only', 'The thermostat stays at 72 degrees overnight.');

  const indirect = await search.search({ query: 'I feel chilly at bedtime' });
  assert.deepEqual(indirect.items.map(item => item.key), ['semantic-only']);
  assert.deepEqual(indirect.items[0].branches, ['semantic'], 'no shared words, found by meaning alone');

  assert.deepEqual((await search.search({ query: 'where is the sourdough' })).items.map(item => [item.key, item.branches]), [['keyword-only', ['keyword']]]);
  assert.deepEqual((await search.search({ query: 'tell me about the lounge' })).items.map(item => [item.key, item.branches]), [['entity-only', ['entity']]]);
  assert.deepEqual((await search.search({ query: 'what about Alex' })).items.map(item => [item.key, item.branches]), [['recent-only', ['recent']]]);
});

test('the cutoff counts as calibrated only for the model it was chosen on, at its default value', () => {
  const search = (model, options) => new Retriever({ db: null, gate: new EmbeddingGate(new OllamaEmbedder({ model })), ...options });
  assert.equal(search('nomic-embed-text').cutoffCalibration, 'synthetic_set');
  assert.equal(search('nomic-embed-text:latest').cutoffCalibration, 'synthetic_set');
  assert.equal(search('another-model').cutoffCalibration, 'none');
  assert.equal(search('nomic-embed-text', { semanticCutoff: 0.4 }).cutoffCalibration, 'none');
  assert.equal(new Retriever({ db: null, gate: new EmbeddingGate(null) }).cutoffCalibration, 'none');
});

test('an irrelevant query can stay empty, and the local timer route is not diverted by it', async t => {
  const { db, embedder, retriever: search } = retriever();
  seed(db, 'thermostat', { text: 'The thermostat stays at 72 degrees.' });
  await vectorize(db, embedder, 'thermostat', 'The thermostat stays at 72 degrees.');
  const negative = await search.search({ query: 'quantum zeppelin ballet' });
  assert.deepEqual(negative.items, []);
  assert.equal(negative.counts.semantic, 0, 'below the semantic cutoff');

  const meta = scriptedMeta();
  const { app, clock } = await v2App(t, { meta });
  await publishFact({ app, meta, clock }, 'We keep the thermostat at 68 degrees.', { attribute: 'thermostat', content: 'The thermostat is kept at 68 degrees.' });
  const before = meta.calls.length;
  const result = await chat(app, 'Default timer is five minutes, set me a timer');
  assert.equal(meta.calls.length, before, 'zero foreground model calls with no selected memory');
  assert.equal(result.data.timers.length, 1);
});

test('scope is enforced in every branch before ranking', async () => {
  const { db, embedder, retriever: search } = retriever();
  const sam = ensureEntity(db, { name: 'Sam', type: 'person' });
  seed(db, 'shared', { text: 'The lamp timer note is for everyone.' }, [sam]);
  seed(db, 'private-sam', { text: 'The lamp secret note for Sam.', visibility: 'private:sam', subject: 'Sam' }, [sam]);
  seed(db, 'other-home', { text: 'The lamp note from another home.', household: 'other', subject: 'Sam' }, [sam]);
  for (const [key, text] of [['shared', 'lamp'], ['private-sam', 'lamp'], ['other-home', 'lamp']]) await vectorize(db, embedder, key, text);
  const shared = await search.search({ query: 'Sam lamp' });
  assert.deepEqual(shared.items.map(item => item.key), ['shared']);
  const viewer = await search.search({ query: 'Sam lamp', viewer: 'Sam' });
  assert.deepEqual(viewer.items.map(item => item.key).sort(), ['private-sam', 'shared']);
  assert.equal(viewer.items.some(item => item.key === 'other-home'), false);
});

test('branch caps, the item limit and the estimated token budget all hold', async () => {
  const { db, retriever: search } = retriever();
  transaction(db, () => { for (let index = 0; index < 60; index++) seed(db, `note-${index}`, { text: `Marigold ${'detail '.repeat(index === 0 ? 3 : 200)} ${index}`, location: { type: 'semantic', attribute: `topic-${index}` } }); });
  const result = await search.search({ query: 'marigold' });
  assert.equal(result.counts.keyword, 30);
  assert.ok(result.items.length <= 12);
  assert.ok(result.estimated_tokens <= 4000, 'estimated, conservatively, not counted by a tokenizer');
  const small = await search.search({ query: 'marigold', tokenBudget: 800 });
  assert.ok(small.estimated_tokens <= 800);
});

test('one query embeds once across rounds, and only a changed query embeds again', async t => {
  const meta = scriptedMeta([[call('list_timers', {})], [call('list_timers', {})], [reply('No timers.')]]);
  const { app, embedder } = await v2App(t, { meta });
  await chat(app, 'Which timers are running for the warm kettle?');
  assert.equal(meta.calls.length, 3);
  const queryCalls = embedder.calls.filter(item => item.kind === 'query' && item.texts[0].includes('warm kettle'));
  assert.equal(queryCalls.length, 1, 'three model rounds, one query embedding');

  const { db, retriever: search, embedder: direct } = retriever();
  seed(db, 'item', { text: 'kettle' });
  const cache = new Map();
  await search.search({ query: 'kettle', cache });
  await search.search({ query: 'kettle', cache });
  await search.search({ query: 'warm thermostat', cache });
  assert.deepEqual(direct.calls.map(item => item.texts[0]), ['kettle', 'warm thermostat']);
});

test('incompatible vectors are never compared, and invalid ones are refused', async () => {
  const { db, retriever: search } = retriever();
  const other = fakeEmbedder({ model: 'other-model-v9' });
  const wide = fakeEmbedder({ dimensions: 100 });
  seed(db, 'other-model', { text: 'alpha' });
  seed(db, 'wrong-dimensions', { text: 'beta' });
  await vectorize(db, other, 'other-model', 'lamp');
  // Same model name, stale width: stored from an earlier configuration.
  const { vectors } = await wide.embed(['lamp']);
  const hash = db.prepare('SELECT text_hash FROM search_items WHERE key = ?').get('wrong-dimensions').text_hash;
  db.prepare('INSERT INTO item_vectors (key, model, text_hash, dimensions, vector) VALUES (?, ?, ?, ?, ?)').run('wrong-dimensions', 'test-embedder-v1', hash, 100, encodeVector(vectors[0]));
  assert.deepEqual((await search.search({ query: 'lamp brightness' })).items, []);

  for (const bad of [[[1, Number.NaN]], [[0, 0]], [[1, 2], [1]], []]) {
    const gate = new EmbeddingGate({ provider: 'test', model: 'm', embed: async () => ({ model: 'm', vectors: bad }) });
    assert.equal(await gate.embedQuery('x'), null);
    assert.equal(gate.status().ready, false);
  }
  const unnamed = new EmbeddingGate({ provider: 'test', model: 'm', embed: async () => ({ vectors: [[1, 2]] }) });
  assert.equal(await unnamed.embedQuery('x'), null);
});

test('a text edit makes its old vector unusable until reindexed', async () => {
  const { db, embedder, retriever: search } = retriever();
  seed(db, 'item', { text: 'The lamp is on the desk.' });
  await vectorize(db, embedder, 'item', 'The lamp is on the desk.');
  seed(db, 'item', { text: 'Replaced wording without that topic.' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM item_vectors').get().n, 0);
  assert.equal((await search.search({ query: 'brightness' })).counts.semantic, 0);
});

test('an embedding outage degrades semantic search only; lexical and entity search keep working, and it is reported', async t => {
  const embedder = fakeEmbedder();
  const meta = scriptedMeta();
  const { app, clock } = await v2App(t, { meta, embedder });
  await publishFact({ app, meta, clock }, 'Our boiler is serviced in March.', { attribute: 'boiler service', content: 'The boiler is serviced in March.' });
  embedder.failing = true;
  const context = await contextFor(app, 'when is the boiler serviced');
  assert.equal(context.stats.semantic_state, 'degraded');
  assert.ok(JSON.parse(context.text).retrieved.some(item => /boiler/u.test(item.text)));
  assert.equal(app.learning.status().semantic.state, 'degraded');
  assert.equal(app.learning.status().semantic.ready, false);
});

test('semantic status says checking until the first check finishes, so a normal start is not reported as degraded', async t => {
  const embedder = fakeEmbedder();
  const firstCheck = deferred();
  const embed = embedder.embed;
  embedder.embed = async (...args) => { await firstCheck.promise; return embed(...args); };
  const { app } = await v2App(t, { meta: scriptedMeta(), embedder });
  assert.equal(app.learning.status().semantic.state, 'checking');
  firstCheck.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.learning.status().semantic.state, 'ready');
});

test('the Ollama adapter uses the documented endpoints and pins model identity', async () => {
  const requests = [];
  const embedder = new OllamaEmbedder({ baseUrl: 'http://127.0.0.1:11434/', model: 'nomic-embed-text', fetchImpl: async (url, init = {}) => {
    requests.push([url, init.method ?? 'GET', init.body ? JSON.parse(init.body) : null]);
    return url.endsWith('/api/tags') ? { ok: true, json: async () => ({ models: [{ name: 'nomic-embed-text:latest', digest: 'abc123' }] }) } : { ok: true, json: async () => ({ embeddings: [[0.1, 0.2]] }) };
  } });
  const gate = new EmbeddingGate(embedder);
  const result = await gate.embedQuery('hello');
  assert.equal(result.model, 'ollama:nomic-embed-text:latest@abc123');
  assert.deepEqual(requests[1], ['http://127.0.0.1:11434/api/embed', 'POST', { model: 'nomic-embed-text', input: ['hello'] }]);
  const missing = new EmbeddingGate(new OllamaEmbedder({ fetchImpl: async () => ({ ok: true, json: async () => ({ models: [] }) }) }));
  assert.equal(await missing.embedQuery('x'), null);
  assert.match(missing.status().error, /not installed/u);
});

test('people, conditions and events stay distinct through validated consolidation', () => {
  const candidate = (id, overrides = {}) => ({ id, source_ids: [`s-${id}`], subject: 'Alex', type: 'semantic', text: `Text ${id}`, attribute: 'lamp brightness', conditions: '', exceptions: '', event_time: '', temporal: 'ongoing', is_correction: false, evidence_kind: 'direct', source_quote: 'q', ...overrides });
  const record = { id: 'r1', version: 3, type: 'semantic', subject: 'Alex', text: 'Alex likes 20 percent.', attribute: 'lamp brightness', conditions: '', status: 'current', event_time: '' };
  const run = (candidates, operations) => validateProposal({ operations, summary: null }, { candidates: new Map(candidates.map(item => [item.id, item])), records: new Map([['r1', record]]), sourceIds: new Set(candidates.flatMap(item => item.source_ids)) });

  // Temporary versus ongoing.
  const temporary = candidate('a', { temporal: 'temporary', is_correction: true });
  assert.match(run([temporary], [createOperation(temporary, { op: 'supersede', type: 'semantic', target_id: 'r1', expected_version: 3 })]).rejected[0].reason, /temporary/u);
  const onceOnly = run([temporary], [createOperation(temporary, { type: 'semantic' })]).operations[0];
  assert.deepEqual([onceOnly.op, onceOnly.type, onceOnly.temporal], ['create', 'episodic', 'temporary'], 'tonight becomes an event, not a preference');

  // A supersede needs an explicit ongoing correction of the same point.
  const plain = candidate('b');
  assert.match(run([plain], [createOperation(plain, { op: 'supersede', target_id: 'r1', expected_version: 3 })]).rejected[0].reason, /explicit ongoing correction/u);
  const explicit = candidate('c', { is_correction: true });
  assert.equal(run([explicit], [createOperation(explicit, { op: 'supersede', target_id: 'r1', expected_version: 3 })]).operations[0].op, 'supersede');
  const otherPerson = candidate('d', { is_correction: true, subject: 'Sam' });
  assert.match(run([otherPerson], [createOperation(otherPerson, { op: 'supersede', target_id: 'r1', expected_version: 3 })]).rejected[0].reason, /match the subject/u, 'one person cannot overwrite another');
  const conditional = candidate('e', { is_correction: true, conditions: 'evenings' });
  assert.match(run([conditional], [createOperation(conditional, { op: 'supersede', target_id: 'r1', expected_version: 3 })]).rejected[0].reason, /conditions/u);

  // Compatible conditions coexist; a contradiction without a correction stays unresolved; a duplicate merges.
  assert.equal(run([conditional], [createOperation(conditional, { is_correction: undefined })]).operations[0].op, 'create');
  const clash = candidate('f', { text: 'Alex likes 90 percent.' });
  assert.equal(run([clash], [createOperation(clash)]).operations[0].op, 'unresolved');
  const same = candidate('g', { text: 'Alex likes 20 percent.' });
  assert.deepEqual([run([same], [createOperation(same)]).operations[0].op, run([same], [createOperation(same)]).operations[0].target_id], ['merge', 'r1']);

  // Evidence never becomes authority.
  const suggestion = candidate('h', { evidence_kind: 'assistant_suggestion', attribute: 'tea' });
  assert.match(run([suggestion], [createOperation(suggestion)]).rejected[0].reason, /suggestion or external/u);
  const external = candidate('i', { evidence_kind: 'external', attribute: 'tea' });
  assert.match(run([external], [createOperation(external)]).rejected[0].reason, /suggestion or external/u);
  const action = candidate('j', { evidence_kind: 'verified_result', attribute: 'tea' });
  assert.match(run([action], [createOperation(action)]).rejected[0].reason, /verified action alone/u);
  assert.equal(run([action], [createOperation(action, { type: 'episodic' })]).operations[0].evidence_kind, 'verified_result');
  const guess = candidate('k', { evidence_kind: 'inference', attribute: 'tea' });
  assert.equal(run([guess], [createOperation(guess)]).operations[0].op, 'unresolved');
  assert.equal(run([guess], [createOperation(guess, { profile: true, memory_kind: 'guidance' })]).operations[0].profile, false);
  assert.equal(run([guess], [createOperation(guess, { memory_kind: 'guidance' })]).operations[0].memory_kind, null, 'an inference cannot become always-read guidance');

  // Grounding.
  assert.match(run([plain], [createOperation(plain, { source_ids: ['elsewhere'] })]).rejected[0].reason, /source outside/u);
  assert.match(run([plain], [{ ...createOperation(plain), candidate_ids: ['nope'] }]).rejected[0].reason, /outside this batch/u);
  assert.equal(run([plain], [createOperation(plain, { attribute: 'other' }), createOperation(plain, { attribute: 'other' })]).rejected.length, 1, 'a candidate is consumed once');
  const episode = candidate('l', { type: 'episodic', attribute: '', event_time: '2026-10-01' });
  assert.match(run([episode], [createOperation(episode, { op: 'merge', target_id: 'r1', expected_version: 3 })]).rejected[0].reason, /record type/u);
});

test('extractor output needs real evidence', () => {
  const base = { type: 'semantic', text: 'T', subject: 'household', attribute: '', conditions: '', exceptions: '', event_time: '', temporal: 'unknown', is_correction: false, evidence_kind: 'direct', source_ids: ['u'], source_quote: 'exact words' };
  const context = { userMessages: new Map([['u', 'these exact words here']]), sourceIds: new Set(['u', 'a']), hasCompletedOutcome: false };
  assert.equal(validateCandidates({ candidates: [base] }, context).length, 1);
  assert.deepEqual(validateCandidates({ candidates: [] }, context), [], 'no durable information means zero candidates');
  for (const bad of [{ source_quote: 'not said' }, { source_ids: ['unknown'] }, { source_ids: ['a'], source_quote: 'exact words' }, { evidence_kind: 'verified_result', type: 'episodic' }, { is_correction: true, evidence_kind: 'inference' }, { type: 'rule' }, { text: '' }]) {
    assert.throws(() => validateCandidates({ candidates: [{ ...base, ...bad }] }, context), undefined, JSON.stringify(bad));
  }
  assert.throws(() => validateCandidates({ candidates: Array(7).fill(base) }, context));
});

test('two people keep separate preferences, ambiguous names stay ambiguous, and identical events stay separate', async t => {
  const meta = scriptedMeta();
  const { app, clock } = await v2App(t, { meta });
  await publishFact({ app, meta, clock }, 'Alex takes coffee black.', { subject: 'Alex', attribute: 'coffee', content: 'Alex takes coffee black.' });
  await publishFact({ app, meta, clock }, 'Sam takes coffee with oat milk.', { subject: 'Sam', attribute: 'coffee', content: 'Sam takes coffee with oat milk.' });
  const facts = currentFacts(app).filter(item => item.attribute === 'coffee');
  assert.equal(facts.length, 2, 'different subjects do not conflict');
  const forSam = await retrieved(app, 'How does Sam take coffee?');
  assert.equal(forSam[0].subject, 'Sam');

  // Same words, separate occasions.
  const session = randomUUID();
  meta.steps.push([reply('Okay.')]);
  meta.extract = async exchange => ({ candidates: [{ type: 'episodic', text: 'The hall smoke alarm went off.', subject: 'household', attribute: 'smoke alarm', conditions: '', exceptions: '', event_time: '2026-10-02', temporal: 'ongoing', is_correction: false, evidence_kind: 'direct', source_ids: [exchange.user.id], source_quote: exchange.user.text }] });
  await chat(app, 'The smoke alarm went off in the hall.', session);
  meta.steps.push([reply('Okay.')]);
  await chat(app, 'The smoke alarm went off in the hall again.', session);
  clock.advance(120_000);
  await app.learning.drain();
  assert.equal(currentFacts(app).filter(item => item.content === 'The hall smoke alarm went off.').length, 2);

  // An alias shared by two people is reported, and both remain candidates.
  const { db } = app.engine;
  ensureEntity(db, { name: 'Sam Lee', type: 'person', aliases: ['Sammy'] });
  ensureEntity(db, { name: 'Sam Park', type: 'person', aliases: ['Sammy'] });
  const data = JSON.parse((await contextFor(app, 'What does Sammy like?')).text);
  assert.deepEqual(data.ambiguous_names, ['sammy']);
});

test('unresolved contradictions are not presented as a certain current fact', async t => {
  const meta = scriptedMeta();
  const { app, clock } = await v2App(t, { meta });
  await publishFact({ app, meta, clock }, 'Bedtime is at nine.', { attribute: 'bedtime', content: 'Bedtime is at nine.' });
  await publishFact({ app, meta, clock }, 'Bedtime is at eleven.', { attribute: 'bedtime', content: 'Bedtime is at eleven.' });
  const results = await retrieved(app, 'What time is bedtime?');
  const statuses = results.filter(item => item.kind === 'record' && /Bedtime/u.test(item.text)).map(item => [item.text, item.status]).sort();
  assert.deepEqual(statuses, [['Bedtime is at eleven.', 'unresolved'], ['Bedtime is at nine.', 'current']]);
});

test('a concurrent version change is retried from current state rather than overwritten', async t => {
  const meta = scriptedMeta();
  const { app, clock } = await v2App(t, { meta });
  await publishFact({ app, meta, clock }, 'Dinner is at six.', { attribute: 'dinner time', content: 'Dinner is at six.' });
  const original = currentFacts(app).find(item => item.attribute === 'dinner time');
  const message = 'Actually dinner is at seven from now on.';
  meta.steps.push([saveFact({ content: 'Dinner is at seven.', attribute: 'dinner time', source_quote: message, supersedes: original.id })], [reply('Dinner at seven.')]);
  await chat(app, message);
  let attempts = 0;
  meta.consolidate = async batch => {
    attempts++;
    const note = batch.candidates[0];
    const target = batch.related_records.find(item => item.id === original.id);
    // The first proposal is overtaken by an owner edit before it can commit.
    if (attempts === 1) await app.memory.putManualFact({ id: original.id, content: 'Dinner is at half past six.', subject: 'household', kind: 'fact' });
    return { operations: [createOperation(note, { op: 'supersede', target_id: original.id, expected_version: target.version })], summary: { text: 'Dinner changed.', source_ids: note.source_ids } };
  };
  clock.advance(120_000);
  await app.learning.drain();
  assert.equal(currentFacts(app).find(item => item.id === original.id).content, 'Dinner is at half past six.', 'the stale proposal did not win');
  clock.advance(10_000);
  await app.learning.drain();
  assert.equal(attempts, 2, 'retried from current state');
  const versions = app.memory.inspect().facts.filter(item => item.id === original.id);
  assert.deepEqual(versions.map(item => item.version).sort(), [1, 2, 3]);
  assert.equal(currentFacts(app).find(item => item.id === original.id).content, 'Dinner is at seven.');
});

test('explicit saves are told honestly that they are not permanent yet', async t => {
  const meta = scriptedMeta([async (_input, { instructions, tools }) => {
    assert.match(tools.find(tool => tool.name === 'memory_save_fact').description, /not permanent yet/u);
    assert.match(tools.find(tool => tool.name === 'memory_save_rule').description, /not permanent yet/u);
    assert.doesNotMatch(tools.find(tool => tool.name === 'memory_save_fact').description, /Immediately save/u);
    assert.match(instructions, /until after the conversation closes/u);
    assert.ok(memoryData(instructions));
    return [reply('Hello.')];
  }]);
  const { app } = await v2App(t, { meta });
  await chat(app, 'Hello there.');
});

test('document chunking keeps exact text, offsets and table headers', () => {
  const content = `# Plan\n\nIntro.\n\n## Rates\n\n| Item | Price |\n|---|---|\n${Array.from({ length: 60 }, (_, index) => `| Row ${index} | ${index} dollars |`).join('\n')}\n\n## End\n\nDone.`;
  const passages = chunkDocument(content);
  assert.ok(passages.length > 2);
  for (const passage of passages) assert.equal(content.slice(passage.start, passage.end), passage.text, 'an exact slice of the source');
  const later = passages.find(passage => passage.section === 'Rates' && passage.text.includes('Row 50'));
  assert.equal(later.header, '| Item | Price |');
});
