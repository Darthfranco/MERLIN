// Web lookup policy and evidence.
//
// Meta's Responses API accepts only tool_choice "auto", so a request cannot force
// the built-in web_search tool. MERLIN therefore decides locally, with no model
// call, when a live search is required, enables the tool without waiting for the
// model to ask, and verifies afterwards that a search actually completed.

const normalize = text => String(text ?? '').normalize('NFKC').replace(/[’‘`]/gu, "'").replace(/\s+/gu, ' ').trim().toLowerCase();

const NONE = Object.freeze({ level: 'none', reason: '' });

// "Don't look it up", "no need to search", "without googling". "Don't forget to
// look it up" is still a request. Stop/quit only count right next to the verb so
// "stop the timer and search for pizza" keeps its search.
const WORD_GAP = "(?:(?!and\\b|then\\b|also\\b|but\\b)[a-z']+\\s+)";
const SEARCH_VERB = "(?:search(?:ing)?|look(?:ing)?\\s+(?:[a-z0-9'-]+\\s+){0,3}?up|google|googling|using (?:the )?(?:web|internet))";
const NEGATED = new RegExp(`\\b(?:do not|don't|dont|never|no need to|not to|without|avoid|no more)\\s+(?!forget\\b)${WORD_GAP}{0,3}?${SEARCH_VERB}\\b|\\b(?:stop|quit)\\s+${SEARCH_VERB}\\b`, 'u');
// "Can you search the web?" asks about the ability. "Can you look up the weather?" is a request.
const CAPABILITY = /^(?:(?:hey|hi|ok|okay|merlin|mister|so)[,\s]+)*(?:can|could|do|are|will|would) you (?:actually |also |even |really )?(?:search|look(?: [a-z]+){0,2} up|browse|google|go online|get online|use the (?:web|internet)|access the (?:web|internet)|find (?:things|stuff|information) online)(?: (?:the )?(?:web|internet|net))?(?: online)?(?: (?:for me|at all|too))?\s*[?.!]*$/u;
// "When I say gym, look up my plan" defines a routine; it is not a request now.
const TRIGGER_DEFINITION = /\b(?:if|when(?:ever)?|every time|each time|any ?time) (?:i|we) (?:say|tell you|ask)\b/u;

// "Search Spotify for jazz" and "look up my gym routine" name another source right
// after the verb. "Pause Spotify and search for the museum hours" does not.
const OTHER_SOURCE = "(?:spotify|playlists?|songs?|tracks?|albums?|artists?|music|memory|memories|my (?:[a-z']+ ){0,2}?(?:notes?|documents?|docs?|routines?|conversations?|history|timers?|files?|facts|plan|schedule|workout))";
const SCOPED_TO_OTHER_SOURCE = new RegExp(`\\b(?:search(?:ing)?|look(?:ing)?\\s+(?:[a-z0-9'-]+\\s+){0,3}?up)\\s+(?:[a-z0-9'-]+\\s+){0,3}?${OTHER_SOURCE}\\b`, 'u');
const LOOK_UP = /\blook\s+(?:[a-z0-9'-]+\s+){0,4}?up\b/u;
const SEARCH = /\bsearch(?:ing)?\b(?!\s+(?:engine|history|bar|results?)\b)/u;
const GOOGLE = /(?:^|[\s,.;!?])(?:google|googling)\b(?!\s+(?:home|nest|calendar|drive|assistant|maps?|photos?|cast|pixel|account|docs?|sheets?|chromecast|tv)\b)/u;
const ONLINE_CHECK = /\b(?:look|check|find|see|verify|confirm|browse|read|pull up|research|dig|ask|get)\b[^.?!;]{0,40}\b(?:online|on the (?:web|internet|net)|on google|on the website|from the (?:web|internet))\b/u;

// Requests that other tools or MERLIN's own context answer.
const INTERNAL = /\b(?:timers?|(?<!smoke |fire |security |carbon monoxide )alarms?|countdown|routines?|spotify|playlists?|songs?|music|volume|shuffle|pause|resume|skip|queue|memory|remember|forget|reminders?|merlin|lights?|oven|thermostat|camera|doorbell|my (?:name|default|preferences?|settings?|schedule|calendar|documents?|notes?|plan|workout)|your (?:name|goal|purpose)|yourself|who are you|what are you|what can you do|what do you do|how do you work)\b/u;
const SELF_REFERENCE = /^(?:what|who|when|where|which)(?:'s|s| is| are| was| were| did| have| has)?\s+(?:my|our|i|we|me)\b|\b(?:i|we) (?:said|told you|asked|set|saved|created|made)\b|\b(?:do|did|have|am|would) (?:i|we) (?:prefer|like|love|hate|usually|normally|always|own|have|had|said|told|asked|set|save|saved|name|named|call|called)\b|\bmy (?:favou?rite|usual|default|name|preferences?)\b/u;
const DATE_TIME = /^(?:what(?:'s|s| is)?(?: the)?(?: current| today's)? (?:date|time|day|month|year)(?: is it| it is)?(?: today| now| right now)?|what (?:time|day|date) is it(?: now| right now| today)?)(?: in [a-z .,'-]+)?\s*[?.!]*$/u;
const ARITHMETIC = /\d\s*(?:[-+*/x×÷^]|plus|minus|times|divided by|over|% of|percent of|to the power)\s*\d/u;
const SMALL_TALK = /\bhow(?:'s| is| are)\s+(?:it going|things|everything|life)\b|\bwhat'?s up\b/u;

// Subjects whose answers change or that a household assistant should check.
const TIME_SENSITIVE = /\b(?:weather|forecast|temperature|humidity|wind chill|uv index|air quality|pollen|rain(?:ing)?|snow(?:ing)?|storms?|hurricane|sunrise|sunset|news|headlines?|breaking news|scores?|standings|playoffs?|who won|who'?s winning|stocks?|share price|price of|prices of|exchange rate|bitcoin|ethereum|crypto|gas prices?|mortgage rates?|showtimes?|movies? (?:are )?(?:playing|showing)|what'?s (?:playing|on tonight)|(?:playing|showing) (?:tonight|today|now)|open (?:now|today|tonight|late)|(?:business|opening|store|office) hours|hours of operation|what time (?:does|do|is)|traffic|road closures?|flight status|release date|(?:next|upcoming) (?:game|match|race|election|marathon|holiday|season|episode|launch|event))\b/u;

const LEAD_IN = /^(?:(?:hey|hi|hello|ok|okay|so|and|also|um|uh|well|please|merlin|mister|sir|quick question|just curious)\b[,.!:\s-]*)+/u;
const ASKING = /^(?:(?:can|could|would|will) you (?:please |just )?(?:tell|let|show) me(?: know)?|do you (?:happen to )?know|i(?:'m| am) (?:curious|wondering)(?: about)?|i wonder|i want to know|i need to know|i'd like to know|tell me|let me know)\b[,:\s]*/u;
const WH_QUESTION = /^(?:who|whom|whose|who's|what|what's|whats|when|when's|whens|where|where's|wheres|which|why|how)\b/u;
const OTHER_FACT_QUESTION = /^(?:is it true|is there|are there|define|difference between|meaning of|recipe for|history of|about)\b/u;
const ADDRESSES_MERLIN = /\b(?:you|your|yours|yourself)\b/u;
// Statements, and instructions to process supplied text, are not questions about the world.
const NOT_A_REQUEST = /^(?:read|say|repeat|write|rewrite|translate|summarize|spell|pronounce|echo|speak|type|i|we|my|it's|its|that's|thats|this|these)\b/u;
// "What is next?" and "who is she?" follow a conversation; they name nothing to look up.
const VAGUE_END = /\b(?:next|that|this|it|them|those|these|she|he|they|her|him|else|more|now|up|new|happening|going on|wrong|good|then|later)\s*[?.!]*$/u;

/**
 * Decide whether a request needs a live web lookup.
 *   explicit: the user asked MERLIN to look it up. Never skipped.
 *   required: the answer is time-sensitive or a factual question about the world.
 *   none:     conversation, household, device or tool requests, or a lookup that
 *             was declined or only described.
 */
export function classifyLookup(message) {
  const text = normalize(message);
  if (!text) return NONE;
  if (NEGATED.test(text) || CAPABILITY.test(text) || TRIGGER_DEFINITION.test(text)) return NONE;

  if (ONLINE_CHECK.test(text) || (!SCOPED_TO_OTHER_SOURCE.test(text) && (LOOK_UP.test(text) || SEARCH.test(text) || GOOGLE.test(text)))) {
    return { level: 'explicit', reason: 'You asked me to look this up.' };
  }
  if (INTERNAL.test(text) || ARITHMETIC.test(text) || SMALL_TALK.test(text)) return NONE;

  const question = text.replace(LEAD_IN, '').trim();
  if (DATE_TIME.test(question)) return NONE;
  const asked = ASKING.test(question);
  const body = question.replace(ASKING, '').trim();
  if (TIME_SENSITIVE.test(text) && (text.includes('?') || !NOT_A_REQUEST.test(body))) {
    return { level: 'required', reason: 'This answer can change, so it needs a current source.' };
  }

  const factual = WH_QUESTION.test(body) || OTHER_FACT_QUESTION.test(body) || (asked && /^(?:if|whether)\b/u.test(body));
  if (!factual || body.split(' ').length < 3 || VAGUE_END.test(body)) return NONE;
  if (SELF_REFERENCE.test(body) || ADDRESSES_MERLIN.test(body)) return NONE;
  return { level: 'required', reason: 'This is a factual question, so it needs a source.' };
}

export const LOOKUP_REPLIES = Object.freeze({
  failed: "I couldn't look that up online just now, so I won't guess. Please ask me again in a moment.",
  denied: "Your saved instructions don't allow web searches, so I can't look that up.",
});

/** Model-facing instruction for the current round. */
export function lookupDirective(tracker, { enforcing = false, canSearch = true } = {}) {
  if (!tracker.required) return '';
  if (tracker.blocked) {
    return '\nA saved instruction blocks web search for this request. Do not claim you searched or looked anything up. Say plainly that you cannot look it up, and never present remembered facts as search results.';
  }
  if (tracker.satisfied) {
    return '\nThe required web lookup has completed. Answer from the search results, cite them, and say so plainly if the results are thin or disagree.';
  }
  if (!canSearch) return '';
  const mandatory = tracker.level === 'explicit' ? 'The user explicitly asked you to look this up, so searching is mandatory.' : `${tracker.reason}`;
  return `\nLookup required. ${mandatory} Call web_search with a focused query before you answer, even if you think you already know. Answer only from the results and cite the sources.${enforcing ? ' Your previous draft did not search, so it was discarded. Search now.' : ''}`;
}

export function enforcementMessage(tracker) {
  return tracker.level === 'explicit'
    ? 'The user explicitly asked you to look this up, and no web search has happened yet. Call web_search now with a focused query, then answer from the results. Do not answer from memory.'
    : 'This request needs a current source and no web search has happened yet. Call web_search now with a focused query, then answer from the results. Do not answer from memory.';
}

/** Remove provider citation markers such as 【1743†L8-L10】 from user-visible text. */
export function stripCitationMarkers(text) {
  return typeof text === 'string' ? text.replace(/\s*【[^】]*】/gu, '') : text;
}

const safeLink = (url, title, fallback = '') => {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return { url: parsed.href, title: String(title || fallback || parsed.hostname).slice(0, 300) };
  } catch { return null; }
};

const MAX_QUERIES = 12;
const MAX_RESULTS = 12;
const MAX_FALLBACK_SOURCES = 5;

/** Tracks one request's lookup policy, enforcement and evidence. */
export class LookupTracker {
  constructor() {
    this.level = 'none';
    this.reason = '';
    this.blocked = '';
    this.attempted = 0;
    this.completed = 0;
    this.enforced = 0;
    this.queries = [];
    this.results = new Map();
  }

  setPolicy({ level, reason }) { this.level = level; this.reason = reason; if (level === 'none') this.blocked = ''; }
  get required() { return this.level !== 'none'; }
  get satisfied() { return this.completed > 0; }

  /** Record a web_search_call output item exactly as Meta reported it. */
  record(item) {
    this.attempted++;
    if (item.status !== 'completed') return;
    this.completed++;
    const query = item.action?.query;
    if (typeof query === 'string' && query.trim() && this.queries.length < MAX_QUERIES) this.queries.push(query.trim().slice(0, 200));
    for (const result of Array.isArray(item.results) ? item.results : []) {
      if (this.results.size >= MAX_RESULTS) break;
      const link = typeof result?.url === 'string' ? safeLink(result.url, result.title) : null;
      if (link && !this.results.has(link.url)) this.results.set(link.url, link);
    }
  }

  /** Pages Meta retrieved, used only when the reply carries no citations of its own. */
  retrievedSources() {
    return [...this.results.values()].slice(0, MAX_FALLBACK_SOURCES).map(link => ({ ...link, basis: 'retrieved' }));
  }

  state() {
    if (!this.required) return this.completed ? 'searched' : 'not_required';
    if (this.satisfied) return this.enforced ? 'enforced' : 'done';
    if (this.blocked) return 'blocked';
    return this.level === 'explicit' ? 'failed' : 'unverified';
  }

  /** Response/inspector record. Omitted when no lookup was needed or performed. */
  summary() {
    if (!this.required && !this.completed) return null;
    return {
      policy: this.level, reason: this.reason, state: this.state(),
      searches: this.completed, failed_searches: this.attempted - this.completed, enforced: this.enforced,
      queries: [...this.queries], consulted: [...this.results.values()],
    };
  }
}
