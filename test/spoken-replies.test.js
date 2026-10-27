import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareSpokenReply } from '../src/spoken-replies.js';
import { normalizeRule } from '../src/memory-rules.js';

const rule = (kind, value) => normalizeRule({ kind, value, scope: 'assistant_reply', original: 'Synthetic speech rule.', source_id: 'manual', source_quote: '', explanation: 'Synthetic fixture.' });

test('speech checks both original and expanded wording against literal bans', () => {
  assert.equal(prepareSpokenReply('It is 16°F with 20% humidity.'), 'It is 16 degrees Fahrenheit with 20 percent humidity.');
  assert.throws(() => prepareSpokenReply('It is 16°F.', [rule('avoid_word', 'Fahrenheit')]), /cannot be spoken/);
  assert.throws(() => prepareSpokenReply('It is 16°F.', [rule('avoid_phrase', '16°F')]), /cannot be spoken/);
  assert.throws(() => prepareSpokenReply('[Reference](https://example.test/forbidden)', [rule('avoid_word', 'forbidden')]), /cannot be spoken/);
});

test('required literal framing stays exact while ordinary body notation becomes speakable', () => {
  const rules = [rule('response_prefix', 'Status: 16°F.'), rule('response_suffix', '100% confirmed.')];
  assert.equal(prepareSpokenReply('Wind: 5 km/h.', rules), 'Status: 16°F. Wind: 5 kilometers per hour. 100% confirmed.');
});

test('accepted case and NFKC framing variants stay intact without duplicate prefixes or suffixes', () => {
  const prefix = rule('response_prefix', 'Status: 16°F.');
  for (const framing of ['STATUS: 16°f.', 'Status: 16℉.', 'Ｓｔａｔｕｓ: 16°F.']) {
    assert.equal(prepareSpokenReply(`${framing} Wind: 5 km/h.`, [prefix]), `${framing} Wind: 5 kilometers per hour.`);
  }
  const rules = [prefix, rule('address_as', 'Captain 16°F'), rule('response_suffix', '100% confirmed.')];
  assert.equal(prepareSpokenReply('STATUS: 16℉. CAPTAIN 16℉, Wind: 5 km/h. １００％ CONFIRMED.', rules),
    'STATUS: 16℉. CAPTAIN 16℉, Wind: 5 kilometers per hour. １００％ CONFIRMED.');
  assert.equal(prepareSpokenReply('CAPTAIN 16℉, Wind: 5 km/h.', [rule('address_as', 'Captain 16°F')]),
    'CAPTAIN 16℉, Wind: 5 kilometers per hour.');
});

test('disabled framing never protects shorthand from normal speech expansion', () => {
  for (const state of [{ active: false }, ...['disabled', 'deleted', 'superseded', 'inactive', 'archived'].map(status => ({ status }))]) {
    for (const kind of ['response_prefix', 'address_as', 'response_suffix']) {
      assert.equal(prepareSpokenReply('16°F', [{ ...rule(kind, '16°F'), ...state }]), '16 degrees Fahrenheit');
    }
  }
});

test('speech expansion cannot exceed synthesis bounds or silently truncate facts', () => {
  const text = '16°F '.repeat(390).trim();
  assert.ok(text.length < 2000);
  assert.throws(() => prepareSpokenReply(text), /too long to read aloud/);
});
