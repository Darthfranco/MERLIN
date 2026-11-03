import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchWithRetry } from '../src/provider-retry.js';
import { MetaClient } from '../src/meta.js';
import { MetaTranscriber } from '../src/voice/meta.js';

// A connection that never opened, as Node's fetch reports it.
const unreachable = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
const ok = payload => ({ ok: true, status: 200, json: async () => structuredClone(payload) });
const scripted = steps => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const step = steps.shift();
    assert.ok(step, 'unexpected extra request');
    return step(init);
  };
  return { calls, fetchImpl };
};

test('a request that could not connect is tried once more, with the same request and signal', async () => {
  const reasons = [];
  const { calls, fetchImpl } = scripted([() => { throw unreachable(); }, () => ok({ fine: true })]);
  const signal = AbortSignal.timeout(10_000);
  const response = await fetchWithRetry(fetchImpl, 'https://api.meta.ai/v1/x', { method: 'POST', body: '{"a":1}', signal }, { delayMs: 1, onRetry: reason => reasons.push(reason) });
  assert.deepEqual(await response.json(), { fine: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].init.body, calls[0].init.body);
  assert.equal(calls[1].init.signal, signal, 'both attempts share one deadline');
  assert.deepEqual(reasons, ['UND_ERR_CONNECT_TIMEOUT'], 'only a reason code is reported');
});

test('a gateway error is tried once more and its unread body is released', async () => {
  let cancelled = false;
  const { calls, fetchImpl } = scripted([() => ({ ok: false, status: 503, body: { cancel: async () => { cancelled = true; } } }), () => ok({})]);
  assert.equal((await fetchWithRetry(fetchImpl, 'u', {}, { delayMs: 1 })).status, 200);
  assert.equal(calls.length, 2);
  assert.ok(cancelled);
});

test('at most one retry, and ordinary errors are not retried', async () => {
  const twice = scripted([() => { throw unreachable(); }, () => { throw unreachable(); }]);
  await assert.rejects(fetchWithRetry(twice.fetchImpl, 'u', {}, { delayMs: 1 }), /fetch failed/);
  assert.equal(twice.calls.length, 2);
  const gateway = scripted([() => ({ ok: false, status: 502 }), () => ({ ok: false, status: 502 })]);
  assert.equal((await fetchWithRetry(gateway.fetchImpl, 'u', {}, { delayMs: 1 })).status, 502);
  assert.equal(gateway.calls.length, 2);
  for (const status of [400, 401, 403, 429, 500]) {
    const once = scripted([() => ({ ok: false, status })]);
    assert.equal((await fetchWithRetry(once.fetchImpl, 'u', {}, { delayMs: 1 })).status, status);
    assert.equal(once.calls.length, 1, `HTTP ${status} is not retried`);
  }
});

test('cancellation and the overall timeout are never retried, even during the pause', async () => {
  const controller = new AbortController();
  const cancelled = scripted([() => { controller.abort(); throw controller.signal.reason; }]);
  await assert.rejects(fetchWithRetry(cancelled.fetchImpl, 'u', { signal: controller.signal }, { delayMs: 1 }));
  assert.equal(cancelled.calls.length, 1);
  const later = new AbortController();
  const paused = scripted([() => { setTimeout(() => later.abort(), 5); throw unreachable(); }]);
  await assert.rejects(fetchWithRetry(paused.fetchImpl, 'u', { signal: later.signal }, { delayMs: 1000 }));
  assert.equal(paused.calls.length, 1, 'stopping during the pause sends nothing more');
});

test('MERLIN replies after one unreachable attempt, and still fails plainly after two', async () => {
  const output = [{ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Hi!' }] }];
  const reasons = [];
  const { calls, fetchImpl } = scripted([() => { throw unreachable(); }, () => ok({ status: 'completed', output })]);
  const meta = new MetaClient({ apiKey: 'synthetic-key', fetchImpl, retryDelayMs: 1, onRetry: reason => reasons.push(reason) });
  assert.deepEqual(await meta.respond([{ role: 'user', content: 'Hello' }], [], 'Be useful.'), output);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].init.body, calls[0].init.body);
  assert.deepEqual(reasons, ['UND_ERR_CONNECT_TIMEOUT']);
  const down = scripted([() => { throw unreachable(); }, () => { throw unreachable(); }]);
  const failing = new MetaClient({ apiKey: 'synthetic-key', fetchImpl: down.fetchImpl, retryDelayMs: 1, onRetry: () => {} });
  await assert.rejects(failing.respond([], [], ''), error => error.status === 502 && /could not be reached/.test(error.message));
  assert.equal(down.calls.length, 2);
});

test('voice transcription is tried once more when Meta could not be reached', async () => {
  const audio = Buffer.alloc(44 + 3200);
  audio.write('RIFF', 0); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22); audio.writeUInt32LE(16_000, 24);
  audio.writeUInt32LE(32_000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(3200, 40);
  const { calls, fetchImpl } = scripted([() => { throw unreachable(); }, () => ok({ transcript: 'Hello, Merlin.' })]);
  const client = new MetaTranscriber({ apiKey: 'synthetic-key', fetchImpl, retryDelayMs: 1, onRetry: () => {} });
  assert.equal((await client.transcribe(audio)).text, 'Hello, Merlin.');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, calls[0].url);
});
