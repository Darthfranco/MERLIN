// Speech-only fallback for assistant-owned prose. Never run on an exact-text
// echo or treat this as a unit converter: only recognized notation is expanded.
const NUMBER = String.raw`[+−-]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)`;
const FRACTION = String.raw`[+−-]?(?:(?:\d+[ \t]*)?[½¼¾]|(?:\d+(?:[ \t]+|-))?[1-7]/[2348])`;
const AMOUNT = `(?:${FRACTION}|${NUMBER})`;
const LEFT = String.raw`(?<![\p{L}\p{N}_#./:+−-])(?<!\d,)`;
const RIGHT = String.raw`(?![\p{L}\p{N}_/−-]|[.,]\d)`;
const DIGITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const SMALL = [...DIGITS, 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty'];
const VULGAR = { '½': [1, 2], '¼': [1, 4], '¾': [3, 4] };
const DENOMINATORS = { 2: ['half', 'halves'], 3: ['third', 'thirds'], 4: ['quarter', 'quarters'], 8: ['eighth', 'eighths'] };
const UNITS = [
  ['km/h|kph', 'kilometer per hour', 'kilometers per hour'],
  ['mph', 'mile per hour', 'miles per hour'],
  ['m/s', 'meter per second', 'meters per second'],
  ['kg|kilograms?', 'kilogram', 'kilograms'],
  ['mg|milligrams?', 'milligram', 'milligrams'],
  ['g|grams?', 'gram', 'grams'],
  ['km|kilometers?', 'kilometer', 'kilometers'],
  ['cm|centimeters?', 'centimeter', 'centimeters'],
  ['mm|millimeters?', 'millimeter', 'millimeters'],
  ['ml|milliliters?', 'milliliter', 'milliliters'],
  ['liters?', 'liter', 'liters'],
  ['oz|ounces?', 'ounce', 'ounces'],
  ['lbs?|pounds?', 'pound', 'pounds'],
  ['ft|feet|foot', 'foot', 'feet'],
  ['inches|inch', 'inch', 'inches'],
  ['hrs?|hours?', 'hour', 'hours'],
  ['mins?|minutes?', 'minute', 'minutes'],
  ['secs?|seconds?', 'second', 'seconds'],
  ['ms|milliseconds?', 'millisecond', 'milliseconds'],
  ['tbsp|tablespoons?', 'tablespoon', 'tablespoons'],
  ['tsp|teaspoons?', 'teaspoon', 'teaspoons'],
  ['cups?', 'cup', 'cups'],
].map(([pattern, singular, plural]) => ({ pattern, singular, plural, match: new RegExp(`^(?:${pattern})$`, 'iu') }));
const UNIT = UNITS.map(unit => unit.pattern).join('|');
const TEMPERATURE = String.raw`(?:°[ \t]*[FC]|[℉℃]|[FC])`;
const UNIT_BOUNDARY = RIGHT;

function signed(text, value) {
  return text.startsWith('-') || text.startsWith('−') ? `minus ${value}` : text.startsWith('+') ? `plus ${value}` : value;
}

function fractionParts(text) {
  const unsigned = text.replace(/^[+−-]/u, '').trim();
  const vulgar = unsigned.match(/^(\d+)?\s*([½¼¾])$/u);
  if (vulgar) return [vulgar[1] || '', ...VULGAR[vulgar[2]]];
  const slash = unsigned.match(/^(?:(\d+)(?:\s+|-))?([1-7])\/([2348])$/u);
  return slash ? [slash[1] || '', Number(slash[2]), Number(slash[3])] : null;
}

function spokenNumber(text) {
  const fraction = fractionParts(text);
  if (fraction) {
    const [whole, numerator, denominator] = fraction;
    const part = `${SMALL[numerator]} ${DENOMINATORS[denominator][numerator === 1 ? 0 : 1]}`;
    return signed(text, whole ? `${whole} and ${part}` : part);
  }
  const [whole, decimal] = text.replace(/^[+−-]/u, '').split('.');
  return signed(text, decimal ? `${whole || '0'} point ${[...decimal].map(digit => DIGITS[Number(digit)]).join(' ')}` : whole);
}

function magnitude(text) {
  const fraction = fractionParts(text);
  return fraction ? Number(fraction[0] || 0) + fraction[1] / fraction[2] : Math.abs(Number(text.replace(/[,+−]/gu, '')));
}

function unitName(unit, amount, range = false) {
  const entry = UNITS.find(candidate => candidate.match.test(unit));
  const singular = magnitude(amount) === 1 || (fractionParts(amount) && magnitude(amount) < 1);
  return entry[!range && singular ? 'singular' : 'plural'];
}

function temperatureName(unit) {
  return /[F℉]/iu.test(unit) ? 'Fahrenheit' : 'Celsius';
}

function temperatureContext(match, source, offset) {
  if (/[°℉℃]/u.test(match)) return true;
  const before = source.slice(Math.max(0, offset - 100), offset).split(/[.!?;\n]/u).at(-1);
  // Bare F/C also identify seats, apartments, and parts. Require an explicit
  // temperature cue in this clause; numeric shape alone supplies no meaning.
  return !/\b(?:seat|apartment|apt|room|suite|model|code|unit|id)\b/iu.test(before)
    && /\b(?:weather|temperatures?|forecast|thermostat|thermometer|celsius|fahrenheit)\b|[°℉℃]/iu.test(before);
}

function smallNumber(number) {
  return number < 20 ? SMALL[number] : `${TENS[Math.floor(number / 10)]}${number % 10 ? ` ${SMALL[number % 10]}` : ''}`;
}

function clockWords(hour, minute, meridiem) {
  return `${smallNumber(hour)}${minute ? ` ${minute < 10 ? 'oh ' : ''}${smallNumber(minute)}` : ''} ${meridiem.toUpperCase()} M`;
}

function moneyWords(symbol, amount, sign = '') {
  const units = { '$': ['dollar', 'dollars', 'cent', 'cents'], '€': ['euro', 'euros', 'cent', 'cents'], '£': ['pound', 'pounds', 'penny', 'pence'] }[symbol];
  const unsigned = amount.replace(/^[+−-]/u, '');
  const [whole, decimal] = unsigned.split('.');
  // More than two decimal places is kept exactly, never rounded into cents.
  if (decimal?.length > 2) return signed(sign || amount, `${spokenNumber(unsigned)} ${units[magnitude(unsigned) === 1 ? 0 : 1]}`);
  const cents = decimal ? Number(decimal.padEnd(2, '0')) : 0;
  const wholeValue = Number(whole.replaceAll(',', ''));
  const parts = [];
  if (wholeValue || !cents) parts.push(`${whole} ${units[wholeValue === 1 ? 0 : 1]}`);
  if (cents) parts.push(`${cents} ${units[cents === 1 ? 2 : 3]}`);
  return signed(sign || amount, parts.join(' and '));
}

function prose(text) {
  // Inline destinations are not spoken. Non-web links are protected below,
  // including Kokoro's native [word](+2) and [word](/phonemes/) syntax.
  text = text.replace(/\[([^\]\n]+)\]\(https?:\/\/[^\s)]+(?:\s+"[^"\n]*")?\)/giu, '$1');
  text = text.replace(/(?<![\p{L}\p{N}_*])(\*\*|__)(?=\S)([^\n]*?\S)\1(?![\p{L}\p{N}_*])/gu, '$2')
    .replace(/(?<![\p{L}\p{N}_*])\*(?=\S)([^*\n]*?\S)\*(?![\p{L}\p{N}_*])/gu, '$1')
    .replace(/(?<![\p{L}\p{N}_])_(?=\S)([^_\n]*?\S)_(?![\p{L}\p{N}_])/gu, '$1');
  text = text.split(/\r?\n/u).map(line => {
    const stripped = line.replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d{1,2}\.\s+)/u, '');
    return stripped !== line && stripped.trim() && !/[.!?:;]$/u.test(stripped.trimEnd()) ? `${stripped.trimEnd()}.` : stripped;
  }).join('\n');

  // A slash between two fully specified temperatures separates the readings;
  // no equivalence, conversion, preferred unit, or missing value is invented.
  text = text.replace(new RegExp(`${LEFT}(${NUMBER})[ \\t]*(${TEMPERATURE})[ \\t]*/[ \\t]*(${NUMBER})[ \\t]*(${TEMPERATURE})${RIGHT}`, 'giu'),
    (match, a, unitA, b, unitB, offset, source) => temperatureContext(match, source, offset)
      ? `${spokenNumber(a)} ${magnitude(a) === 1 ? 'degree' : 'degrees'} ${temperatureName(unitA)}, ${spokenNumber(b)} ${magnitude(b) === 1 ? 'degree' : 'degrees'} ${temperatureName(unitB)}` : match);
  text = text.replace(new RegExp(`${LEFT}(${NUMBER})[ \\t]*(${TEMPERATURE})[ \\t]*[–—-][ \\t]*(${NUMBER})[ \\t]*(${TEMPERATURE})${RIGHT}`, 'giu'),
    (match, a, unitA, b, unitB, offset, source) => !temperatureContext(match, source, offset) ? match : temperatureName(unitA) === temperatureName(unitB)
      ? `${spokenNumber(a)} to ${spokenNumber(b)} degrees ${temperatureName(unitB)}`
      : `${spokenNumber(a)} degrees ${temperatureName(unitA)} to ${spokenNumber(b)} degrees ${temperatureName(unitB)}`);
  text = text.replace(new RegExp(`${LEFT}(${NUMBER})[ \\t]*[–—-][ \\t]*(${NUMBER})[ \\t]*(${TEMPERATURE})${RIGHT}`, 'giu'),
    (match, a, b, unit, offset, source) => temperatureContext(match, source, offset) ? `${spokenNumber(a)} to ${spokenNumber(b)} degrees ${temperatureName(unit)}` : match);
  text = text.replace(new RegExp(`${LEFT}(${NUMBER})[ \\t]*(${TEMPERATURE})${RIGHT}`, 'giu'),
    (match, value, unit, offset, source) => temperatureContext(match, source, offset) ? `${spokenNumber(value)} ${magnitude(value) === 1 ? 'degree' : 'degrees'} ${temperatureName(unit)}` : match);

  text = text.replace(new RegExp(`${LEFT}(${NUMBER})[ \\t]*%?[ \\t]*[–—-][ \\t]*(${NUMBER})[ \\t]*%${RIGHT}`, 'gu'),
    (_, a, b) => `${spokenNumber(a)} to ${spokenNumber(b)} percent`);
  text = text.replace(new RegExp(`${LEFT}(${NUMBER})[ \\t]*%${RIGHT}`, 'gu'), (_, value) => `${spokenNumber(value)} percent`);
  text = text.replace(new RegExp(`${LEFT}([$€£])(${NUMBER})[ \\t]*[–—-][ \\t]*([$€£])?(${NUMBER})${RIGHT}`, 'gu'),
    (_, symbolA, a, symbolB, b) => `${moneyWords(symbolA, a)} to ${moneyWords(symbolB || symbolA, b)}`);
  text = text.replace(new RegExp(`${LEFT}([+−-]?)([$€£])(${NUMBER})${RIGHT}`, 'gu'),
    (_, sign, symbol, value) => moneyWords(symbol, value, sign));

  text = text.replace(new RegExp(`${LEFT}(${AMOUNT})[ \\t]*(${UNIT})[ \\t]*[–—-][ \\t]*(${AMOUNT})[ \\t]*(${UNIT})${UNIT_BOUNDARY}`, 'giu'),
    (_, a, unitA, b, unitB) => unitName(unitA, '1') === unitName(unitB, '1')
      ? `${spokenNumber(a)} to ${spokenNumber(b)} ${unitName(unitB, b, true)}`
      : `${spokenNumber(a)} ${unitName(unitA, a)} to ${spokenNumber(b)} ${unitName(unitB, b)}`);
  text = text.replace(new RegExp(`${LEFT}(${AMOUNT})[ \\t]*[–—-][ \\t]*(${AMOUNT})[ \\t]*(${UNIT})${UNIT_BOUNDARY}`, 'giu'),
    (match, a, b, unit) => {
      const quantity = match.slice(0, -unit.length).trim();
      return fractionParts(quantity) ? `${spokenNumber(quantity)} ${unitName(unit, quantity)}`
        : `${spokenNumber(a)} to ${spokenNumber(b)} ${unitName(unit, b, true)}`;
    });
  text = text.replace(new RegExp(`${LEFT}(${AMOUNT})[ \\t]*(${UNIT})${UNIT_BOUNDARY}`, 'giu'),
    (_, amount, unit) => `${spokenNumber(amount)} ${unitName(unit, amount)}`);
  text = text.replace(new RegExp(`${LEFT}([+−-]?(?:\\d+[ \\t]*)?[½¼¾])${RIGHT}`, 'gu'), (_, fraction) => spokenNumber(fraction));

  text = text.replace(/(?<![\p{L}\p{N}_./:])([1-9]|1[0-2])(?::([0-5]\d))?[ \t]*([ap])\.?m\.?(?![\p{L}\p{N}_:])/giu,
    (match, hour, minute, meridiem) => `${clockWords(Number(hour), Number(minute || 0), meridiem)}${match.endsWith('.') ? '.' : ''}`);
  // Generic "at" also introduces media offsets. Require an explicit clock cue.
  text = text.replace(/\b(the time is|the clock reads)[ \t]+([01]\d|2[0-3]):([0-5]\d)(?![:\d\p{L}_])/giu,
    (_, cue, hour, minute) => `${cue} ${clockWords(Number(hour) % 12 || 12, Number(minute), Number(hour) < 12 ? 'a' : 'p')}`);
  return text;
}

/** Expand common unambiguous speech shorthand without changing literal text.
 * Callers own length validation and must apply their normal output rules to the
 * result. The exact-text voice lab intentionally does not use this function.
 */
export function normalizeSpokenText(text, { literalPhrases = [] } = {}) {
  if (typeof text !== 'string') throw new TypeError('Speech text must be a string.');
  let prefix = '\uE000MERLIN';
  while (text.includes(prefix)) prefix += 'X';
  const values = [];
  const protect = value => `${prefix}${values.push(value) - 1}\uE001`;
  let masked = text;
  const literals = [...new Set(literalPhrases.filter(value => typeof value === 'string' && value))].sort((a, b) => b.length - a.length);
  if (literals.length) masked = masked.replace(new RegExp(literals.map(value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|'), 'gu'), protect);
  masked = masked.replace(/```[^]*?(?:```|$)|~~~[^]*?(?:~~~|$)|`[^`\n]+`/gu, protect);
  // Protect native/non-web Markdown links before paths and URLs inside them.
  masked = masked.replace(/\[[^\]\n]*\]\((?!https?:\/\/)[^)\n]*\)/giu, protect);
  // Leave web Markdown links available to the prose-label conversion, then
  // protect only genuinely raw web addresses, email addresses, and file paths.
  masked = masked.replace(/\[([^\]\n]+)\]\(https?:\/\/[^\s)]+(?:\s+"[^"\n]*")?\)/giu, '$1');
  masked = masked.replace(/\b(?:https?:\/\/|www\.)[^\s<>]+|\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b|(?<![\p{L}\p{N}_])(?:[a-z]:[\\/]|~\/|\.{1,2}\/|\/)[^\s<>]+/giu, protect);
  let normalized = prose(masked);
  // A protected code block or URL can contain an already-protected literal.
  // Restore outer spans first so every nested literal is restored exactly too.
  for (let index = values.length - 1; index >= 0; index--) normalized = normalized.split(`${prefix}${index}\uE001`).join(values[index]);
  return normalized;
}
