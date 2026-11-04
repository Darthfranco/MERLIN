import { checkOutput } from './memory-rules.js';
import { checkPersonalityDraft } from './personality.js';

// The middle of a three-part spoken answer for internet questions (owner request, November 3, 2026): a prerecorded
// clip, then this line, then the real answer. It is written by its own small Meta call while the search runs, says
// only what MERLIN is looking up, and is never part of the reply, history or memory.
export const LOOKUP_LINE_INSTRUCTIONS = `You are MERLIN, a friendly home assistant. A web search for the person's request is starting right now, and the full answer will follow separately.
Write the one short sentence MERLIN says aloud while it searches. Name what you are looking up, using the request and any saved household context, such as where they live. At most 14 words.
Examples: "Checking the weather in Brooklyn for you now." "Looking up kosher pizza places near you."
Do not answer the question, guess, or state any result, number, time, name of a business or other fact. No greeting, no question, no name or title for the person. Plain text only.`;

const LOOKING = /\b(?:look(?:s|ing)?(?: (?:up|into|for))?|check(?:ing)?|search(?:ing)?|find(?:ing)?|pull(?:ing)? up|see what)\b/iu;

/** Only a short statement of what is being looked up survives; anything else means no line, never a different one. */
export function checkedLookupLine(text, { rules = [], policy } = {}) {
  if (typeof text !== 'string') return null;
  const line = text.replace(/\s+/gu, ' ').trim().replace(/^["“']+|["”']+$/gu, '').trim();
  // A number of its own would be an early result ("68 degrees", "9 PM"); one inside a name, like PS5 or 49ers, is not.
  if (!line || line.length > 110 || line.split(' ').length > 16 || /(?<![\p{L}\p{N}])\d+(?![\p{L}\p{N}])/u.test(line) || /[?:;\n]/u.test(line) || !/[.!]$/u.test(line) || !LOOKING.test(line)) return null;
  const checked = checkOutput(rules, line);
  if (checked.violations.length || checked.conflicts.length || checked.text !== line) return null;
  if (policy && checkPersonalityDraft(line, policy, rules).length) return null;
  return line;
}
