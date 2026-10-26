import assert from 'node:assert/strict';
import test from 'node:test';
import { MetaClient } from '../src/meta.js';

const evidence = 'I prefer oat milk.';
const sources = [{ id: 'user-source-1', text: evidence, created_at: '2026-10-26T12:00:00.000Z', ignored_private_metadata: 'not for inference' }];
const fact = overrides => ({ source_id: sources[0].id, source_quote: evidence, content: 'Prefers oat milk.', subject: 'household', kind: 'preference', reason: 'Directly stated durable preference.', supersedes: '', ...overrides });
const response = (facts = [], extra = {}) => ({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ facts }) }] }], ...extra });

function provider(payload) {
  const calls = [];
  const client = new MetaClient({ apiKey: 'synthetic-test-key', fetchImpl: async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => payload };
  } });
  return { client, calls };
}

test('household extraction uses standard Meta, minimal effort, no tools, no response storage and a strict small schema', async () => {
  const { client, calls } = provider(response([fact()], { usage: { input_tokens: 120, output_tokens: 36 } }));
  const result = await client.extractMemories(sources, [{ id: 'known', content: 'Likes tea.', subject: 'household', kind: 'preference', source_quote: 'This private quote is unnecessary.' }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.meta.ai/v1/responses');
  const body = calls[0].body;
  assert.equal(body.model, 'muse-spark-1.3');
  assert.equal(body.store, false);
  assert.deepEqual(body.reasoning, { effort: 'minimal' });
  assert.ok(!body.tools || body.tools.length === 0);
  assert.equal(body.max_output_tokens, 4096);
  assert.equal(body.text.format.type, 'json_schema');
  assert.equal(body.text.format.strict, true);
  assert.equal(body.text.format.schema.additionalProperties, false);
  const schema = body.text.format.schema.properties.facts;
  assert.equal(schema.maxItems, 6);
  assert.equal(schema.items.additionalProperties, false);
  assert.deepEqual(schema.items.properties.kind.enum, ['fact', 'preference', 'guidance']);
  assert.deepEqual(new Set(schema.items.required), new Set(Object.keys(schema.items.properties)));
  const input = JSON.parse(body.input);
  assert.equal('ignored_private_metadata' in input.messages[0], false);
  assert.equal('source_quote' in input.currentFacts[0], false);
  assert.match(body.instructions, /exact substring/i);
  assert.match(body.instructions, /supersedes empty/i);
  assert.deepEqual(result, { facts: [fact()], usage: { input_tokens: 120, output_tokens: 36 } });
  assert.throws(() => new MetaClient({ apiKey: 'synthetic', model: 'muse-spark-1.3-contributor' }), /Contributor/);
});

test('extraction rejects incomplete, missing, malformed or unexpected structured responses', async t => {
  const malformed = [
    ['incomplete', response([], { status: 'incomplete' })],
    ['missing output', { status: 'completed' }],
    ['invalid JSON', response([], { output: [{ type: 'message', content: [{ type: 'output_text', text: '{bad' }] }] })],
    ['null root', response([], { output: [{ type: 'message', content: [{ type: 'output_text', text: 'null' }] }] })],
    ['wrong facts type', response({})],
    ['too many facts', response(Array.from({ length: 7 }, () => fact()))],
    ['extra top-level data', response([], { output: [{ type: 'message', content: [{ type: 'output_text', text: '{"facts":[],"execute":"injected code"}' }] }] })],
    ['unknown fact kind', response([fact({ kind: 'executable_rule' })])],
    ['missing provenance', response([fact({ source_id: undefined })])],
    ['unknown source', response([fact({ source_id: 'invented-source' })])],
    ['invented quotation', response([fact({ source_quote: 'I own a tiger.' })])],
    ['non-string content', response([fact({ content: 7 })])],
    ['unexpected fact field', response([fact({ execute: 'injected code' })])],
    ['automatic supersession', response([fact({ supersedes: 'known' })])],
  ];
  for (const [name, payload] of malformed) {
    await t.test(name, async () => {
      const { client } = provider(payload);
      await assert.rejects(client.extractMemories(sources), error => error.status === 502, 'Malformed provider output should fail as a controlled upstream-data error');
    });
  }
});

test('extraction rejects provider tool calls even alongside a valid empty fact response', async () => {
  const payload = response([]);
  payload.output.unshift({ type: 'function_call', name: 'create_timer', arguments: '{"duration_seconds":60}', call_id: 'unrequested', status: 'completed' });
  const { client, calls } = provider(payload);
  await assert.rejects(client.extractMemories(sources), error => error.status === 502);
  assert.equal(calls.length, 1);
});
