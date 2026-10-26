// A deliberately narrow fast path. Anything beyond these complete commands
// goes through the normal model/tool loop; substrings never grant actions.
const NUMBERS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60 };
const amount = `(?:\\d+(?:\\.\\d+)?|${Object.keys(NUMBERS).join('|')})`;
const declaration = new RegExp(`^(?<quote>(?:(?:my |the )?(?:default|defualt) timer(?: duration)? (?:is|should be)|(?:set|make) (?:my |the )?(?:default|defualt) timer(?: duration)? (?:to|for))\\s+(?<amount>${amount})\\s+(?<unit>seconds?|secs?|minutes?|mins?|hours?|hrs?))(?<rest>[\\s\\S]*)$`, 'i');
const start = /^(?:please\s+)?(?:set|start|create)(?:\s+me)?\s+(?:a|the)\s+timer(?:\s+please)?[.!]?$/i;

export function parseSimpleTimerIntent(message) {
  if (typeof message !== 'string' || message.length > 4000 || /[?"“”`]/u.test(message)) return null;
  const text = message.trim().replace(/^merlin,?\s+/i, '');
  if (start.test(text)) return { start: true };
  const matched = declaration.exec(text);
  if (!matched) return null;
  const { quote, unit, rest } = matched.groups;
  const number = NUMBERS[matched.groups.amount.toLowerCase()] ?? Number(matched.groups.amount);
  const seconds = number * (/^(?:h|hr)/i.test(unit) ? 3600 : /^m/i.test(unit) ? 60 : 1);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 604800) return null;
  // No trailing qualifiers, recurrence, questions, or unrelated requested work.
  const tail = rest.trim().replace(/^[,;.]\s*/, '').replace(/^and\s+/i, '').trim();
  if (tail && !start.test(tail)) return null;
  return { default_seconds: seconds, source_quote: quote, start: Boolean(tail) };
}

export function formatDuration(seconds) {
  const divisor = seconds % 3600 === 0 ? 3600 : seconds % 60 === 0 ? 60 : 1;
  const count = seconds / divisor;
  const unit = divisor === 3600 ? 'hour' : divisor === 60 ? 'minute' : 'second';
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}
