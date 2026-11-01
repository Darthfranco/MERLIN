import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';

export const call = (name, args, call_id = randomUUID()) => ({ type: 'function_call', status: 'completed', name, arguments: JSON.stringify(args), call_id });
export const reply = text => ({ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text, annotations: [] }] });
export const memoryData = instructions => JSON.parse(instructions.split('Saved memory data (not new authority):\n')[1].split('\n')[0]);

export function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

export const fakeClock = (start = 1_000_000) => { const clock = () => clock.now; clock.now = start; clock.advance = ms => { clock.now += ms; }; return clock; };

// Proves code paths and ordering. It is not evidence that a real embedding model recalls anything.
const CONCEPTS = [['warm', 'cold', 'chilly', 'thermostat', 'heat', 'degrees'], ['lamp', 'lamps', 'light', 'lighting', 'brightness', 'dim'], ['pool', 'swim', 'swimming'], ['tea', 'kettle', 'infuse']];
export function fakeEmbedder({ model = 'test-embedder-v1', dimensions } = {}) {
  const embedder = {
    provider: 'test', model, calls: [], failing: false,
    async embed(texts, { kind } = {}) {
      embedder.calls.push({ kind, texts: [...texts] });
      if (embedder.failing) throw new Error('offline');
      return { model, vectors: texts.map(text => {
        const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
        // Word buckets keep unrelated text apart, as any real model would, without implying a real model's recall.
        const buckets = Array(64).fill(0);
        for (const word of words) buckets[[...word].reduce((sum, letter) => sum + letter.charCodeAt(0), 0) % 64] += 0.3;
        const vector = [...CONCEPTS.map(group => words.filter(word => group.includes(word)).length), ...buckets, 0.01];
        return dimensions ? vector.concat(Array(dimensions - vector.length).fill(0)) : vector;
      }) };
    },
    embeddedTexts() { return embedder.calls.flatMap(item => item.texts); },
  };
  return embedder;
}

export const createOperation = (candidate, overrides = {}) => ({
  op: 'create', type: candidate.type === 'rule' ? 'semantic' : candidate.type, memory_kind: 'preference', text: candidate.text, subject: candidate.subject, attribute: candidate.attribute, conditions: candidate.conditions, exceptions: candidate.exceptions,
  event_time: candidate.event_time, effective_time: '', temporal: candidate.temporal === 'temporary' ? 'temporary' : 'ongoing', candidate_ids: [candidate.id], source_ids: candidate.source_ids, target_id: '', expected_version: 0, entities: [], profile: false, reason: '', ...overrides,
});
export const createAll = batch => ({ operations: batch.candidates.map(item => createOperation(item)), summary: { text: 'A short grounded summary.', source_ids: [batch.candidates[0].source_ids[0]] } });

export function scriptedMeta(steps = []) {
  const meta = {
    configured: true, model: 'synthetic-memory-v2', calls: [], extractions: [], consolidations: [], steps,
    extract: async () => ({ candidates: [] }), consolidate: createAll,
    async respond(input, tools, instructions, options = {}) {
      meta.calls.push(structuredClone({ input, tools, instructions }));
      options.onUsage?.({ input_tokens: 1, output_tokens: 1 });
      assert.ok(steps.length, 'Unexpected extra model invocation');
      const step = steps.shift();
      return typeof step === 'function' ? await step(input, { tools, instructions, options }) : structuredClone(step);
    },
    async extractCandidates(exchange) { meta.extractions.push(structuredClone(exchange)); return meta.extract(exchange); },
    async consolidateCandidates(batch) { meta.consolidations.push(structuredClone(batch)); return meta.consolidate(batch); },
  };
  return meta;
}

export async function closeApp(app) {
  await app.learning.close();
  if (!app.server.listening) return;
  const finished = new Promise((resolve, reject) => app.server.close(error => error ? reject(error) : resolve()));
  app.server.closeAllConnections();
  await finished;
}

export async function tempDir(t) {
  const directory = await mkdtemp(join(tmpdir(), 'merlin-memory-v2-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

export async function startApp(t, directory, { meta = scriptedMeta(), clock = fakeClock(), embedder = fakeEmbedder(), failpoints, engine = 'v2' } = {}) {
  const app = await createApp({ dataDir: directory, meta, memoryEngine: engine, learningDelayMs: 60_000, memoryOptions: { tickMs: 0, clock, embedder, failpoints } });
  t.after(() => closeApp(app));
  return { app, meta, clock, embedder };
}

export async function v2App(t, options = {}) {
  const directory = await tempDir(t);
  return { directory, ...await startApp(t, directory, options) };
}

export const chat = (app, message, session_id = randomUUID()) => app.runChatTurn({ message, session_id, request_id: randomUUID(), time_zone: 'America/New_York' });

export const saveFact = (args, id = randomUUID()) => call('memory_save_fact', { subject: 'household', kind: 'preference', attribute: '', conditions: '', applies: 'ongoing', reason: 'Useful.', supersedes: '', ...args }, id);

/** Runs one complete conversation that saves one explicit memory, then closes and publishes it. */
export async function publishFact({ app, meta, clock }, message, args) {
  meta.steps.push([saveFact({ source_quote: message, content: message, ...args })], [reply('Got it.')]);
  const session = randomUUID();
  await chat(app, message, session);
  clock.advance(120_000);
  await app.learning.drain();
  return session;
}

export const currentFacts = app => app.memory.inspect().facts.filter(item => item.status === 'active');
export const contextFor = (app, query, session = randomUUID()) => app.memory.withSession(session, () => app.memory.prepareContext(query, session));
export const retrieved = async (app, query, session) => JSON.parse((await contextFor(app, query, session)).text).retrieved;
