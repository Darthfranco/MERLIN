import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpeechPlan, SPEECH_DELIVERIES, validateSpeechDelivery } from '../src/voice/prosody.js';

test('every delivery preserves source words, whitespace, punctuation, and native pronunciation/stress markup', () => {
  const examples = [
    'That is [so](+2) good! Ready? Take your time…',
    'Dr. Rivera has 3.5 cups. It is [Kokoro](/kˈOkəɹO/).',
    'Use [Dr. R](/ɹ/). Keep [two words](-1) together.\n\nThird paragraph.',
    'I said “yes!” Did you hear?\nAnother line with a final word',
    'A. Smith has a reminder.  No missing characters.',
  ];
  for (const delivery of SPEECH_DELIVERIES) {
    for (const text of examples) {
      const plan = createSpeechPlan(text, { delivery });
      assert.equal(plan.map(segment => segment.text).join(''), text);
      assert.equal(plan.at(-1).pauseMs, 0);
      for (const segment of plan) {
        assert.equal((segment.text.match(/\[/gu) || []).length, (segment.text.match(/\]/gu) || []).length);
      }
    }
  }
  const plan = createSpeechPlan(examples[1]);
  assert.equal(plan[0].text, 'Dr. Rivera has 3.5 cups. ');
  assert.ok(createSpeechPlan(examples[2])[0].text.includes('[Dr. R](/ɹ/)'));
});

test('neutral keeps the original single-pass speed; other presets change cadence within the public limits', () => {
  const text = 'Hello! Are you ready? Take your time.';
  assert.deepEqual(createSpeechPlan(text, { delivery: 'neutral', speed: 1.1 }), [{ text, speed: 1.1, pauseMs: 0 }]);
  for (const delivery of ['natural', 'lively', 'gentle']) {
    for (const speed of [0.75, 1, 1.25]) {
      const plan = createSpeechPlan(text, { delivery, speed });
      assert.equal(plan.length, 3);
      assert.ok(plan.every(segment => segment.speed >= 0.75 && segment.speed <= 1.25));
      assert.ok(plan.slice(0, -1).every(segment => segment.pauseMs > 0 && segment.pauseMs <= 500));
    }
  }
  const gentle = createSpeechPlan(text, { delivery: 'gentle' });
  const lively = createSpeechPlan(text, { delivery: 'lively' });
  assert.ok(gentle.every((segment, index) => segment.speed < lively[index].speed));
  assert.ok(gentle[0].pauseMs > lively[0].pauseMs);
});

test('sentence-dense input remains bounded and no remainder is truncated', () => {
  const text = 'Hi! '.repeat(400) + 'The final sentence must survive.';
  const plan = createSpeechPlan(text);
  assert.ok(plan.length <= 32);
  assert.equal(plan.map(segment => segment.text).join(''), text);
  assert.ok(plan.at(-1).text.endsWith('The final sentence must survive.'));
});

test('unsupported delivery controls and invalid rates fail before synthesis', () => {
  for (const value of ['happy', '[sad]', '', null, {}, true]) {
    assert.throws(() => validateSpeechDelivery(value), /Choose natural/);
  }
  for (const speed of [NaN, Infinity, -1, 0.74, 1.26, '1', true]) {
    assert.throws(() => createSpeechPlan('Hello', { speed }), /speech speed/);
  }
});
