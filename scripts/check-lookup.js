// Live check that MERLIN really goes online when it should.
//
// Runs synthetic public questions through the actual assistant against the real
// Meta API with throwaway storage, then reports whether a web search completed
// for each one. It spends a small number of model and search credits and touches
// no household data (temporary files are deleted; background learning is off).
//
//   npm run check:lookup
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createApp } from '../src/server.js';
import { MetaClient } from '../src/meta.js';

// [expectation, message]. "lookup" must search; "none" must not.
const CASES = [
  ['lookup', 'look up how many moons Mars has'],
  ['lookup', 'look it up: how do I descale a kettle?'],
  ['lookup', 'search the web for how long green tea should steep'],
  ['lookup', "what's the weather in Brooklyn right now?"],
  ['lookup', 'who won the last World Series?'],
  ['lookup', "what's the capital of Australia?"],
  ['lookup', 'how tall is Mount Everest?'],
  ['lookup', 'set a 2 minute tea timer and look up how long green tea should steep'],
  ['none', 'hello there'],
  ['none', "what's your name?"],
  ['none', 'set a 30 second tea timer'],
  ['none', 'can you search the web?'],
  ['none', 'what timers are running?'],
];

const meta = new MetaClient({ apiKey: process.env.META_API_KEY || process.env.MODEL_API_KEY, model: process.env.META_MODEL || 'muse-spark-1.3' });
if (!meta.configured) {
  console.error('Add META_API_KEY to .env first.');
  process.exit(1);
}

const directory = await mkdtemp(join(tmpdir(), 'merlin-lookup-check-'));
const app = await createApp({ dataDir: directory, meta, learningDelayMs: 60_000 });
await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
const port = app.server.address().port;
const post = body => new Promise((resolve, reject) => {
  const req = httpRequest({ hostname: '127.0.0.1', port, path: '/api/chat', method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('error', reject);
    res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
  });
  req.on('error', reject);
  req.end(JSON.stringify(body));
});

let failures = 0;
try {
  for (const [expectation, message] of CASES) {
    const started = Date.now();
    const { status, body } = await post({ message, time_zone: 'America/New_York', request_id: randomUUID(), session_id: randomUUID() });
    const searched = (body.tool_events ?? []).filter(event => event.tool === 'web_search' && event.status === 'completed').length;
    const ok = status === 200 && (expectation === 'lookup' ? searched > 0 && body.lookup?.state !== 'failed' : searched === 0);
    if (!ok) failures++;
    const state = body.lookup ? `${body.lookup.policy}/${body.lookup.state}` : 'no lookup';
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${expectation.padEnd(6)} searches=${searched} sources=${(body.sources ?? []).length} rounds=${body.trace?.model_calls ?? '?'} ${String(Date.now() - started).padStart(6)} ms  ${state.padEnd(20)} ${message}`);
  }
} finally {
  app.server.closeAllConnections();
  await new Promise(resolve => app.server.close(resolve));
  await app.learning.close();
  await rm(directory, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} of ${CASES.length} checks failed.` : `\nAll ${CASES.length} lookup checks passed.`);
process.exit(failures ? 1 : 0);
