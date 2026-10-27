import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { KokoroTts, validateSpeechText } from '../src/voice/kokoro.js';

function wav() {
  const result = Buffer.alloc(84);
  result.write('RIFF'); result.writeUInt32LE(result.length - 8, 4); result.write('WAVEfmt ', 8);
  result.writeUInt32LE(16, 16); result.writeUInt16LE(1, 20); result.writeUInt16LE(1, 22);
  result.writeUInt32LE(24000, 24); result.writeUInt32LE(48000, 28);
  result.writeUInt16LE(2, 32); result.writeUInt16LE(16, 34);
  result.write('data', 36); result.writeUInt32LE(result.length - 44, 40);
  return result;
}

function harness(respond, options = {}) {
  const workers = [];
  const invocations = [];
  const service = new KokoroTts({
    existsImpl: () => true,
    spawnImpl: (file, args, settings) => {
      invocations.push({ file, args, settings });
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new Writable({ write(data, _, callback) { callback(); respond?.(JSON.parse(data.toString()), child); } });
      child.send = data => child.stdout.write(`${JSON.stringify(data)}\n`);
      child.kill = signal => { child.killed = signal; queueMicrotask(() => child.emit('exit', null, signal)); };
      workers.push(child);
      queueMicrotask(() => child.send({ type: 'ready' }));
      return child;
    },
    ...options,
  });
  return { service, workers, invocations };
}

test('Kokoro validates text and speed before starting any process', async () => {
  const { service, workers } = harness();
  assert.equal(validateSpeechText(' Hello. '), 'Hello.');
  for (const text of ['', '  ', null, 7, 'a'.repeat(2001), 'bad\0text']) {
    await assert.rejects(service.synthesize(text), /1 and 2000 characters/);
  }
  for (const speed of [0, 0.74, 1.26, Infinity, NaN, '1']) {
    await assert.rejects(service.synthesize('Hello', { speed }), /speech speed/);
  }
  assert.equal(workers.length, 0);
});

test('Kokoro gives setup instructions before spawning with missing local assets', async () => {
  const { service, workers } = harness(null, { existsImpl: () => false });
  assert.equal(service.status().configured, false);
  await assert.rejects(service.synthesize('Hello'), error => error.status === 503 && /setup:voice/.test(error.message));
  assert.equal(workers.length, 0);
});

test('Kokoro returns validated WAV and reuses its local offline Fenrir worker', async t => {
  const requests = [];
  const { service, workers, invocations } = harness((request, child) => {
    requests.push(request);
    setImmediate(() => child.send({ id: request.id, audio: wav().toString('base64') }));
  });
  t.after(() => service.close());
  assert.deepEqual(await service.synthesize('Hello.', { speed: 0.75 }), wav());
  assert.deepEqual(await service.synthesize('Another sentence.', { speed: 1.25 }), wav());
  assert.equal(workers.length, 1);
  assert.equal(requests[0].speed, 0.75);
  assert.equal(requests[1].speed, 1.25);
  assert.notEqual(requests[0].id, requests[1].id);
  assert.equal(service.status().voice, 'am_fenrir');
  assert.equal(service.status().ready, true);
  assert.equal(service.status().busy, false);
  assert.equal(invocations[0].settings.env.HF_HUB_OFFLINE, '1');
  assert.equal(invocations[0].settings.env.HF_HUB_DISABLE_TELEMETRY, '1');
  assert.equal(Object.hasOwn(invocations[0].settings.env, 'META_API_KEY'), false);
  assert.equal(Object.hasOwn(invocations[0].settings.env, 'HF_TOKEN'), false);
  assert.equal(invocations[0].args.includes('Hello.'), false);
});

test('Kokoro rejects overlapping work without queueing and supports cancellation', async t => {
  const { service, workers } = harness();
  t.after(() => service.close());
  const controller = new AbortController();
  const pending = service.synthesize('First request', { signal: controller.signal });
  assert.equal(service.status().busy, true);
  await assert.rejects(service.synthesize('Second request'), error => error.status === 409);
  controller.abort();
  await assert.rejects(pending, error => error.status === 499);
  assert.equal(workers[0].killed, 'SIGKILL');
  assert.equal(service.status().busy, false);
  assert.equal(service.status().ready, false);
  await assert.rejects(service.synthesize('Already stopped', { signal: controller.signal }), error => error.status === 499);
  assert.equal(workers.length, 1);
});

test('Kokoro times out a stuck worker and starts fresh for the next request', async t => {
  let first = true;
  const { service, workers } = harness((request, child) => {
    if (!first) setImmediate(() => child.send({ id: request.id, audio: wav().toString('base64') }));
    first = false;
  }, { timeoutMs: 30 });
  t.after(() => service.close());
  await assert.rejects(service.synthesize('First request'), error => error.status === 504);
  assert.equal(workers[0].killed, 'SIGKILL');
  service.timeoutMs = 1000;
  assert.deepEqual(await service.synthesize('Second request'), wav());
  assert.equal(workers.length, 2);
});

test('Kokoro rejects invalid or misidentified audio and never leaks worker diagnostics', async () => {
  for (const mode of ['bad-wav', 'wrong-id', 'bad-json', 'fatal']) {
    const { service, workers } = harness((request, child) => {
      setImmediate(() => {
        child.stderr.write('PRIVATE SYNTHETIC INPUT must not be returned');
        if (mode === 'bad-json') return child.stdout.write('PRIVATE SYNTHETIC INPUT\n');
        if (mode === 'fatal') return child.send({ type: 'fatal', error: 'PRIVATE SYNTHETIC INPUT' });
        child.send({ id: mode === 'wrong-id' ? 'wrong' : request.id, audio: mode === 'bad-wav' ? Buffer.from('bad wav').toString('base64') : wav().toString('base64') });
      });
    });
    await assert.rejects(service.synthesize('Hello'), error => [502, 503].includes(error.status) && !error.message.includes('PRIVATE'));
    assert.equal(workers[0].killed, 'SIGKILL');
    service.close();
  }
});

test('Kokoro handles empty speech without breaking subsequent inference', async t => {
  let first = true;
  const { service, workers } = harness((request, child) => {
    const message = first ? { id: request.id, error: 'no_speech' } : { id: request.id, audio: wav().toString('base64') };
    first = false;
    setImmediate(() => child.send(message));
  });
  t.after(() => service.close());
  await assert.rejects(service.synthesize('...'), /did not produce speech/);
  assert.deepEqual(await service.synthesize('Hello'), wav());
  assert.equal(workers.length, 1);
});

test('Kokoro reports process failures and close settles active work', async () => {
  const { service, workers } = harness();
  const first = service.synthesize('Hello');
  workers[0].emit('error', new Error('PRIVATE SYNTHETIC ERROR'));
  await assert.rejects(first, error => error.status === 503 && !error.message.includes('PRIVATE'));
  const second = service.synthesize('Hello again');
  service.close();
  await assert.rejects(second, error => error.status === 499);
  assert.equal(workers[1].killed, 'SIGKILL');
});
