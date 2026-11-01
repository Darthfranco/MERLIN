import { randomUUID } from 'node:crypto';
import { normalizeRule } from '../memory-rules.js';
import { isSpotifyTool } from '../spotify-tools.js';
import { HOUSEHOLD, bumpDeletionGeneration, deletionGeneration, ensureEntity, getMeta, normalizeKey, parse, recordKey, removeSearchItem, sha, toRecord, transaction, upsertSearchItem } from './db.js';
import { encodeVector } from './embeddings.js';
import { chunkDocument, outline } from './documents.js';
import { currentVersion, latestVersion, retireVersion, textHash, writeRecordVersion } from './records.js';
import { terms } from './retrieval.js';
import { validateCandidates, validateProposal } from './validation.js';

export const CLOSE_AFTER_MS = 120_000;
const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 600_000;
const MAX_BATCH_CANDIDATES = 20;
const RECENT_SOURCE_MESSAGES = 6;
const RECENT_SOURCE_CHARS = 6_000;
const SOURCE_CHARS = 12_000;
const VECTOR_BATCH = 32;
const ERROR_MESSAGE = 'Background memory learning could not finish. Saved conversation is intact. Retry learning from the memory panel.';
const backoff = attempts => Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1));
const iso = ms => new Date(ms).toISOString();

/** Only fixed outcome receipts reach capture. Spotify keeps tool and status only, with no text at all. */
export function sanitizeOutcomes(events = []) {
  return events.filter(event => event && typeof event.tool === 'string').slice(0, 20).map(event => ({
    tool: event.tool, status: event.status === 'completed' ? 'completed' : 'failed',
    ...(isSpotifyTool(event.tool) || typeof event.message !== 'string' ? {} : { message: event.message.slice(0, 300) }),
  }));
}

/** Segments, capture, consolidation and background indexing. The live path never awaits any of it. */
export class MemoryLifecycle {
  #db; #store; #meta; #gate; #clock; #closeAfterMs; #failpoints; #interval; #onDeletionSweep;
  #active = new Map();
  #running = null;
  #again = false;
  #closed = false;
  #autoRun;
  #vectorRetryAt = 0;
  #routines = null;
  #documentsDirty = true;

  constructor({ db, store, meta, gate, clock = Date.now, closeAfterMs = CLOSE_AFTER_MS, tickMs = 1000, failpoints = {}, onDeletionSweep }) {
    this.#db = db; this.#store = store; this.#meta = meta; this.#gate = gate; this.#clock = clock; this.#closeAfterMs = closeAfterMs;
    this.#failpoints = failpoints; this.#onDeletionSweep = onDeletionSweep; this.#autoRun = tickMs > 0;
    if (this.#autoRun) { this.#interval = setInterval(() => { void this.tick().catch(() => {}); }, tickMs); this.#interval.unref?.(); }
  }
  attachRoutines(routineStore) { this.#routines = routineStore; }
  #now() { return iso(this.#clock()); }
  async #fail(point) { await this.#failpoints[point]?.(); }
  get #foregroundBusy() { return [...this.#active.values()].some(count => count > 0); }

  // ---- Foreground clock. Background work never touches last_activity_ms. ----
  #openSegment(sessionId) {
    const open = this.#db.prepare(`SELECT id FROM segments WHERE session_id = ? AND status = 'open' ORDER BY opened_at DESC LIMIT 1`).get(sessionId);
    if (open) return open.id;
    const id = randomUUID();
    this.#db.prepare(`INSERT INTO segments (id, session_id, status, opened_at, last_activity_ms) VALUES (?, ?, 'open', ?, ?)`).run(id, sessionId, this.#now(), this.#clock());
    return id;
  }
  #touch(sessionId) {
    const id = this.#openSegment(sessionId);
    this.#db.prepare('UPDATE segments SET last_activity_ms = ? WHERE id = ?').run(this.#clock(), id);
    return id;
  }
  beginRequest(sessionId) { this.#active.set(sessionId, (this.#active.get(sessionId) ?? 0) + 1); this.#touch(sessionId); }
  endRequest(sessionId) {
    const next = (this.#active.get(sessionId) ?? 1) - 1;
    if (next > 0) this.#active.set(sessionId, next); else this.#active.delete(sessionId);
    this.#touch(sessionId);
    this.#documentsDirty = true;
    this.#kick();
  }
  documentsChanged() { this.#documentsDirty = true; this.#kick(); }
  /** Explicit operational close. A request still running closes as soon as it finishes. */
  requestClose(sessionId) {
    const open = this.#db.prepare(`SELECT id FROM segments WHERE session_id = ? AND status = 'open'`).get(sessionId);
    if (!open) return { closed: false };
    this.#db.prepare('UPDATE segments SET close_requested = 1 WHERE id = ?').run(open.id);
    this.#kick();
    return { closed: !this.#active.get(sessionId) };
  }
  #closeDue() {
    const now = this.#clock();
    for (const segment of this.#db.prepare(`SELECT * FROM segments WHERE status = 'open'`).all()) {
      if (this.#active.get(segment.session_id)) continue;
      const idle = now - segment.last_activity_ms >= this.#closeAfterMs;
      if (!idle && !segment.close_requested) continue;
      const boundary = this.#db.prepare('SELECT MAX(seq) AS seq FROM exchanges WHERE segment_id = ?').get(segment.id).seq;
      this.#db.prepare('UPDATE segments SET status = ?, boundary_seq = ?, close_reason = ?, closed_at = ? WHERE id = ?')
        .run(boundary === null ? 'done' : 'closed', boundary, segment.close_requested ? 'explicit' : 'inactivity', iso(now), segment.id);
    }
  }

  // ---- Durable enqueue on the reply path: one small synchronous local write. ----
  async enqueue(source, { request_id, session_id, assistant_source_id = null, tool_events = [], skip = false } = {}) {
    const sessionId = session_id ?? source.session_id;
    const requestId = request_id ?? source.request_id;
    const seq = transaction(this.#db, () => {
      const existing = this.#db.prepare('SELECT seq FROM exchanges WHERE request_id = ?').get(requestId);
      if (existing) return existing.seq;
      const now = this.#now();
      return Number(this.#db.prepare(`INSERT INTO exchanges (session_id, request_id, user_source_id, assistant_source_id, outcomes, segment_id, completed_at, captured_at, skip)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(sessionId, requestId, source.id, assistant_source_id, JSON.stringify(sanitizeOutcomes(tool_events)), this.#openSegment(sessionId), now, skip ? now : null, skip ? 1 : 0).lastInsertRowid);
    });
    this.#kick();
    return { queued: !skip, seq };
  }
  /** Closes the save/enqueue crash gap without reinterpreting the imported archive. */
  reconcileCompleted() {
    const cutoff = getMeta(this.#db, 'rollback_cutoff') ?? '';
    const messages = this.#store.snapshot().conversations.filter(item => item.created_at > cutoff);
    const replies = new Map(messages.filter(item => item.role === 'assistant').map(item => [item.request_id, item]));
    const known = this.#db.prepare('SELECT 1 FROM exchanges WHERE request_id = ?');
    const controls = this.#db.prepare(`SELECT 1 FROM control_items WHERE request_id = ? AND kind != 'statement' LIMIT 1`);
    let recovered = 0;
    for (const message of messages) {
      if (message.role !== 'user' || known.get(message.request_id)) continue;
      const reply = replies.get(message.request_id);
      if (!reply && !controls.get(message.request_id)) continue;
      this.enqueue(message, { assistant_source_id: reply?.id ?? null });
      recovered++;
    }
    return recovered;
  }

  // ---- Worker: one job at a time, and it yields to any foreground request between jobs. ----
  #kick() { if (this.#autoRun && !this.#closed) setTimeout(() => { void this.tick().catch(() => {}); }, 0).unref?.(); }
  async tick() {
    if (this.#closed) return;
    this.#closeDue();
    await this.#pump();
  }
  #pump() {
    if (this.#running) { this.#again = true; return this.#running; }
    this.#running = (async () => {
      do { this.#again = false; await this.#work(); } while (this.#again && !this.#closed);
    })().finally(() => { this.#running = null; });
    return this.#running;
  }
  async #work() {
    if (this.#documentsDirty) { this.#documentsDirty = false; this.#syncDocuments(); }
    while (!this.#closed && !this.#foregroundBusy) {
      const job = this.#nextCapture() ?? this.#nextConsolidation() ?? this.#nextDocument() ?? this.#nextVectors();
      if (!job) return;
      await job();
    }
  }
  async drain() { await this.tick(); await this.#running; return this.status(); }
  async close() {
    if (this.#closed) { await this.#running; return; }
    this.#closed = true; clearInterval(this.#interval);
    await this.#running;
    this.#db.close();
  }

  // ---- Capture ----
  #nextCapture() {
    if (!this.#meta?.configured || typeof this.#meta.extractCandidates !== 'function') return null;
    const row = this.#db.prepare('SELECT * FROM exchanges WHERE captured_at IS NULL AND failed = 0 AND next_attempt_at <= ? ORDER BY seq LIMIT 1').get(this.#clock());
    return row && (() => this.#capture(row));
  }
  async #capture(exchange) {
    const generation = deletionGeneration(this.#db);
    try {
      const appended = this.#db.prepare('SELECT COUNT(*) AS n FROM candidates WHERE exchange_seq = ?').get(exchange.seq).n > 0;
      if (!appended) {
        const snapshot = this.#store.snapshot();
        const user = snapshot.conversations.find(item => item.id === exchange.user_source_id && item.role === 'user');
        if (!user) { this.#db.prepare('DELETE FROM exchanges WHERE seq = ?').run(exchange.seq); return; }
        const assistant = snapshot.conversations.find(item => item.id === exchange.assistant_source_id);
        const prior = snapshot.conversations.filter(item => item.session_id === exchange.session_id && item.request_id !== exchange.request_id && item.created_at <= user.created_at).slice(-RECENT_SOURCE_MESSAGES);
        const recent = []; let budget = RECENT_SOURCE_CHARS;
        for (const item of prior.reverse()) { if (item.text.length > budget) break; budget -= item.text.length; recent.unshift({ id: item.id, role: item.role, text: item.text, created_at: item.created_at }); }
        const explicit = this.#db.prepare(`SELECT * FROM control_items WHERE request_id = ? AND kind != 'statement' AND status = 'active'`).all(exchange.request_id).map(row => ({ ...row, data: parse(row.data, {}) }));
        const outcomes = parse(exchange.outcomes, []);
        const payload = { user: { id: user.id, text: user.text, created_at: user.created_at }, assistant: assistant ? { id: assistant.id, text: assistant.text } : null, verified_outcomes: outcomes, recent_context: recent,
          already_recorded: explicit.map(item => ({ kind: item.kind, text: item.data.content ?? item.data.explanation })) };
        const raw = await this.#meta.extractCandidates(payload);
        // A deletion during that call makes its output stale. The next pass re-reads what survives.
        if (this.#closed || deletionGeneration(this.#db) !== generation) return;
        const sources = [user, ...(assistant ? [assistant] : []), ...recent];
        const extracted = validateCandidates(raw, { userMessages: new Map(sources.filter(item => item.role === 'user').map(item => [item.id, item.text])), sourceIds: new Set(sources.map(item => item.id)), hasCompletedOutcome: outcomes.some(item => item.status === 'completed') });
        transaction(this.#db, () => {
          if (!this.#db.prepare('SELECT 1 FROM exchanges WHERE seq = ?').get(exchange.seq)) return;
          const insert = this.#db.prepare(`INSERT OR IGNORE INTO candidates (id, session_id, exchange_seq, source_ids, household, subject, type, text, attribute, conditions, exceptions, event_time, temporal, is_correction, evidence_kind, payload, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
          const now = this.#now();
          extracted.forEach((item, index) => insert.run(`cand:${exchange.seq}:${index}`, exchange.session_id, exchange.seq, JSON.stringify(item.source_ids), HOUSEHOLD, item.subject, item.type, item.text, item.attribute, item.conditions, item.exceptions, item.event_time, item.temporal, item.is_correction ? 1 : 0, item.evidence_kind, JSON.stringify({ source_quote: item.source_quote }), now));
          for (const control of explicit) {
            const data = control.data;
            if (control.kind === 'rule') insert.run(`cand:${exchange.seq}:ctl:${control.id}`, exchange.session_id, exchange.seq, JSON.stringify([control.source_id]), HOUSEHOLD, 'household', 'rule', data.explanation, data.kind, '', '', '', data.applies === 'this_conversation' ? 'temporary' : 'ongoing', 0, 'direct', JSON.stringify({ rule: data.rule_args, source_quote: data.source_quote }), now);
            else insert.run(`cand:${exchange.seq}:ctl:${control.id}`, exchange.session_id, exchange.seq, JSON.stringify([control.source_id]), HOUSEHOLD, data.subject, data.temporal === 'temporary' ? 'episodic' : 'semantic', data.content, data.attribute ?? '', data.conditions ?? '', '', '', data.temporal, data.supersedes ? 1 : 0, 'direct', JSON.stringify({ source_quote: data.source_quote, memory_kind: data.kind, reason: data.reason, target_hint: data.supersedes ?? '' }), now);
          }
        });
        await this.#fail('capture:after-append');
      }
      this.#db.prepare('UPDATE exchanges SET captured_at = ?, attempts = 0 WHERE seq = ?').run(this.#now(), exchange.seq);
    } catch {
      const attempts = exchange.attempts + 1;
      this.#db.prepare('UPDATE exchanges SET attempts = ?, next_attempt_at = ?, failed = ? WHERE seq = ?').run(attempts, this.#clock() + backoff(attempts), attempts >= MAX_ATTEMPTS ? 1 : 0, exchange.seq);
    }
  }

  // ---- Consolidation ----
  #nextConsolidation() {
    if (!this.#meta?.configured || typeof this.#meta.consolidateCandidates !== 'function') return null;
    const segments = this.#db.prepare(`SELECT * FROM segments WHERE status = 'closed' AND failed = 0 AND next_attempt_at <= ? ORDER BY boundary_seq`).all(this.#clock());
    for (const segment of segments) {
      // The boundary waits, in the background, until capture has covered it.
      const uncaptured = this.#db.prepare('SELECT COUNT(*) AS n FROM exchanges WHERE segment_id = ? AND seq <= ? AND captured_at IS NULL').get(segment.id, segment.boundary_seq).n;
      if (!uncaptured) return () => this.#consolidate(segment);
    }
    return null;
  }
  #pendingCandidates(segment) {
    return this.#db.prepare(`SELECT candidates.* FROM candidates JOIN exchanges ON exchanges.seq = candidates.exchange_seq
      WHERE exchanges.segment_id = ? AND exchanges.seq <= ? AND candidates.status = 'pending' ORDER BY subject, attribute, exchange_seq, candidates.id`).all(segment.id, segment.boundary_seq)
      .map(row => { const payload = parse(row.payload, {}); return { ...row, source_ids: parse(row.source_ids, []), is_correction: Boolean(row.is_correction), source_quote: payload.source_quote ?? '', payload }; });
  }
  #setPrepared(segmentId, value) { this.#db.prepare('UPDATE segments SET prepared = ? WHERE id = ?').run(value === null ? null : JSON.stringify(value), segmentId); }
  #deferSegment(segment) {
    const attempts = segment.attempts + 1;
    this.#db.prepare('UPDATE segments SET attempts = ?, next_attempt_at = ?, failed = ? WHERE id = ?').run(attempts, this.#clock() + backoff(attempts), attempts >= MAX_ATTEMPTS ? 1 : 0, segment.id);
  }
  async #consolidate(segment) {
    const generation = deletionGeneration(this.#db);
    try {
      let prepared = parse(segment.prepared, null);
      if (prepared?.stage === 'published') { this.#acknowledge(segment, prepared); return; }
      if (prepared && prepared.generation !== generation) { this.#setPrepared(segment.id, null); prepared = null; }
      await this.#publishRules(segment);
      if (!prepared) {
        const batch = this.#pendingCandidates(segment).slice(0, MAX_BATCH_CANDIDATES);
        if (!batch.length) { this.#finishSegment(segment); return; }
        const input = this.#consolidationInput(segment, batch);
        const raw = await this.#meta.consolidateCandidates(input.request);
        if (this.#closed || deletionGeneration(this.#db) !== generation) return;
        const proposal = validateProposal(raw, { candidates: new Map(batch.map(item => [item.id, item])), records: input.records, sourceIds: input.sourceIds });
        prepared = { stage: 'prepared', generation, batch_ids: batch.map(item => item.id), ...proposal };
        // Persist before any write, so a storage retry does not repeat a successful model call.
        this.#setPrepared(segment.id, prepared);
      }
      await this.#fail('consolidate:after-prepare');
      const vectors = await this.#prepareVectors(prepared);
      this.#commit(segment, prepared, vectors);
      await this.#fail('consolidate:after-publish');
      this.#acknowledge(segment, { ...prepared, stage: 'published' });
    } catch (error) {
      if (error.code === 'MEMORY_VERSION_CONFLICT' || error.code === 'MEMORY_STALE_PROPOSAL') this.#setPrepared(segment.id, null);
      this.#deferSegment(segment);
    }
  }
  #consolidationInput(segment, batch) {
    const records = new Map();
    const related = this.#db.prepare(`SELECT * FROM records WHERE status IN ('current', 'unresolved') AND lower(subject) = ? AND lower(attribute) = ? LIMIT 5`);
    const lexical = this.#db.prepare(`SELECT search_items.ref_id AS id FROM search_fts JOIN search_items ON search_items.key = search_fts.key WHERE search_fts MATCH ? AND search_items.kind = 'record' ORDER BY bm25(search_fts) LIMIT 3`);
    for (const item of batch) {
      for (const row of related.all(normalizeKey(item.subject), normalizeKey(item.attribute))) records.set(row.id, toRecord(row));
      const words = terms(item.text).slice(0, 12);
      if (words.length) for (const { id } of lexical.all(words.map(word => `"${word.replaceAll('"', '""')}"`).join(' OR '))) { const row = currentVersion(this.#db, id); if (row) records.set(id, row); }
    }
    const conversations = new Map(this.#store.snapshot().conversations.map(item => [item.id, item]));
    const sourceIds = new Set(batch.flatMap(item => item.source_ids));
    const sources = []; let budget = SOURCE_CHARS;
    for (const id of sourceIds) { const message = conversations.get(id); if (!message) continue; const excerpt = message.text.slice(0, Math.max(0, Math.min(2000, budget))); budget -= excerpt.length; sources.push({ id, role: message.role, text: excerpt, created_at: message.created_at }); }
    return { records, sourceIds, request: {
      segment_closed_at: segment.closed_at,
      candidates: batch.map(({ id, source_ids, subject, type, text, attribute, conditions, exceptions, event_time, temporal, is_correction, evidence_kind, source_quote }) => ({ id, source_ids, subject, type, text, attribute, conditions, exceptions, event_time, temporal, is_correction, evidence_kind, source_quote })),
      related_records: [...records.values()].map(({ id, version, type, subject, text, attribute, conditions, exceptions, temporal, event_time, status }) => ({ id, version, type, subject, text, attribute, conditions, exceptions, temporal, event_time, status })),
      sources,
    } };
  }
  /** Explicit rules take the code path only. The model never writes an executable rule. */
  async #publishRules(segment) {
    const candidates = this.#db.prepare(`SELECT candidates.* FROM candidates JOIN exchanges ON exchanges.seq = candidates.exchange_seq WHERE exchanges.segment_id = ? AND exchanges.seq <= ? AND candidates.status = 'pending' AND candidates.type = 'rule'`).all(segment.id, segment.boundary_seq);
    for (const candidate of candidates) {
      const controlId = candidate.id.split(':ctl:')[1];
      if (candidate.temporal === 'ongoing') {
        const { rule } = parse(candidate.payload, {});
        const published = await this.#store.putRule(normalizeRule(rule), `v2-rule:${candidate.id}`);
        this.#db.prepare(`UPDATE control_items SET status = 'published', data = json_set(data, '$.published_rule_id', ?) WHERE id = ?`).run(published.id, controlId);
      }
      this.#db.prepare(`UPDATE candidates SET status = 'processed', text = '', payload = NULL WHERE id = ?`).run(candidate.id);
    }
  }
  /** Network work happens here, before the transaction. An outage leaves lexical search working and vectors queued. */
  async #prepareVectors(prepared) {
    if (!this.#gate.configured) return null;
    const texts = prepared.operations.filter(op => op.op !== 'discard').map(op => op.text);
    if (!texts.length) return null;
    try {
      const { model, vectors, dimensions } = await this.#gate.embedDocuments(texts.map(text => `\n${text}`));
      return { model, dimensions, byText: new Map(texts.map((text, index) => [text, vectors[index]])) };
    } catch { return null; }
  }
  #commit(segment, prepared, vectors) {
    const now = this.#now();
    const conversations = new Map(this.#store.snapshot().conversations.map(item => [item.id, item]));
    transaction(this.#db, () => {
      if (deletionGeneration(this.#db) !== prepared.generation) throw Object.assign(new Error('Stale proposal.'), { code: 'MEMORY_STALE_PROPOSAL' });
      const pending = new Set(this.#db.prepare(`SELECT id FROM candidates WHERE status = 'pending'`).all().map(row => row.id));
      const tombstone = this.#db.prepare('SELECT created_at FROM tombstones WHERE text_hash = ?');
      prepared.published_ids = [];
      prepared.dropped_ids = [];
      prepared.operations.forEach((op, index) => {
        if (!op.candidate_ids.every(id => pending.has(id))) return;
        if (op.op === 'discard') { prepared.published_ids.push(...op.candidate_ids); return; }
        // A record forgotten earlier returns only from a later statement, never from older evidence.
        const forgotten = tombstone.get(textHash(op.text));
        if (forgotten && !op.source_ids.some(id => (conversations.get(id)?.created_at ?? '') > forgotten.created_at)) { prepared.dropped_ids.push(...op.candidate_ids); return; }
        const operationId = `op:${segment.id}:${sha(prepared.batch_ids.join(',')).slice(0, 12)}:${index}`;
        const fields = { type: op.type, kind: op.memory_kind ?? parse(this.#db.prepare('SELECT payload FROM candidates WHERE id = ?').get(op.candidate_ids[0])?.payload, {})?.memory_kind ?? (op.type === 'episodic' ? 'event' : 'fact'), subject: op.subject, text: op.text, attribute: op.attribute, conditions: op.conditions, exceptions: op.exceptions, event_time: op.event_time, effective_time: op.effective_time, temporal: op.temporal, evidence_kind: op.evidence_kind, source_quote: op.source_quote, reason: op.reason, profile: op.profile, operation_id: operationId };
        const entityIds = [...op.entities.map(entity => ensureEntity(this.#db, entity)), ...(normalizeKey(op.subject) === 'household' ? [] : [ensureEntity(this.#db, { name: op.subject, type: 'person' })])].filter(Boolean);
        let record;
        if (op.op === 'supersede' || op.op === 'merge') {
          const target = currentVersion(this.#db, op.target_id);
          // Never last-writer-wins. A moved target sends this proposal back to reconcile from current state.
          if (!target || target.version !== op.expected_version) throw Object.assign(new Error('Version conflict.'), { code: 'MEMORY_VERSION_CONFLICT' });
          retireVersion(this.#db, target.id, target.version, now);
          const sourceIds = op.op === 'merge' ? [...new Set([...target.source_ids, ...op.source_ids])] : op.source_ids;
          record = writeRecordVersion(this.#db, { ...fields, id: target.id, version: target.version + 1, status: 'current', source_ids: sourceIds, supersedes: `${target.id}:v${target.version}`, created_at: now }, entityIds);
        } else {
          record = writeRecordVersion(this.#db, { ...fields, id: `rec_${sha(operationId).slice(0, 24)}`, version: 1, status: op.op === 'unresolved' ? 'unresolved' : 'current', source_ids: op.source_ids, created_at: now }, entityIds);
        }
        const vector = vectors?.byText.get(op.text);
        if (vector) this.#storeVector(recordKey(record.id, record.version), vectors.model, vectors.dimensions, vector);
        prepared.published_ids.push(...op.candidate_ids);
      });
      if (prepared.summary) this.#writeSummary(segment, prepared.summary, now);
      prepared.stage = 'published';
      this.#setPrepared(segment.id, prepared);
    });
  }
  #storeVector(key, model, dimensions, vector) {
    const hash = this.#db.prepare('SELECT text_hash FROM search_items WHERE key = ?').get(key)?.text_hash;
    if (hash) this.#db.prepare('INSERT OR REPLACE INTO item_vectors (key, model, text_hash, dimensions, vector) VALUES (?, ?, ?, ?, ?)').run(key, model, hash, dimensions, encodeVector(vector));
  }
  #writeSummary(segment, summary, now) {
    const id = `summary:${segment.id}`;
    const prior = latestVersion(this.#db, id);
    if (prior) retireVersion(this.#db, id, prior.version, now);
    writeRecordVersion(this.#db, { id, version: (prior?.version ?? 0) + 1, type: 'episodic', kind: 'summary', subject: 'household', text: prior ? `${prior.text} ${summary.text}`.slice(0, 4000) : summary.text,
      temporal: 'ongoing', evidence_kind: 'direct', source_ids: [...new Set([...(prior?.source_ids ?? []), ...summary.source_ids])], status: 'current', event_time: segment.closed_at ?? '', supersedes: prior ? `${id}:v${prior.version}` : null, created_at: now });
  }
  /** Marks only exactly committed candidates. Anything rejected or uncommitted stays queued. */
  #acknowledge(segment, prepared) {
    transaction(this.#db, () => {
      const done = this.#db.prepare(`UPDATE candidates SET status = 'processed', text = '', payload = NULL WHERE id = ? AND status = 'pending'`);
      for (const id of [...(prepared.published_ids ?? []), ...(prepared.dropped_ids ?? [])]) {
        done.run(id);
        const controlId = id.split(':ctl:')[1];
        if (controlId) this.#db.prepare(`UPDATE control_items SET status = 'published' WHERE id = ? AND json_extract(data, '$.temporal') != 'temporary'`).run(controlId);
      }
      const finished = new Set([...(prepared.published_ids ?? []), ...(prepared.dropped_ids ?? [])]);
      const retried = prepared.batch_ids.filter(id => !finished.has(id));
      for (const id of retried) this.#db.prepare(`UPDATE candidates SET attempts = attempts + 1, status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE status END WHERE id = ?`).run(MAX_ATTEMPTS, id);
      this.#db.prepare(`UPDATE segments SET prepared = NULL, attempts = 0, next_attempt_at = ? WHERE id = ?`).run(retried.length ? this.#clock() + BASE_BACKOFF_MS : 0, segment.id);
    });
    this.#finishSegment(segment);
  }
  #finishSegment(segment) {
    const counts = this.#db.prepare(`SELECT SUM(candidates.status = 'pending') AS pending, SUM(candidates.status = 'failed') AS failed FROM candidates JOIN exchanges ON exchanges.seq = candidates.exchange_seq WHERE exchanges.segment_id = ? AND exchanges.seq <= ?`).get(segment.id, segment.boundary_seq);
    if (counts.pending) return;
    if (counts.failed) this.#db.prepare('UPDATE segments SET failed = 1 WHERE id = ?').run(segment.id);
    else this.#db.prepare(`UPDATE segments SET status = 'done', prepared = NULL WHERE id = ?`).run(segment.id);
  }

  // ---- Documents and routine cards are indexed outside the reply path. ----
  #syncDocuments() {
    const documents = this.#store.snapshot().documents;
    const present = new Map(documents.map(item => [item.id, item]));
    const now = this.#now();
    transaction(this.#db, () => {
      for (const row of this.#db.prepare('SELECT * FROM documents_index').all()) {
        const current = present.get(row.id);
        if (current && current.version === row.version) continue;
        if (!current) this.#db.prepare('DELETE FROM documents_index WHERE id = ?').run(row.id);
        else this.#db.prepare(`UPDATE documents_index SET version = ?, status = 'pending', attempts = 0, next_attempt_at = 0, error = NULL, updated_at = ? WHERE id = ?`).run(current.version, now, row.id);
        // A replaced document's old text must stop being retrievable immediately.
        for (const { key } of this.#db.prepare(`SELECT key FROM search_items WHERE kind IN ('passage', 'document') AND ref_id = ?`).all(row.id)) removeSearchItem(this.#db, key);
      }
      for (const document of documents) this.#db.prepare(`INSERT OR IGNORE INTO documents_index (id, version, status, updated_at) VALUES (?, ?, 'pending', ?)`).run(document.id, document.version, now);
    });
  }
  #nextDocument() {
    const row = this.#db.prepare(`SELECT * FROM documents_index WHERE status = 'pending' AND next_attempt_at <= ? LIMIT 1`).get(this.#clock());
    return row && (() => this.#indexDocument(row));
  }
  async #indexDocument(row) {
    try {
      const document = this.#store.snapshot().documents.find(item => item.id === row.id && item.version === row.version);
      // A stale row must change state here, or the worker would pick it again forever.
      if (!document) { this.#syncDocuments(); return; }
      const passages = chunkDocument(document.content);
      const sections = outline(document.content);
      transaction(this.#db, () => {
        for (const { key } of this.#db.prepare(`SELECT key FROM search_items WHERE kind IN ('passage', 'document') AND ref_id = ?`).all(document.id)) removeSearchItem(this.#db, key);
        const now = this.#now();
        upsertSearchItem(this.#db, { key: `document:${document.id}:${document.version}`, kind: 'document', ref_id: document.id, ref_version: document.version, title: document.title, text: document.description || document.content.slice(0, 280),
          terms: sections.slice(0, 20).map(section => section.heading).join(' '), location: { char_count: document.content.length, status: 'ready', outline: sections.slice(0, 20) }, updated_at: now }, [ensureEntity(this.#db, { name: document.title, type: 'document' })]);
        passages.forEach((passage, index) => upsertSearchItem(this.#db, { key: `passage:${document.id}:${document.version}:${index}`, kind: 'passage', ref_id: document.id, ref_version: document.version, title: document.title,
          text: passage.text, terms: passage.section, location: { section: passage.section, start: passage.start, end: passage.end, header: passage.header }, updated_at: now }));
        this.#db.prepare(`UPDATE documents_index SET status = 'ready', attempts = 0, error = NULL, updated_at = ? WHERE id = ?`).run(now, document.id);
      });
    } catch {
      const attempts = row.attempts + 1;
      this.#db.prepare(`UPDATE documents_index SET attempts = ?, next_attempt_at = ?, status = ?, error = 'Indexing failed.' WHERE id = ?`).run(attempts, this.#clock() + backoff(attempts), attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', row.id);
    }
  }
  /** Small and cheap enough for the request path: a card is searchable by words now, its vector follows later. */
  syncRoutineCards() {
    if (!this.#routines) return;
    const routines = this.#routines.list();
    const present = new Set(routines.map(routine => `routine:${routine.id}:${routine.version}`));
    const stale = this.#db.prepare(`SELECT key FROM search_items WHERE kind = 'routine'`).all().filter(row => !present.has(row.key));
    const missing = routines.filter(routine => !this.#db.prepare('SELECT 1 FROM search_items WHERE key = ?').get(`routine:${routine.id}:${routine.version}`));
    if (!stale.length && !missing.length) return;
    transaction(this.#db, () => {
      stale.forEach(({ key }) => removeSearchItem(this.#db, key));
      for (const routine of missing) upsertSearchItem(this.#db, { key: `routine:${routine.id}:${routine.version}`, kind: 'routine', ref_id: routine.id, ref_version: routine.version, title: routine.name, text: routine.prompt,
        terms: routine.aliases.join(' '), location: { aliases: routine.aliases }, updated_at: routine.updated_at ?? this.#now() }, [ensureEntity(this.#db, { name: routine.name, type: 'routine', aliases: routine.aliases })]);
    });
  }
  #nextVectors() {
    if (!this.#gate.configured || this.#clock() < this.#vectorRetryAt) return null;
    const model = this.#gate.status().model ?? '';
    const rows = this.#db.prepare(`SELECT key, title, text, terms, text_hash FROM search_items WHERE NOT EXISTS (SELECT 1 FROM item_vectors WHERE item_vectors.key = search_items.key AND item_vectors.model = ? AND item_vectors.text_hash = search_items.text_hash) LIMIT ?`).all(model, VECTOR_BATCH);
    if (rows.length) return () => this.#embedRows(rows);
    // Fully reindexed under the current model: retire vectors from any earlier one.
    if (model) this.#db.prepare('DELETE FROM item_vectors WHERE model != ?').run(model);
    return null;
  }
  async #embedRows(rows) {
    const generation = deletionGeneration(this.#db);
    try {
      const { model, vectors, dimensions } = await this.#gate.embedDocuments(rows.map(row => `${row.title}\n${row.text}`));
      // Store a vector only for the exact text it encodes; deletion or an edit meanwhile discards it.
      transaction(this.#db, () => {
        if (deletionGeneration(this.#db) !== generation) return;
        const current = this.#db.prepare('SELECT text_hash FROM search_items WHERE key = ?');
        rows.forEach((row, index) => { if (current.get(row.key)?.text_hash === row.text_hash) this.#storeVector(row.key, model, dimensions, vectors[index]); });
      });
    } catch { this.#vectorRetryAt = this.#clock() + MAX_BACKOFF_MS / 10; }
  }

  // ---- Deletion. Publication never reaches here, and this removes only what depends on removed sources. ----
  sweepInvalidated() {
    const snapshot = this.#store.snapshot();
    const present = new Set(snapshot.conversations.map(item => item.id));
    const removedSeq = [];
    transaction(this.#db, () => {
      for (const row of this.#db.prepare('SELECT seq, user_source_id FROM exchanges').all()) if (!present.has(row.user_source_id)) removedSeq.push(row.seq);
      for (const seq of removedSeq) { this.#db.prepare('DELETE FROM candidates WHERE exchange_seq = ?').run(seq); this.#db.prepare('DELETE FROM exchanges WHERE seq = ?').run(seq); }
      for (const row of this.#db.prepare(`SELECT id, source_ids FROM candidates WHERE status != 'processed'`).all()) if (parse(row.source_ids, []).some(id => !present.has(id))) this.#db.prepare('DELETE FROM candidates WHERE id = ?').run(row.id);
      for (const row of this.#db.prepare('SELECT id, source_id FROM control_items').all()) if (!present.has(row.source_id)) this.#db.prepare('DELETE FROM control_items WHERE id = ?').run(row.id);
      for (const row of this.#db.prepare(`SELECT id, version, source_ids FROM records WHERE provenance_gap = 0`).all()) {
        if (!parse(row.source_ids, []).some(id => id !== 'manual' && !present.has(id))) continue;
        this.#db.prepare('UPDATE records SET provenance_gap = 1 WHERE id = ? AND version = ?').run(row.id, row.version);
        this.#db.prepare(`UPDATE search_items SET location = json_set(location, '$.provenance_gap', 1) WHERE key = ?`).run(recordKey(row.id, row.version));
      }
      bumpDeletionGeneration(this.#db);
    });
    this.#syncDocuments();
    this.syncRoutineCards();
    this.#onDeletionSweep?.();
    return this.status();
  }
  purgeSession(sessionId) {
    transaction(this.#db, () => {
      this.#db.prepare(`DELETE FROM candidates WHERE session_id = ?`).run(sessionId);
      this.#db.prepare('DELETE FROM exchanges WHERE session_id = ?').run(sessionId);
      this.#db.prepare('DELETE FROM segments WHERE session_id = ?').run(sessionId);
      this.#db.prepare('DELETE FROM control_items WHERE session_id = ?').run(sessionId);
      bumpDeletionGeneration(this.#db);
    });
    this.#active.delete(sessionId);
  }
  wipeAll() {
    transaction(this.#db, () => {
      for (const table of ['exchanges', 'segments', 'candidates', 'control_items', 'records', 'search_items', 'search_fts', 'item_vectors', 'entities', 'entity_aliases', 'item_entities', 'documents_index', 'migration_map', 'tombstones']) this.#db.exec(`DELETE FROM ${table}`);
      bumpDeletionGeneration(this.#db);
    });
    this.#active.clear();
    this.#documentsDirty = true;
  }
  /** The server's existing "invalidate learning" call. In v2 it is a dependency sweep, not a wipe. */
  async clear() { return this.sweepInvalidated(); }
  async retry() {
    transaction(this.#db, () => {
      this.#db.prepare('UPDATE exchanges SET failed = 0, attempts = 0, next_attempt_at = 0 WHERE captured_at IS NULL').run();
      this.#db.prepare(`UPDATE segments SET failed = 0, attempts = 0, next_attempt_at = 0 WHERE status = 'closed'`).run();
      this.#db.prepare(`UPDATE candidates SET status = 'pending', attempts = 0 WHERE status = 'failed'`).run();
      this.#db.prepare(`UPDATE documents_index SET status = 'pending', attempts = 0, next_attempt_at = 0, error = NULL WHERE status = 'failed'`).run();
    });
    this.#vectorRetryAt = 0;
    this.#kick();
    return this.status();
  }
  status() {
    const count = sql => this.#db.prepare(sql).get().n;
    const backlog = count('SELECT COUNT(*) AS n FROM exchanges WHERE captured_at IS NULL');
    const closed = this.#db.prepare(`SELECT id, session_id, boundary_seq, close_reason, closed_at, attempts, failed, prepared IS NOT NULL AS has_prepared FROM segments WHERE status = 'closed' ORDER BY boundary_seq LIMIT 20`).all();
    const open = this.#db.prepare(`SELECT id, session_id, opened_at, last_activity_ms FROM segments WHERE status = 'open' ORDER BY opened_at LIMIT 20`).all();
    const failed = count('SELECT COUNT(*) AS n FROM exchanges WHERE failed = 1') + count('SELECT COUNT(*) AS n FROM segments WHERE failed = 1 AND status = \'closed\'') + count(`SELECT COUNT(*) AS n FROM documents_index WHERE status = 'failed'`);
    const semantic = this.#gate.status();
    return {
      pending: backlog + closed.length, running: Boolean(this.#running), error: failed ? ERROR_MESSAGE : null,
      capture_backlog: backlog,
      candidates: { pending: count(`SELECT COUNT(*) AS n FROM candidates WHERE status = 'pending'`), failed: count(`SELECT COUNT(*) AS n FROM candidates WHERE status = 'failed'`) },
      segments: { open: open.map(({ id, session_id, opened_at, last_activity_ms }) => ({ id, session_id, opened_at, last_activity_at: iso(last_activity_ms) })), consolidating: closed.map(item => ({ ...item, failed: Boolean(item.failed), has_prepared: Boolean(item.has_prepared) })), close_after_seconds: this.#closeAfterMs / 1000 },
      semantic: { ...semantic, state: !semantic.provider || semantic.provider === 'none' ? 'unconfigured' : semantic.ready ? 'ready' : 'degraded' },
      index: { items: count('SELECT COUNT(*) AS n FROM search_items'), vectors: count('SELECT COUNT(*) AS n FROM item_vectors'), records_current: count(`SELECT COUNT(*) AS n FROM records WHERE status = 'current'`) },
      documents: this.#db.prepare('SELECT id, version, status FROM documents_index ORDER BY updated_at DESC LIMIT 30').all(),
      retry: { available: failed > 0, max_attempts: MAX_ATTEMPTS },
    };
  }
}
