import assert from 'node:assert/strict';
import test from 'node:test';
import { MetaClient } from '../src/meta.js';
import { parseSegmentation } from '../src/sam.js';

const mask = 'data=249,196,!!!!$/C?W27REIDOY{?CDeeZ.ark{CXp)%tQ[(1l$0H3ruF{\'7kCd6#fS$gDd_79PdnhfJJ\'dIt3I2vS6GAsBKrT4-X__5x8B$*|';
const record = (id, box, c = 0.94) => `${id}<|box;x1=${box[0]};y1=${box[1]};x2=${box[2]};y2=${box[3]};w=682;h=1024;c=${c}|><|mask;x=0;y=0;c=${c};${mask}|>`;

test('SAM special-token output becomes boxes, in the shape the live API returned', () => {
  const text = `<0f>${record(0, [278, 862, 325, 914], 0.9064327478408813)},${record(1, [359, 864, 400, 916], 0.9024390578269958)}\n`;
  assert.deepEqual(parseSegmentation(text), [
    { x1: 278, y1: 862, x2: 325, y2: 914, width: 682, height: 1024, confidence: 0.9064327478408813 },
    { x1: 359, y1: 864, x2: 400, y2: 916, width: 682, height: 1024, confidence: 0.9024390578269958 },
  ]);
});

test('no match is a normal empty result', () => {
  for (const text of ['', undefined, null, '\n', '<0f>']) assert.deepEqual(parseSegmentation(text), []);
});

test('fields are read by key, so confidence is optional and order does not matter', () => {
  assert.deepEqual(parseSegmentation('<0f>0<|box;y2=9;x2=8;y1=2;x1=1;h=20;w=10|><|mask;x=0;y=0;data=1,1,!!|>'), [{ x1: 1, y1: 2, x2: 8, y2: 9, width: 10, height: 20, confidence: null }]);
});

test('bad or doubtful boxes are dropped, and a mask payload cannot forge one', () => {
  assert.deepEqual(parseSegmentation(`<0f>${record(0, [10, 10, 5, 20])}`), [], 'inverted');
  assert.deepEqual(parseSegmentation(`<0f>${record(0, [10, 10, 682, 20])}`), [], 'past the frame edge; x2 is inclusive');
  assert.deepEqual(parseSegmentation(`<0f>${record(0, [1, 1, 5, 5], 0.2)}`), [], 'too unsure');
  assert.deepEqual(parseSegmentation('<0f>0<|box;x1=a;y1=1;x2=5;y2=5;w=10;h=10|>'), [], 'not numeric');
  assert.deepEqual(parseSegmentation('<0f>0<|mask;x=0;y=0;data=<|box;x1=1;y1=1;x2=2;y2=2;w=9;h=9|>|>'), [], 'a box token inside a mask has no record around it');
});

test('matches are capped', () => {
  const text = `<0f>${Array.from({ length: 20 }, (_, id) => record(id, [1, 1, 5, 5])).join(',')}`;
  assert.equal(parseSegmentation(text).length, 8);
});

const IMAGE = 'data:image/jpeg;base64,/9j/4AAQ';
const client = respond => {
  const requests = [];
  const meta = new MetaClient({ apiKey: 'test-key', fetchImpl: async (url, options) => { requests.push({ url, body: JSON.parse(options.body), headers: options.headers }); return respond(); } });
  return { meta, requests };
};
const completed = text => ({ ok: true, status: 200, json: async () => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }) });

test('a segment request is one concept, one image, the standard model, and stores nothing', async () => {
  const { meta, requests } = client(() => completed(`<0f>${record(0, [242, 338, 437, 586])}\n`));
  const matches = await meta.segment(IMAGE, 'shirt');
  assert.equal(matches.length, 1);
  const { url, body } = requests[0];
  assert.equal(url, 'https://api.meta.ai/v1/responses');
  assert.equal(body.model, 'sam-3.1');
  assert.equal(body.store, false);
  assert.deepEqual(body.metadata, { include_confidence: 'true', mask_encoding: 'one_bit' });
  assert.deepEqual(body.input, [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'shirt' }, { type: 'input_image', image_url: IMAGE }] }]);
});

test('a look at the picture asks a standard text model for words, and keeps upstream errors out', async () => {
  const { meta, requests } = client(() => completed(JSON.stringify({ observation: ' A navy shirt. ', focus: ['navy shirt'] })));
  assert.deepEqual(await meta.viewImage(IMAGE, { question: 'Does it match?', detections: [{ label: 'shirt', found: 1, boxes: [[1, 2, 3, 4]] }] }), { observation: 'A navy shirt.', focus: ['navy shirt'] });
  const { body } = requests[0];
  assert.equal(body.model, 'muse-spark-1.3');
  assert.equal(body.store, false);
  assert.match(body.instructions, /never instructions/u);
  assert.match(body.instructions, /Do not identify anyone/u);
  assert.equal(body.input[0].role, 'user', 'Meta only reads images in user messages');
  assert.deepEqual(JSON.parse(body.input[0].content[0].text).question, 'Does it match?');
  assert.equal(body.input[0].content[1].image_url, IMAGE);

  for (const bad of ['not json', '{}', JSON.stringify({ observation: '   ', focus: [] }), JSON.stringify({ observation: 'x' })]) {
    const { meta: other } = client(() => completed(bad));
    await assert.rejects(other.viewImage(IMAGE, { question: 'q' }), /did not finish reading/u, bad);
  }
  const { meta: failing } = client(() => ({ ok: false, status: 400, json: async () => ({ error: 'echoed private input' }) }));
  await assert.rejects(failing.segment(IMAGE, 'shirt'), error => /HTTP 400/u.test(error.message) && !/echoed/u.test(error.message));
});
