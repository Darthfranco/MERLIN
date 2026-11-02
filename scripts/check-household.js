// Live check that questions about the household stay out of the web, and that web
// text never reads as a fact about the household.
//
// Runs one invented pet through the actual assistant on both memory engines against
// the real Meta API with throwaway storage. It spends a small number of model and
// search credits and touches no household data. v2 uses the configured embedding
// service. Searches and labels are checked by code; reply wording is model-dependent
// and is printed for a person to read.
//
//   npm run check:household
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/server.js';
import { LOOKUP_REPLIES } from '../src/lookup.js';
import { MetaClient } from '../src/meta.js';

const STATEMENT = 'Just so you know, my dog Biscuit naps on the sunporch.';
const QUESTION = 'Where does Biscuit nap?';

const meta = new MetaClient({ apiKey: process.env.META_API_KEY || process.env.MODEL_API_KEY, model: process.env.META_MODEL || 'muse-spark-1.3' });
if (!meta.configured) {
  console.error('Add META_API_KEY to .env first.');
  process.exit(1);
}

const searches = data => (data.tool_events ?? []).filter(event => event.tool === 'web_search' && event.status === 'completed').length;
const labeled = data => String(data.reply).includes(LOOKUP_REPLIES.general);

let failures = 0;
function report(engine, name, ok, data) {
  if (!ok) failures++;
  const state = data.lookup ? `${data.lookup.policy}/${data.lookup.state}` : 'no lookup';
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${engine.padEnd(6)} ${name.padEnd(34)} searches=${searches(data)} labeled=${labeled(data)} ${state}\n      ${String(data.reply ?? data.error).replace(/\s+/gu, ' ').slice(0, 260)}`);
}

async function withApp(engine, work) {
  const directory = await mkdtemp(join(tmpdir(), 'merlin-household-check-'));
  let now = Date.now();
  const app = await createApp({ dataDir: directory, meta, memoryEngine: engine, learningDelayMs: 0, memoryOptions: { tickMs: 0, clock: () => now } });
  const ask = async (message, session_id = randomUUID()) => (await app.runChatTurn({ message, session_id, request_id: randomUUID(), time_zone: 'America/New_York' })).data;
  try { await work({ app, ask, close: async () => { now += 120_000; await app.learning.drain(); } }); }
  finally {
    await app.learning.close();
    await rm(directory, { recursive: true, force: true });
  }
}

for (const engine of ['legacy', 'v2']) {
  await withApp(engine, async ({ ask }) => {
    const data = await ask(QUESTION);
    report(engine, 'no memory: no search, or labeled', searches(data) === 0 || labeled(data), data);
  });
  await withApp(engine, async ({ ask }) => {
    const session = randomUUID();
    await ask(STATEMENT, session);
    const data = await ask(QUESTION, session);
    report(engine, 'answer in the conversation', searches(data) === 0, data);
  });
  await withApp(engine, async ({ app, ask, close }) => {
    await ask(STATEMENT);
    await close();
    const held = JSON.stringify(app.memory.inspect().facts ?? []).includes('Biscuit');
    if (!held) console.log(`      ${engine}: learning published nothing about Biscuit, so the next line is not a finalized-memory result.`);
    const data = await ask(QUESTION);
    report(engine, 'answer in finalized memory', held && searches(data) === 0, data);
    const explicit = await ask(`${QUESTION} Look it up.`);
    report(engine, 'explicit "look it up" is honored', searches(explicit) > 0 && labeled(explicit), explicit);
    const web = await ask("what's the capital of Australia?");
    report(engine, 'general fact still searches', searches(web) > 0 && !labeled(web), web);
    const current = await ask("what's the weather in Brooklyn right now?");
    report(engine, 'current question still searches', searches(current) > 0 && !labeled(current), current);
  });
}
console.log(failures ? `\n${failures} household checks failed.` : '\nAll household checks passed. Reply wording above is model-dependent.');
process.exit(failures ? 1 : 0);
