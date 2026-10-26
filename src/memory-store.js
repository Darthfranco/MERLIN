import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, chmod } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const COLLECTIONS = ['facts', 'rules', 'documents', 'conversations', 'events'];
const FACT_KEYS = ['content', 'subject', 'kind', 'source_id', 'source_quote', 'reason', 'supersedes'];
const RULE_KEYS = ['kind', 'value', 'scope', 'source_id', 'source_quote', 'original', 'explanation'];
const STOP_WORDS = new Set('a an and are as at be but by can do does for from have how i in is it me my of on or our please tell that the their them there this to us was we what when where which who with would you your'.split(' '));
const now = () => new Date().toISOString();
const clone = value => structuredClone(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function invalid(message) {
  const error = new Error(message);
  error.code = 'INVALID_MEMORY_ARGUMENT';
  error.status = 400;
  return error;
}

function string(value, name, max = 500, empty = false) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) {
    throw invalid(`${name} must be ${empty ? 'a' : 'a nonempty'} string of at most ${max} characters.`);
  }
  return value;
}

function keys(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) {
    throw invalid('Memory arguments contain unexpected fields.');
  }
}

function json(value, name, max = 200_000) {
  let encoded;
  try {
    encoded = JSON.stringify(value, (_key, entry) => {
      if (typeof entry === 'function' || typeof entry === 'undefined' || typeof entry === 'symbol'
        || typeof entry === 'bigint' || (typeof entry === 'number' && !Number.isFinite(entry))) {
        throw invalid(`${name} must contain JSON data only.`);
      }
      return entry;
    });
  } catch {
    throw invalid(`${name} must contain JSON data only.`);
  }
  if (!encoded || encoded.length > max) throw invalid(`${name} exceeds its size limit.`);
  return JSON.parse(encoded);
}

function timestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) throw invalid('Invalid memory timestamp.');
}

function memoryIds(value) {
  if (!Array.isArray(value) || value.length > 1000 || new Set(value).size !== value.length) {
    throw invalid('memory_ids must contain at most 1000 distinct memory identifiers.');
  }
  return value.map(id => string(id, 'memory_ids', 200));
}

function evidence(value) {
  string(value.source_id, 'source_id', 200);
  string(value.source_quote, 'source_quote', 12_000, value.source_id === 'manual');
}

function factArgs(value) {
  keys(value, FACT_KEYS);
  const result = {
    content: string(value.content, 'content', 2000).trim(),
    subject: string(value.subject ?? 'household', 'subject', 120).trim(),
    kind: value.kind ?? 'fact', source_id: value.source_id,
    source_quote: value.source_quote, reason: string(value.reason ?? '', 'reason', 1000, true),
  };
  if (!['fact', 'preference', 'guidance'].includes(result.kind)) throw invalid('Unsupported household memory kind.');
  evidence(result);
  if (value.supersedes !== undefined) result.supersedes = string(value.supersedes, 'supersedes', 200);
  return result;
}

function ruleArgs(value) {
  keys(value, RULE_KEYS);
  const result = {
    kind: string(value.kind, 'kind', 100), value: json(value.value, 'value', 4000),
    scope: string(value.scope, 'scope', 100), source_id: value.source_id,
    source_quote: value.source_quote, original: string(value.original, 'original', 4000),
    explanation: string(value.explanation, 'explanation', 2000),
  };
  evidence(result);
  return result;
}

function documentArgs(value) {
  keys(value, ['id', 'title', 'description', 'content']);
  const result = {
    title: string(value.title, 'title', 160).trim(),
    description: string(value.description ?? '', 'description', 1000, true).trim(),
    content: string(value.content, 'content', 100_000),
  };
  if (value.id !== undefined) result.id = string(value.id, 'id', 200);
  return result;
}

function tokenize(text) {
  return [...new Set(text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])]
    .filter(term => !STOP_WORDS.has(term));
}

function relevance(text, terms) {
  const words = new Set(tokenize(text));
  return terms.reduce((score, term) => score + (words.has(term) ? 1 : 0), 0);
}

function sections(content) {
  const result = [];
  const pattern = /^(?:#{1,6}\s+(.+)|([^\n]{1,120})\n(?:={3,}|-{3,})\s*$)/gm;
  for (const match of content.matchAll(pattern)) {
    if (result.length === 200) break;
    result.push({ heading: (match[1] ?? match[2]).trim(), start: match.index });
  }
  if (!result.length || result[0].start !== 0) result.unshift({ heading: 'Introduction', start: 0 });
  return result.map((section, index) => ({ ...section, end: result[index + 1]?.start ?? content.length }));
}

function catalog(document) {
  const { content, operation_id, ...entry } = document;
  const sectionList = sections(content);
  return { ...entry, char_count: content.length, sections: sectionList.slice(0, 12), section_count: sectionList.length };
}

function snippet(text, terms, maximum = 800) {
  const normalized = text.toLowerCase();
  const positions = terms.map(term => normalized.indexOf(term)).filter(index => index >= 0);
  const start = positions.length ? Math.max(0, Math.min(...positions) - 120) : 0;
  return { text: text.slice(start, start + maximum), start, end: Math.min(text.length, start + maximum), truncated: start > 0 || text.length > start + maximum };
}

function initialState() {
  return { version: 1, revision: 0, epoch: 0, facts: [], rules: [], documents: [], conversations: [], events: [] };
}

function validateState(state) {
  keys(state, ['version', 'revision', 'epoch', ...COLLECTIONS]);
  if (state.version !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0
    || !Number.isSafeInteger(state.epoch) || state.epoch < 0
    || COLLECTIONS.some(key => !Array.isArray(state[key]))) throw invalid('Unsupported memory file structure or version.');
  const ids = new Set();
  const operations = new Set();
  const messages = new Set();
  for (const collection of COLLECTIONS) {
    for (const entry of state[collection]) {
      if (!object(entry)) throw invalid('Invalid memory record.');
      string(entry.id, 'id', 200);
      if (ids.has(entry.id)) throw invalid('Duplicate memory record id.');
      ids.add(entry.id);
      timestamp(entry.created_at);
      if (entry.operation_id !== undefined) {
        string(entry.operation_id, 'operation_id', 256);
        const key = `${collection}:${entry.operation_id}`;
        if (operations.has(key)) throw invalid('Duplicate memory operation.');
        operations.add(key);
      }
      if (collection === 'facts' || collection === 'rules') {
        const argumentKeys = collection === 'facts' ? FACT_KEYS : RULE_KEYS;
        keys(entry, [...argumentKeys, 'id', 'status', 'created_at', 'updated_at', 'operation_id']);
        const args = Object.fromEntries(argumentKeys.filter(key => key in entry).map(key => [key, entry[key]]));
        (collection === 'facts' ? factArgs : ruleArgs)(args);
        if (!['active', 'superseded'].includes(entry.status) || (collection === 'rules' && entry.status !== 'active')) {
          throw invalid('Invalid memory record status.');
        }
        timestamp(entry.updated_at);
      } else if (collection === 'documents') {
        keys(entry, ['id', 'title', 'description', 'content', 'version', 'created_at', 'updated_at', 'operation_id']);
        documentArgs({ title: entry.title, description: entry.description, content: entry.content });
        if (!Number.isSafeInteger(entry.version) || entry.version < 1) throw invalid('Invalid document version.');
        timestamp(entry.updated_at);
      } else if (collection === 'conversations') {
        keys(entry, ['id', 'session_id', 'request_id', 'role', 'text', 'created_at', 'turn', 'memory_ids']);
        string(entry.session_id, 'session_id', 200);
        string(entry.request_id, 'request_id', 200);
        string(entry.text, 'text', 100_000, true);
        if (!['user', 'assistant'].includes(entry.role)) throw invalid('Invalid conversation role.');
        const key = `${entry.request_id}:${entry.role}`;
        if (messages.has(key)) throw invalid('Duplicate conversation message.');
        messages.add(key);
        if ('memory_ids' in entry) memoryIds(entry.memory_ids);
        if ('turn' in entry) {
          if (entry.role !== 'assistant') throw invalid('Only assistant messages can contain protocol history.');
          json(entry.turn, 'turn', 2_000_000);
        }
      } else {
        keys(entry, ['id', 'type', 'message', 'details', 'created_at']);
        string(entry.type, 'type', 100);
        string(entry.message, 'message', 2000);
        if ('details' in entry) json(entry.details, 'details', 40_000);
      }
    }
  }
  if (state.events.length > 100) throw invalid('Memory event limit exceeded.');
}

/** Single-process store. Share one instance per file; mutations commit before becoming visible. */
export class MemoryStore {
  #filePath;
  #state;
  #queue = Promise.resolve();

  constructor({ filePath } = {}) {
    this.#filePath = resolve(string(filePath, 'filePath', 4096));
  }

  #enqueue(action) {
    const result = this.#queue.then(action);
    this.#queue = result.catch(() => {});
    return result;
  }

  #requireInitialized() {
    if (!this.#state) throw new Error('MemoryStore.init() must succeed before using memory.');
  }

  async #persist(state) {
    const temporary = `${this.#filePath}.${randomUUID()}.tmp`;
    let handle;
    try {
      await mkdir(dirname(this.#filePath), { recursive: true, mode: 0o700 });
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.#filePath);
    } catch (cause) {
      await handle?.close().catch(() => {});
      await rm(temporary, { force: true }).catch(() => {});
      const error = new Error('Could not save memory; the requested change was not applied.', { cause });
      error.code = 'MEMORY_STORAGE_ERROR';
      error.status = 500;
      throw error;
    }
  }

  async init() {
    return this.#enqueue(async () => {
      if (this.#state) return this;
      let contents;
      try { contents = await readFile(this.#filePath, 'utf8'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      let state;
      if (contents === undefined) {
        state = initialState();
        await this.#persist(state);
      } else {
        try { state = JSON.parse(contents); validateState(state); }
        catch (cause) {
          const error = new Error('The memory file is invalid or corrupted; it was not overwritten. Restore or move it before restarting.', { cause });
          error.code = 'MEMORY_STORAGE_CORRUPT';
          throw error;
        }
        await chmod(this.#filePath, 0o600);
      }
      this.#state = state;
      return this;
    });
  }

  get epoch() { this.#requireInitialized(); return this.#state.epoch; }

  snapshot() {
    this.#requireInitialized();
    const { version, ...snapshot } = this.#state;
    return clone(snapshot);
  }

  async #mutate(action, expectedEpoch) {
    return this.#enqueue(async () => {
      this.#requireInitialized();
      if (expectedEpoch !== undefined && expectedEpoch !== this.#state.epoch) {
        const error = new Error('Memory changed while this operation was pending; discarded stale work.');
        error.code = 'MEMORY_STALE_OPERATION';
        error.status = 409;
        throw error;
      }
      const state = clone(this.#state);
      const { result, changed = true } = action(state);
      if (changed) {
        state.revision++;
        await this.#persist(state);
        this.#state = state;
      }
      return clone(result);
    });
  }

  #checkEvidence(state, value) {
    if (value.source_id === 'manual') return;
    const source = state.conversations.find(message => message.id === value.source_id && message.role === 'user');
    if (!source || !source.text.includes(value.source_quote)) {
      throw invalid('Memory must cite an exact quotation from a stored user message.');
    }
  }

  #existing(state, collection, operationId, args) {
    if (operationId === undefined) return undefined;
    string(operationId, 'operationId', 256);
    const existing = state[collection].find(entry => entry.operation_id === operationId);
    if (existing && Object.entries(args).some(([key, value]) => JSON.stringify(existing[key]) !== JSON.stringify(value))) {
      throw invalid('This memory operation ID was already used with different arguments.');
    }
    return existing;
  }

  async recordMessage(value) {
    keys(value, ['session_id', 'request_id', 'role', 'text', 'turn', 'memory_ids']);
    const args = {
      session_id: string(value.session_id, 'session_id', 200),
      request_id: string(value.request_id, 'request_id', 200),
      role: value.role, text: string(value.text, 'text', 100_000, true),
    };
    if (!['user', 'assistant'].includes(args.role)) throw invalid('Invalid conversation role.');
    if ('memory_ids' in value) args.memory_ids = memoryIds(value.memory_ids);
    if ('turn' in value) {
      if (args.role !== 'assistant') throw invalid('Only assistant messages can contain protocol history.');
      args.turn = json(value.turn, 'turn', 2_000_000);
    }
    return this.#mutate(state => {
      const existing = state.conversations.find(entry => entry.request_id === args.request_id && entry.role === args.role);
      if (existing) {
        if (Object.entries(args).some(([key, entry]) => JSON.stringify(existing[key]) !== JSON.stringify(entry))) {
          throw invalid('This request message was already stored with different arguments.');
        }
        return { result: existing, changed: false };
      }
      const record = { id: randomUUID(), ...args, created_at: now() };
      state.conversations.push(record);
      return { result: record };
    });
  }

  async putFact(value, operationId, expectedEpoch) {
    const args = factArgs(value);
    return this.#mutate(state => {
      const existing = this.#existing(state, 'facts', operationId, args);
      if (existing) return { result: existing, changed: false };
      this.#checkEvidence(state, args);
      let cleared_sessions = [];
      if (args.supersedes) {
        const prior = state.facts.find(entry => entry.id === args.supersedes && entry.status === 'active');
        if (!prior) throw invalid('The fact being replaced must exist and be active.');
        prior.status = 'superseded';
        prior.updated_at = now();
        // Keep the new correction's user evidence even when it is also the prior source.
        const sourceIds = new Set(prior.source_id === args.source_id ? [] : [prior.source_id]);
        cleared_sessions = this.#invalidate(state, sourceIds, new Set([prior.id]), args.source_id);
        state.events = [];
        state.epoch++;
      }
      const created_at = now();
      const record = { id: randomUUID(), ...args, status: 'active', created_at, updated_at: created_at };
      if (operationId !== undefined) record.operation_id = operationId;
      state.facts.push(record);
      return { result: args.supersedes ? { ...record, cleared_sessions } : record };
    }, expectedEpoch);
  }

  async putRule(value, operationId, expectedEpoch) {
    const args = ruleArgs(value);
    return this.#mutate(state => {
      const existing = this.#existing(state, 'rules', operationId, args);
      if (existing) return { result: existing, changed: false };
      this.#checkEvidence(state, args);
      const created_at = now();
      const record = { id: randomUUID(), ...args, status: 'active', created_at, updated_at: created_at };
      if (operationId !== undefined) record.operation_id = operationId;
      state.rules.push(record);
      return { result: record };
    }, expectedEpoch);
  }

  async putDocument(value, operationId) {
    const args = documentArgs(value);
    return this.#mutate(state => {
      const existing = this.#existing(state, 'documents', operationId, args);
      if (existing) return { result: existing, changed: false };
      const previous = args.id ? state.documents.find(entry => entry.id === args.id) : undefined;
      if (args.id && !previous) throw invalid('Document not found.');
      const record = {
        id: previous?.id ?? randomUUID(), ...args, version: (previous?.version ?? 0) + 1,
        created_at: previous?.created_at ?? now(), updated_at: now(),
      };
      if (operationId !== undefined) record.operation_id = operationId;
      let cleared_sessions = [];
      if (previous) {
        state.documents[state.documents.indexOf(previous)] = record;
        // Remove only requests exposed to the old document and their protocol caches.
        cleared_sessions = this.#invalidate(state, new Set(), new Set([record.id]));
        state.events = [];
        state.epoch++;
      } else state.documents.push(record);
      return { result: previous ? { ...record, cleared_sessions } : record };
    });
  }

  #invalidate(state, sourceIds, memoryIds = new Set(), preserveSourceId) {
    const sources = state.conversations.filter(message => sourceIds.has(message.id)
      || message.memory_ids?.some(id => memoryIds.has(id)));
    const requests = new Set(sources.map(message => message.request_id));
    const sessions = new Set(sources.map(message => message.session_id));
    state.conversations = state.conversations.filter(message => message.id === preserveSourceId || !requests.has(message.request_id));
    for (const message of state.conversations) if (sessions.has(message.session_id)) delete message.turn;
    return [...sessions];
  }

  async invalidateReferences(value) {
    keys(value, ['ids', 'source_ids']);
    const ids = memoryIds(value.ids ?? []);
    const sourceIds = memoryIds(value.source_ids ?? []);
    if (!ids.length && !sourceIds.length) throw invalid('Provide at least one memory or source identifier to invalidate.');
    return this.#mutate(state => {
      const cleared_sessions = this.#invalidate(state, new Set(sourceIds), new Set(ids));
      state.events = [];
      state.epoch++;
      return { result: { cleared_sessions, epoch: state.epoch } };
    });
  }

  async remove(value) {
    keys(value, ['collection', 'id']);
    if (!['facts', 'rules', 'documents'].includes(value.collection)) throw invalid('Unsupported memory collection.');
    string(value.id, 'id', 200);
    return this.#mutate(state => {
      const record = state[value.collection].find(entry => entry.id === value.id);
      if (!record) throw invalid('Memory record not found.');
      const removedIds = new Set([record.id]);
      // Delete every revision in a fact's supersession chain, so a correction cannot resurrect it.
      if (value.collection === 'facts') {
        let changed = true;
        while (changed) {
          changed = false;
          for (const entry of state.facts) {
            if (entry.supersedes && (removedIds.has(entry.id) || removedIds.has(entry.supersedes))) {
              if (!removedIds.has(entry.id) || !removedIds.has(entry.supersedes)) changed = true;
              removedIds.add(entry.id); removedIds.add(entry.supersedes);
            }
          }
        }
      }
      const removed = state[value.collection].filter(entry => removedIds.has(entry.id));
      state[value.collection] = state[value.collection].filter(entry => !removedIds.has(entry.id));
      const clearedSessions = this.#invalidate(state, new Set(removed.map(entry => entry.source_id)), removedIds);
      // Traces can contain quoted evidence and document snippets. Purge rather than retaining copies.
      state.events = [];
      state.epoch++;
      return { result: { removed_id: record.id, removed_ids: [...removedIds], cleared_sessions: clearedSessions, epoch: state.epoch } };
    });
  }

  async resolveRules(value) {
    keys(value, ['keep_id', 'remove_ids']);
    string(value.keep_id, 'keep_id', 200);
    if (!Array.isArray(value.remove_ids) || !value.remove_ids.length || value.remove_ids.length > 100
      || new Set(value.remove_ids).size !== value.remove_ids.length || value.remove_ids.includes(value.keep_id)) {
      throw invalid('Choose a rule to keep and distinct conflicting rules to remove.');
    }
    value.remove_ids.forEach(id => string(id, 'remove_ids', 200));
    return this.#mutate(state => {
      if (![value.keep_id, ...value.remove_ids].every(id => state.rules.some(rule => rule.id === id))) {
        throw invalid('All rules in the resolution must exist.');
      }
      const removed = state.rules.filter(rule => value.remove_ids.includes(rule.id));
      state.rules = state.rules.filter(rule => !value.remove_ids.includes(rule.id));
      const cleared_sessions = this.#invalidate(state, new Set(removed.map(rule => rule.source_id)), new Set(value.remove_ids));
      state.events = [];
      state.epoch++;
      return { result: { kept: state.rules.find(rule => rule.id === value.keep_id), removed_ids: value.remove_ids, cleared_sessions, epoch: state.epoch } };
    });
  }

  async clearConversation(sessionId) {
    string(sessionId, 'session_id', 200);
    return this.#mutate(state => {
      const count = state.conversations.filter(message => message.session_id === sessionId).length;
      state.conversations = state.conversations.filter(message => message.session_id !== sessionId);
      state.events = [];
      state.epoch++;
      return { result: { removed_messages: count, epoch: state.epoch } };
    });
  }

  async clearAll() {
    return this.#mutate(state => {
      COLLECTIONS.forEach(collection => { state[collection] = []; });
      state.epoch++;
      return { result: { epoch: state.epoch } };
    });
  }

  async addEvent(value, expectedEpoch) {
    keys(value, ['type', 'message', 'details']);
    const args = { type: string(value.type, 'type', 100), message: string(value.message, 'message', 2000) };
    if ('details' in value) args.details = json(value.details, 'details', 40_000);
    return this.#mutate(state => {
      const event = { id: randomUUID(), ...args, created_at: now() };
      state.events.push(event);
      state.events = state.events.slice(-100);
      return { result: event };
    }, expectedEpoch);
  }

  search(query, { session_id, limit = 6 } = {}) {
    this.#requireInitialized();
    string(query, 'query', 4000, true);
    if (session_id !== undefined) string(session_id, 'session_id', 200);
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw invalid('Search limit must be an integer from 1 to 20.');
    const terms = tokenize(query).slice(0, 64);
    if (!terms.length) return { facts: [], documents: [], messages: [] };
    const rank = (entries, score) => entries.map(entry => ({ entry, score: score(entry) }))
      .filter(hit => hit.score > 0).sort((a, b) => b.score - a.score || b.entry.created_at.localeCompare(a.entry.created_at))
      .slice(0, limit).map(hit => ({ ...hit.entry, score: hit.score }));
    const facts = rank(this.#state.facts.filter(fact => fact.status === 'active'), fact => relevance(`${fact.subject} ${fact.content}`, terms))
      .map(({ operation_id, source_quote, ...fact }) => ({ ...fact, source_quote: source_quote.slice(0, 400), source_quote_truncated: source_quote.length > 400 }));
    const documents = rank(this.#state.documents, document => relevance(document.title, terms) * 4
      + relevance(document.description, terms) * 2 + relevance(document.content, terms))
      .map(document => ({ ...catalog(document), snippet: snippet(document.content, terms).text }));
    const messages = rank(this.#state.conversations.filter(message => !session_id || message.session_id === session_id), message => relevance(message.text, terms))
      .map(({ turn, text, ...message }) => ({ ...message, text: snippet(text, terms, 1200).text, truncated: text.length > 1200 }));
    return clone({ facts, documents, messages });
  }

  readDocument(id, { query = '', maxChars = 12_000 } = {}) {
    this.#requireInitialized();
    string(id, 'id', 200);
    string(query, 'query', 4000, true);
    if (!Number.isInteger(maxChars) || maxChars < 100 || maxChars > 24_000) throw invalid('maxChars must be an integer from 100 to 24000.');
    const document = this.#state.documents.find(entry => entry.id === id);
    if (!document) throw invalid('Document not found.');
    const terms = tokenize(query).slice(0, 64);
    const candidates = sections(document.content).map(section => ({ ...section,
      score: relevance(section.heading, terms) * 4 + relevance(document.content.slice(section.start, section.end), terms),
    })).sort((a, b) => b.score - a.score || a.start - b.start);
    const section = candidates[0];
    let start = section.start;
    if (terms.length && section.end - start > maxChars) {
      const withinSection = document.content.slice(start, section.end);
      const match = snippet(withinSection, terms, maxChars);
      start += match.start;
    }
    const end = Math.min(terms.length ? section.end : document.content.length, start + maxChars);
    return clone({ ...catalog(document), sections: [{ heading: section.heading, start: section.start, end: section.end }], content: document.content.slice(start, end), start, end,
      heading: section.heading, truncated: start !== 0 || end < document.content.length,
      section_truncated: end < section.end, relevant_match: terms.length > 0 && section.score > 0,
    });
  }
}
