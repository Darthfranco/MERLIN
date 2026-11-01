import { HOUSEHOLD, VISIBILITY_SHARED, normalizeKey, parse } from './db.js';
import { cosine, decodeVector } from './embeddings.js';
import { qualifierNote } from './documents.js';

export const BRANCH_CAPS = { semantic: 40, keyword: 30, entity: 20, recent: 10 };
export const RRF_K = 60;
export const MAX_ITEMS = 12;
export const RETRIEVED_TOKEN_BUDGET = 4000;
// Chosen by scripts/calibrate-memory-v2.js for this model on invented text, not on household queries.
// Any other model counts as uncalibrated in the inspector. Override with MERLIN_MEMORY_SEMANTIC_CUTOFF.
export const DEFAULT_SEMANTIC_CUTOFF = 0.525;
const CUTOFF_CALIBRATED_MODEL = 'nomic-embed-text';
const STOP_WORDS = new Set('a an and are as at be but by can could do does did for from get give got had has have how i if in is it its just let like make me my no not of on or our please set should so tell than that the their them then there these they this to up us was we were what when where which who why will with would you your'.split(' '));

/** Documented conservative estimate (about three characters per token), not a tokenizer count. */
export const estimateTokens = text => Math.ceil(String(text).length / 3);
export const terms = text => [...new Set(String(text).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].filter(term => term.length > 1 && !STOP_WORDS.has(term));

export function fuseRanks(branches, k = RRF_K) {
  const fused = new Map();
  for (const [branch, keys] of Object.entries(branches)) {
    keys.forEach((key, index) => {
      const entry = fused.get(key) ?? { key, score: 0, branches: [] };
      entry.score += 1 / (k + index + 1);
      entry.branches.push(branch);
      fused.set(key, entry);
    });
  }
  return [...fused.values()].sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
}

export class Retriever {
  #db;
  #gate;
  #cutoff;
  constructor({ db, gate, semanticCutoff = DEFAULT_SEMANTIC_CUTOFF }) { this.#db = db; this.#gate = gate; this.#cutoff = semanticCutoff; }
  get semanticCutoff() { return this.#cutoff; }
  get cutoffCalibration() {
    const model = String(this.#gate.status().configured_model ?? '').replace(/:latest$/u, '');
    return this.#cutoff === DEFAULT_SEMANTIC_CUTOFF && model === CUTOFF_CALIBRATED_MODEL ? 'synthetic_set' : 'none';
  }

  /** Scope goes into every branch's SQL, so an out-of-scope row can never reach ranking. */
  #scope({ household = HOUSEHOLD, viewer = null } = {}) {
    const visibilities = [VISIBILITY_SHARED, ...(viewer ? [`private:${normalizeKey(viewer)}`] : [])];
    return { sql: `household = ? AND visibility IN (${visibilities.map(() => '?').join(', ')})`, args: [household, ...visibilities] };
  }
  #entityMatches(query) {
    const words = normalizeKey(query).replace(/[^\p{L}\p{N}\s'-]/gu, ' ').split(/\s+/u).filter(Boolean);
    const lookup = this.#db.prepare('SELECT entity_id FROM entity_aliases WHERE alias = ?');
    const matched = new Map();
    const ambiguous = [];
    for (let size = 4; size >= 1; size--) {
      for (let start = 0; start + size <= words.length && start < 64; start++) {
        const alias = words.slice(start, start + size).join(' ');
        if (size === 1 && STOP_WORDS.has(alias)) continue;
        const rows = lookup.all(alias);
        if (!rows.length) continue;
        // An alias naming several entities stays ambiguous. Both are candidates and the model must ask.
        if (rows.length > 1) ambiguous.push({ alias, entity_ids: rows.map(row => row.entity_id) });
        for (const row of rows) matched.set(row.entity_id, alias);
      }
    }
    return { entityIds: [...matched.keys()], ambiguous };
  }
  #keyword(query, scope) {
    const list = terms(query).slice(0, 32);
    if (!list.length) return [];
    // Quoted terms keep FTS operators in household text from being interpreted.
    const match = list.map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ');
    return this.#db.prepare(`SELECT search_items.key AS key FROM search_fts JOIN search_items ON search_items.key = search_fts.key
      WHERE search_fts MATCH ? AND ${scope.sql} ORDER BY bm25(search_fts), search_items.key LIMIT ?`).all(match, ...scope.args, BRANCH_CAPS.keyword).map(row => row.key);
  }
  #entity(entityIds, scope) {
    if (!entityIds.length) return [];
    const marks = entityIds.map(() => '?').join(', ');
    return this.#db.prepare(`SELECT search_items.key AS key, COUNT(DISTINCT item_entities.entity_id) AS matched FROM item_entities JOIN search_items ON search_items.key = item_entities.key
      WHERE item_entities.entity_id IN (${marks}) AND ${scope.sql} GROUP BY search_items.key ORDER BY matched DESC, search_items.updated_at DESC, search_items.key LIMIT ?`)
      .all(...entityIds, ...scope.args, BRANCH_CAPS.entity).map(row => row.key);
  }
  /** Only an actually named active subject adds records here. No match means an empty branch, not recent household filler. */
  #recent(entityIds, scope) {
    if (!entityIds.length) return [];
    const names = entityIds.flatMap(id => this.#db.prepare('SELECT alias FROM entity_aliases WHERE entity_id = ?').all(id).map(row => row.alias));
    const marks = names.map(() => '?').join(', ');
    return this.#db.prepare(`SELECT key FROM search_items WHERE kind = 'record' AND lower(subject) IN (${marks}) AND ${scope.sql} ORDER BY updated_at DESC, key LIMIT ?`)
      .all(...names, ...scope.args, BRANCH_CAPS.recent).map(row => row.key);
  }
  #semantic(embedding, scope) {
    if (!embedding) return [];
    const { model, vectors: [query] } = embedding;
    // A bounded full scan, measured and disclosed. There is no ANN index in this prototype.
    const rows = this.#db.prepare(`SELECT search_items.key AS key, vector, dimensions FROM item_vectors JOIN search_items ON search_items.key = item_vectors.key
      WHERE item_vectors.model = ? AND item_vectors.text_hash = search_items.text_hash AND ${scope.sql}`).all(model, ...scope.args);
    return rows.filter(row => row.dimensions === query.length)
      .map(row => ({ key: row.key, score: cosine(query, decodeVector(row.vector)) }))
      .filter(hit => Number.isFinite(hit.score) && hit.score >= this.#cutoff)
      .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key)).slice(0, BRANCH_CAPS.semantic).map(hit => hit.key);
  }
  /** Request-local reuse: the same query text and scope embed once however many model rounds run. */
  async #embedding(queryText, cache, signal) {
    if (!this.#gate.configured) return null;
    const cached = cache?.get(queryText);
    if (cached) return cached;
    const pending = this.#gate.embedQuery(queryText, { signal });
    cache?.set(queryText, pending);
    return pending;
  }

  async search({ query, recent = [], household, viewer, signal, cache, maxItems = MAX_ITEMS, tokenBudget = RETRIEVED_TOKEN_BUDGET }) {
    const started = performance.now();
    const scope = this.#scope({ household, viewer });
    const clean = String(query).slice(0, 2000);
    // Short follow-ups need the prior turn to resolve what they refer to.
    const context = recent.slice(-2).join(' ').slice(-400);
    const prepared = `${clean}${context ? `\n${context}` : ''}`;
    const keywordText = terms(clean).length < 3 ? prepared : clean;
    const { entityIds, ambiguous } = this.#entityMatches(prepared);
    const [semantic, keyword, entity, recentKeys] = await Promise.all([
      this.#embedding(prepared, cache, signal).then(embedding => ({ embedding, keys: this.#semantic(embedding, scope) })),
      Promise.resolve().then(() => this.#keyword(keywordText, scope)),
      Promise.resolve().then(() => this.#entity(entityIds, scope)),
      Promise.resolve().then(() => this.#recent(entityIds, scope)),
    ]);
    const branches = { semantic: semantic.keys, keyword, entity, recent: recentKeys };
    const fused = fuseRanks(branches);
    const items = this.#select(fused, { maxItems, tokenBudget });
    return {
      items, ambiguous, query_chars: prepared.length,
      semantic_state: !this.#gate.configured ? 'unconfigured' : semantic.embedding ? 'ready' : 'degraded',
      counts: Object.fromEntries(Object.entries(branches).map(([name, keys]) => [name, keys.length])),
      estimated_tokens: items.reduce((sum, item) => sum + item.estimated_tokens, 0),
      elapsed_ms: Math.round(performance.now() - started),
    };
  }

  #select(fused, { maxItems, tokenBudget }) {
    const read = this.#db.prepare('SELECT * FROM search_items WHERE key = ?');
    const selected = [];
    const perTopic = new Map();
    let used = 0;
    for (const hit of fused) {
      if (selected.length >= maxItems) break;
      const row = read.get(hit.key);
      if (!row) continue;
      const location = parse(row.location, {});
      // Coverage over repetition: one point cannot crowd out distinct topics.
      const topic = row.kind === 'passage' ? `${row.ref_id}:${location.section}` : `${row.kind}:${row.subject}:${location.attribute || row.ref_id}`;
      const count = perTopic.get(topic) ?? 0;
      if (count >= (row.kind === 'passage' ? 3 : 2)) continue;
      const item = this.#present(row, location, hit);
      if (used + item.estimated_tokens > tokenBudget) continue;
      used += item.estimated_tokens;
      perTopic.set(topic, count + 1);
      selected.push(item);
    }
    return selected;
  }

  #present(row, location, hit) {
    const base = { key: row.key, kind: row.kind, id: row.ref_id, version: row.ref_version, subject: row.subject, title: row.title, score: Number(hit.score.toFixed(5)), branches: hit.branches, updated_at: row.updated_at };
    let item;
    if (row.kind === 'passage') {
      const neighbours = this.#db.prepare(`SELECT text, location FROM search_items WHERE kind = 'passage' AND ref_id = ? AND ref_version = ? AND key != ?`).all(row.ref_id, row.ref_version, row.key)
        .map(entry => ({ text: entry.text, ...parse(entry.location, {}) })).filter(entry => Math.abs(entry.start - location.start) < 2500);
      const note = qualifierNote({ section: location.section, start: location.start }, neighbours);
      item = { ...base, document_title: row.title, section: location.section, start: location.start, end: location.end, ...(location.header ? { table_header: location.header } : {}), text: row.text, ...(note ? { nearby_qualification: note } : {}) };
    } else if (row.kind === 'document') {
      item = { ...base, text: row.text, char_count: location.char_count, status: location.status, outline: location.outline };
    } else if (row.kind === 'routine') {
      // A card explains what exists. It neither carries the executable steps nor authorizes a run.
      item = { ...base, name: row.title, aliases: location.aliases ?? [], purpose: row.text.slice(0, 200), activation_requires_user_intent: true };
    } else {
      item = { ...base, type: location.type, memory_kind: location.memory_kind, text: row.text, attribute: location.attribute, conditions: location.conditions, exceptions: location.exceptions, temporal: location.temporal, event_time: location.event_time, effective_time: location.effective_time, evidence_kind: location.evidence_kind, status: location.status, source_ids: location.source_ids, ...(location.provenance_gap ? { provenance_gap: true } : {}) };
    }
    item.estimated_tokens = estimateTokens(JSON.stringify(item));
    return item;
  }
}
