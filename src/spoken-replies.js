import { normalizeSpokenText } from '../public/shared/spoken-text.js';
import { checkOutput } from './memory-rules.js';
import { AppError } from './errors.js';
import { validateSpeechText, MAX_SPEECH_CHARACTERS } from './voice/kokoro.js';

export const SPOKEN_REPLY_INSTRUCTIONS = `Write MERLIN's replies for listening, including typed replies that may be read aloud. Use natural spoken sentences, not screen shorthand. Keep the current personality and concise useful answer.
Say unit names and symbols in words: "sixteen degrees Fahrenheit", "twelve degrees Celsius", "twenty percent", "five kilometers per hour", "three to five minutes", "two dollars and fifty cents", and "half a cup". These are independent formatting examples, not equivalent temperatures, conversions, user preferences, or facts. Preserve every value, sign, decimal, range endpoint, qualifier, and unit; never silently convert, round, or assume a missing unit. Use the requested or clearly applicable unit, and do not add redundant conversions unless useful or requested.
Write ordinary quantities in words when practical. Express times and dates conversationally and unambiguously, for example "four thirty in the afternoon" or "October twenty-seventh" when the source actually specifies that meaning. Preserve the year and time zone when relevant. Do not guess an ambiguous numeric date, time period, currency, abbreviation, or identifier. Spell out unfamiliar abbreviations when their meaning is known; if an initialism needs separate letters, write it that way. Turn slashes and symbols into the relation they actually mean: per, to, and, or, divided by, minus, or plus. Do not mechanically read every slash the same way.
Prefer brief connected sentences over tables, markdown decoration, parenthetical shorthand, or symbol-heavy lists. Introduce separate items with spoken transitions when needed. Keep source links in citations and name useful sources naturally; do not recite raw URLs unless asked. When exact code, a URL, a model number, a quoted passage, or a literal spelling is requested, preserve it exactly and add a short spoken explanation if useful. Explicit literal output instructions remain authoritative. This changes only wording, never tool arguments, saved evidence, or action status.`;

function literalEdge(text, value, suffix = false) {
  const source = suffix ? text.trimEnd() : text.trimStart();
  const target = value.trim().normalize('NFKC').toLowerCase();
  let length = 0;
  const characters = [...source];
  if (suffix) characters.reverse();
  // Match the actual code-point span: NFKC can change its length (℉ → °F),
  // so slicing by the saved value's length can cut the framing incorrectly.
  for (const character of characters) {
    length += character.length;
    const candidate = suffix ? source.slice(-length) : source.slice(0, length);
    if (candidate.normalize('NFKC').toLowerCase() === target) return candidate;
  }
  return '';
}

function literalFraming(text, rules) {
  // Match the rule compiler's active-state contract. Inactive instructions must
  // neither add framing nor stop ordinary shorthand from being spoken clearly.
  const active = rules.filter(rule => rule && rule.active !== false
    && !['disabled', 'deleted', 'superseded', 'inactive', 'archived'].includes(rule.status));
  const prefix = active.find(rule => rule.kind === 'response_prefix');
  const address = active.find(rule => rule.kind === 'address_as');
  const suffix = active.find(rule => rule.kind === 'response_suffix');
  const prefixText = prefix ? literalEdge(text, prefix.value) : '';
  const phrases = [prefixText, suffix ? literalEdge(text, suffix.value, true) : ''];
  if (address) {
    const remainder = prefixText ? text.trimStart().slice(prefixText.length).trimStart() : text;
    phrases.push(literalEdge(remainder, address.value) || literalEdge(text, address.value));
  }
  return phrases.filter(Boolean);
}

/** Derive local speech without changing the archived/displayed reply or its facts. */
export function prepareSpokenReply(text, rules = []) {
  const original = checkOutput(rules, text);
  if (original.violations.length || original.conflicts.length) throw new AppError('The reply cannot be spoken under the current instructions.', 409);
  const literalPhrases = literalFraming(original.text, rules);
  const spoken = normalizeSpokenText(original.text, { literalPhrases });
  const checked = checkOutput(rules, spoken);
  if (checked.violations.length || checked.conflicts.length) throw new AppError('The reply cannot be spoken under the current instructions.', 409);
  // Expansion can exceed the synthesis limit. Never truncate a result to fit.
  if (checked.text.length > MAX_SPEECH_CHARACTERS) throw new AppError('Your answer is on screen. It is too long to read aloud.');
  return validateSpeechText(checked.text);
}
