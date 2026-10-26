import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, chmod } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const PENDING_MS = 10 * 60 * 1000;
const AUTHORING_SOURCE_LIMIT = 20;
const AUTHORING_SOURCE_CHARS = 24000;
const CONFIRMATIONS = new Set(['yes', 'yes please', 'ok', 'okay', 'do it', 'confirm']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);
const normalize = value => value.normalize('NFKC').toLowerCase().replaceAll('’', "'").replace(/\s+/gu, ' ').trim();
const activationText = value => normalize(value).replace(/[.!]+$/u, '').trim();
function invalid(message) {
  const error = new Error(message); error.code = 'INVALID_ROUTINE_ARGUMENT'; error.status = 400; return error;
}
function text(value, name, maximum, empty = false) {
  if (typeof value !== 'string' || value.length > maximum || (!empty && !value.trim())
    || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)) throw invalid(`${name} must be ${empty ? 'a' : 'a nonempty'} string of at most ${maximum} characters.`);
  return value.trim();
}
function keys(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw invalid('Routine arguments contain unexpected fields.');
}
function definitionSources(value) {
  if (!Array.isArray(value) || !value.length || value.length > AUTHORING_SOURCE_LIMIT) throw invalid('Invalid routine definition sources.');
  const ids = new Set(); let chars = 0;
  return value.map(item => {
    keys(item, ['source_id', 'source_quote']);
    const source_id = text(item.source_id, 'Definition source ID', 200);
    const source_quote = text(item.source_quote, 'Definition source quotation', AUTHORING_SOURCE_CHARS);
    if (ids.has(source_id) || (chars += source_quote.length) > AUTHORING_SOURCE_CHARS) throw invalid('Invalid or oversized routine definition sources.');
    ids.add(source_id); return { source_id, source_quote };
  });
}
function args(value, stored = false) {
  keys(value, ['id', 'name', 'aliases', 'prompt', 'source_id', 'source_quote', ...(stored ? ['definition_sources'] : [])]);
  const name = text(value.name, 'Routine name', 80);
  const prompt = text(value.prompt, 'Routine prompt', 12000);
  const aliases = value.aliases ?? [];
  if (!Array.isArray(aliases) || aliases.length > 12) throw invalid('Use at most 12 explicit routine aliases.');
  const cleaned = aliases.map(alias => text(alias, 'Routine alias', 120));
  const triggers = [name, ...cleaned].map(activationText);
  if (triggers.some(trigger => !trigger || CONFIRMATIONS.has(trigger)) || new Set(triggers).size !== triggers.length) {
    throw invalid('Routine names and aliases must be distinct and cannot be generic confirmations.');
  }
  return { ...(value.id === undefined ? {} : { id: text(value.id, 'Routine ID', 200) }), name, aliases: cleaned, prompt,
    source_id: text(value.source_id, 'Source ID', 200), source_quote: text(value.source_quote, 'Source quotation', 16000, value.source_id === 'manual'),
    ...(value.definition_sources === undefined ? {} : { definition_sources: definitionSources(value.definition_sources) }) };
}
function evidence(value, source, allowedSources) {
  if (value.source_id === 'manual') return;
  if (!source || source.role !== 'user' || source.id !== value.source_id || typeof source.text !== 'string'
    || !source.text.includes(value.source_quote)) {
    throw invalid('Save the exact requested routine prompt with an exact quote from the current direct user message.');
  }
  // The existing direct-save contract remains strict. A trusted service may
  // additionally supply bounded direct-user evidence from this conversation.
  if (allowedSources === undefined) {
    if (!value.source_quote.includes(value.prompt)) throw invalid('Save the exact requested routine prompt with an exact quote from the current direct user message.');
    if (![value.name, ...value.aliases].every(trigger => normalize(value.source_quote).includes(normalize(trigger)))) {
      throw invalid('Routine names and aliases must be explicitly present in the supporting user quote.');
    }
    return;
  }
  if (!Array.isArray(allowedSources) || !allowedSources.length || allowedSources.length > AUTHORING_SOURCE_LIMIT) throw invalid('Invalid routine authoring source pool.');
  const ids = new Set(); let chars = 0;
  const candidates = allowedSources.map(item => {
    if (!item || item.role !== 'user' || typeof item.text !== 'string'
      || (source.session_id === undefined ? item.id !== source.id : item.session_id !== source.session_id)) {
      throw invalid('Routine definitions need direct user messages from the same conversation.');
    }
    text(item.id, 'Definition source ID', 200); text(item.text, 'Definition source text', AUTHORING_SOURCE_CHARS);
    if (ids.has(item.id) || (chars += item.text.length) > AUTHORING_SOURCE_CHARS) throw invalid('Invalid or oversized routine authoring source pool.');
    ids.add(item.id); return item;
  }).reverse();
  const used = new Set();
  const complete = candidates.find(item => item.text.includes(value.prompt));
  if (complete) used.add(complete.id);
  else {
    const fragments = value.prompt.split('\n');
    if (fragments.length < 2 || fragments.some(fragment => !fragment.trim())) throw invalid('Save the exact requested routine prompt from the supporting direct user messages; invent no actions.');
    for (const fragment of fragments) {
      const match = candidates.find(item => item.text.includes(fragment));
      if (!match) throw invalid('Save the exact requested routine prompt from the supporting direct user messages; invent no actions.');
      used.add(match.id);
    }
  }
  for (const trigger of [value.name, ...value.aliases]) {
    const match = candidates.find(item => normalize(item.text).includes(normalize(trigger)));
    if (!match) {
      throw invalid('Routine names and aliases must be explicitly present in the supporting user quote.');
    }
    used.add(match.id);
  }
  return definitionSources(allowedSources.filter(item => used.has(item.id)).map(item => ({ source_id: item.id, source_quote: item.text })));
}
function date(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function initial() { return { version: 1, routines: [], pending: [], activations: [] }; }
function publicRoutine({ operation_id, ...routine }) { return clone(routine); }
function routineCatalog({ id, name, aliases, version }) { return { id, name, aliases: [...aliases], version }; }
function informational(message) {
  const value = normalize(message);
  return value.includes('?') || /^(?:what|how|why|when|where|who|which)\b|^(?:tell me about|explain|i wonder|give me advice)\b/u.test(value);
}
function mentions(textValue, phrase) {
  const text = normalize(textValue); const needle = normalize(phrase);
  let index = text.indexOf(needle);
  while (index >= 0) {
    const before = [...text.slice(Math.max(0, index - 2), index)].at(-1) ?? '';
    const after = [...text.slice(index + needle.length, index + needle.length + 2)][0] ?? '';
    if (!/[\p{L}\p{N}\p{M}_]/u.test(before) && !/[\p{L}\p{N}\p{M}_]/u.test(after)) return true;
    index = text.indexOf(needle, index + needle.length);
  }
  return false;
}

/** Recover a real proposal from a prose-only reply; this grants no activation permission. */
export function detectRoutineSuggestion(routines, { message, reply } = {}) {
  if (!Array.isArray(routines) || typeof message !== 'string' || typeof reply !== 'string'
    || informational(message) || !reply.trim() || reply.length > 6000 || reply.includes('`') || /^\s*>/mu.test(reply)) return null;
  let normalized = normalize(reply);
  // Quoted names are ordinary labels. Quoted questions, code, and examples are not proposals.
  for (const routine of routines) for (const alias of [routine.name, ...(routine.aliases ?? [])]) {
    const name = normalize(alias);
    for (const [open, close] of [['“', '”'], ['"', '"'], ["'", "'"]]) normalized = normalized.split(`${open}${name}${close}`).join(name);
  }
  if (/["“”‘]/u.test(normalized) || /(?:^|[\s([{])'[^'\n]+'(?=$|[\s).,!?\]])/u.test(normalized)
    || /\b(?:for example|as an example|e\.g\.|suppose|hypothetically|imagine|quoted|quotation|you could ask|i could ask)\b/u.test(normalized)) return null;
  const questions = [...normalized.matchAll(/\b(?:do you want|would you like|did you mean|shall i|should i)\s+(?:me\s+)?(?:to\s+)?(?:start|run|begin)\b[^?\n]{0,240}\?/gu)];
  if (questions.length !== 1) return null;
  const question = questions[0];
  const previous = normalized.slice(0, question.index).split(/[.!?\n]/u).filter(part => part.trim()).at(-1)?.slice(-240) ?? '';
  if (/\b(?:if|whether|might|could|example)\b/u.test(previous)) return null;
  const direct = routines.filter(routine => [routine.name, ...(routine.aliases ?? [])].some(alias => mentions(question[0], alias)));
  const candidates = direct.length ? direct : /\b(?:it|that|the routine)\b/u.test(question[0]) && /\broutine\b/u.test(previous)
    ? routines.filter(routine => [routine.name, ...(routine.aliases ?? [])].some(alias => mentions(previous, alias))) : [];
  if (candidates.length !== 1) return null;
  return { ...routineCatalog(candidates[0]), reason: 'A direct yes/no question proposed one explicitly named saved routine; confirmation is still required.' };
}
function triggerPhrases(routine) {
  const phrases = new Set();
  for (const alias of [routine.name, ...(routine.aliases ?? [])]) {
    const trigger = activationText(alias);
    const exact = [trigger, `start ${trigger}`, `run ${trigger}`, `begin ${trigger}`,
      `start ${trigger} routine`, `run ${trigger} routine`, `begin ${trigger} routine`,
      `start my ${trigger} routine`, `run my ${trigger} routine`, `start the ${trigger} routine`, `run the ${trigger} routine`,
      `i'm going to ${trigger}`, `im going to ${trigger}`, `i am going to ${trigger}`];
    for (const request of exact) for (const phrase of [request, `merlin ${request}`, `merlin, ${request}`]) phrases.add(phrase);
  }
  return phrases;
}
function validate(state) {
  keys(state, ['version', 'routines', 'pending', 'activations']);
  if (state.version !== 1 || !Array.isArray(state.routines) || !Array.isArray(state.pending)
    || !Array.isArray(state.activations) || state.routines.length > 100 || state.pending.length > 100 || state.activations.length > 1000) throw invalid('Invalid routine file.');
  const ids = new Set(); const triggers = new Set();
  for (const routine of state.routines) {
    keys(routine, ['id', 'name', 'aliases', 'prompt', 'source_id', 'source_quote', 'definition_sources', 'created_at', 'updated_at', 'version', 'operation_id']);
    const input = args(Object.fromEntries(['id', 'name', 'aliases', 'prompt', 'source_id', 'source_quote', 'definition_sources'].filter(key => key in routine).map(key => [key, routine[key]])), true);
    if (input.definition_sources) {
      if (input.source_id === 'manual') throw invalid('Manual routines cannot claim conversational definition sources.');
      evidence(input, { id: input.source_id, role: 'user', text: input.source_quote, session_id: 'stored' },
        input.definition_sources.map(item => ({ id: item.source_id, role: 'user', text: item.source_quote, session_id: 'stored' })));
    }
    if (ids.has(routine.id) || !Number.isSafeInteger(routine.version) || routine.version < 1 || !date(routine.created_at) || !date(routine.updated_at)) throw invalid('Invalid or duplicate routine record.');
    ids.add(routine.id);
    if (routine.operation_id !== undefined) text(routine.operation_id, 'Operation ID', 256);
    for (const trigger of triggerPhrases(routine)) {
      if (triggers.has(trigger)) throw invalid('Ambiguous routine trigger.'); triggers.add(trigger);
    }
  }
  const sessions = new Set();
  for (const pending of state.pending) {
    keys(pending, ['session_id', 'routine_id', 'request_id', 'confirmation_request_id', 'created_at', 'expires_at']);
    ['session_id', 'routine_id', 'request_id'].forEach(key => text(pending[key], key, 200));
    if ('confirmation_request_id' in pending) text(pending.confirmation_request_id, 'Confirmation request ID', 200);
    if (!ids.has(pending.routine_id) || sessions.has(pending.session_id) || !date(pending.created_at)
      || !date(pending.expires_at) || Date.parse(pending.expires_at) - Date.parse(pending.created_at) !== PENDING_MS) throw invalid('Invalid pending routine.');
    sessions.add(pending.session_id);
  }
  for (const receipt of state.activations) {
    keys(receipt, ['session_id', 'request_id', 'routine_id', 'created_at']);
    ['session_id', 'request_id', 'routine_id'].forEach(key => text(receipt[key], key, 200));
    if (!date(receipt.created_at)) throw invalid('Invalid routine activation receipt.');
  }
}

/** Anchored activation syntax. Similar meaning never grants execution permission. */
export function matchRoutineActivation(routine, message) {
  if (typeof message !== 'string') return null;
  const candidate = activationText(message);
  if (candidate.includes('?')) return null;
  for (const alias of [routine.name, ...(routine.aliases ?? [])]) {
    if (triggerPhrases({ name: alias }).has(candidate)) return alias;
  }
  return null;
}

/** Durable routine data and per-session consent; saved prompts are data, never eval'd code. */
export class RoutinesStore {
  #path; #state; #queue = Promise.resolve(); #now;
  constructor({ filePath, now = Date.now } = {}) {
    this.#path = resolve(text(filePath, 'filePath', 4096));
    if (typeof now !== 'function') throw invalid('Routine clock must be a function.'); this.#now = now;
  }
  #timestamp() {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || !Number.isFinite(new Date(now).getTime())) throw invalid('Invalid routine clock.');
    return now;
  }
  #ready() { if (!this.#state) throw new Error('RoutinesStore.init() must succeed first.'); }
  #exclusive(action) { const result = this.#queue.then(action); this.#queue = result.catch(() => {}); return result; }
  async #persist(state) {
    const temporary = `${this.#path}.${randomUUID()}.tmp`; let handle;
    try {
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
      handle = await open(temporary, 'wx', 0o600); await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
      await handle.sync(); await handle.close(); handle = undefined; await rename(temporary, this.#path);
    } catch (cause) {
      await handle?.close().catch(() => {}); await rm(temporary, { force: true }).catch(() => {});
      const error = new Error('Could not save routines; the requested change was not applied.', { cause }); error.code = 'ROUTINE_STORAGE_ERROR'; throw error;
    }
  }
  async #mutate(action) {
    return this.#exclusive(async () => {
      this.#ready(); const next = clone(this.#state); const result = action(next);
      await this.#persist(next); this.#state = next; return clone(result);
    });
  }
  async init() {
    return this.#exclusive(async () => {
      if (this.#state) return this;
      let contents;
      try { contents = await readFile(this.#path, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      let state;
      if (contents === undefined) { state = initial(); await this.#persist(state); }
      else {
        try { state = JSON.parse(contents); validate(state); }
        catch (cause) { const error = new Error('The routine file is corrupted; it was not overwritten.', { cause }); error.code = 'ROUTINE_STORAGE_CORRUPT'; throw error; }
        await chmod(this.#path, 0o600);
      }
      this.#state = state; return this;
    });
  }
  list() { this.#ready(); return this.#state.routines.map(publicRoutine); }
  getPending(sessionId) {
    this.#ready(); text(sessionId, 'Session ID', 200);
    const pending = this.#state.pending.find(item => item.session_id === sessionId && Date.parse(item.expires_at) > this.#timestamp());
    return pending ? clone(pending) : null;
  }
  async save(value, source, operationId, allowedSources) {
    const input = args(value);
    const definitions = evidence(input, source, allowedSources);
    if (definitions) input.definition_sources = definitions;
    if (operationId !== undefined) text(operationId, 'Operation ID', 256);
    return this.#mutate(state => {
      const duplicate = operationId && state.routines.find(item => item.operation_id === operationId);
      if (duplicate) {
        if (Object.entries(input).some(([key, entry]) => JSON.stringify(duplicate[key]) !== JSON.stringify(entry))) throw invalid('Routine operation ID was reused with different data.');
        return publicRoutine(duplicate);
      }
      const previous = input.id && state.routines.find(item => item.id === input.id);
      if (input.id && !previous) throw invalid('Routine not found.');
      if (!previous && state.routines.length >= 100) throw invalid('At most 100 routines can be saved.');
      const otherTriggers = new Set(state.routines.filter(item => item.id !== input.id).flatMap(item => [...triggerPhrases(item)]));
      if ([...triggerPhrases(input)].some(alias => otherTriggers.has(alias))) throw invalid('Another routine already uses this name or activation phrase. Choose a distinct trigger.');
      const stamp = new Date(this.#timestamp()).toISOString();
      const record = { ...input, id: previous?.id ?? randomUUID(), version: (previous?.version ?? 0) + 1,
        created_at: previous?.created_at ?? stamp, updated_at: stamp, ...(operationId ? { operation_id: operationId } : {}) };
      if (previous) {
        state.routines[state.routines.indexOf(previous)] = record;
        state.pending = state.pending.filter(item => item.routine_id !== record.id);
      } else state.routines.push(record);
      return publicRoutine(record);
    });
  }
  async remove(id) {
    text(id, 'Routine ID', 200);
    return this.#mutate(state => {
      if (!state.routines.some(item => item.id === id)) throw invalid('Routine not found.');
      state.routines = state.routines.filter(item => item.id !== id);
      state.pending = state.pending.filter(item => item.routine_id !== id);
      state.activations = state.activations.filter(item => item.routine_id !== id);
      return { removed_id: id };
    });
  }
  async clear() { return this.#mutate(state => { Object.assign(state, initial()); return { cleared: true }; }); }
  async clearSession(sessionId) {
    text(sessionId, 'Session ID', 200);
    return this.#mutate(state => {
      state.pending = state.pending.filter(item => item.session_id !== sessionId);
      state.activations = state.activations.filter(item => item.session_id !== sessionId);
      return { cleared_session: sessionId };
    });
  }
  async beginRequest({ session_id, request_id, message }) {
    text(session_id, 'Session ID', 200); text(request_id, 'Request ID', 200); text(message, 'User message', 12000);
    this.#ready();
    if (!this.#state.pending.some(item => item.session_id === session_id)) return null;
    return this.#mutate(state => {
      const pending = state.pending.find(item => item.session_id === session_id);
      if (!pending) return null;
      if (pending.request_id === request_id || pending.confirmation_request_id === request_id) return clone(pending);
      if (Date.parse(pending.expires_at) > this.#timestamp() && !pending.confirmation_request_id && CONFIRMATIONS.has(activationText(message))) {
        pending.confirmation_request_id = request_id; return clone(pending);
      }
      state.pending = state.pending.filter(item => item !== pending); return null;
    });
  }
  async suggest({ session_id, routine_id, request_id, message = '' }) {
    text(message, 'User message', 12000, true);
    return this.#decision({ session_id, routine_id, request_id, message, forceSuggest: true });
  }
  async activate({ session_id, routine_id, message, request_id }) {
    text(message, 'User message', 12000);
    return this.#decision({ session_id, routine_id, message, request_id, forceSuggest: false });
  }
  async #decision({ session_id, routine_id, message, request_id, forceSuggest }) {
    text(session_id, 'Session ID', 200); text(routine_id, 'Routine ID', 200); text(request_id, 'Request ID', 200);
    return this.#mutate(state => {
      const routine = state.routines.find(item => item.id === routine_id);
      if (!routine) throw invalid('Routine not found.');
      if (informational(message)) {
        state.pending = state.pending.filter(item => item.session_id !== session_id);
        return { started: false, mode: 'ignored', routine: routineCatalog(routine),
          reason: 'This request asks for information. Mentioning a routine in a question does not activate or suggest it.' };
      }
      const prior = state.activations.find(item => item.session_id === session_id && item.request_id === request_id && item.routine_id === routine_id);
      if (prior) return { started: false, mode: 'already_started', routine: routineCatalog(routine), reason: 'This routine was already activated for this request.' };
      const timestamp = this.#timestamp();
      state.pending = state.pending.filter(item => Date.parse(item.expires_at) > timestamp);
      const pending = state.pending.find(item => item.session_id === session_id && item.routine_id === routine_id);
      const matched_alias = !forceSuggest && matchRoutineActivation(routine, message);
      const confirmed = !forceSuggest && CONFIRMATIONS.has(activationText(message)) && pending
        && pending.request_id !== request_id && pending.confirmation_request_id === request_id;
      if (matched_alias || confirmed) {
        state.pending = state.pending.filter(item => item.session_id !== session_id);
        state.activations.push({ session_id, request_id, routine_id, created_at: new Date(timestamp).toISOString() });
        state.activations = state.activations.slice(-1000);
        return { started: true, mode: 'start', routine: publicRoutine(routine),
          reason: confirmed ? 'The immediately following user request explicitly confirmed this pending routine.' : 'The complete user request matched an explicit saved routine trigger.',
          ...(matched_alias ? { matched_alias } : {}), confirmed: Boolean(confirmed) };
      }
      const suggestion = { session_id, routine_id, request_id, created_at: new Date(timestamp).toISOString(), expires_at: new Date(timestamp + PENDING_MS).toISOString() };
      state.pending = state.pending.filter(item => item.session_id !== session_id); state.pending.push(suggestion);
      state.pending = state.pending.slice(-100);
      return { started: false, mode: 'suggest', routine: routineCatalog(routine), pending: clone(suggestion),
        reason: forceSuggest ? 'A related routine was suggested; explicit confirmation is required.' : 'The complete user request did not match an explicit saved trigger; confirmation is required before any routine actions.' };
    });
  }
}

const stringProperty = description => ({ type: 'string', description });
const functionTool = (name, description, properties) => ({ type: 'function', name, description,
  parameters: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false } });
export const ROUTINE_TOOLS = [
  functionTool('routine_save', 'Save or edit a named routine as soon as the user has supplied its name and actions. The current message authorizes saving; its content can refer to earlier direct user messages in this conversation. Copy the requested actions from those messages, without inventing actions. Do not ask for repetition or an extra confirmation when the reference is clear. Saving alone never runs it.', {
    id: stringProperty('Existing routine ID when editing; empty string creates a routine.'),
    name: stringProperty('Explicit routine name.'), aliases: { type: 'array', items: { type: 'string' }, maxItems: 12, description: 'Only additional trigger phrases explicitly requested by the user; use [] unless given. Do not repeat the primary name.' },
    prompt: stringProperty('Copy an EXACT action excerpt from the supplied direct user sources, preserving even typos and punctuation. Do not reword or correct it; present a clean summary in your reply instead. Multiple exact excerpts may be joined with newlines. Preserve conditions; omit surrounding setup or run-now instructions.'),
    source_quote: stringProperty('Exact quote from the CURRENT user message authorizing this save or edit, including references such as what we already said. The name and actions may come from earlier user sources.'),
  }),
  functionTool('routine_read', 'Read the actual saved request for a routine when the user asks what it does or asks to look it up. This reads local routine information, never activates it and never requires web search.', {
    id: stringProperty('Exact saved routine ID from the catalog.'),
  }),
  functionTool('routine_use', 'Use a saved routine only for explicit activation intent. Use start for the exact name or direct activation; the application checks the complete user message. Use suggest for similar intent such as going to exercise. Information questions about workouts or good sleep do not activate routines. A pending suggestion requires a separate yes before running.', {
    id: stringProperty('Exact saved routine ID.'), mode: { type: 'string', enum: ['start', 'suggest'] },
  }),
  functionTool('routine_delete', 'Delete a saved routine only when the current direct user explicitly asks.', {
    id: stringProperty('Exact saved routine ID.'), source_quote: stringProperty('Exact quote of the user request to delete this routine.'),
  }),
];
export const ROUTINE_INSTRUCTIONS = `Named routines are saved replacement requests, not arbitrary executable code. Distinguish DEFINING/EDITING, READING, and STARTING a routine before choosing actions. Do not require formal syntax or the word routine: "bedtime should set a timer and look up the weather" defines a named routine. Tolerate ordinary typos.
When the user defines or asks to save a routine, call routine_save as soon as the name and requested actions are clear. Use the current conversation and supplied direct-user authoring sources to resolve "that", "what we already said", or a quoted answer to your setup question. Do not ask them to repeat information already available, supply an exact sentence, or confirm an already clear save request. Ask ONE concise question only for an actually missing or genuinely ambiguous detail. A prior assistant suggestion alone is not evidence of user-requested actions; use the user's actual instructions.
During routine setup, the action text describes what to SAVE, not what to EXECUTE. A quoted prompt supplied during setup completes the definition; it does not start timers or searches. Never execute the body or call routine_use just because its keyword appears in the definition. Run after saving only if the current user separately and explicitly asks to run it now. Otherwise confirm the completed save briefly and let a later intentional activation run it. Never claim saved without a successful routine_save result. Use an existing ID for a clearly requested edit; do not create a duplicate of the same routine.
When asked "what is my bedtime routine" or "look up bedtime", read the matching saved routine with routine_read (or use its already loaded saved definition). Explain the actual saved steps; do not search the web for a dictionary definition or claim it is absent merely because the small catalog omits its full prompt. A read is never an activation.
Before answering each new user message, compare the CURRENT message's intent with the saved routine names and aliases as part of this same response.
Use routine_use(start) for an explicit whole-request activation such as a standalone name, "Merlin goodnight", or "I'm going to workout". Information questions such as "what should I eat before I workout" or "how do I get a goodnight of sleep" do not activate or suggest routines.
When the CURRENT message clearly announces an intention to begin an activity that strongly matches one saved routine, but is not an exact activation phrase, you MUST propose that routine by calling routine_use with mode suggest. For example, if Workout exists and the user says "I'm going to exercise in the gym", call routine_use(suggest) for Workout; do not merely acknowledge the plan, offer generic advice, or wait for the user to ask for timers. Suggestion asks permission; it does not start any actions. If the intent is unrelated, informational, ambiguous between routines, or the CURRENT message explicitly says not to start or suggest it, do not propose it.
A prior turn's one-time "do not start it" instruction applied to that earlier request. Do not silently turn it into an ongoing ban on suggestions in later turns. Only an explicitly saved applicable standing instruction or an opt-out in the CURRENT message persists as a reason to withhold a relevant suggestion.
You MUST call routine_use with mode suggest BEFORE asking any question about starting a saved routine. Never ask an activation confirmation only in prose: without the tool there is no pending state for the user's next yes. The application asks the confirmation after the tool succeeds. Then wait for explicit confirmation in a new user turn. Never execute a suggested routine. Only a successful routine_use result with started:true authorizes its exact saved prompt for this request. Apply all current standing rules and actual tool limits to every resulting action; successful activation does not prove any action completed. Never invent Goodnight actions.`;

export class RoutineService {
  constructor({ store, memoryStore }) { this.store = store; this.memoryStore = memoryStore; }
  inspect(sessionId) { return { routines: this.store.list(), pending_routine: sessionId ? this.store.getPending(sessionId) : null }; }
  context(sessionId) {
    return { routines: this.store.list().map(({ id, name, aliases, version }) => ({ id, name, aliases, version })),
      pending_routine: sessionId ? this.store.getPending(sessionId) : null, instructions: ROUTINE_INSTRUCTIONS };
  }
  #authoringPool(sessionId, sourceId) {
    const messages = this.memoryStore.snapshot().conversations;
    const current = messages.findIndex(item => item.id === sourceId && item.role === 'user'
      && (item.session_id === sessionId || item.session_id === undefined));
    if (current < 0) throw invalid('Routine authoring needs the current direct user message.');
    const selected = [];
    let chars = 0;
    for (let index = current; index >= 0 && selected.length < AUTHORING_SOURCE_LIMIT; index--) {
      const item = messages[index];
      if (item.role !== 'user' || (item.session_id !== sessionId && item.id !== sourceId)) continue;
      if (typeof item.text !== 'string' || !item.text.trim()) continue;
      if (chars + item.text.length > AUTHORING_SOURCE_CHARS) break;
      selected.push(item); chars += item.text.length;
    }
    return selected.reverse();
  }
  authoringSources(sessionId, sourceId) {
    return this.#authoringPool(sessionId, sourceId).map(({ id, text }) => ({ id, text }));
  }
  #source(context, quote) {
    const source = this.memoryStore.snapshot().conversations.find(item => item.id === context.source_id && item.role === 'user');
    if (!source || (source.session_id !== undefined && source.session_id !== context.session_id)
      || typeof quote !== 'string' || !quote.trim() || !source.text.includes(quote) || source.text !== context.message) {
      throw invalid('Routine changes need an exact quotation from the current direct user message.');
    }
    return source;
  }
  async execute(name, value, context, operationId) {
    if (name === 'routine_save') {
      keys(value, ['id', 'name', 'aliases', 'prompt', 'source_quote']);
      const source = this.#source(context, value.source_quote);
      const allowedSources = this.#authoringPool(context.session_id, source.id);
      // Repeating the name in aliases adds no meaning. Remove this common model
      // formatting mistake without adding or inferring an activation phrase.
      const aliases = typeof value.name === 'string' && Array.isArray(value.aliases) && value.aliases.every(alias => typeof alias === 'string')
        ? [...new Map(value.aliases.map(alias => [activationText(alias), alias])).values()].filter(alias => activationText(alias) !== activationText(value.name)) : value.aliases;
      const routine = await this.store.save({ ...value, aliases, ...(value.id ? { id: value.id } : { id: undefined }), source_id: source.id }, source, operationId, allowedSources);
      return { routine, saved: true, activated: false };
    }
    if (name === 'routine_read') {
      keys(value, ['id']); text(value.id, 'Routine ID', 200);
      const routine = this.store.list().find(item => item.id === value.id);
      if (!routine) throw invalid('Routine not found.');
      return { routine, read: true, activated: false };
    }
    if (name === 'routine_delete') {
      keys(value, ['id', 'source_quote']); this.#source(context, value.source_quote); return this.store.remove(value.id);
    }
    if (name === 'routine_use') {
      keys(value, ['id', 'mode']);
      if (!['start', 'suggest'].includes(value.mode)) throw invalid('Routine use mode must be start or suggest.');
      const common = { session_id: context.session_id, request_id: context.request_id ?? operationId?.split(':')[0], routine_id: value.id };
      return value.mode === 'suggest' ? this.store.suggest({ ...common, message: context.message }) : this.store.activate({ ...common, message: context.message });
    }
    throw invalid('Unknown routine operation.');
  }
}
