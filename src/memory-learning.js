import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, chmod } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const MAX_BATCH = 4;
const MAX_FACTS = 20;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const jobKey = job => `${job.epoch}:${job.source_id}`;
const errorMessage = 'Background memory learning could not finish. Saved conversation is intact. Retry learning from the memory panel.';
const string = (value, maximum) => typeof value === 'string' && Boolean(value.trim()) && value.length <= maximum;
const initial = () => ({ version: 1, generation: 0, pending: [], prepared: null, error: null });

function validJob(job) {
  return object(job) && string(job.source_id, 200) && Number.isSafeInteger(job.epoch) && job.epoch >= 0;
}
function validateState(state) {
  if (!object(state) || state.version !== 1 || !Number.isSafeInteger(state.generation) || state.generation < 0
    || !Array.isArray(state.pending) || state.pending.length > 10000 || !state.pending.every(validJob)
    || new Set(state.pending.map(jobKey)).size !== state.pending.length
    || !(state.error === null || state.error === errorMessage)) throw new Error('Invalid learning queue.');
  if (state.prepared !== null) {
    const batch = state.prepared;
    if (!object(batch) || batch.generation !== state.generation || !Array.isArray(batch.jobs)
      || !batch.jobs.length || batch.jobs.length > MAX_BATCH || !batch.jobs.every(validJob)
      || !batch.jobs.every(job => state.pending.some(item => jobKey(item) === jobKey(job)))
      || !Array.isArray(batch.facts) || batch.facts.length > MAX_FACTS
      || !Number.isFinite(batch.started_at) || !Number.isSafeInteger(batch.input_chars)
      || !Array.isArray(batch.truncated_sources)) throw new Error('Invalid prepared learning batch.');
    for (const fact of batch.facts) validateFact(fact, new Set(batch.jobs.map(job => job.source_id)));
  }
}
function validateFact(fact, sourceIds) {
  if (!object(fact) || Object.keys(fact).some(key => !['source_id', 'source_quote', 'content', 'subject', 'kind', 'reason'].includes(key))
    || !sourceIds.has(fact.source_id) || !string(fact.source_quote, 12000) || !string(fact.content, 2000)
    || !string(fact.subject, 120) || !['fact', 'preference', 'guidance'].includes(fact.kind)
    || typeof fact.reason !== 'string' || fact.reason.length > 1000) throw new Error('Invalid extracted household fact.');
  return fact;
}
function normalizedFact(value) {
  if (!object(value) || (value.supersedes !== undefined && value.supersedes !== '')) {
    throw new Error('Automatic learning cannot replace explicit memories.');
  }
  const { supersedes, ...fact } = value;
  return fact;
}
function usage(value) {
  if (!object(value)) return null;
  return Object.fromEntries(Object.entries(value).filter(([key, number]) =>
    ['input_tokens', 'output_tokens', 'total_tokens'].includes(key) && Number.isSafeInteger(number) && number >= 0));
}

/** Durable, serial background learning. Only sourced facts are accepted; never executable rules. */
export class MemoryLearning {
  #store;
  #meta;
  #filePath;
  #delay;
  #state;
  #queue = Promise.resolve();
  #running = null;
  #timer;
  #closed = false;

  constructor({ store, meta, filePath, delayMs = 750 } = {}) {
    if (!store || typeof store.snapshot !== 'function' || typeof store.putFact !== 'function'
      || !string(filePath, 4096) || !Number.isFinite(delayMs) || delayMs < 0 || delayMs > 60000) {
      throw new Error('MemoryLearning requires a memory store, file path, and delay from 0 to 60000 ms.');
    }
    this.#store = store; this.#meta = meta; this.#filePath = resolve(filePath); this.#delay = delayMs;
  }
  #exclusive(action) {
    const result = this.#queue.then(action);
    this.#queue = result.catch(() => {});
    return result;
  }
  #requireReady() {
    if (!this.#state) throw new Error('MemoryLearning.init() must succeed first.');
    if (this.#closed) throw new Error('Memory learning is closed.');
  }
  async #persist(state) {
    const temporary = `${this.#filePath}.${randomUUID()}.tmp`;
    let handle;
    try {
      await mkdir(dirname(this.#filePath), { recursive: true, mode: 0o700 });
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
      await handle.sync(); await handle.close(); handle = undefined;
      await rename(temporary, this.#filePath);
    } catch (cause) {
      await handle?.close().catch(() => {});
      await rm(temporary, { force: true }).catch(() => {});
      const error = new Error('Could not save the background memory queue.', { cause });
      error.code = 'MEMORY_LEARNING_STORAGE_ERROR';
      throw error;
    }
  }
  async #commit(state) { await this.#persist(state); this.#state = state; }

  async init() {
    await this.#exclusive(async () => {
      if (this.#state) return;
      let contents;
      try { contents = await readFile(this.#filePath, 'utf8'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (contents === undefined) await this.#commit(initial());
      else {
        let state;
        try { state = JSON.parse(contents); validateState(state); }
        catch (cause) {
          const error = new Error('The memory learning queue is corrupted; it was not overwritten.', { cause });
          error.code = 'MEMORY_LEARNING_STORAGE_CORRUPT';
          throw error;
        }
        await chmod(this.#filePath, 0o600); this.#state = state;
      }
    });
    this.#schedule();
    return this;
  }

  status() {
    return { pending: this.#state?.pending.length ?? 0, running: Boolean(this.#running), error: this.#state?.error ?? null };
  }

  async enqueue(source) {
    const result = await this.#exclusive(async () => {
      this.#requireReady();
      if (typeof this.#meta?.extractMemories !== 'function') return { queued: false, reason: 'Background extraction is unavailable.' };
      const id = typeof source === 'string' ? source : source?.id ?? source?.source_id;
      const snapshot = this.#store.snapshot();
      const record = snapshot.conversations.find(item => item.id === id && item.role === 'user');
      if (!record) return { queued: false, reason: 'The source user message is no longer retained.' };
      const job = { source_id: record.id, epoch: snapshot.epoch };
      if (this.#state.pending.some(item => jobKey(item) === jobKey(job))) return { queued: true, duplicate: true };
      if (this.#state.pending.length >= 10000) throw new Error('Background memory queue is full.');
      const next = structuredClone(this.#state); next.pending.push(job);
      await this.#commit(next);
      return { queued: true };
    });
    this.#schedule();
    return result;
  }

  #schedule() {
    if (!this.#state || this.#closed || this.#timer || this.#running || this.#state.error || !this.#state.pending.length
      || typeof this.#meta?.extractMemories !== 'function') return;
    this.#timer = setTimeout(() => { this.#timer = undefined; void this.#start(); }, this.#delay);
    this.#timer.unref?.();
  }
  #start() {
    if (this.#running) return this.#running;
    if (this.#closed || !this.#state || this.#state.error || typeof this.#meta?.extractMemories !== 'function') return Promise.resolve();
    this.#running = this.#run().finally(() => { this.#running = null; this.#schedule(); });
    return this.#running;
  }
  async drain() {
    this.#requireReady();
    clearTimeout(this.#timer); this.#timer = undefined;
    await this.#queue;
    await this.#start();
    return this.status();
  }
  async retry() {
    await this.#exclusive(async () => {
      this.#requireReady(); const next = structuredClone(this.#state); next.error = null; await this.#commit(next);
    });
    this.#schedule(); return this.status();
  }
  async clear() {
    clearTimeout(this.#timer); this.#timer = undefined;
    return this.#exclusive(async () => {
      this.#requireReady();
      await this.#commit({ ...initial(), generation: this.#state.generation + 1 });
      return this.status();
    });
  }
  async close() {
    this.#closed = true; clearTimeout(this.#timer); this.#timer = undefined;
    await this.#queue;
    await this.#running;
  }

  #cancelled(batch) {
    return this.#closed || this.#state.generation !== batch.generation
      || batch.jobs.some(job => job.epoch !== this.#store.epoch);
  }
  async #next() {
    return this.#exclusive(async () => {
      if (this.#closed || this.#state.error) return null;
      const snapshot = this.#store.snapshot();
      const retained = new Set(snapshot.conversations.filter(item => item.role === 'user').map(item => item.id));
      const pending = this.#state.pending.filter(job => job.epoch === snapshot.epoch && retained.has(job.source_id));
      const prepared = this.#state.prepared;
      const validPrepared = prepared && prepared.jobs.every(job => pending.some(item => jobKey(item) === jobKey(job)));
      if (pending.length !== this.#state.pending.length || (prepared && !validPrepared)) {
        await this.#commit({ ...this.#state, pending, prepared: validPrepared ? prepared : null });
      }
      if (!pending.length) return null;
      if (this.#state.prepared) return this.#state.prepared;
      const jobs = [];
      let budget = 24000;
      for (const job of pending) {
        const size = Math.min(12000, snapshot.conversations.find(item => item.id === job.source_id).text.length);
        if (jobs.length && size > budget) break;
        jobs.push(job); budget -= size;
        if (jobs.length === MAX_BATCH) break;
      }
      return { generation: this.#state.generation, jobs };
    });
  }

  async #event(type, message, batch, details = {}) {
    if (this.#cancelled(batch)) return;
    await this.#store.addEvent({ type, message,
      details: { source_ids: batch.jobs.map(job => job.source_id), ...details },
    }, batch.jobs[0].epoch);
  }
  async #prepare(batch) {
    const snapshot = this.#store.snapshot();
    let remaining = 24000;
    const truncated_sources = [];
    const messages = batch.jobs.map(job => {
      const source = snapshot.conversations.find(item => item.id === job.source_id && item.role === 'user');
      if (!source) throw new Error('Learning source is no longer available.');
      const text = source.text.slice(0, Math.min(12000, remaining)); remaining -= text.length;
      if (text.length < source.text.length) truncated_sources.push(source.id);
      return { id: source.id, source_id: source.id, role: 'user', text, created_at: source.created_at };
    });
    let budget = 20000;
    const currentFacts = snapshot.facts.filter(fact => fact.status === 'active').slice(-80).reverse()
      .map(({ id, content, subject, kind }) => ({ id, content, subject, kind }))
      .filter(fact => { const size = JSON.stringify(fact).length; if (size > budget) return false; budget -= size; return true; }).reverse();
    const started_at = Date.now();
    const input_chars = messages.reduce((sum, item) => sum + item.text.length, 0) + JSON.stringify(currentFacts).length;
    await this.#event('learning_started', 'Background household learning started from retained user messages.', batch,
      { message_count: messages.length, input_chars, truncated_sources });
    if (this.#cancelled(batch)) return null;
    const extracted = await this.#meta.extractMemories(messages, currentFacts);
    if (this.#cancelled(batch)) return null;
    if (!object(extracted) || !Array.isArray(extracted.facts) || extracted.facts.length > MAX_FACTS
      || Object.keys(extracted).some(key => !['facts', 'usage'].includes(key))) throw new Error('Unexpected memory extraction response.');
    const ids = new Set(batch.jobs.map(job => job.source_id));
    const facts = extracted.facts.map(value => validateFact(normalizedFact(value), ids));
    for (const fact of facts) {
      if (!messages.find(message => message.id === fact.source_id)?.text.includes(fact.source_quote)) throw new Error('Extracted fact has no exact user evidence.');
    }
    const prepared = { ...batch, facts, started_at, input_chars, truncated_sources, usage: usage(extracted.usage) };
    return this.#exclusive(async () => {
      if (this.#cancelled(batch)) return null;
      await this.#commit({ ...this.#state, prepared }); return prepared;
    });
  }
  async #apply(batch) {
    let saved = 0;
    for (let index = 0; index < batch.facts.length; index++) {
      if (this.#cancelled(batch)) return false;
      const fact = batch.facts[index];
      const snapshot = this.#store.snapshot();
      const source = snapshot.conversations.find(item => item.id === fact.source_id && item.role === 'user');
      if (!source || !source.text.includes(fact.source_quote)) return false;
      const equivalent = snapshot.facts.some(item => item.status === 'active' && item.content === fact.content
        && item.subject === fact.subject && item.kind === fact.kind);
      if (equivalent) continue;
      await this.#store.putFact(fact, `learning:${fact.source_id}:${index}`, batch.jobs[0].epoch);
      saved++;
    }
    if (this.#cancelled(batch)) return false;
    await this.#event('learning_completed', 'Background household learning finished; extracted facts retain their original evidence.', batch,
      { saved_count: saved, candidate_count: batch.facts.length, duration_ms: Date.now() - batch.started_at,
        input_chars: batch.input_chars, truncated_sources: batch.truncated_sources, usage: batch.usage });
    await this.#exclusive(async () => {
      if (this.#cancelled(batch)) return;
      const keys = new Set(batch.jobs.map(jobKey));
      await this.#commit({ ...this.#state, pending: this.#state.pending.filter(job => !keys.has(jobKey(job))), prepared: null });
    });
    return true;
  }
  async #run() {
    let batch;
    try {
      while (!this.#closed && (batch = await this.#next())) {
        if (!batch.facts) batch = await this.#prepare(batch);
        if (!batch) continue;
        await this.#apply(batch);
      }
    } catch (error) {
      if (this.#closed || (batch && this.#cancelled(batch)) || error.code === 'MEMORY_STALE_OPERATION') return;
      try {
        await this.#exclusive(async () => {
          if (!this.#closed && (!batch || !this.#cancelled(batch))) {
            await this.#commit({ ...this.#state, error: errorMessage });
          }
        });
        if (batch) await this.#event('learning_failed', errorMessage, batch, { retry_available: true });
      } catch {
        // Surface even a queue/event persistence failure in this process without leaking raw inputs.
        if (this.#state && !this.#closed) this.#state = { ...this.#state, error: errorMessage };
      }
    }
  }
}
