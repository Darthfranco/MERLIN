import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { createApp } from '../src/server.js';
import { AppError } from '../src/errors.js';
import { TimerStore } from '../src/timers.js';

const answer = text => [{ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text, annotations: [] }] }];
const timerCall = () => [{ type: 'function_call', status: 'completed', call_id: randomUUID(), name: 'create_timer', arguments: JSON.stringify({ label: 'Synthetic tea', duration: 90, unit: 'seconds' }) }];

async function fixture(t, steps, transcripts) {
  const directory = await mkdtemp(join(tmpdir(), 'merlin-voice-integration-'));
  let timerClock = Date.now();
  const timers = await new TimerStore({ filePath: join(directory, 'timers.json'), now: () => timerClock }).init();
  const detectorEvents = [], uploads = [], spoken = [], modelCalls = [], messages = [];
  const listener = {
    sample: 0,
    status: () => ({ configured: true, wakeWord: 'MERLIN', localOnly: true }),
    async start() { this.sample = 0; },
    async process(pcm) {
      const from = this.sample; this.sample += pcm.length / 2;
      return { sample: this.sample, speech: false, events: (detectorEvents.shift() || (() => []))(from, this.sample) };
    },
    close() {},
  };
  const meta = { configured: true, model: 'synthetic-meta', async respond(input, tools, instructions, options) {
    modelCalls.push({ input: structuredClone(input), tools, instructions, options });
    assert.ok(steps.length, 'Unexpected reasoning request');
    const step = steps.shift();
    return typeof step === 'function' ? await step({ input, tools, instructions, options }) : step;
  } };
  const app = await createApp({ dataDir: directory, timers, meta, learningDelayMs: 60_000, listener,
    voiceMeta: { configured: true, model: 'synthetic-transcribe', async transcribe(wav, options) { uploads.push({ wav, options }); return { text: transcripts.shift() }; } },
    tts: { status: () => ({ configured: true }), async synthesize(text, options) { spoken.push({ text, options }); return Buffer.alloc(48044); }, close() {} },
    spotify: { status: () => ({ connected: false, configured: false }), control: () => { throw new Error('Spotify must not run from voice'); } },
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const socket = new WebSocket(origin.replace('http:', 'ws:') + '/api/voice/session', { origin });
  socket.on('message', (data, binary) => messages.push(binary ? { binary: Buffer.from(data) } : JSON.parse(data.toString())));
  socket.on('error', () => {});
  t.after(async () => {
    socket.terminate(); app.closeVoice();
    await new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  });
  await once(socket, 'open');
  const sessionId = randomUUID();
  socket.send(JSON.stringify({ type: 'start', sessionId, timeZone: 'America/New_York' }));
  async function waitFor(predicate) {
    const seen = messages.find(predicate); if (seen) return seen;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Expected voice event did not arrive')), 3000);
      const onMessage = (data, binary) => {
        const message = binary ? { binary: Buffer.from(data) } : JSON.parse(data.toString());
        if (predicate(message)) finish(null, message);
      };
      function finish(error, message) { clearTimeout(timer); socket.off('message', onMessage); error ? reject(error) : resolve(message); }
      socket.on('message', onMessage);
    });
  }
  await waitFor(event => event.type === 'state' && event.state === 'wake');
  function utterance({ wake = false } = {}) {
    detectorEvents.push(
      from => [wake ? { type: 'wake', sample: from + 640, startSample: from, endSample: from + 640 } : { type: 'speech_start', sample: from + 640, startSample: from }],
      () => [], () => [], (_from, end) => [{ type: 'speech_end', sample: end, endSample: end }],
    );
    for (let index = 0; index < 4; index++) socket.send(Buffer.alloc(2560, wake ? 2 : 3));
  }
  return { ...app, socket, sessionId, uploads, spoken, modelCalls, messages, waitFor, utterance, detectorEvents,
    async advanceTimers(ms) { timerClock += ms; await timers.tick(); },
  };
}

test('unified voice socket runs actual assistant tools and archives only directed transcript with checked reply', { timeout: 7000 }, async t => {
  const h = await fixture(t, [timerCall(), answer('Your synthetic timer is set.')], ['Merlin, start a ninety second tea timer.']);
  h.socket.send(Buffer.alloc(2560));
  await new Promise(setImmediate);
  assert.equal(h.uploads.length, 0);
  assert.equal(h.modelCalls.length, 0);
  h.utterance({ wake: true });
  const event = await h.waitFor(message => message.type === 'response');
  await h.waitFor(message => message.binary);
  assert.equal(h.uploads.length, 1);
  assert.equal(event.response.timers.length, 1);
  assert.equal(event.response.timers[0].duration_seconds, 90);
  assert.equal(event.response.tool_events[0].status, 'completed');
  assert.equal(event.response.trace, undefined);
  assert.equal(h.spoken[0].text, event.response.reply);
  assert.notEqual(h.spoken[0].text, 'start a ninety second tea timer.');
  const archive = h.store.snapshot().conversations.filter(item => item.session_id === h.sessionId);
  assert.equal(archive.find(item => item.role === 'user').text, 'start a ninety second tea timer.');
  assert.equal(archive.find(item => item.role === 'assistant').text, event.response.reply);
  const progress = h.messages.filter(message => message.type === 'progress');
  assert.ok(progress.some(message => message.progress.stage === 'tool_start' && message.progress.tool === 'create_timer'));
  assert.ok(progress.every(message => Object.keys(message.progress).every(key => ['stage', 'at_ms', 'tool', 'ok'].includes(key))));
  assert.ok(h.modelCalls.every(call => !call.tools.some(tool => tool.name?.startsWith('spotify_'))));
});

test('unified voice barge-in preserves completed timer history before processing fresh speech and speaks no stale reply', { timeout: 7000 }, async t => {
  let entered, priorAborted = false;
  const waiting = new Promise(resolve => { entered = resolve; });
  const h = await fixture(t, [
    timerCall(),
    ({ options }) => new Promise((_resolve, reject) => {
      entered();
      options.signal.addEventListener('abort', () => { priorAborted = true; reject(new AppError('Interrupted.', 499)); }, { once: true });
    }),
    ({ input }) => {
      assert.match(JSON.stringify(input), /Confirmed tool outcomes/);
      assert.match(JSON.stringify(input), /Synthetic tea/);
      return answer('One timer is running.');
    },
  ], ['Merlin, start a ninety second tea timer.', 'How many timers are running?']);
  h.utterance({ wake: true }); await waiting;
  assert.equal((await h.timers.list()).length, 1);
  h.utterance();
  const event = await h.waitFor(message => message.type === 'response');
  await h.waitFor(message => message.binary);
  assert.equal(priorAborted, true);
  assert.equal(h.uploads.length, 2);
  assert.equal(h.modelCalls.length, 3);
  assert.equal(h.messages.filter(message => message.type === 'response').length, 1);
  assert.equal(h.spoken.length, 1);
  assert.equal(h.spoken[0].text, event.response.reply);
  assert.match(event.response.reply, /One timer is running/);
  assert.equal((await h.timers.list()).length, 1);
});

test('unified completed timer notification speaks once in body mode without reasoning, archives, or new actions', { timeout: 7000 }, async t => {
  const h = await fixture(t, [], []);
  const timer = await h.timers.create({ label: 'Synthetic tea', duration_seconds: 1, time_zone: 'UTC' }, 'timer-notification-test');
  await h.advanceTimers(1000);
  h.socket.send(JSON.stringify({ type: 'timer_alert', timerId: timer.id }));
  h.socket.send(JSON.stringify({ type: 'timer_alert', timerId: timer.id }));
  const notice = await h.waitFor(message => message.type === 'notification');
  const audio = await h.waitFor(message => message.type === 'audio');
  await h.waitFor(message => message.binary);
  assert.equal(notice.presentationMode, 'body');
  assert.equal(notice.response.presentation[0].id, timer.id);
  assert.equal(audio.presentationMode, 'body');
  h.socket.send(JSON.stringify({ type: 'playback', revision: audio.revision, utteranceId: audio.utteranceId, playing: false }));
  await h.waitFor(message => message.type === 'state' && message.state === 'wake' && message.revision > audio.revision);
  h.socket.send(JSON.stringify({ type: 'timer_alert', timerId: timer.id }));
  const pong = once(h.socket, 'pong'); h.socket.ping(); await pong;
  assert.equal(h.spoken.length, 1);
  assert.equal(h.spoken[0].text, notice.response.reply);
  assert.equal(h.uploads.length, 0);
  assert.equal(h.modelCalls.length, 0);
  assert.equal(h.store.snapshot().conversations.length, 0);
  assert.equal((await h.timers.list()).length, 1);
});

test('timer callback resolving after explicit sleep cannot start stale notification speech', { timeout: 7000 }, async t => {
  const h = await fixture(t, [], []);
  const timer = await h.timers.create({ label: 'Synthetic tea', duration_seconds: 1, time_zone: 'UTC' }, 'timer-stale-notification-test');
  await h.advanceTimers(1000);
  const list = h.timers.list.bind(h.timers);
  const completed = await list();
  let release, entered;
  const reading = new Promise(resolve => { entered = resolve; });
  h.timers.list = async () => { entered(); return await new Promise(resolve => { release = resolve; }); };
  h.socket.send(JSON.stringify({ type: 'timer_alert', timerId: timer.id }));
  await reading;
  h.socket.send(JSON.stringify({ type: 'sleep' }));
  await h.waitFor(message => message.type === 'state' && message.state === 'wake' && message.revision > 0);
  release(completed); h.timers.list = list;
  await new Promise(setImmediate);
  const pong = once(h.socket, 'pong'); h.socket.ping(); await pong;
  assert.equal(h.spoken.length, 0);
  assert.equal(h.messages.some(message => message.type === 'notification'), false);
  assert.equal(h.modelCalls.length, 0);
});
