import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_AUDIO_BYTES, MAX_RECORDING_SECONDS, validateWav } from '../src/voice/audio.js';
import { MetaTranscriber } from '../src/voice/meta.js';

function wav({ sampleRate = 16_000, seconds = 0.1, channels = 1, bits = 16, format = 1 } = {}) {
  const blockAlign = channels * bits / 8;
  const dataBytes = Math.round(sampleRate * seconds) * blockAlign;
  const result = Buffer.alloc(44 + dataBytes);
  result.write('RIFF', 0);
  result.writeUInt32LE(result.length - 8, 4);
  result.write('WAVEfmt ', 8);
  result.writeUInt32LE(16, 16);
  result.writeUInt16LE(format, 20);
  result.writeUInt16LE(channels, 22);
  result.writeUInt32LE(sampleRate, 24);
  result.writeUInt32LE(sampleRate * blockAlign, 28);
  result.writeUInt16LE(blockAlign, 32);
  result.writeUInt16LE(bits, 34);
  result.write('data', 36);
  result.writeUInt32LE(dataBytes, 40);
  return result;
}

function withMetadata(audio) {
  const metadata = Buffer.from('Synthetic microphone location');
  const chunk = Buffer.alloc(8 + metadata.length + metadata.length % 2);
  chunk.write('LIST', 0);
  chunk.writeUInt32LE(metadata.length, 4);
  metadata.copy(chunk, 8);
  const result = Buffer.concat([audio.subarray(0, 12), chunk, audio.subarray(12)]);
  result.writeUInt32LE(result.length - 8, 4);
  return result;
}

test('voice input accepts bounded mono PCM16 WAV at the two supported sample rates', () => {
  assert.equal(MAX_RECORDING_SECONDS, 60);
  assert.equal(MAX_AUDIO_BYTES, 2_881_024);
  for (const sampleRate of [16_000, 24_000]) {
    for (const seconds of [0.1, MAX_RECORDING_SECONDS]) {
      const info = validateWav(wav({ sampleRate, seconds }));
      assert.equal(info.sampleRate, sampleRate);
      assert.equal(info.durationMs, seconds * 1000);
    }
  }
});

test('voice input rejects unsupported encodings, malformed WAV, and inconsistent sample framing', () => {
  const corrupt = (mutate) => { const buffer = wav(); mutate(buffer); return buffer; };
  const invalid = [
    ['not WAV', Buffer.from('synthetic audio')],
    ['empty', Buffer.alloc(0)],
    ['stereo', wav({ channels: 2 })],
    ['compressed', wav({ format: 3 })],
    ['8-bit', wav({ bits: 8 })],
    ['unsupported rate', wav({ sampleRate: 44_100 })],
    ['no samples', wav({ seconds: 0 })],
    ['bad container', corrupt(buffer => buffer.write('RIFX', 0))],
    ['bad wave ID', corrupt(buffer => buffer.write('XXXX', 8))],
    ['inconsistent RIFF size', corrupt(buffer => buffer.writeUInt32LE(40, 4))],
    ['truncated samples', wav().subarray(0, 50)],
    ['bad byte rate', corrupt(buffer => buffer.writeUInt32LE(1, 28))],
    ['bad block alignment', corrupt(buffer => buffer.writeUInt16LE(1, 32))],
    ['oversized declared data', corrupt(buffer => buffer.writeUInt32LE(buffer.length, 40))],
    ['over 60 seconds', wav({ seconds: 60.01 })],
    ['over byte limit', Buffer.alloc(MAX_AUDIO_BYTES + 1)],
  ];
  for (const [name, buffer] of invalid) {
    assert.throws(() => validateWav(buffer), error => [400, 413, 415].includes(error.status), name);
  }
});

test('voice input removes ancillary metadata while preserving the exact recorded samples', () => {
  const clean = wav();
  for (let index = 44; index < clean.length; index += 2) clean.writeInt16LE(index % 500, index);
  const info = validateWav(withMetadata(clean));
  assert.deepEqual(info.audio, clean);
  assert.equal(info.audio.includes('Synthetic microphone location'), false);
});

test('Meta voice requires a server-side key and rejects invalid audio before a provider request', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('unexpected provider request'); };
  const unconfigured = new MetaTranscriber({ apiKey: '  ', fetchImpl });
  assert.equal(unconfigured.configured, false);
  assert.equal(unconfigured.model, 'muse-voice-transcribe-1.0');
  await assert.rejects(unconfigured.transcribe(wav()), error => error.status === 503);
  const configured = new MetaTranscriber({ apiKey: 'synthetic-test-key', fetchImpl });
  assert.equal(configured.configured, true);
  await assert.rejects(configured.transcribe(Buffer.from('not audio')), error => [400, 415].includes(error.status));
  assert.equal(calls, 0);
});

test('Meta voice sends only canonical WAV and the fixed standard model using authenticated multipart data', async () => {
  const audio = wav();
  const calls = [];
  const client = new MetaTranscriber({ apiKey: ' synthetic-test-key ', fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ transcript: '  Hello, Merlin.  ' }) };
  } });
  const result = await client.transcribe(withMetadata(audio));
  assert.deepEqual(result, { text: 'Hello, Merlin.', model: 'muse-voice-transcribe-1.0', audioDurationMs: 100 });
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  const endpoint = new URL(url);
  assert.equal(endpoint.origin + endpoint.pathname, 'https://api.meta.ai/v1/asr/transcribe');
  assert.match(endpoint.searchParams.get('sessionId'), /^[a-f0-9-]{36}$/);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'Bearer synthetic-test-key');
  assert.equal(init.redirect, 'error');
  assert.equal(new Headers(init.headers).has('content-type'), false, 'fetch must supply the multipart boundary');
  assert.ok(init.signal instanceof AbortSignal);
  assert.ok(init.body instanceof FormData);
  assert.deepEqual([...init.body.keys()].sort(), ['audio', 'request']);
  const request = init.body.get('request');
  assert.equal(request.type, 'application/json');
  assert.deepEqual(JSON.parse(await request.text()), { model: 'muse-voice-transcribe-1.0', audioEncoding: 'WAV', mode: 'PUSH_TO_TALK' });
  const recording = init.body.get('audio');
  assert.equal(recording.name, 'recording.wav');
  assert.equal(recording.type, 'audio/wav');
  assert.deepEqual(Buffer.from(await recording.arrayBuffer()), audio);
});

test('Meta voice rejects empty, malformed, and unbounded transcripts without exposing their contents', async () => {
  for (const [body, status] of [
    [null, 502], [{}, 502], [{ transcript: 42 }, 502],
    [{ transcript: 'x'.repeat(20_001) }, 502], [{ transcript: '' }, 422], [{ transcript: ' \n ' }, 422],
  ]) {
    const client = new MetaTranscriber({ apiKey: 'synthetic-test-key', fetchImpl: async () => ({ ok: true, status: 200, json: async () => body }) });
    await assert.rejects(client.transcribe(wav()), error => error.status === status);
  }
  const client = new MetaTranscriber({ apiKey: 'synthetic-test-key', fetchImpl: async () => ({
    ok: true, status: 200, json: async () => { throw new Error('synthetic private upstream response'); },
  }) });
  await assert.rejects(client.transcribe(wav()), error => error.status === 502 && !error.message.includes('private upstream'));
});

test('Meta voice never starts an upload for an already cancelled recording', async () => {
  let calls = 0;
  const client = new MetaTranscriber({ apiKey: 'synthetic-test-key', fetchImpl: async () => { calls++; } });
  await assert.rejects(client.transcribe(wav(), { signal: AbortSignal.abort() }), error => error.status === 499);
  assert.equal(calls, 0);
});

test('Meta voice checks actual account model availability without treating a text model as voice access', async () => {
  for (const available of [true, false]) {
    const calls = [];
    const client = new MetaTranscriber({ apiKey: 'synthetic-test-key', fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ data: [{ id: available ? 'muse-voice-transcribe-1.0' : 'muse-spark-1.3' }] }) };
    } });
    if (available) assert.deepEqual(await client.checkAccess(), { model: 'muse-voice-transcribe-1.0', available: true });
    else await assert.rejects(client.checkAccess(), error => error.status === 503);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.meta.ai/v1/models');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer synthetic-test-key');
    assert.equal(calls[0].init.redirect, 'error');
  }
});

test('Meta voice never exposes provider error bodies or network error details', async () => {
  const secret = 'synthetic private transcript or credential';
  for (const status of [401, 403, 429, 500]) {
    let bodyReads = 0;
    const client = new MetaTranscriber({ apiKey: 'synthetic-test-key', fetchImpl: async () => ({
      ok: false, status,
      async text() { bodyReads++; return secret; },
      async json() { bodyReads++; return { error: secret }; },
    }) });
    await assert.rejects(client.transcribe(wav()), error => {
      assert.equal(error.status, 502);
      assert.equal(error.message.includes(secret), false);
      return true;
    });
    assert.equal(bodyReads, 0);
  }
  const client = new MetaTranscriber({ apiKey: 'synthetic-test-key', fetchImpl: async () => { throw new Error(secret); } });
  await assert.rejects(client.transcribe(wav()), error => error.status === 502 && !error.message.includes(secret));
});

test('Meta voice cancellation and timeout abort the actual provider request', async t => {
  for (const mode of ['cancel', 'timeout']) {
    await t.test(mode, async () => {
      let observed;
      let started;
      const entered = new Promise(resolve => { started = resolve; });
      const controller = new AbortController();
      const client = new MetaTranscriber({ apiKey: 'synthetic-test-key', timeoutMs: mode === 'timeout' ? 20 : 10_000,
        fetchImpl: async (_url, { signal }) => {
          observed = signal;
          started();
          return new Promise((_resolve, reject) => {
            if (signal.aborted) reject(signal.reason);
            else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        },
      });
      // AbortSignal.timeout does not keep Node alive on its own.
      const keepAlive = setInterval(() => {}, 1000);
      try {
        const request = client.transcribe(wav(), { signal: controller.signal });
        const rejected = assert.rejects(request, error => [499, 502, 504].includes(error.status) || error.name === 'AbortError');
        await entered;
        if (mode === 'cancel') controller.abort();
        await rejected;
        assert.equal(observed.aborted, true);
      } finally { clearInterval(keepAlive); }
    });
  }
});
