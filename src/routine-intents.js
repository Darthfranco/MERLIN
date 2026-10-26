// This classifies a conversation's purpose only. The routine service must still
// ground every saved action in direct user evidence before saving or running it.
const normalize = value => value.normalize('NFKC').replaceAll('’', "'").replace(/[“”]/gu, '"').replace(/\s+/gu, ' ').trim();
const folded = value => normalize(value).toLowerCase();
const terminal = value => value.replace(/[.!?]+$/u, '').trim();
const ACTION_SOURCE = '(?:please\\s+)?(?:make|set|start|create|look\\s+up|search|find|say|tell|read|show|check|list|cancel|play|turn|open|close|give|remind|wait|ask|reply|summarize)\\b';
const ACTION = new RegExp(`^${ACTION_SOURCE}`, 'iu');
const WHEN_SAID = new RegExp(`^(?:when(?:ever)?|every time)\\s+i\\s+say\\s+(.+?)(?:\\s*[,;:]\\s*|\\s+)(?:then\\s+)?(${ACTION_SOURCE}[\\s\\S]*)$`, 'iu');
const REFERENCE = /^(?:(?:use|save|do)\s+)?(?:what (?:we|i) (?:already |just )?(?:said|discussed)(?: before| earlier)?|what (?:we|i) said (?:already|above)|(?:the )?same (?:thing|steps|actions|request|prompt)(?: as (?:before|above))?|(?:the )?(?:above|previous) (?:steps|actions|request|prompt)|that(?: one)?|it|as (?:we|i) discussed)$/iu;
const YES = /^(?:yes|yes please|yeah|yep|ok|okay|sure|please do|do it|confirm)$/iu;
const SHORT_SAVE = /^(?:save|use)\s+(?:it|that|this)(?:\s+(?:then|please))?$/iu;
const QUESTION_PREFIX = /^(?:what|how|why|when|where|who|which|is|are|am|was|were|does|do|did|has|have|had|can|could|would|should|will|may|might)\b/iu;

function courteous(value) {
  return value.replace(/^(?:merlin[,:]?\s+)?(?:(?:ok(?:ay)?|alright|all right|sure)[,:]?\s+)?(?:so\s+)?(?:please\s+)?/iu, '')
    .replace(/^(?:can|could|would|will) you\s+(?:please\s+)?/iu, '');
}

function excluded(value) {
  return /^(?:don't|do not|never|stop|avoid)\b/iu.test(value)
    || /^(?:for example|as an example|e\.g\.|example\s*:|hypothetically|suppose|imagine|what if|if|unless)\b/iu.test(value)
    || /^(?:he|she|they|someone|somebody|anyone|another person|the user|my friend|my doctor)\s+(?:said|says|asked|asks|wants|wanted|thinks|should|shoudl)\b/iu.test(value)
    || /^(?:he|she|they|someone|somebody|anyone|everyone)\s+(?:really |probably |perhaps )?(?:should|shoudl)\b/iu.test(value)
    || /^[\p{L}\p{M}'-]+(?:\s+[\p{L}\p{M}'-]+){0,2}\s+(?:said|says|asked|asks|wants|wanted|thinks)\s+\S/iu.test(value)
    || /^\s*>/u.test(value);
}

function nameOf(value) {
  let name = terminal(value.trim()).replace(/^["']|["']$/gu, '').trim();
  if (!name || name.length > 80 || name.split(/\s+/u).length > 8 || /[\n\r:?!]/u.test(name)
    || /^(?:i|we|you|he|she|they|it|this|that|them|someone|somebody|anyone|my friend|my doctor|the user)$/iu.test(name)) return undefined;
  return name;
}

function nameFromTail(tail) {
  const quoted = tail.match(/^["']([^"']+)["'](?:\s|[:,.!?]|$)/u);
  if (quoted) return nameOf(quoted[1]);
  return nameOf(tail.split(/\s+(?:(?:that|which)\s+)?(?:should|shoudl|will|to|with|does)\s+|\s*[:;,]\s*|\s+[—–]\s+/iu)[0]);
}

// An execution clause inside a quoted recipe is recipe text, not permission to run now.
function outsideQuotes(value, end) {
  let quote = null;
  for (let index = 0; index < end; index++) {
    const character = value[index];
    if (!["'", '"', '`'].includes(character)) continue;
    if (character === "'" && /[\p{L}\p{N}]/u.test(value[index - 1] ?? '') && /[\p{L}\p{N}]/u.test(value[index + 1] ?? '')) continue;
    if (quote === character) quote = null;
    else if (!quote) quote = character;
  }
  return !quote;
}

function executionClause(value) {
  const clause = /(?:[,;.]\s*|\s+(?:and|then|also)\s+)(?:also\s+)?(?:run|start|begin|execute)\s+(?:it|this routine|that routine|the routine)\s+now[.!?]*$/iu.exec(value);
  if (!clause || !outsideQuotes(value, clause.index)
    || /(?:^|[.;,]\s*|\band\s+)(?:don't|do not|never)\s+(?:run|start|begin|execute)\b/iu.test(value.slice(0, clause.index))) return { text: value, run_now: false };
  // In "Tea should set a timer and start it now", "it" can mean the timer
  // within the recipe. Require a separate request or an explicit routine target.
  if (!/\balso\b|\b(?:this|that|the) routine\b/iu.test(clause[0])
    && !/\bas\s+(?:a |my |the )?routine$/iu.test(value.slice(0, clause.index))) return { text: value, run_now: false };
  return { text: value.slice(0, clause.index).trim(), run_now: true };
}

function authoring(message) {
  if (typeof message !== 'string' || !message.trim() || message.length > 4000) return null;
  const value = courteous(normalize(message));
  if (quotedBody(message) || excluded(value) || (QUESTION_PREFIX.test(value) && !WHEN_SAID.test(terminal(value)))) return null;
  const execution = executionClause(value);
  const text = terminal(execution.text);
  let match;
  let name;
  if ((match = /^(?:save|set|create|make|add|define|store)\s+(?:a |my |the )?routine\s+(?:(?:named|called)\s+)?(.+)$/iu.exec(text))) {
    name = nameFromTail(match[1]);
  } else if ((match = /^(?:save|set|create|make|add|define|store)\s+(.+?)\s+as\s+(?:a |my |the )?routine(?:\s+(?:named|called)\s+(.+?)|\s+(?:then|please))?(?:\s*[:;,]\s*[\s\S]+)?$/iu.exec(text))) {
    name = nameFromTail(match[2] ?? match[1]);
  } else if ((match = /^(?:save|create|make|add|define|store)\s+(?:my |the )?(.+?)\s+routine(?:\s*[:;,]\s*[\s\S]+|\s+(?:then|please))?$/iu.exec(text))) {
    name = nameOf(match[1]);
  } else if ((match = /^(?:a )?routine\s+(?:named|called)\s+(.+)$/iu.exec(text))) {
    name = nameFromTail(match[1]);
    if (!/[,:]|\b(?:should|shoudl|will|does|to|that)\b/iu.test(match[1])) return null;
  } else if ((match = WHEN_SAID.exec(text))) {
    name = nameOf(match[1]);
  } else if ((match = /^(.+?)\s+(?:should|shoudl)\s+(.+)$/iu.exec(text)) && ACTION.test(match[2])) {
    name = nameOf(match[1]);
    if (!name) return null;
  } else return null;
  return { mode: 'authoring', ...(name ? { name } : {}), run_now: execution.run_now,
    reason: 'The complete request defines or saves a named routine; its action text is recipe content until separately authorized to run.' };
}

function lookup(message, routines) {
  const value = terminal(courteous(normalize(message)));
  if (excluded(value)) return null;
  const patterns = [
    /^(?:what's|what is)\s+(?:my |the )?(?:saved )?(.+?)\s+routine(?:\s+(?:called|named))?$/iu,
    /^(?:what does)\s+(?:my |the )?(?:saved )?(.+?)\s+routine\s+do$/iu,
    /^what are\s+(?:the )?steps\s+(?:of|in|for)\s+(?:my |the )?(?:saved )?(.+?)\s+routine$/iu,
    /^(?:look up|show me|tell me about|describe)\s+(?:my |the )?(?:saved )?(.+?)(?:\s+routine)?$/iu,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(value);
    if (!match) continue;
    const target = nameOf(match[1]);
    const routine = target && routines.find(item => [item.name, ...(item.aliases ?? [])].some(alias => folded(alias) === folded(target)));
    if (routine) return { mode: 'lookup', name: routine.name, run_now: false, reason: 'This is an information request about an existing routine, not an activation.' };
  }
  return null;
}

function quotedBody(value) {
  const text = normalize(value).replace(/[.!]$/u, '').trim();
  return /^"[\s\S]+"$/u.test(text) || /^'[\s\S]+'$/u.test(text);
}

function asksToSave(value) {
  const text = normalize(value);
  return text.includes('?') && /\b(?:save|create|set up|store|add|name)\b[\s\S]{0,180}\broutine\b|\broutine\b[\s\S]{0,180}\b(?:save|create|store)\b/iu.test(text)
    && !/\b(?:run|start|begin|execute)\b[\s\S]{0,40}\bnow\b/iu.test(text);
}

function continuation(message, precedingAssistant) {
  const value = terminal(courteous(normalize(message)));
  return REFERENCE.test(value) || quotedBody(message)
    || SHORT_SAVE.test(value)
    || (YES.test(value) && asksToSave(precedingAssistant ?? ''));
}

/** Obvious non-authorizing prose must never gain save permission from a tool call. */
export function isRoutineDefinitionBlocked(message, { allowContinuation = false } = {}) {
  if (typeof message !== 'string' || !message.trim() || message.length > 4000) return true;
  const value = courteous(normalize(message));
  if (excluded(value)) return true;
  if (quotedBody(message) || REFERENCE.test(terminal(value)) || YES.test(terminal(value)) || SHORT_SAVE.test(terminal(value))) return !allowContinuation;
  if (authoring(message)) return false;
  return QUESTION_PREFIX.test(value)
    || /^(?:tell me about|explain|describe|look up|show me)\b/iu.test(value);
}

/** Prior same-session turns; routine_saved is a trusted persisted-save receipt. */
export function detectRoutineIntent({ message, messages = [], routines = [] } = {}) {
  if (typeof message !== 'string' || !message.trim() || message.length > 4000 || !Array.isArray(messages) || !Array.isArray(routines)) return null;
  const direct = authoring(message);
  const information = lookup(message, routines);
  if (information) return information;
  const history = messages.filter(item => item && ['user', 'assistant'].includes(item.role) && typeof item.text === 'string').slice(-10);
  if (history.at(-1)?.role === 'user' && history.at(-1).text === message) history.pop();
  let context;
  let precedingAssistant = '';
  let continued = 0;
  for (const item of history) {
    if (item.role === 'assistant') { precedingAssistant = item.text; continue; }
    const prior = authoring(item.text);
    if (prior) { context = prior; continued = 0; }
    else if (context && continued < 4 && continuation(item.text, precedingAssistant)) continued++;
    else context = undefined;
    if (item.routine_saved === true) { context = undefined; continued = 0; }
    precedingAssistant = '';
  }
  if (direct) return { ...direct, ...(direct.name ? {} : context?.name ? { name: context.name } : {}) };
  if (!context || continued >= 4 || excluded(courteous(normalize(message))) || !continuation(message, precedingAssistant)) return null;
  return { mode: 'authoring', ...(context.name ? { name: context.name } : {}), run_now: false,
    reason: 'This directly continues the recent routine-definition conversation; earlier user evidence must supply the recipe.' };
}
