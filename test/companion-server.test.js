import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { MetaClient } from '../src/meta.js';
import { presentationEvent } from '../src/companion.js';
import { normalizeRule } from '../src/memory-rules.js';

const call = (name, args = {}, call_id = randomUUID()) => ({ type: 'function_call', status: 'completed', name, arguments: JSON.stringify(args), call_id });
const answer = text => ({ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text, annotations: [] }] });
const body = (message, extra = {}) => ({ message, session_id: randomUUID(), request_id: randomUUID(), time_zone: 'America/New_York', ...extra });
const secret = 'synthetic-provider-metadata-must-stay-private';
function script(...steps) {
  return { configured: true, model: 'synthetic-meta', calls: [], async respond(input, tools, instructions, options) {
    this.calls.push({ input: structuredClone(input), tools: structuredClone(tools), instructions });
    const step = steps.shift(); assert.ok(step, 'Unexpected model call');
    return typeof step === 'function' ? step({ input, tools, instructions, options }) : step;
  } };
}

async function fixture(t, meta = script([answer('Ready.')])) {
  const directory = await mkdtemp(join(tmpdir(), 'merlin-companion-test-'));
  const spoken = [];
  const spotifyCalls = [];
  const app = await createApp({ dataDir: directory, meta, learningDelayMs: 60_000,
    spotify: { status: () => ({ configured: true, connected: false, private_metadata: secret }), control: (...args) => spotifyCalls.push(args) },
    voiceMeta: { configured: true, model: 'synthetic-voice' },
    tts: { status: () => ({ configured: true, voice: 'am_fenrir' }), synthesize: async (text, options) => { spoken.push({ text, options }); return Buffer.from('synthetic-wav'); }, close() {} },
    listener: { status: () => ({ configured: true, wakeWord: 'MERLIN' }), close() {} },
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    app.closeVoice();
    await new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  });
  const request = async (path, value) => {
    const response = await fetch(origin + path, value ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) } : {});
    const content = response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text();
    return { status: response.status, headers: response.headers, body: content };
  };
  return { ...app, meta, request, spoken, spotifyCalls, origin };
}

test('companion reports only actual services, same timers and local voice readiness', async t => {
  const app = await fixture(t);
  const state = await app.request('/api/companion/state');
  assert.equal(state.status, 200);
  for (const name of ['lights', 'oven', 'schedules', 'cameras']) assert.deepEqual(state.body.services[name], { available: false, connected: false, status: 'unsupported' });
  assert.deepEqual(state.body.services.spotify, { available: true, configured: true, connected: false, status: 'not_connected', voice_control: false });
  assert.equal(state.body.voice.voice, 'am_fenrir');
  assert.equal(JSON.stringify(state.body).includes(secret), false);
  const voice = await app.request('/api/voice/status');
  assert.deepEqual(voice.body, state.body.voice);
  assert.equal((await app.request('/api/chat', body('Hello', { channel: 'ambient' }))).status, 400);
});

test('foreground progress strips household evidence and correlates real timer results', async t => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const app = await fixture(t, script(() => pending, [answer('The timer is set.')]));
  const request = body('Set a 90 second synthetic timer.');
  const work = app.runChatTurn(request);
  while (!app.meta.calls.length) await new Promise(resolve => setTimeout(resolve, 2));
  const active = await app.request(`/api/companion/progress?request_id=${request.request_id}`);
  assert.equal(active.body.status, 'running');
  assert.ok(active.body.events.some(event => event.stage === 'model'));
  finish([call('create_timer', { label: 'Synthetic tea', duration: 90, unit: 'seconds' })]);
  const result = await work;
  assert.equal(result.status, 200);
  assert.equal(result.data.presentation[0].id, result.data.timers[0].id);
  assert.equal(result.data.presentation[0].duration_seconds, 90);
  const progress = (await app.request(`/api/companion/progress?request_id=${request.request_id}`)).body;
  assert.equal(progress.status, 'complete');
  assert.ok(progress.events.some(event => event.stage === 'tool_start' && event.tool === 'create_timer'));
  assert.ok(progress.events.every(event => Object.keys(event).every(key => ['stage', 'at_ms', 'tool', 'ok'].includes(key))));
  assert.equal(JSON.stringify(progress).includes('Synthetic tea'), false);
  assert.deepEqual(presentationEvent('tool_result', 10, { tool: 'spotify_control', ok: true, result: secret, args: secret }), { stage: 'tool_result', at_ms: 10, tool: 'spotify_control', ok: true });
  assert.equal(presentationEvent('routine_context', 2, { private: secret }), null);
});

test('voice channel bypasses Spotify shortcuts and forbids invented tools', async t => {
  const app = await fixture(t, script(({ tools, instructions }) => {
    assert.ok(!tools.some(tool => tool.name?.startsWith('spotify_')));
    assert.match(instructions, /Spotify is unavailable for voice/);
    return [answer('Use the music panel for Spotify controls.')];
  }, [call('spotify_control', { action: 'pause' })]));
  const first = await app.runChatTurn(body('Pause Spotify.', { channel: 'voice' }));
  assert.equal(first.status, 200);
  assert.equal(app.meta.calls.length, 1);
  const invented = await app.runChatTurn(body('Pause the currently playing music on Spotify.', { channel: 'voice' }));
  assert.equal(invented.status, 502);
  assert.equal(app.spotifyCalls.length, 0);
});

test('voice routine expansion keeps Spotify unavailable while completing its timer', async t => {
  const app = await fixture(t, script(({ tools }) => {
    assert.ok(!tools.some(tool => tool.name?.startsWith('spotify_')));
    return [call('create_timer', { label: 'Synthetic tea', duration: 30, unit: 'seconds' })];
  }, [answer('Your timer is set. Use the music panel for Spotify.') ]));
  await app.routineStore.save({ name: 'synthetic tea time', aliases: [], prompt: 'Set a 30 second synthetic tea timer and play Spotify.', source_id: 'manual', source_quote: '' });
  const result = await app.runChatTurn(body('synthetic tea time', { channel: 'voice' }));
  assert.equal(result.status, 200);
  assert.equal(result.data.timers.length, 1);
  assert.equal(app.spotifyCalls.length, 0);
});

test('routine presentation uses the saved definition and survives a checked replacement', async t => {
  const app = await fixture(t, script());
  const session_id = randomUUID();
  const first = await app.runChatTurn(body('If I say synthetic teatime, set a thirty second timer.', { session_id }));
  assert.equal(first.status, 200);
  assert.equal(first.data.presentation[0].type, 'routine-saved');
  assert.equal(first.data.presentation[0].trigger, 'synthetic teatime');
  const replacement = await app.runChatTurn(body('If I say synthetic teatime, set a forty second timer.', { session_id }));
  assert.equal(replacement.status, 200);
  const stored = app.routineStore.list()[0];
  assert.deepEqual(replacement.data.presentation[0].steps, [stored.prompt]);
  assert.match(replacement.data.presentation[0].steps[0], /forty/);
  assert.equal(replacement.data.timers.length, 0);
});

test('a rapid voice follow-up waits for interrupted receipts before reading history', async t => {
  let finish;
  const delayed = new Promise(resolve => { finish = resolve; });
  const old = new AbortController();
  const app = await fixture(t, script(() => delayed, ({ input }) => {
    assert.match(JSON.stringify(input), /Reply failed:/);
    return [answer('Ready for the next request.')];
  }));
  const session_id = randomUUID();
  const first = app.runChatTurn(body('An unfinished request.', { session_id, channel: 'voice' }), { signal: old.signal });
  while (!app.meta.calls.length) await new Promise(resolve => setTimeout(resolve, 2));
  old.abort();
  const second = app.runChatTurn(body('What is next?', { session_id, channel: 'voice' }));
  finish([answer('This answer is stale.')]);
  assert.equal((await first).status, 499);
  assert.equal((await second).status, 200);
});

test('interrupt after one tool preserves its receipt and prevents later calls and replay', async t => {
  const controller = new AbortController();
  const app = await fixture(t, script([call('create_timer', { label: 'First', duration: 30, unit: 'seconds' }), call('create_timer', { label: 'Second', duration: 60, unit: 'seconds' })]));
  const create = app.timers.create.bind(app.timers);
  app.timers.create = async (...args) => { const result = await create(...args); controller.abort(); return result; };
  const input = body('Create two synthetic timers.');
  const result = await app.runChatTurn(input, { signal: controller.signal });
  assert.equal(result.status, 499);
  assert.equal(result.data.timers.length, 1);
  assert.equal(result.data.tool_events[0].status, 'completed');
  assert.match(result.data.tool_events[0].message, /First/);
  const retry = await app.runChatTurn(input);
  assert.equal(retry.status, 499);
  assert.equal((await app.timers.list()).length, 1);
  assert.equal(app.meta.calls.length, 1);
  const progress = await app.request(`/api/companion/progress?request_id=${input.request_id}`);
  assert.equal(progress.body.status, 'interrupted');
  assert.match(JSON.stringify(app.memory.history(input.session_id)), /Confirmed tool outcomes/);
});

test('late model response after interruption cannot execute its proposed timer', async t => {
  const controller = new AbortController();
  const app = await fixture(t, script(() => { controller.abort(); return [call('create_timer', { label: 'Stale', duration: 30, unit: 'seconds' })]; }));
  const result = await app.runChatTurn(body('Set a timer.'), { signal: controller.signal });
  assert.equal(result.status, 499);
  assert.equal(result.data.timers.length, 0);
});

test('speech accepts only checked stored replies and deletion removes their replay', async t => {
  const app = await fixture(t, script([answer('Ready to help.')]));
  const input = body('Hello.');
  const result = await app.runChatTurn(input);
  assert.equal((await app.request('/api/companion/speak', { request_id: input.request_id, text: 'Unchecked text' })).status, 400);
  assert.equal((await app.request('/api/companion/speak', { request_id: randomUUID() })).status, 404);
  assert.equal((await app.request('/api/companion/speak', { request_id: input.request_id })).status, 200);
  assert.equal(app.spoken[0].text, result.data.reply);
  await app.request('/api/memory/clear', {});
  assert.equal((await app.request('/api/companion/speak', { request_id: input.request_id })).status, 404);
  await assert.rejects(app.replyAudio(input.request_id), error => error.status === 404);
});

test('wake-session reply audio rechecks stored text against current instructions', async t => {
  const app = await fixture(t, script([answer('Ready to help.')]));
  const input = body('Hello.');
  const result = await app.runChatTurn(input);
  assert.deepEqual(await app.replyAudio(input.request_id), { reply: result.data.reply, presentation: [] });
  await app.store.putRule(normalizeRule({ kind: 'avoid_word', value: 'ready', scope: 'assistant_reply', original: 'Never say ready.', source_id: 'manual', source_quote: '', explanation: 'Synthetic speech output rule.' }));
  await assert.rejects(app.replyAudio(input.request_id), error => error.status === 409);
  await assert.rejects(app.replyAudio(randomUUID()), error => error.status === 404);
  await assert.rejects(app.replyAudio('unchecked text'), error => error.status === 400);
  assert.equal(app.spoken.length, 0);
});

test('speaker check speaks only a fixed checked phrase with no model or memory write', async t => {
  const app = await fixture(t, script());
  assert.equal((await app.request('/api/companion/audio-check', { text: 'Client supplied text' })).status, 400);
  assert.equal((await app.request('/api/companion/audio-check', {})).status, 200);
  assert.equal(app.spoken[0].text, 'MERLIN is ready.');
  assert.equal(app.meta.calls.length, 0);
  assert.equal(app.spotifyCalls.length, 0);
  assert.equal(app.store.snapshot().conversations.length, 0);
  await app.store.putRule(normalizeRule({ kind: 'avoid_word', value: 'ready', scope: 'assistant_reply', original: 'Never say ready.', source_id: 'manual', source_quote: '', explanation: 'Synthetic speaker check rule.' }));
  assert.equal((await app.request('/api/companion/audio-check', {})).status, 409);
  assert.equal(app.spoken.length, 1);
});

test('timer speech verifies completion and current rules without a model or user-text input', async t => {
  const app = await fixture(t, script());
  const timer = await app.timers.create({ label: 'Synthetic tea', duration_seconds: 1, time_zone: 'UTC' }, 'synthetic-timer-alert');
  assert.equal((await app.request('/api/companion/timer-speech', { timer_id: timer.id })).status, 409);
  assert.equal((await app.request('/api/companion/timer-speech', { timer_id: randomUUID() })).status, 409);
  assert.equal((await app.request('/api/companion/timer-speech', { timer_id: timer.id, text: 'Client supplied text' })).status, 400);
  while ((await app.timers.list())[0].status === 'running') { await new Promise(resolve => setTimeout(resolve, 20)); await app.timers.tick(); }
  const receipt = await app.timerAlert(timer.id);
  assert.equal(receipt.reply, 'Your “Synthetic tea” timer is finished.');
  assert.equal(receipt.presentation[0].id, timer.id);
  assert.equal(receipt.presentation[0].status, 'completed');
  assert.equal((await app.request('/api/companion/timer-speech', { timer_id: timer.id })).status, 200);
  assert.equal(app.spoken[0].text, receipt.reply);
  await app.store.putRule(normalizeRule({ kind: 'avoid_word', value: 'tea', scope: 'assistant_reply', original: 'Never say tea.', source_id: 'manual', source_quote: '', explanation: 'Synthetic alert output rule.' }));
  assert.equal((await app.request('/api/companion/timer-speech', { timer_id: timer.id })).status, 409);
  assert.equal(app.spoken.length, 1);
  assert.equal(app.meta.calls.length, 0);
  assert.equal(app.spotifyCalls.length, 0);
  assert.equal(app.store.snapshot().conversations.length, 0);
  await app.timers.dismiss(timer.id);
  await assert.rejects(app.timerAlert(timer.id), error => error.status === 409);
});

test('character assets are served on the assistant origin without exposing authoring/private files', async t => {
  const app = await fixture(t);
  assert.equal((await app.request('/character/viewer/motion.js')).status, 200);
  assert.equal((await app.request('/character/viewer/motion-footprints.json')).status, 200);
  assert.equal((await app.request('/voice/recorder-worklet.js')).status, 200);
  for (const path of ['/character/merlin-states.blend', '/character/previews/states-validation.json', '/character/viewer/../../../../data/memory.json', '/character/viewer/%2e%2e%2f%2e%2e%2f%2e%2e%2fdata/memory.json']) assert.equal((await app.request(path)).status, 404, path);
});

test('Meta cancellation reaches fetch and never becomes an ordinary connection error', async () => {
  const controller = new AbortController();
  const meta = new MetaClient({ apiKey: 'synthetic-key', fetchImpl: async (_url, options) => {
    assert.equal(options.signal.aborted, false);
    controller.abort();
    assert.equal(options.signal.aborted, true);
    throw new Error('synthetic aborted fetch');
  } });
  await assert.rejects(meta.respond([], [], '', { signal: controller.signal }), error => error.status === 499);
});
