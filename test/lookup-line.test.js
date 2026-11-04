import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { checkedLookupLine } from '../src/lookup-line.js';
import { isAcknowledgmentEcho } from '../src/acknowledgments.js';
import { personalityContext } from '../src/personality.js';
import { normalizeRule } from '../src/memory-rules.js';
import { queuedSpeech } from '../src/voice/speech-queue.js';

// The middle of the three-part spoken answer for internet questions (owner request, November 3, 2026).
const answer = text => ({ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text, annotations: [] }] });
const search = query => ({ type: 'web_search_call', id: `ws_${randomUUID()}`, status: 'completed', action: { type: 'search', query }, results: [{ type: 'text_result', title: 'NWS', url: 'https://forecast.weather.gov/b', snippet: '' }] });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const LINE = 'Checking the weather in Brooklyn for you now.';
const rule = (kind, value) => normalizeRule({ kind, value, scope: 'assistant_reply', original: 'Synthetic.', source_id: 'manual', source_quote: '', explanation: 'Synthetic.' });

async function fixture(t, { steps, line = async () => LINE }) {
  const directory = await mkdtemp(join(tmpdir(), 'merlin-lookup-line-'));
  const spoken = [], lines = [];
  const meta = {
    configured: true, model: 'synthetic-meta', calls: [],
    async respond(input, tools, instructions, options) {
      this.calls.push({ tools, instructions });
      const step = steps.shift(); assert.ok(step, 'Unexpected model call');
      return typeof step === 'function' ? step({ input, tools, instructions, options }) : step;
    },
    async lookupLine(request) { lines.push(request); return line(request); },
  };
  const app = await createApp({ dataDir: directory, meta, learningDelayMs: 60_000,
    tts: { status: () => ({ configured: true, voice: 'am_fenrir' }), synthesize: async text => { spoken.push(text); return Buffer.from('synthetic-wav'); }, close() {} },
    voiceMeta: { configured: true, model: 'synthetic-voice' }, listener: { status: () => ({ configured: true, wakeWord: 'MERLIN' }), close() {} } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await app.learning.close();
    await new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  });
  const post = async (path, value) => {
    const response = await fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
    return { status: response.status, type: response.headers.get('content-type'), body: response.headers.get('content-type')?.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer()) };
  };
  const progress = async id => (await (await fetch(`${origin}/api/companion/progress?request_id=${id}`)).json());
  return { app, meta, spoken, lines, post, progress };
}
const chat = message => ({ message, session_id: randomUUID(), request_id: randomUUID(), time_zone: 'America/New_York', channel: 'typed' });

test('a search request offers a spoken lookup line while it runs, then never again, and the line is not part of the reply', async t => {
  const gate = deferred();
  const h = await fixture(t, { steps: [async () => { await gate.promise; return [search('weather Brooklyn'), answer('It is sunny in Brooklyn today.')]; }] });
  const request = chat('Look up the weather in Brooklyn.');
  const reply = h.post('/api/chat', request);
  let events = [];
  for (let attempt = 0; attempt < 100 && !events.some(event => event.stage === 'lookup_line'); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
    events = (await h.progress(request.request_id)).events ?? [];
  }
  const offered = events.find(event => event.stage === 'lookup_line');
  assert.ok(offered, 'the page is told a line is ready');
  assert.deepEqual(Object.keys(offered).sort(), ['at_ms', 'stage'], 'the progress stream carries no words');
  assert.equal(h.lines.length, 1);
  assert.equal(h.lines[0].message, 'Look up the weather in Brooklyn.');
  const audio = await h.post('/api/companion/lookup-speech', { request_id: request.request_id, delivery: 'natural', speed: 1 });
  assert.equal(audio.status, 200);
  assert.equal(audio.type, 'audio/wav');
  assert.deepEqual(h.spoken, [LINE]);
  gate.resolve();
  const done = await reply;
  assert.equal(done.status, 200);
  assert.equal(done.body.reply, 'It is sunny in Brooklyn today.');
  assert.equal((await h.post('/api/companion/lookup-speech', { request_id: request.request_id })).status, 409, 'once the answer is known there is nothing left to cover');
  const stored = h.app.store.snapshot().conversations.map(item => item.text).join('\n');
  assert.equal(stored.includes('Checking the weather'), false, 'the line is never saved as conversation');
  assert.ok(done.body.trace.events.some(event => event.stage === 'lookup_line' && event.data.text === LINE), 'the inspector shows what was said');
});

test('no line for a request that does not search, in plain style, or under a rule that fixes the wording', async t => {
  const quiet = await fixture(t, { steps: [[answer('Hello!')]] });
  assert.equal((await quiet.post('/api/chat', chat('Hello there'))).status, 200);
  assert.equal(quiet.lines.length, 0);

  const plain = await fixture(t, { steps: [[search('weather'), answer('Sunny.')]] });
  await plain.app.store.setPersonality({ style: 'plain', address: '' });
  assert.equal((await plain.post('/api/chat', chat('Look up the weather in Brooklyn.'))).status, 200);
  assert.equal(plain.lines.length, 0);

  const framed = await fixture(t, { steps: [[search('weather'), answer('Status: sunny.')]] });
  await framed.app.store.putRule(rule('response_prefix', 'Status:'));
  assert.equal((await framed.post('/api/chat', chat('Look up the weather in Brooklyn.'))).status, 200);
  assert.equal(framed.lines.length, 0);
});

test('a line that fails its checks is never offered, and a failing line call never affects the answer', async t => {
  const bad = await fixture(t, { steps: [[search('weather'), answer('Sunny.')]], line: async () => 'It is 68 degrees and sunny in Brooklyn.' });
  const result = await bad.post('/api/chat', chat('Look up the weather in Brooklyn.'));
  assert.equal(result.status, 200);
  assert.equal(result.body.trace.events.some(event => event.stage === 'lookup_line'), false);
  assert.ok(result.body.trace.events.some(event => event.stage === 'lookup_line_skipped'), 'the inspector says why none was said');
  const broken = await fixture(t, { steps: [[search('weather'), answer('Sunny.')]], line: async () => { throw new Error('offline'); } });
  const still = await broken.post('/api/chat', chat('Look up the weather in Brooklyn.'));
  assert.equal(still.status, 200);
  assert.equal(still.body.reply, 'Sunny.');

  const said = await fixture(t, { steps: [[answer('Noted.')], [search('weather'), answer('Sunny.')]] });
  const session = randomUUID();
  await said.post('/api/chat', { ...chat('I live in Brooklyn, New York.'), session_id: session });
  await said.post('/api/chat', { ...chat("What's the weather today?"), session_id: session });
  assert.match(said.lines[0].context, /Earlier in this conversation: I live in Brooklyn, New York\./u, 'what was said earlier gives the line its context');
});

test('the line checks keep only a short statement of what is being looked up', () => {
  const policy = personalityContext();
  for (const line of [LINE, 'Looking up kosher pizza places near you.', '“Searching for the Knicks score now.”', 'Checking PS5 prices in Brooklyn for you now.', 'Looking up the 49ers schedule.']) assert.ok(checkedLookupLine(line, { policy }), line);
  for (const line of ['It is 68 degrees in Brooklyn.', 'Checking whether it closes at 9 tonight.', 'Want me to look that up?', 'Sure thing!', 'Checking: sunny all day.', `${'Looking up '.repeat(12)}now.`, 'Checking the weather for you, mister.', 'Golly, checking the weather now.', '', null]) {
    assert.equal(checkedLookupLine(line, { policy }), null, String(line));
  }
  assert.equal(checkedLookupLine(LINE, { policy, rules: [rule('avoid_word', 'Brooklyn')] }), null, 'saved word bans apply');
});

test('speech requests wait their turn instead of failing as busy', async () => {
  let running = 0, overlapped = false;
  const voice = { synthesize: async text => { running++; overlapped ||= running > 1; await new Promise(resolve => setTimeout(resolve, 5)); running--; return text; }, status: () => ({ configured: true }) };
  const queued = queuedSpeech(voice);
  assert.deepEqual(await Promise.all([queued.synthesize('one'), queued.synthesize('two'), queued.synthesize('three')]), ['one', 'two', 'three']);
  assert.equal(overlapped, false);
  assert.deepEqual(queued.status(), { configured: true });
  const stopped = new AbortController(); stopped.abort();
  await assert.rejects(queued.synthesize('never', { signal: stopped.signal }));
});

test('MERLIN hearing its own lookup line is an echo, not a request', () => {
  assert.equal(isAcknowledgmentEcho('checking the weather in Brooklyn for you now', null, [LINE]), true);
  assert.equal(isAcknowledgmentEcho('what is the weather in Queens tomorrow', null, [LINE]), false);
  assert.equal(isAcknowledgmentEcho('checking the weather in Brooklyn for you now', null, []), false);
});
