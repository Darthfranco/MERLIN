import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { generateRoutineArt, makeRoutineArtRequest, parseOptions } from '../scripts/generate-routine-art.mjs';

function pngChunk(type, data) {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length);
  chunk.write(type, 4, 'ascii');
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return chunk;
}

function syntheticPng() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(64, 0);
  header.writeUInt32BE(64, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.alloc(64 * (64 * 3 + 1)))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

test('routine artwork uses standard Muse with no persistence, browsing, or external references', () => {
  const body = makeRoutineArtRequest('Tea time', 'A steaming cup');
  assert.equal(body.model, 'muse-image-1.0');
  assert.equal(body.store, false);
  assert.deepEqual(body.tools, [{ type: 'image_generation', enable_image_search: false, enable_web_search: false, enable_shell: false, reasoning_strength: 'low', size: '1024x1024', output_format: 'png' }]);
  assert.match(body.input, /subject data only/);
  assert.throws(() => makeRoutineArtRequest(''), /title/);
  assert.throws(() => makeRoutineArtRequest('Tea\ntime'), /control characters/);
  assert.throws(() => makeRoutineArtRequest('Tea', 'x'.repeat(601)), /description/);
});

test('artwork CLI defaults to local files and requires explicit synthetic-public intent', () => {
  assert.match(parseOptions(['--title', 'Tea time']).out, /\/local\/routine-art\/tea-time\.png$/);
  assert.throws(() => parseOptions(['--title', 'Tea', '--out', 'assets/tea.png']), /public-demo/);
  assert.match(parseOptions(['--title', 'Tea', '--out', 'assets/tea.png', '--public-demo']).out, /\/assets\/tea\.png$/);
  assert.throws(() => parseOptions(['--title', 'Tea', '--out', '../tea.png', '--public-demo']), /inside the repository/);
  assert.throws(() => parseOptions(['--title', 'Tea', '--title', 'Other']), /repeat/);
});

test('artwork generation refuses missing keys before making a request', async () => {
  let calls = 0;
  await assert.rejects(generateRoutineArt({ title: 'Tea', fetchImpl: () => { calls++; } }), /META_API_KEY/);
  assert.equal(calls, 0);
});

test('artwork generation records the exact Unicode prompt without changing PNG pixels', async () => {
  const original = syntheticPng();
  const { bytes, provenance } = await generateRoutineArt({
    title: 'Tea café', description: 'One small cup', apiKey: 'synthetic-key',
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.meta.ai/v1/responses');
      assert.equal(options.redirect, 'error');
      assert.equal(JSON.parse(options.body).store, false);
      return Response.json({ status: 'completed', output: [{ type: 'image_generation_call', status: 'completed', result: original.toString('base64') }] });
    },
  });
  const metadataLength = bytes.readUInt32BE(33);
  assert.equal(bytes.toString('ascii', 37, 41), 'iTXt');
  assert.equal(bytes.toString('utf8', 41, 41 + metadataLength), `Description\0\0\0\0\0${provenance.request.input}`);
  assert.ok(Buffer.concat([bytes.subarray(0, 33), bytes.subarray(33 + metadataLength + 12)]).equals(original));
  assert.equal(provenance.image.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(provenance.image.width, 64);
  assert.equal(provenance.image.height, 64);
});

test('provider errors do not reveal response bodies or trigger automatic retries', async () => {
  let calls = 0;
  await assert.rejects(generateRoutineArt({
    title: 'Tea', apiKey: 'synthetic-key', fetchImpl: async () => { calls++; return new Response('private upstream input', { status: 403 }); },
  }), error => /HTTP 403/.test(error.message) && !/private|synthetic-key/.test(error.message));
  assert.equal(calls, 1);
});

test('incomplete and non-PNG results are not accepted as completed artwork', async () => {
  for (const payload of [
    { status: 'incomplete', output: [] },
    { status: 'completed', output: [{ type: 'image_generation_call', status: 'completed', result: Buffer.from('not a PNG').toString('base64') }] },
  ]) {
    await assert.rejects(generateRoutineArt({ title: 'Tea', apiKey: 'synthetic-key', fetchImpl: async () => Response.json(payload) }), /completed image|requested PNG/);
  }
});
