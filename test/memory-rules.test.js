import test from 'node:test';
import assert from 'node:assert/strict';
import { RULE_KINDS, normalizeRule, findConflicts, relevantConflicts, checkTool, checkOutput, safeClarification } from '../src/memory-rules.js';

function rule(kind, value, id = `${kind}-${value}`) {
  return { ...normalizeRule({ kind, value, scope: RULE_KINDS[kind].scope, original: 'Synthetic instruction.', source_id: 'synthetic-turn' }), id };
}

test('compiler accepts only known kinds, matching scopes, and bounded data', () => {
  assert.throws(() => normalizeRule({ kind: 'avoid_topic', value: 'cats', scope: 'assistant_reply' }), /general guidance/);
  assert.throws(() => normalizeRule({ kind: 'avoid_word', value: 'cat', scope: 'tools' }), /explicit assistant_reply/);
  assert.throws(() => normalizeRule({ kind: 'avoid_word', value: '(cat|dog)', scope: 'assistant_reply' }), /single Unicode word/);
  assert.throws(() => rule('tool_deny', 'play_song'), /not available/);
  assert.throws(() => rule('timer_default_unit', 'milliseconds'), /seconds, minutes, or hours/);
  assert.throws(() => rule('timer_max_seconds', 1.5), /integer/);
  assert.throws(() => rule('address_as', 'A\u0000B'), /control characters/);
  assert.equal(rule('avoid_word', 'cafe\u0301').value, 'cafe\u0301');
});

test('conflicting defaults have stable identifiers and neither value wins', () => {
  const a = rule('timer_default_unit', 'seconds', 'rule-a');
  const b = rule('timer_default_unit', 'minutes', 'rule-b');
  const conflicts = findConflicts([a, b]);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].key, 'timer_default_unit');
  assert.deepEqual(conflicts, findConflicts([b, a]));
  assert.deepEqual(conflicts[0].rule_ids, ['rule-a', 'rule-b']);
  assert.equal(checkTool([a, b], { name: 'create_timer', args: { label: 'Tea', duration: 5, unit: 'default' } }).ok, false);
  assert.equal(checkTool([a, b], { name: 'create_timer', args: { label: 'Tea', duration: 5, unit: 'minutes' } }).ok, true);
  assert.equal(checkTool([a, b], { name: 'create_timer', args: { label: 'Tea', duration_seconds: 5 } }).ok, true);
  assert.equal(checkTool([a, b], { name: 'cancel_timer', args: { timer_id: 'a' } }).ok, true);
  assert.equal(checkOutput([a, b], 'Hello.').conflicts.length, 0);
  assert.equal(relevantConflicts([a, b], { message: 'Start a timer for 5' }).length, 1);
  assert.equal(relevantConflicts([a, b], { message: 'Start a timer for 5 minutes' }).length, 0);
  assert.equal(relevantConflicts([a, b], { message: 'What is the weather?' }).length, 0);
});

test('duplicate exact values do not conflict and disabled rules do not participate', () => {
  const a = rule('address_as', 'Sir', 'a');
  const b = rule('address_as', 'Sir', 'b');
  assert.deepEqual(findConflicts([a, b]), []);
  assert.equal(checkOutput([a, b], 'Hello.').text, 'Sir, Hello.');
  assert.deepEqual(findConflicts([a, { ...rule('address_as', 'Captain'), active: false }]), []);
  assert.deepEqual(findConflicts([a, { ...rule('address_as', 'Captain'), status: 'deleted' }]), []);
  assert.equal(checkOutput([{ ...rule('avoid_word', 'cat'), status: 'superseded' }], 'cat').violations.length, 0);
});

test('literal word checks use Unicode boundaries and normalized case without semantic expansion', () => {
  const words = [rule('avoid_word', 'cat'), rule('avoid_word', 'café')];
  for (const text of ['A cat.', 'CAT!', 'A (cat)', 'ＣＡＴ', 'A cafe\u0301.']) {
    assert.equal(checkOutput(words, text).violations.length, 1, text);
  }
  for (const text of ['education', 'catfish', 'cat_thing', 'concatenate', '猫cat猫', 'The kitten is here.', 'caféine']) {
    assert.equal(checkOutput(words, text).violations.length, 0, text);
  }
});

test('literal phrases are never interpreted as regular expressions', () => {
  const phrase = rule('avoid_phrase', 'a.*b');
  assert.equal(checkOutput([phrase], 'a.*b').violations.length, 1);
  assert.equal(checkOutput([phrase], 'axyzb').violations.length, 0);
  const whole = rule('avoid_phrase', 'black cat');
  assert.equal(checkOutput([whole], 'A BLACK CAT.').violations.length, 1);
  assert.equal(checkOutput([whole], 'black catfish').violations.length, 0);
});

test('required response wording and a literal ban are flagged before delivery', () => {
  const rules = [rule('address_as', 'Sir', 'address'), rule('avoid_word', 'sir', 'ban')];
  const conflicts = findConflicts(rules);
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0].rule_ids, ['address', 'ban']);
  assert.equal(checkOutput(rules, 'Hello.').conflicts.length, 1);
  assert.equal(checkTool(rules, { name: 'list_timers', args: {} }).ok, true);
  const fallback = safeClarification(rules, conflicts);
  assert.ok(fallback);
  assert.equal(checkOutput([rules[1]], fallback).violations.length, 0);
  assert.ok(!fallback.includes('address'));
});

test('global required-text conflicts are relevant to replies but not independent tools', () => {
  const rules = [rule('response_prefix', 'Hello', 'a'), rule('response_prefix', 'Welcome', 'b')];
  assert.equal(relevantConflicts(rules, { message: 'What is the weather?' }).length, 1);
  assert.equal(relevantConflicts(rules, { tool: 'web_search' }).length, 0);
  assert.equal(checkOutput(rules, 'A draft.').text, 'A draft.');
});

test('a literal prohibition spanning required prefix and address is flagged at write time', () => {
  const rules = [rule('response_prefix', 'Hello', 'prefix'), rule('address_as', 'Sir', 'address'), rule('avoid_phrase', 'Hello Sir', 'ban')];
  const conflicts = findConflicts(rules);
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0].rule_ids, ['address', 'ban', 'prefix']);
  assert.ok(safeClarification(rules, conflicts));
});

test('tool restrictions block only their named tool, including search', () => {
  const rules = [rule('tool_deny', 'web_search', 'no-search')];
  assert.equal(checkTool(rules, { name: 'web_search', args: {} }).ok, false);
  assert.deepEqual(checkTool(rules, { name: 'web_search', args: {} }).applied_rule_ids, ['no-search']);
  assert.equal(checkTool(rules, { name: 'list_timers', args: {} }).ok, true);
  assert.equal(checkOutput(rules, 'search').violations.length, 0);
});

test('timer defaults are applied locally and explicit units override them', () => {
  const rules = [rule('timer_default_unit', 'seconds', 'seconds')];
  const defaulted = checkTool(rules, { name: 'create_timer', args: { label: 'Tea', duration: 5, unit: 'default' } });
  assert.deepEqual(defaulted.args, { label: 'Tea', duration_seconds: 5 });
  assert.deepEqual(defaulted.applied_rule_ids, ['seconds']);
  const explicit = checkTool(rules, { name: 'create_timer', args: { label: 'Tea', amount: 0.5, unit: 'minutes' } });
  assert.equal(explicit.ok, true);
  assert.equal(explicit.args.duration_seconds, 30);
  assert.deepEqual(explicit.applied_rule_ids, []);
  assert.equal(checkTool([], { name: 'create_timer', args: { label: 'Tea', duration: 5 } }).ok, false);
});

test('timer constraints apply to explicit, default, and legacy durations', () => {
  const rules = [rule('timer_default_unit', 'minutes'), rule('timer_max_seconds', 60, 'maximum')];
  assert.equal(checkTool(rules, { name: 'create_timer', args: { label: 'Tea', duration: 2 } }).ok, false);
  assert.equal(checkTool(rules, { name: 'create_timer', args: { label: 'Tea', duration: 120, unit: 'seconds' } }).ok, false);
  assert.equal(checkTool(rules, { name: 'create_timer', args: { label: 'Tea', duration_seconds: 120 } }).ok, false);
  assert.equal(checkTool(rules, { name: 'create_timer', args: { label: 'Tea', duration_seconds: 60 } }).ok, true);
  for (const args of [{ duration_seconds: 10, unit: 'seconds' }, { duration_seconds: undefined }, { duration_seconds: null }, { duration: 1, amount: 2, unit: 'seconds' }, { duration: -1, unit: 'hours' }, { duration: 0.1, unit: 'seconds' }, { duration: 1, unit: 'days' }, { duration_seconds: 604801 }, { duration: 1, unit: 'hours', injected: true }]) {
    assert.equal(checkTool(rules, { name: 'create_timer', args: { label: 'Tea', ...args } }).ok, false, JSON.stringify(args));
  }
});

test('output modifiers are deterministic, applied once, and never redact factual claims', () => {
  const rules = [rule('address_as', 'Sir'), rule('response_prefix', 'MERLIN:'), rule('response_suffix', 'At your service.')];
  const first = checkOutput(rules, 'The timer is running.');
  assert.equal(first.text, 'MERLIN: Sir, The timer is running. At your service.');
  assert.equal(checkOutput(rules, first.text).text, first.text);
  const rejected = checkOutput([rule('avoid_word', 'running')], 'The timer is running.');
  assert.equal(rejected.text, 'The timer is running.');
  assert.equal(rejected.changed, false);
  assert.equal(rejected.violations.length, 1);
});

test('a clarification is never emitted with forbidden fallback wording', () => {
  const rules = [rule('address_as', 'Sir', 'a'), rule('address_as', 'Captain', 'b'), rule('avoid_word', 'Please')];
  const fallback = safeClarification(rules);
  assert.ok(fallback);
  assert.equal(checkOutput([rules[2]], fallback).violations.length, 0);
});
