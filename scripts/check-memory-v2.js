// Readiness and lightweight latency for the v2 memory engine. Synthetic text only; no Meta calls, no household data.
// Part 1 talks to the configured real embedding service. Part 2 measures only local search work, with embedding
// excluded, on a throwaway database. Neither part is a recall guarantee or a scale claim.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction, upsertSearchItem } from '../src/memory-v2/db.js';
import { EmbeddingGate, OllamaEmbedder, cosine, encodeVector } from '../src/memory-v2/embeddings.js';
import { Retriever } from '../src/memory-v2/retrieval.js';
import { validateCandidates, validateProposal } from '../src/memory-v2/validation.js';
import { MetaClient } from '../src/meta.js';

const RECORDS = 'The thermostat stays at 68 degrees overnight.|Recycling goes out on Tuesday mornings.|The spare key is in the blue pot by the door.'.split('|');
const POSITIVE = 'I feel too cold when I go to bed';
const NEGATIVE = 'Which Roman emperor built the longest wall?';

async function checkEmbeddingService() {
  const embedder = new OllamaEmbedder({ baseUrl: process.env.MERLIN_EMBEDDING_URL || undefined, model: process.env.MERLIN_EMBEDDING_MODEL || undefined });
  const gate = new EmbeddingGate(embedder);
  console.log(`Embedding service: ${embedder.baseUrl}, model ${embedder.model}`);
  const status = await gate.check();
  if (!status.ready) {
    console.log(`NOT READY: ${status.error}`);
    console.log(`Semantic retrieval would run degraded. To set it up: install Ollama, run "ollama pull ${embedder.model}", then rerun this check.`);
    return false;
  }
  console.log(`READY: ${status.model}, ${status.dimensions} dimensions.`);
  const { vectors } = await gate.embedDocuments([...RECORDS, POSITIVE, NEGATIVE]);
  const [positive, negative] = vectors.slice(-2);
  const scores = query => RECORDS.map((_, index) => cosine(query, vectors[index]));
  console.log(`Indirect query, best match "${RECORDS[scores(positive).indexOf(Math.max(...scores(positive)))]}":`, scores(positive).map(score => score.toFixed(3)).join(' '));
  console.log('Unrelated query scores:', scores(negative).map(score => score.toFixed(3)).join(' '));
  console.log('Use these scores to calibrate MERLIN_MEMORY_SEMANTIC_CUTOFF. Three sentences cannot establish recall.');
  return scores(positive).indexOf(Math.max(...scores(positive))) === 0;
}

async function measureLocalSearch({ items = 2000, queries = 200, dimensions = 768 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'merlin-memory-check-'));
  try {
    const db = openDatabase(join(directory, 'check.sqlite'));
    const random = () => Array.from({ length: dimensions }, () => Math.random() - 0.5);
    transaction(db, () => {
      for (let index = 0; index < items; index++) {
        const key = `record:r${index}:1`;
        const hash = upsertSearchItem(db, { key, kind: 'record', ref_id: `r${index}`, ref_version: 1, subject: 'household', text: `Synthetic household note number ${index} about topic ${index % 37}.`, location: { type: 'semantic', attribute: `topic ${index % 37}` }, updated_at: new Date(0).toISOString() });
        db.prepare('INSERT INTO item_vectors (key, model, text_hash, dimensions, vector) VALUES (?, ?, ?, ?, ?)').run(key, 'check-model', hash, dimensions, encodeVector(random()));
      }
    });
    const gate = new EmbeddingGate({ provider: 'check', model: 'check-model', embed: async texts => ({ model: 'check-model', vectors: texts.map(random) }) });
    const retriever = new Retriever({ db, gate });
    const times = [];
    for (let index = 0; index < queries; index++) {
      const started = performance.now();
      await retriever.search({ query: `note about topic ${index % 37}` });
      times.push(performance.now() - started);
    }
    times.sort((a, b) => a - b);
    console.log(`Local search, embedding excluded: ${items} items, ${dimensions} dimensions, ${queries} queries, p50 ${times[Math.floor(queries * 0.5)].toFixed(1)} ms, p95 ${times[Math.floor(queries * 0.95)].toFixed(1)} ms. Bounded full vector scan; no ANN index.`);
    db.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** Optional, with --meta: two small paid calls proving the real provider accepts both v2 contracts. Synthetic text only. */
async function checkMeta() {
  const meta = new MetaClient({ apiKey: process.env.META_API_KEY || process.env.MODEL_API_KEY, model: process.env.META_MODEL || 'muse-spark-1.3' });
  if (!meta.configured) { console.log('Meta: not configured, skipped.'); return false; }
  const user = { id: 'synthetic-user-1', text: 'Actually, I want the hall lamp at 40 percent every evening from now on. It used to be 20.', created_at: '2026-11-01T18:00:00.000Z' };
  const raw = await meta.extractCandidates({ user, assistant: { id: 'synthetic-assistant-1', text: 'I will use 40 percent in the evenings.' }, verified_outcomes: [], recent_context: [], already_recorded: [] });
  const candidates = validateCandidates(raw, { userMessages: new Map([[user.id, user.text]]), sourceIds: new Set([user.id, 'synthetic-assistant-1']), hasCompletedOutcome: false });
  console.log(`Meta extraction: ${candidates.length} valid candidate(s).`, candidates.map(({ type, text, attribute, conditions, temporal, is_correction, evidence_kind }) => ({ type, text, attribute, conditions, temporal, is_correction, evidence_kind })));
  const notes = candidates.map((item, index) => ({ id: `synthetic-candidate-${index}`, ...item }));
  if (!notes.length) { console.log('Meta consolidation: skipped, nothing was extracted from a clear correction.'); return false; }
  const record = { id: 'synthetic-record-1', version: 1, type: 'semantic', subject: notes[0].subject, text: 'The hall lamp is set to 20 percent in the evenings.', attribute: notes[0].attribute, conditions: notes[0].conditions, exceptions: '', temporal: 'ongoing', event_time: '', status: 'current' };
  const proposal = await meta.consolidateCandidates({ segment_closed_at: '2026-11-01T18:05:00.000Z', candidates: notes, related_records: [record], sources: [{ id: user.id, role: 'user', text: user.text, created_at: user.created_at }] });
  const checked = validateProposal(proposal, { candidates: new Map(notes.map(item => [item.id, item])), records: new Map([[record.id, record]]), sourceIds: new Set([user.id]) });
  console.log('Meta consolidation:', checked.operations.map(({ op, type, text, target_id, expected_version }) => ({ op, type, text, target_id, expected_version })), 'rejected:', checked.rejected, 'summary:', Boolean(checked.summary));
  console.log('This proves the provider accepts the schemas on one synthetic case. It does not measure extraction quality.');
  return true;
}

const ready = await checkEmbeddingService();
await measureLocalSearch();
const metaOk = process.argv.includes('--meta') ? await checkMeta() : true;
process.exitCode = ready && metaOk ? 0 : 1;
