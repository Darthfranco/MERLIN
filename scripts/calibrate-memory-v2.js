// Calibrates the v2 semantic cutoff for the configured embedding model on the labeled synthetic set. No Meta calls.
// The cutoff is chosen on one half and reported on the other. Rerun this when the embedding model changes.
// The result is a starting value for that model on invented text, not a recall guarantee for a real household.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction, upsertSearchItem } from '../src/memory-v2/db.js';
import { EmbeddingGate, OllamaEmbedder, cosine, encodeVector } from '../src/memory-v2/embeddings.js';
import { DEFAULT_SEMANTIC_CUTOFF, MAX_ITEMS, Retriever } from '../src/memory-v2/retrieval.js';
import { DISTRACTORS, NEGATIVE_GENERAL, NEGATIVE_HOUSEHOLD, POSITIVE, RECORDS } from './memory-v2-calibration-set.js';

const half = (list, part) => list.filter((_, index) => index % 2 === part);
const percent = value => `${Math.round(value * 100)}%`.padStart(4);
const mean = list => list.reduce((sum, value) => sum + value, 0) / (list.length || 1);
const corpus = [...RECORDS, ...DISTRACTORS];

const embedder = new OllamaEmbedder({ baseUrl: process.env.MERLIN_EMBEDDING_URL || undefined, model: process.env.MERLIN_EMBEDDING_MODEL || undefined });
const gate = new EmbeddingGate(embedder);
const status = await gate.check();
if (!status.ready) { console.log(`NOT READY: ${status.error}`); process.exit(1); }
console.log(`Model: ${status.model}. ${RECORDS.length} labeled records, ${DISTRACTORS.length} distractors, ${POSITIVE.length} answerable queries, ${NEGATIVE_GENERAL.length} general and ${NEGATIVE_HOUSEHOLD.length} household-sounding unanswerable queries.`);

// Stored records embed as `${title}\n${text}`; these have no title.
const { model, vectors, dimensions } = await gate.embedDocuments(corpus.map(text => `\n${text}`));
const scoresFor = async queries => (await gate.embedDocuments(queries)).vectors.map(query => vectors.map(vector => cosine(query, vector)));

const positive = (await scoresFor(POSITIVE.map(([query]) => query))).map((scores, index) => {
  const target = scores[POSITIVE[index][1]];
  return { query: POSITIVE[index][0], scores, target, rank: scores.filter(score => score > target).length + 1 };
});
const negatives = async queries => (await scoresFor(queries)).map((scores, index) => ({ query: queries[index], scores, top: Math.max(...scores) }));
const general = await negatives(NEGATIVE_GENERAL);
const household = await negatives(NEGATIVE_HOUSEHOLD);

const within = (list, k) => list.filter(entry => entry.rank <= k).length / list.length;
console.log(`\nRanking across the whole store: recall@1 ${percent(within(positive, 1))}, @5 ${percent(within(positive, 5))}, @${MAX_ITEMS} ${percent(within(positive, MAX_ITEMS))}.`);
console.log(`Scores: answer mean ${mean(positive.map(entry => entry.target)).toFixed(3)}, lowest ${Math.min(...positive.map(entry => entry.target)).toFixed(3)}. Best false match, general mean ${mean(general.map(entry => entry.top)).toFixed(3)}, household-sounding mean ${mean(household.map(entry => entry.top)).toFixed(3)}.`);

const hits = (list, cutoff) => list.filter(entry => entry.target >= cutoff && entry.rank <= MAX_ITEMS).length;
const falseItems = (list, cutoff) => mean(list.map(entry => entry.scores.filter(score => score >= cutoff).length));
const leak = (list, cutoff) => list.filter(entry => entry.top >= cutoff).length / list.length;
const grid = Array.from({ length: 21 }, (_, index) => 0.3 + index * 0.025);

const parts = { tune: half(positive, 0), holdout: half(positive, 1) };
const negativeParts = { tune: { general: half(general, 0), household: half(household, 0) }, holdout: { general: half(general, 1), household: half(household, 1) } };
console.log('\nSemantic branch alone. Recall needs the answer above the cutoff and in the top 12. "False" is items per unanswerable query.');
console.log('cutoff | tune recall, general false, household false | holdout recall, general false, household false');
for (const cutoff of grid) {
  const row = name => `${percent(hits(parts[name], cutoff) / parts[name].length)} ${falseItems(negativeParts[name].general, cutoff).toFixed(1).padStart(5)} ${falseItems(negativeParts[name].household, cutoff).toFixed(1).padStart(5)}`;
  console.log(`${cutoff.toFixed(3)} | ${row('tune')} | ${row('holdout')}`);
}

// The fixed rule: the highest cutoff that gives up at most one tuning query from the best recall available.
const best = Math.max(...grid.map(cutoff => hits(parts.tune, cutoff)));
const tuned = Math.max(...grid.filter(cutoff => hits(parts.tune, cutoff) >= best - 1));
console.log(`\nChosen on the tuning half: ${tuned.toFixed(3)}. Holdout at that value: recall ${percent(hits(parts.holdout, tuned) / parts.holdout.length)}, general queries returning anything ${percent(leak(negativeParts.holdout.general, tuned))}, household-sounding returning anything ${percent(leak(negativeParts.holdout.household, tuned))}.`);

// The real search path: every branch, fusion, and the item limit, on a throwaway database.
const directory = await mkdtemp(join(tmpdir(), 'merlin-memory-calibration-'));
try {
  const db = openDatabase(join(directory, 'calibration.sqlite'));
  transaction(db, () => corpus.forEach((text, index) => {
    const key = `record:c${index}:1`;
    const hash = upsertSearchItem(db, { key, kind: 'record', ref_id: `c${index}`, ref_version: 1, subject: 'household', text, location: { type: 'semantic' }, updated_at: new Date(0).toISOString() });
    db.prepare('INSERT INTO item_vectors (key, model, text_hash, dimensions, vector) VALUES (?, ?, ?, ?, ?)').run(key, model, hash, dimensions, encodeVector(vectors[index]));
  }));
  const measure = async (label, retriever) => {
    let found = 0;
    for (const [query, target] of POSITIVE) if ((await retriever.search({ query })).items.some(item => item.id === `c${target}`)) found++;
    const items = async list => mean(await Promise.all(list.map(async query => (await retriever.search({ query })).items.length)));
    console.log(`${label.padEnd(28)} answer retrieved ${percent(found / POSITIVE.length)} (${found}/${POSITIVE.length}), items per general query ${(await items(NEGATIVE_GENERAL)).toFixed(1)}, per household-sounding query ${(await items(NEGATIVE_HOUSEHOLD)).toFixed(1)}`);
  };
  console.log('\nFull hybrid search, up to 12 items:');
  await measure('Keyword and entity only', new Retriever({ db, gate: new EmbeddingGate(null) }));
  await measure(`Hybrid at default ${DEFAULT_SEMANTIC_CUTOFF}`, new Retriever({ db, gate, semanticCutoff: DEFAULT_SEMANTIC_CUTOFF }));
  await measure(`Hybrid at chosen ${tuned.toFixed(3)}`, new Retriever({ db, gate, semanticCutoff: tuned }));
  db.close();
} finally { await rm(directory, { recursive: true, force: true }); }

console.log('\nHardest answers:', [...positive].sort((a, b) => b.rank - a.rank).slice(0, 5).map(entry => `#${entry.rank} ${entry.target.toFixed(2)} "${entry.query}"`).join(' | '));
console.log('Closest false matches:', [...household, ...general].sort((a, b) => b.top - a.top).slice(0, 5).map(entry => `${entry.top.toFixed(2)} "${entry.query}"`).join(' | '));
console.log('Invented text and a small store. Treat this as a starting value and recheck it against real use.');
