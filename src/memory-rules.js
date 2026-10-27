import { createHash } from 'node:crypto';

/** The compiler accepts data for these trusted handlers, never executable code. */
export const RULE_KINDS = Object.freeze({
  timer_default_unit: Object.freeze({ scope: 'timers', value_type: 'unit', description: 'Use seconds, minutes, or hours only when a timer has no explicit unit.' }),
  timer_default_seconds: Object.freeze({ scope: 'timers', value_type: 'integer', description: 'Use this complete duration in seconds only when the user omits the timer duration entirely. A supplied amount uses its own explicit or default unit.' }),
  timer_max_seconds: Object.freeze({ scope: 'timers', value_type: 'integer', description: 'Reject timers longer than this number of seconds.' }),
  address_as: Object.freeze({ scope: 'assistant_reply', value_type: 'text', description: 'Begin replies with this form of address unless it is already present.' }),
  avoid_word: Object.freeze({ scope: 'assistant_reply', value_type: 'word', description: 'Block this literal word, case-insensitively with Unicode word boundaries; this is not a topic ban.' }),
  avoid_phrase: Object.freeze({ scope: 'assistant_reply', value_type: 'text', description: 'Block this literal phrase, case-insensitively; this is not a semantic restriction.' }),
  response_prefix: Object.freeze({ scope: 'assistant_reply', value_type: 'text', description: 'Start replies with this literal text.' }),
  response_suffix: Object.freeze({ scope: 'assistant_reply', value_type: 'text', description: 'End replies with this literal text.' }),
  tool_deny: Object.freeze({ scope: 'tools', value_type: 'tool', description: 'Block one implemented operation: create_timer, cancel_timer, web_search, spotify_control, spotify_search, spotify_playlists, or spotify_status.' }),
});

const UNITS = Object.freeze({ seconds: 1, minutes: 60, hours: 3600 });
const DENIABLE_TOOLS = new Set(['create_timer', 'cancel_timer', 'web_search', 'spotify_control', 'spotify_search', 'spotify_playlists', 'spotify_status']);
const SINGLETONS = new Set(['timer_default_unit', 'timer_default_seconds', 'timer_max_seconds', 'address_as', 'response_prefix', 'response_suffix']);
const AFFIXES = new Set(['address_as', 'response_prefix', 'response_suffix']);
const LEXICAL = new Set(['avoid_word', 'avoid_phrase']);
const WORD_CHARACTER = /[\p{L}\p{N}\p{M}_]/u;
const WORD = /^[\p{L}\p{N}_][\p{L}\p{N}\p{M}_]*$/u;
const MAX_TIMER_SECONDS = 604800;

function invalid(message) {
  const error = new Error(message);
  error.code = 'INVALID_MEMORY_RULE';
  return error;
}
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function fold(value) { return value.normalize('NFKC').toLowerCase(); }
function hash(value) { return createHash('sha256').update(value).digest('hex').slice(0, 16); }
function string(value, name, maximum, optional = false) {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string' || value.length > maximum || (!optional && !value.trim()) || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)) {
    throw invalid(`${name} must be ${optional ? 'a' : 'a nonempty'} string of at most ${maximum} characters without control characters.`);
  }
  return value.trim();
}

/** Interpret meaning before calling this compiler. Unknown semantic kinds are rejected. */
export function normalizeRule(input) {
  if (!object(input) || typeof input.kind !== 'string' || !Object.hasOwn(RULE_KINDS, input.kind)) {
    throw invalid('This instruction has no supported deterministic rule. Keep its original meaning as general guidance instead.');
  }
  const descriptor = RULE_KINDS[input.kind];
  if (input.scope !== descriptor.scope) throw invalid(`Rule ${input.kind} requires the explicit ${descriptor.scope} scope.`);
  let value = input.value;
  if (descriptor.value_type === 'integer') {
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMER_SECONDS) throw invalid(`${input.kind} must be an integer from 1 to 604800.`);
  } else {
    value = string(value, 'Rule value', input.kind === 'avoid_word' ? 80 : 240);
    if (descriptor.value_type === 'unit' && !Object.hasOwn(UNITS, value)) throw invalid('Timer default unit must be seconds, minutes, or hours.');
    if (descriptor.value_type === 'tool' && !DENIABLE_TOOLS.has(value)) throw invalid('This tool is not available for a deterministic tool restriction.');
    if (descriptor.value_type === 'word' && !WORD.test(value.normalize('NFKC'))) throw invalid('An exact-word restriction must contain a single Unicode word. Use avoid_phrase for literal phrases.');
  }
  return {
    kind: input.kind, value, scope: descriptor.scope,
    original: string(input.original, 'Original instruction', 4000, true),
    explanation: string(input.explanation, 'Rule explanation', 2000, true),
    source_id: string(input.source_id, 'Source ID', 160, true),
    source_quote: string(input.source_quote, 'Source quotation', 4000, true),
  };
}

function activeRules(rules) {
  if (!Array.isArray(rules)) throw invalid('Rules must be an array.');
  return rules.filter(rule => rule && rule.active !== false && !['disabled', 'deleted', 'superseded', 'inactive', 'archived'].includes(rule.status)).map(rule => {
    const canonical = normalizeRule(rule);
    const id = typeof rule.id === 'string' && rule.id ? rule.id : `rule_${hash(JSON.stringify([canonical.kind, canonical.scope, canonical.value]))}`;
    return { ...canonical, id };
  });
}

/** Literal comparison only: no model, generated regular expression, or topic expansion. */
function containsLiteral(text, rule) {
  const haystack = fold(text);
  const needle = fold(rule.value);
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) return false;
    const before = [...haystack.slice(Math.max(0, index - 2), index)].at(-1) ?? '';
    const after = [...haystack.slice(index + needle.length, index + needle.length + 2)][0] ?? '';
    const first = [...needle][0];
    const last = [...needle].at(-1);
    // A word-like edge must end at a Unicode word boundary. Punctuation is literal.
    if ((!WORD_CHARACTER.test(first) || !WORD_CHARACTER.test(before))
      && (!WORD_CHARACTER.test(last) || !WORD_CHARACTER.test(after))) return true;
    from = index + Math.max(1, needle.length);
  }
  return false;
}

function conflict(key, involved, reason, scope) {
  const rule_ids = [...new Set(involved.map(rule => rule.id))].sort();
  return { id: `conflict_${hash(JSON.stringify([key, rule_ids]))}`, key, rule_ids, reason, scope };
}

export function findConflicts(rules) {
  const active = activeRules(rules);
  const conflicts = [];
  for (const kind of SINGLETONS) {
    const group = active.filter(rule => rule.kind === kind);
    if (new Set(group.map(rule => JSON.stringify(rule.value))).size > 1) {
      conflicts.push(conflict(kind, group, 'Several active instructions require different values for the same setting; no value wins automatically.', group[0].scope));
    }
  }
  for (const duration of active.filter(rule => rule.kind === 'timer_default_seconds')) {
    for (const limit of active.filter(rule => rule.kind === 'timer_max_seconds')) {
      if (duration.value > limit.value) conflicts.push(conflict('timer_default_seconds_limit', [duration, limit], 'The saved default timer duration exceeds the saved maximum duration.', 'timers'));
    }
  }
  for (const required of active.filter(rule => AFFIXES.has(rule.kind))) {
    for (const banned of active.filter(rule => LEXICAL.has(rule.kind))) {
      if (containsLiteral(required.value, banned)) {
        conflicts.push(conflict(`required_text:${required.kind}:${banned.kind}`, [required, banned], 'Required response text contains wording another active instruction forbids.', 'assistant_reply'));
      }
    }
  }
  // A phrase can straddle two required pieces even if neither piece alone violates it.
  for (const prefix of active.filter(rule => rule.kind === 'response_prefix')) {
    for (const address of active.filter(rule => rule.kind === 'address_as')) {
      const combined = `${prefix.value} ${address.value},`;
      for (const banned of active.filter(rule => LEXICAL.has(rule.kind))) {
        if (containsLiteral(combined, banned) && !containsLiteral(prefix.value, banned) && !containsLiteral(address.value, banned)) {
          conflicts.push(conflict('required_text:combined_prefix_address', [prefix, address, banned], 'Combined required response text contains wording another active instruction forbids.', 'assistant_reply'));
        }
      }
    }
  }
  return conflicts.sort((a, b) => a.id.localeCompare(b.id));
}

function toolDetails(tool) { return typeof tool === 'string' ? { name: tool, args: {} } : tool ?? {}; }
function hasExplicitTimerUnit(args = {}) {
  return Object.hasOwn(args, 'duration_seconds') || Object.hasOwn(UNITS, args.unit);
}
function usesWholeTimerDefault(args = {}) {
  return args.duration === null && args.unit === 'default' && !Object.hasOwn(args, 'duration_seconds') && !Object.hasOwn(args, 'amount');
}
function usesTimerUnitDefault(args = {}) {
  const duration = Object.hasOwn(args, 'duration') ? args.duration : args.amount;
  return typeof duration === 'number' && !hasExplicitTimerUnit(args);
}
function messageNeedsTimerDefault(message) {
  if (typeof message !== 'string') return false;
  // This is only an early conservative shortcut. The authoritative check uses tool arguments.
  return /\b(?:set|start|create|make)\b[\s\S]*\btimers?\b|\btimers?\b[\s\S]*\b(?:set|start|create|make)\b/iu.test(message)
    && !/\b(?:seconds?|secs?|minutes?|mins?|hours?|hrs?)\b/iu.test(message);
}

export function relevantConflicts(rules, { message, tool, reply } = {}) {
  const details = toolDetails(tool);
  return findConflicts(rules).filter(entry => {
    if (entry.scope === 'assistant_reply') return reply !== undefined || !tool;
    if (entry.key === 'timer_default_unit') {
      if (details.name) return details.name === 'create_timer' && usesTimerUnitDefault(details.args);
      return messageNeedsTimerDefault(message);
    }
    if (entry.key === 'timer_default_seconds' || entry.key === 'timer_default_seconds_limit') {
      if (details.name) return details.name === 'create_timer' && usesWholeTimerDefault(details.args);
      return messageNeedsTimerDefault(message) && !/\p{N}/u.test(message);
    }
    if (entry.scope === 'timers') return details.name === 'create_timer'
      || (!details.name && typeof message === 'string' && /\btimers?\b/iu.test(message));
    return false;
  });
}

function violation(rule, code, message) { return { rule_id: rule?.id ?? null, code, message }; }

export function checkTool(rules, { name, args = {}, message } = {}) {
  const active = activeRules(rules);
  const result = { ok: true, args: object(args) ? { ...args } : args, applied_rule_ids: [], violations: [], conflicts: [] };
  if (!object(args)) {
    result.violations.push(violation(null, 'INVALID_TOOL_ARGUMENTS', 'Tool arguments must be an object.'));
    result.ok = false;
    return result;
  }
  result.conflicts = relevantConflicts(active, { message, tool: { name, args } });
  // Resolving a named playback request performs the same catalog search as the
  // dedicated search tool. A restriction on search also covers that dependency.
  const operations = new Set([name]);
  if (name === 'spotify_control' && Object.hasOwn(args, 'query')) operations.add('spotify_search');
  for (const rule of active.filter(rule => rule.kind === 'tool_deny' && operations.has(rule.value))) {
    result.applied_rule_ids.push(rule.id);
    result.violations.push(violation(rule, 'TOOL_DENIED', 'A standing instruction blocks this tool.'));
  }
  if (result.conflicts.length || result.violations.length) { result.ok = false; return result; }
  if (name !== 'create_timer') return result;

  const knownArguments = new Set(['label', 'duration_seconds', 'duration', 'amount', 'unit']);
  if (Object.keys(args).some(key => !knownArguments.has(key))) {
    result.violations.push(violation(null, 'INVALID_TOOL_ARGUMENTS', 'Timer arguments contain an unsupported field.'));
  }
  const hasLegacy = Object.hasOwn(args, 'duration_seconds');
  const hasDuration = Object.hasOwn(args, 'duration');
  const hasAmount = Object.hasOwn(args, 'amount');
  let seconds;
  if ((hasLegacy && (hasDuration || hasAmount || Object.hasOwn(args, 'unit'))) || (hasDuration && hasAmount)) {
    result.violations.push(violation(null, 'AMBIGUOUS_TIMER_DURATION', 'Provide one duration representation, with an explicit unit or default.'));
  } else if (hasLegacy) {
    seconds = args.duration_seconds;
  } else if (usesWholeTimerDefault(args)) {
    const defaults = active.filter(rule => rule.kind === 'timer_default_seconds');
    seconds = defaults[0]?.value;
    result.applied_rule_ids.push(...defaults.map(rule => rule.id));
    if (seconds === undefined) result.violations.push(violation(null, 'TIMER_DURATION_REQUIRED', 'How long should I set the timer for?'));
  } else {
    const duration = hasDuration ? args.duration : args.amount;
    let unit = args.unit;
    if (duration === null) {
      result.violations.push(violation(null, 'INVALID_TIMER_DURATION', 'An omitted timer duration needs duration set to null and unit set to default.'));
    } else if (duration === undefined) {
      result.violations.push(violation(null, 'TIMER_DURATION_REQUIRED', 'How long should I set the timer for?'));
    } else if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) {
      result.violations.push(violation(null, 'INVALID_TIMER_DURATION', 'Timer duration must be a finite positive number.'));
    } else if (unit === undefined || unit === 'default') {
      const defaults = active.filter(rule => rule.kind === 'timer_default_unit');
      unit = defaults[0]?.value;
      result.applied_rule_ids.push(...defaults.map(rule => rule.id));
      if (!unit) result.violations.push(violation(null, 'TIMER_UNIT_REQUIRED', 'Should that be seconds, minutes, or hours?'));
    } else if (!Object.hasOwn(UNITS, unit)) {
      result.violations.push(violation(null, 'INVALID_TIMER_UNIT', 'The timer unit must be seconds, minutes, hours, or default.'));
    }
    if (typeof duration === 'number' && Number.isFinite(duration) && duration > 0 && Object.hasOwn(UNITS, unit)) seconds = duration * UNITS[unit];
  }
  if ((hasLegacy || seconds !== undefined) && (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > MAX_TIMER_SECONDS)) {
    result.violations.push(violation(null, 'INVALID_TIMER_DURATION', 'Timer duration must resolve to a whole number of seconds from 1 to 604800.'));
  }
  for (const rule of active.filter(rule => rule.kind === 'timer_max_seconds')) {
    result.applied_rule_ids.push(rule.id);
    if (typeof seconds === 'number' && seconds > rule.value) result.violations.push(violation(rule, 'TIMER_LIMIT_EXCEEDED', 'The requested timer exceeds a saved duration limit.'));
  }
  if (result.violations.length) result.ok = false;
  else result.args = { label: args.label, duration_seconds: seconds };
  result.applied_rule_ids = [...new Set(result.applied_rule_ids)];
  return result;
}

function startsWithLiteral(text, value) {
  const textValue = fold(text.trimStart());
  const prefix = fold(value);
  if (!textValue.startsWith(prefix)) return false;
  return !WORD_CHARACTER.test([...prefix].at(-1)) || !WORD_CHARACTER.test([...textValue.slice(prefix.length)][0] ?? '');
}
function prefixLength(text, value) {
  const needle = fold(value);
  let length = 0;
  for (const character of text) {
    length += character.length;
    if (fold(text.slice(0, length)) === needle) return length;
  }
  return 0;
}
function endsWithLiteral(text, value) {
  const textValue = fold(text.trimEnd());
  const suffix = fold(value);
  if (!textValue.endsWith(suffix)) return false;
  return !WORD_CHARACTER.test([...suffix][0]) || !WORD_CHARACTER.test([...textValue.slice(0, textValue.length - suffix.length)].at(-1) ?? '');
}

export function checkOutput(rules, text) {
  if (typeof text !== 'string') throw invalid('Assistant output must be a string.');
  const active = activeRules(rules);
  const conflicts = relevantConflicts(active, { reply: text });
  const conflictedIds = new Set(conflicts.flatMap(entry => entry.rule_ids));
  let output = text;
  const applied = [];
  const violations = [];
  const prefixRule = active.find(rule => rule.kind === 'response_prefix' && !conflictedIds.has(rule.id));
  // The address is inside the required prefix, preserving both independent contracts.
  for (const kind of ['address_as', 'response_prefix', 'response_suffix']) {
    const group = active.filter(rule => rule.kind === kind && !conflictedIds.has(rule.id));
    if (!group.length) continue;
    const rule = group[0];
    applied.push(...group.map(entry => entry.id));
    if (kind === 'response_suffix') {
      if (!endsWithLiteral(output, rule.value)) output = `${output.trimEnd()} ${rule.value}`.trim();
    } else if (!startsWithLiteral(output, rule.value)) {
      if (kind === 'address_as' && prefixRule && startsWithLiteral(output, prefixRule.value)) {
        const trimmed = output.trimStart();
        const end = prefixLength(trimmed, prefixRule.value);
        const remainder = trimmed.slice(end).trimStart();
        if (!startsWithLiteral(remainder, rule.value)) output = `${trimmed.slice(0, end)} ${rule.value}, ${remainder}`.trim();
      } else output = `${rule.value}${kind === 'address_as' ? ',' : ''} ${output.trimStart()}`.trim();
    }
  }
  for (const rule of active.filter(rule => LEXICAL.has(rule.kind))) {
    applied.push(rule.id);
    if (containsLiteral(output, rule)) violations.push(violation(rule, 'FORBIDDEN_LITERAL', 'The draft contains literal wording prohibited by a standing instruction.'));
  }
  return { text: output, applied_rule_ids: [...new Set(applied)], violations, conflicts, changed: output !== text };
}

/** Never quote forbidden originals while asking the owner to resolve a conflict. */
export function safeClarification(rules, conflicts = findConflicts(rules)) {
  const ids = new Set(conflicts.flatMap(entry => entry.rule_ids));
  const compatible = activeRules(rules).filter(rule => !(ids.has(rule.id) && AFFIXES.has(rule.kind)));
  const keys = new Set(conflicts.map(entry => entry.key));
  const specific = keys.has('timer_default_seconds') ? 'You gave me different default timer lengths. Which should I use?'
    : keys.has('timer_default_seconds_limit') ? 'Your usual timer is longer than your timer limit. Which should I change?'
      : keys.has('timer_default_unit') ? 'You gave me different default timer units. Which should I use?'
        : keys.has('timer_max_seconds') ? 'You gave me different timer limits. Which should I follow?'
          : keys.has('address_as') ? 'How would you like me to address you?'
            : keys.has('response_prefix') ? 'How should I start my replies?'
              : keys.has('response_suffix') ? 'How should I end my replies?' : null;
  const candidates = conflicts.length ? [
    specific,
    'Your instructions disagree. Which should I follow?',
    'Could you clarify which instruction to follow?',
    'Please clarify what you would like me to do.',
  ].filter(Boolean) : [
    'I could not phrase that while following your instructions. How would you like me to respond?',
    'Could you clarify how you would like me to respond?',
    'Please clarify your request.',
  ];
  for (const candidate of candidates) {
    const checked = checkOutput(compatible, candidate);
    if (!checked.violations.length && !checked.conflicts.length) return checked.text;
  }
  // The caller must display the conflict state out of band, rather than leak banned text.
  return '';
}
