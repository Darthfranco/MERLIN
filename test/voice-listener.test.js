import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { LocalVoiceListener } from '../src/voice/listener.js';

function harness(respond, options = {}) {
  const workers = [], invocations = [], requests = [];
  const listener = new LocalVoiceListener({
    existsImpl: () => true,
    spawnImpl: (file, args, settings) => {
      invocations.push({ file, args, settings });
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.stdin = new Writable({ write(data, _, callback) {
        callback();
        const request = JSON.parse(data.toString());
        requests.push(request);
        respond?.(request, child);
      } });
      child.send = data => child.stdout.write(`${JSON.stringify(data)}\n`);
      child.kill = signal => { child.killed = signal; queueMicrotask(() => child.emit('exit', null, signal)); };
      workers.push(child);
      queueMicrotask(() => child.send({ type: 'ready' }));
      return child;
    },
    ...options,
  });
  return { listener, workers, invocations, requests };
}

test('local listener validates frames and setup before starting or retaining work', async () => {
  const { listener, workers } = harness();
  for (const frame of [null, 'audio', new Uint8Array(100), Buffer.alloc(0), Buffer.alloc(3), Buffer.alloc(16002)]) {
    await assert.rejects(listener.process(frame), /PCM16 audio frame/);
  }
  await assert.rejects(listener.process(Buffer.alloc(2560), { keywordEnabled: 'yes' }), /wake-word detection/);
  assert.equal(workers.length, 0);
  const missing = harness(null, { existsImpl: () => false });
  assert.equal(missing.listener.status().configured, false);
  await assert.rejects(missing.listener.start(), error => error.status === 503 && /setup:voice/.test(error.message));
  assert.equal(missing.workers.length, 0);
});

test('local detector uses bounded persistent offline processing and preserves sample positions', async t => {
  let sample = 0;
  const { listener, workers, requests, invocations } = harness((request, child) => {
    sample = request.type === 'reset' ? 0 : sample + Buffer.from(request.pcm, 'base64').length / 2;
    const result = { id: request.id, sample, speech: sample > 0, events: sample > 0 ? [{ type: 'wake', sample, startSample: 100, endSample: 1000 }] : [] };
    setImmediate(() => child.send(result));
  });
  t.after(() => listener.close());
  assert.equal((await listener.start()).ready, true);
  assert.deepEqual(await listener.process(Buffer.alloc(2560)), {
    sample: 1280, speech: true, events: [{ type: 'wake', sample: 1280, startSample: 100, endSample: 1000 }],
  });
  await listener.process(Buffer.alloc(2560), { keywordEnabled: false });
  assert.equal(listener.sample, 2560);
  assert.equal(requests.at(-1).keywordEnabled, false);
  assert.equal((await listener.reset()).sample, 0);
  assert.equal(listener.sample, 0);
  assert.equal(workers.length, 1);
  assert.equal(invocations[0].settings.env.HF_HUB_OFFLINE, '1');
  assert.equal(invocations[0].settings.env.DO_NOT_TRACK, '1');
  for (const name of ['META_API_KEY', 'HF_TOKEN', 'OPENAI_API_KEY']) assert.equal(Object.hasOwn(invocations[0].settings.env, name), false);
  assert.equal(invocations[0].args.includes('pcm'), false);
  assert.equal(listener.status().localOnly, true);
});

test('listener rejects overlapping frames without a queue and cancellation kills all local state', async t => {
  const { listener, workers } = harness();
  t.after(() => listener.close());
  const controller = new AbortController();
  const pending = listener.process(Buffer.alloc(2560), { signal: controller.signal });
  await assert.rejects(listener.process(Buffer.alloc(2560)), error => error.status === 409);
  controller.abort();
  await assert.rejects(pending, error => error.status === 499);
  assert.equal(workers[0].killed, 'SIGKILL');
  assert.equal(listener.status().busy, false);
  assert.equal(listener.sample, 0);
  await assert.rejects(listener.start({ signal: controller.signal }), error => error.status === 499);
  assert.equal(workers.length, 1);
});

test('listener times out stalled inference and starts cleanly after recovery', async t => {
  let first = true;
  const { listener, workers } = harness((request, child) => {
    if (!first) setImmediate(() => child.send({ id: request.id, sample: 1280, speech: false, events: [] }));
    first = false;
  }, { startupTimeoutMs: 30 });
  t.after(() => listener.close());
  await assert.rejects(listener.process(Buffer.alloc(2560)), error => error.status === 504);
  assert.equal(workers[0].killed, 'SIGKILL');
  listener.startupTimeoutMs = 1000;
  assert.equal((await listener.process(Buffer.alloc(2560))).sample, 1280);
  assert.equal(workers.length, 2);
});

test('listener validates monotonic sample receipts and strips unrequested data', async t => {
  const { listener } = harness((request, child) => setImmediate(() => child.send({
    id: request.id, sample: 1280, speech: true, transcript: 'must not be forwarded',
    events: [{ type: 'speech_start', sample: 1024, startSample: 0, transcript: 'must not be forwarded' }],
  })));
  t.after(() => listener.close());
  assert.deepEqual(await listener.process(Buffer.alloc(2560)), {
    sample: 1280, speech: true, events: [{ type: 'speech_start', sample: 1024, startSample: 0 }],
  });
});

test('listener fails closed on malformed receipts and never exposes worker diagnostics', async () => {
  const cases = [
    { sample: 500 }, { sample: -1 }, { speech: 'yes' }, { events: [{ type: 'transcript', sample: 1280 }] },
    { events: [{ type: 'wake', sample: 1280, startSample: 1100, endSample: 1000 }] },
    { events: [{ type: 'speech_end', sample: 1281, endSample: 100 }] },
    { events: [{ type: 'speech_start', sample: 1280, startSample: -1 }] },
    { events: [{ type: 'speech_start', sample: 1280, startSample: 0 }, { type: 'speech_end', sample: 512, endSample: 0 }] },
    { id: 'wrong-id' }, { type: 'fatal', error: 'PRIVATE' }, { error: 'PRIVATE' },
  ];
  for (const extra of cases) {
    const { listener, workers } = harness((request, child) => setImmediate(() => {
      child.stderr.write('PRIVATE audio-derived error');
      child.send({ id: request.id, sample: 1280, speech: false, events: [], ...extra });
    }));
    await assert.rejects(listener.process(Buffer.alloc(2560)), error => [502, 503].includes(error.status) && !error.message.includes('PRIVATE'));
    assert.equal(workers[0].killed, 'SIGKILL');
    listener.close();
  }
});

test('listener closes on process failures, malformed JSON, oversized results, and explicit mute', async () => {
  for (const mode of ['error', 'exit', 'json', 'oversize', 'close']) {
    const { listener, workers } = harness();
    const pending = listener.process(Buffer.alloc(2560));
    if (mode === 'error') workers[0].emit('error', new Error('PRIVATE'));
    if (mode === 'exit') workers[0].emit('exit', 1);
    if (mode === 'json') workers[0].stdout.write('PRIVATE\n');
    if (mode === 'oversize') workers[0].stdout.write('x'.repeat(16001));
    if (mode === 'close') listener.close();
    await assert.rejects(pending, error => [499, 502, 503].includes(error.status) && !error.message.includes('PRIVATE'));
    assert.equal(listener.status().ready, false);
    assert.equal(listener.sample, 0);
    listener.close();
  }
});
