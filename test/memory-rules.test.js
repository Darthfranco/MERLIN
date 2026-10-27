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
  for (const value of [0, -1, 300.5, 604801, null, '300']) assert.throws(() => rule('timer_default_seconds', value), /integer/);
  assert.throws(() => rule('address_as', 'A\u0000B'), /control characters/);
  assert.equal(rule('avoid_word', 'cafe\u0301').value, 'cafe\u0301');
});

test('Spotify restrictions apply to their precise implemented operation without blocking unrelated tools', () => {
  for (const name of ['spotify_control', 'spotify_search', 'spotify_playlists', 'spotify_status']) {
    const restriction = rule('tool_deny', name);
    assert.equal(checkTool([restriction], { name, args: { action: 'play' } }).ok, false);
    assert.equal(checkTool([restriction], { name: 'create_timer', args: { label: 'Tea', duration_seconds: 30 } }).ok, true);
    assert.equal(checkTool([restriction], { name: 'web_search', args: {} }).ok, true);
    const other = name === 'spotify_control' ? 'spotify_search' : 'spotify_control';
    assert.equal(checkTool([restriction], { name: other, args: {} }).ok, true);
  }
  assert.throws(() => rule('tool_deny', 'spotify_specific_song'), /not available/);
});

test('a Spotify search restriction also blocks query resolution inside playback or queue without blocking direct controls', () => {
  const restriction = rule('tool_deny', 'spotify_search');
  for (const action of ['play', 'queue']) {
    const gate = checkTool([restriction], { name: 'spotify_control', args: { action, query: 'Synthetic song', type: 'track' } });
    assert.equal(gate.ok, false);
    assert.deepEqual(gate.applied_rule_ids, [restriction.id]);
    assert.equal(gate.violations[0].code, 'TOOL_DENIED');
  }
  for (const args of [{ action: 'pause' }, { action: 'play' }, { action: 'play', uri: 'spotify:track:1234567890123456789012' }]) {
    assert.equal(checkTool([restriction], { name: 'spotify_control', args }).ok, true);
  }
  assert.equal(checkTool([rule('tool_deny', 'spotify_status')], { name: 'spotify_control', args: { action: 'pause' } }).ok, true);
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

test('a complete five-minute default applies only when duration is explicitly omitted', () => {
  const rules = [rule('timer_default_seconds', 300, 'five-minutes'), rule('timer_default_unit', 'seconds', 'unit-seconds')];
  const omitted = checkTool(rules, { name: 'create_timer', args: { label: 'Tea', duration: null, unit: 'default' } });
  assert.equal(omitted.ok, true);
  assert.deepEqual(omitted.args, { label: 'Tea', duration_seconds: 300 });
  assert.deepEqual(omitted.applied_rule_ids, ['five-minutes']);
  const numbered = checkTool(rules, { name: 'create_timer', args: { label: 'Tea', duration: 5, unit: 'default' } });
  assert.equal(numbered.ok, true); assert.equal(numbered.args.duration_seconds, 5);
  assert.deepEqual(numbered.applied_rule_ids, ['unit-seconds']);
  const explicit = checkTool(rules, { name: 'create_timer', args: { label: 'Tea', duration: 2, unit: 'minutes' } });
  assert.equal(explicit.args.duration_seconds, 120); assert.deepEqual(explicit.applied_rule_ids, []);
  const legacy = checkTool(rules, { name: 'create_timer', args: { label: 'Tea', duration_seconds: 45 } });
  assert.equal(legacy.args.duration_seconds, 45); assert.deepEqual(legacy.applied_rule_ids, []);
});

test('duration defaults never imply a unit and unit defaults never invent a duration', () => {
  const full = [rule('timer_default_seconds', 300)];
  const number = checkTool(full, { name: 'create_timer', args: { label: 'Tea', duration: 5, unit: 'default' } });
  assert.equal(number.ok, false); assert.equal(number.violations[0].code, 'TIMER_UNIT_REQUIRED');
  for (const rules of [[], [rule('timer_default_unit', 'minutes')]]) {
    const result = checkTool(rules, { name: 'create_timer', args: { label: 'Tea', duration: null, unit: 'default' } });
    assert.equal(result.ok, false); assert.deepEqual(result.applied_rule_ids, []);
    assert.equal(result.violations.length, 1); assert.equal(result.violations[0].code, 'TIMER_DURATION_REQUIRED');
    assert.equal(result.violations[0].message, 'How long should I set the timer for?');
  }
});

test('conflicting complete durations block only omitted duration and do not choose a winner', () => {
  const defaults = [rule('timer_default_seconds', 300, 'five'), rule('timer_default_seconds', 600, 'ten')];
  const conflicts = findConflicts(defaults);
  assert.equal(conflicts.length, 1); assert.equal(conflicts[0].key, 'timer_default_seconds');
  assert.deepEqual(conflicts, findConflicts([...defaults].reverse()));
  const missing = checkTool(defaults, { name: 'create_timer', args: { label: 'Tea', duration: null, unit: 'default' } });
  assert.equal(missing.ok, false); assert.deepEqual(missing.conflicts, conflicts); assert.deepEqual(missing.applied_rule_ids, []);
  for (const args of [{ duration: 1, unit: 'minutes' }, { duration_seconds: 30 }]) {
    assert.equal(checkTool(defaults, { name: 'create_timer', args: { label: 'Tea', ...args } }).ok, true);
  }
  assert.equal(checkTool([...defaults, rule('timer_default_unit', 'seconds')], { name: 'create_timer', args: { label: 'Tea', duration: 5, unit: 'default' } }).ok, true);
  assert.equal(checkTool(defaults, { name: 'cancel_timer', args: { timer_id: 'synthetic' } }).ok, true);
  assert.equal(checkOutput(defaults, 'Hello.').conflicts.length, 0);
  assert.match(safeClarification(defaults, conflicts), /Which should I use\?/);
  assert.doesNotMatch(safeClarification(defaults, conflicts), /memory panel|code|rule_ids/i);
});

test('unit conflicts do not affect a complete saved duration', () => {
  const rules = [rule('timer_default_seconds', 300), rule('timer_default_unit', 'seconds'), rule('timer_default_unit', 'minutes')];
  const omitted = checkTool(rules, { name: 'create_timer', args: { label: 'Tea', duration: null, unit: 'default' } });
  assert.equal(omitted.ok, true); assert.equal(omitted.args.duration_seconds, 300); assert.deepEqual(omitted.conflicts, []);
  assert.equal(checkTool(rules, { name: 'create_timer', args: { label: 'Tea', duration: 5, unit: 'default' } }).ok, false);
});

test('complete duration defaults remain subject to saved timer limits and tool denials', () => {
  const rules = [rule('timer_default_seconds', 300, 'default'), rule('timer_max_seconds', 60, 'limit')];
  const conflicts = findConflicts(rules);
  assert.equal(conflicts.length, 1); assert.equal(conflicts[0].key, 'timer_default_seconds_limit');
  assert.equal(checkTool(rules, { name: 'create_timer', args: { label: 'Tea', duration: null, unit: 'default' } }).ok, false);
  assert.equal(checkTool(rules, { name: 'create_timer', args: { label: 'Tea', duration: 30, unit: 'seconds' } }).ok, true);
  const tooLong = checkTool(rules, { name: 'create_timer', args: { label: 'Tea', duration: 120, unit: 'seconds' } });
  assert.equal(tooLong.ok, false); assert.equal(tooLong.violations[0].code, 'TIMER_LIMIT_EXCEEDED');
  const allowed = checkTool([rules[0], rule('timer_max_seconds', 300)], { name: 'create_timer', args: { label: 'Tea', duration: null, unit: 'default' } });
  assert.equal(allowed.ok, true); assert.equal(allowed.args.duration_seconds, 300);
  const denied = checkTool([rules[0], rule('tool_deny', 'create_timer')], { name: 'create_timer', args: { label: 'Tea', duration: null, unit: 'default' } });
  assert.equal(denied.ok, false); assert.equal(denied.violations[0].code, 'TOOL_DENIED');
});

test('malformed null duration forms never inherit a complete saved default', () => {
  const rules = [rule('timer_default_seconds', 300), rule('timer_default_unit', 'minutes')];
  for (const args of [
    { duration: null, unit: 'seconds' }, { duration: null, unit: 'minutes' }, { duration: null },
    { duration: null, unit: null }, { amount: null, unit: 'default' }, { duration_seconds: null },
    { duration: null, amount: 5, unit: 'default' }, { duration: null, duration_seconds: 30, unit: 'default' },
    { duration: undefined, unit: 'default' }, { unit: 'default' },
  ]) {
    const result = checkTool(rules, { name: 'create_timer', args: { label: 'Tea', ...args } });
    assert.equal(result.ok, false, JSON.stringify(args));
    assert.ok(!result.applied_rule_ids.includes('timer_default_seconds-300'), JSON.stringify(args));
  }
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
