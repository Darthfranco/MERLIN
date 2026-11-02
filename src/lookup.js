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
const OWN_QUESTION = /^(?:what|who|when|where|which)(?:'s|s| is| are| was| were| did| have| has)?\s+(?:my|our|i|we|me)\b|\b(?:i|we) (?:said|told you|asked|set|saved|created|made)\b|\b(?:do|did|have|am|would) (?:i|we) (?:prefer|like|love|hate|usually|normally|always|own|have|had|said|told|asked|set|save|saved|name|named|call|called)\b/u;
const MY_PREFERENCE = /\bmy (?:favou?rite|usual|default|name|preferences?)\b/u;
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

// Questions about this household's own people, pets and things. A web page cannot
// know them, so they are answered from the conversation and memory, not searched.
const HOUSEHOLD = Object.freeze({ level: 'household', reason: 'This is about your household, so it is answered from the conversation and memory.' });
// An unfamiliar name reads the same whether it is a pet or a celebrity, so nothing
// is forced either way, and any web result is labeled as general information.
const UNKNOWN_SUBJECT = Object.freeze({ level: 'unknown_subject', reason: 'This names someone who may be part of your household.', general_only: true });

const ASKS = '(?:where|when|who|whom|whose|what|which|how (?:old|tall|big|long|much|many|often|far|heavy))';
// "which vet does my dog see" allows a few words before the verb. Modals and
// prepositions end it: "what can the dog eat" and "what happens if the dog eats chocolate" are general advice.
const NOUN_GAP = "(?:(?!can\\b|could\\b|should\\b|would\\b|will\\b|might\\b|may\\b|must\\b|i\\b|you\\b|if\\b|when\\b|after\\b|before\\b|for\\b|to\\b|about\\b|with\\b|from\\b|in\\b|on\\b|at\\b|and\\b|or\\b|the\\b|a\\b|an\\b)[a-z0-9'-]+ ){0,3}?";
const FAMILY = 'mom|mum|mommy|mummy|dad|daddy|grandma|grandpa|granny|nana|papa|wife|husband|partner|spouse|roommates?|babysitter|nanny';
const HOUSEHOLD_NOUN = `(?:dogs?|cats?|pupp(?:y|ies)|kittens?|pets?|hamsters?|kids?|children|bab(?:y|ies)|toddler|twins|${FAMILY}|(?:spare |house |car |front door )keys?|keys|remote|charger|batteries|scissors|flashlight|wi-?fi(?: password)?)`;
// "where does my dog nap", "how old is our cat". Not "why does my dog eat grass" or "how much should my dog weigh".
const OWN_SUBJECT = new RegExp(`^${ASKS} ${NOUN_GAP}(?:do|does|did|is|are|was|were|has|have|had) (?:my|our)\\b`, 'u');
// "where do we keep the batteries", "where did I put the scissors". Not "where do I buy a kettle".
const SHARED_SUBJECT = new RegExp(`^${ASKS} ${NOUN_GAP}(?:(?:do|did|are|were|have|had) we\\b|(?:do|did) i (?:keep|put|store|leave|park|hide|stash)\\b)`, 'u');
// "where does the dog nap", "where's the spare key", "what's the wifi password". A closed list, since "where is the Louvre" reads the same.
const HOUSEHOLD_THING = new RegExp(`^${ASKS}(?:'s|s)? ${NOUN_GAP}(?:(?:do|does|did|is|are|was|were|has|have|had) )?the ${HOUSEHOLD_NOUN}\\b`, 'u');
const FAMILY_NAME = new RegExp(`^(?:${FAMILY})$`, 'u');

const TITLE = '(?:aunt|auntie|uncle|cousin|grandma|grandpa|nana|papa|mr|mrs|ms|miss|dr|mister|sir)';
const NAME = `(?<name>(?:${TITLE}\\.? )?[a-z][a-z-]*)(?<own>'s)?(?: (?<rest>.+))?$`;
const SUBJECT_FORMS = [
  [new RegExp(`^${ASKS} ${NOUN_GAP}(?<aux>does|did|has|had|is|was) ${NAME}`, 'u')], // "where does biscuit nap"
  [new RegExp(`^(?:where|when|who|what)(?:'s|s) ${NAME}`, 'u'), 'is'], // "what's biscuit's favorite toy"
  [new RegExp(`^(?<aux>does|did|has|is|was) ${NAME}`, 'u')], // "does biscuit like walks"
  [new RegExp(`^(?:where|how old) ${NAME}`, 'u'), 'does'], // "do you know where biscuit naps"
];
const NOT_A_NAME = /^(?:the|a|an|this|that|these|those|it|he|she|they|him|her|them|i|you|we|me|my|our|your|his|their|there|here|someone|anyone|everyone|everybody|somebody|anybody|nobody|something|anything|everything|nothing|people|one|any|some|all|each|every|both|most|many|much|more|less|other|another|next|last|first|today|tomorrow|tonight|yesterday|now|then|what|which|who|how|not|can|could|should|would|will|may|might|must|do|does|did|is|are|was|were|has|have|had|am)$/u;
// What follows "is" when the word before it is the whole subject: "what is biscuit allergic to", "where is biscuit sleeping".
const STATE_AFTER_IS = /^(?:[a-z]+(?:ing|ed)|allergic|afraid|scared|born|from|up to|into|like|on|in|at|with|for)\b/u;

/** The single word or titled name a question is about, if its grammar has one. */
function namedSubject(body) {
  const clean = body.replace(/[?.!]+$/u, '').trim();
  for (const [form, aux] of SUBJECT_FORMS) {
    const groups = clean.match(form)?.groups;
    if (!groups) continue;
    return NOT_A_NAME.test(groups.name) ? null : { aux, ...groups, clean };
  }
  return null;
}

/** Whether an unknown word could still be someone's name, rather than a public topic that needs a source. */
function couldBeHouseholdName({ name, own, aux, rest = '', clean }, raw) {
  const tokens = raw.split(/\s+/u);
  const last = name.split(' ').at(-1);
  const at = tokens.findIndex(token => token.toLowerCase().replace(/[^a-z-]/gu, '') === last);
  if (at >= 0 && /^\p{Lu}/u.test(tokens[at + 1] ?? '')) return false; // "Where does Taylor Swift live?"
  if (/^(?:mean|stand for|opens?|closes?|costs?|sells?|charges?)\b/u.test(rest)) return false; // "what does nasa stand for", "when does costco open"
  if (aux === 'did' && name.endsWith('s')) return false; // "where did dinosaurs live"
  if (!rest && /^(?:does|did|has|is|was) /u.test(clean)) return false; // "was great"
  if (own || !['is', 'was'].includes(aux)) return true;
  if (/^(?:what|who)\b/u.test(clean) && !rest) return false; // "what is photosynthesis", "who is einstein": nobody asks who their own pet is
  if (/^how (?!old\b)/u.test(clean)) return false; // "how tall is mount everest"
  return !rest || STATE_AFTER_IS.test(rest); // Not "is dinner ready"
}

const STATEMENT_LEAD = 'just so you know|fyi|by the way|btw|also|and|so|well|remember that|remember|note that|please note that|please remember that|hey|ok|okay|merlin';
/** Evidence that a word names one of the household's own, not just that it was mentioned: "We shop at Costco" does not count. */
function namedInHousehold(name, evidence) {
  const word = name.replace(/[^a-z' .-]/gu, '').replaceAll('.', '\\.');
  if (!word) return false;
  const pattern = new RegExp(`(?:^|[.!?:;]\\s+)(?:(?:${STATEMENT_LEAD})[,\\s]+)*${word}\\b|\\b(?:my|our|household's|family's)\\s+(?:[a-z'-]+\\s+){0,2}?${word}\\b|\\bthe\\s+${HOUSEHOLD_NOUN}\\s+${word}\\b|\\b(?:named|called|nicknamed)\\s+${word}\\b`, 'u');
  return evidence.some(text => pattern.test(normalize(text)));
}

// "Who feeds Biscuit?" and "what's biscuit's vet called?" name someone outside the grammatical subject.
const CONTRACTIONS = /^(?:what|who|where|when|how|it|that|there|here|let|he|she)$/u;
function mentionsKnownName(body, raw, evidence) {
  if (!new RegExp(`^${ASKS}\\b`, 'u').test(body)) return false;
  const capitalized = raw.split(/\s+/u).slice(1).filter(token => /^\p{Lu}/u.test(token)).map(token => normalize(token).replace(/[^a-z'-]/gu, '').replace(/'s$/u, ''));
  const possessive = [...body.matchAll(/\b([a-z][a-z-]*)'s\b/gu)].map(match => match[1]).filter(word => !CONTRACTIONS.test(word));
  return [...capitalized, ...possessive].some(name => name && !NOT_A_NAME.test(name) && namedInHousehold(name, evidence));
}

const FILLER = new Set("a an and are at be can could did do does for from had has have how i in is it its me my of on or our should the their them they this that to was we were what what's whats when when's whens where where's wheres which who who's whos whom whose why will with would you your long much many often old tell know please".split(' '));
const stem = word => word.length > 4 ? word.replace(/(?:ing|ed|es|s)$/u, '') : word.replace(/s$/u, '');
const contentWords = text => [...new Set((normalize(text).match(/[a-z0-9]+(?:'[a-z]+)?/gu) ?? []).filter(word => !FILLER.has(word)).map(word => stem(word.replace(/'s$/u, ''))))];
/** One saved record or statement already holds every word asked about: "the wifi password", "trash day". */
function answeredAtHome(body, evidence) {
  const wanted = contentWords(body);
  const singleThing = wanted.length === 1 && /^(?:who|what|where|when)(?:'s|s| is| are) the [a-z'-]+\s*[?.!]*$/u.test(body);
  if (wanted.length < 2 && !singleThing) return false;
  return evidence.some(text => { const have = new Set(contentWords(text)); return wanted.every(word => have.has(word)); });
}

const LOOKUP_LEAD = /^(?:(?:please|can you|could you|would you)\s+)*(?:look(?:ing)? up|search(?: the web| online| the internet)? for|google|find out|check online)\s+/u;
/** An explicit lookup whose question is about the household still searches, and its results are labeled. */
function explicitAboutHousehold(text, raw) {
  return text.split(/[,.;:!?]+/u).map(clause => clause.trim().replace(LOOKUP_LEAD, '')).filter(Boolean).some(clause => {
    if (OWN_SUBJECT.test(clause) || SHARED_SUBJECT.test(clause) || HOUSEHOLD_THING.test(clause) || /^(?:where|when|what|who|how old) (?:my|our)\b/u.test(clause)) return true;
    const subject = namedSubject(clause);
    return Boolean(subject) && (FAMILY_NAME.test(subject.name) || couldBeHouseholdName(subject, raw));
  });
}

/** Earlier user statements in this conversation. Questions and MERLIN's own replies are not evidence. */
export function userStatements(history = []) {
  const texts = ({ content }) => typeof content === 'string' ? [content] : Array.isArray(content) ? content.filter(block => block?.type === 'input_text').map(block => String(block.text)) : [];
  return history.filter(item => item.role === 'user').flatMap(texts)
    .flatMap(text => text.split(/(?<=[.!?])\s+/u)).map(sentence => sentence.trim()).filter(sentence => sentence && !sentence.endsWith('?'));
}

/**
 * Decide whether a request needs a live web lookup.
 *   explicit:        the user asked MERLIN to look it up. Never skipped.
 *   required:        the answer is time-sensitive or a factual question about the world.
 *   household:       about the household's own people, pets or things. Answered from
 *                    the conversation and memory, with web search off.
 *   unknown_subject: names someone unfamiliar who may be one of theirs. Nothing is
 *                    forced, and any web result is labeled as general information.
 *   none:            conversation, device or tool requests, or a lookup that was
 *                    declined or only described.
 * `evidence` is saved memory and earlier statements that may name the subject.
 */
export function classifyLookup(message, { evidence = [] } = {}) {
  const text = normalize(message);
  if (!text) return NONE;
  if (NEGATED.test(text) || CAPABILITY.test(text) || TRIGGER_DEFINITION.test(text)) return NONE;

  const raw = String(message).normalize('NFKC');
  if (ONLINE_CHECK.test(text) || (!SCOPED_TO_OTHER_SOURCE.test(text) && (LOOK_UP.test(text) || SEARCH.test(text) || GOOGLE.test(text)))) {
    return { level: 'explicit', reason: 'You asked me to look this up.', ...(explicitAboutHousehold(text, raw) ? { general_only: true } : {}) };
  }
  if (INTERNAL.test(text) || ARITHMETIC.test(text) || SMALL_TALK.test(text)) return NONE;

  const question = text.replace(LEAD_IN, '').trim();
  if (DATE_TIME.test(question)) return NONE;
  const asked = ASKING.test(question);
  const body = question.replace(ASKING, '').trim();
  // A link means the question is about that page, which only the web can answer.
  const hasLink = /https?:\/\//u.test(text);
  const subject = hasLink ? null : namedSubject(body);
  const known = Boolean(subject) && (FAMILY_NAME.test(subject.name) || namedInHousehold(subject.name, evidence));
  if (TIME_SENSITIVE.test(text) && (text.includes('?') || !NOT_A_REQUEST.test(body))) {
    // "What time does Biscuit eat?" asks about the household, not a shop's hours.
    if (known && /^what time\b/u.test(body)) return HOUSEHOLD;
    return { level: 'required', reason: 'This answer can change, so it needs a current source.' };
  }
  if (known) return HOUSEHOLD;

  if (!hasLink && (OWN_SUBJECT.test(body) || SHARED_SUBJECT.test(body) || HOUSEHOLD_THING.test(body))) return HOUSEHOLD;
  const factual = WH_QUESTION.test(body) || OTHER_FACT_QUESTION.test(body) || (asked && /^(?:if|whether)\b/u.test(body));
  const fullQuestion = factual && body.split(' ').length >= 3 && !VAGUE_END.test(body);
  if (fullQuestion && !ADDRESSES_MERLIN.test(body) && !hasLink && (mentionsKnownName(body, raw, evidence) || answeredAtHome(body, evidence))) return HOUSEHOLD;
  if (subject && !VAGUE_END.test(body) && !ADDRESSES_MERLIN.test(body) && couldBeHouseholdName(subject, raw)) return UNKNOWN_SUBJECT;
  if (!fullQuestion) return NONE;
  if (ADDRESSES_MERLIN.test(body)) return NONE;
  if (OWN_QUESTION.test(body)) return HOUSEHOLD;
  if (MY_PREFERENCE.test(body)) return NONE;
  return { level: 'required', reason: 'This is a factual question, so it needs a source.' };
}

export const LOOKUP_REPLIES = Object.freeze({
  failed: "I couldn't look that up online just now, so I won't guess. Please ask me again in a moment.",
  denied: "Your saved instructions don't allow web searches, so I can't look that up.",
  general: 'Anything from the web here is general information, not about your household.',
});

const WEB_IS_GENERAL = 'Web results describe the outside world, not this household: someone with the same name elsewhere is not theirs. Never present a result as a fact about anyone or anything in this household.';

/** Model-facing instruction for the current round. */
export function lookupDirective(tracker, { enforcing = false, canSearch = true } = {}) {
  if (tracker.level === 'household') {
    return "\nThis question is about this household's own people, pets or things. Web search is off for it, because the web does not know this household. Answer only from this conversation and saved memory, checking memory_search if you need to. If they do not hold the answer, say plainly that you don't know and invite the person to tell you or to ask you to look it up. Do not guess or fill the gap with what is typical. If it turns out to be a general question about the outside world, answer what you can and offer to look it up.";
  }
  if (tracker.level === 'unknown_subject') {
    if (tracker.satisfied) return `\n${WEB_IS_GENERAL} If nothing in the results is clearly about what was asked, say you don't know.`;
    return "\nThis question names someone or something that may or may not be part of this household. Check memory first if you need to. If you recognize the name as a famous public person, place, organization or thing, the way anyone would recognize Einstein or Tokyo, it is a general question: search the web and answer from the results. If you do not recognize it, treat it as one of theirs, such as a pet or a relative: do not search the web for it, say plainly that you don't know, and invite the person to tell you. Never guess.";
  }
  if (!tracker.required) return '';
  if (tracker.blocked) {
    return '\nA saved instruction blocks web search for this request. Do not claim you searched or looked anything up. Say plainly that you cannot look it up, and never present remembered facts as search results.';
  }
  if (tracker.satisfied) {
    return `\nThe required web lookup has completed. Answer from the search results, cite them, and say so plainly if the results are thin or disagree. ${WEB_IS_GENERAL} If the question is about the household and no result clearly answers it, say you don't know.`;
  }
  if (!canSearch) return '';
  const mandatory = tracker.level === 'explicit' ? 'The user explicitly asked you to look this up, so searching is mandatory.' : `${tracker.reason}`;
  return `\nLookup required. ${mandatory} Call web_search with a focused query before you answer, even if you think you already know. Answer only from the results and cite the sources.${tracker.generalOnly ? ` ${WEB_IS_GENERAL}` : ''}${enforcing ? ' Your previous draft did not search, so it was discarded. Search now.' : ''}`;
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

const MAX_SNIPPET = 280;
const cleanSnippet = text => typeof text === 'string'
  ? text.normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, MAX_SNIPPET) : '';

const MAX_QUERIES = 12;
const MAX_RESULTS = 12;
const MAX_FALLBACK_SOURCES = 5;

/** Tracks one request's lookup policy, enforcement and evidence. */
export class LookupTracker {
  constructor() {
    this.level = 'none';
    this.reason = '';
    this.generalOnly = false;
    this.blocked = '';
    this.attempted = 0;
    this.completed = 0;
    this.enforced = 0;
    this.queries = [];
    this.results = new Map();
    // Result text is untrusted. It is shown to the person as context, and is kept out of traces and summaries.
    this.snippets = new Map();
  }

  setPolicy({ level, reason, general_only = false }) { this.level = level; this.reason = reason; this.generalOnly = general_only; if (!this.required) this.blocked = ''; }
  get required() { return this.level === 'explicit' || this.level === 'required'; }
  get satisfied() { return this.completed > 0; }
  /** Web text on a question that may be about the household must say it is only general information. */
  get needsGeneralLabel() { return this.generalOnly && this.satisfied; }

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
      if (link && !this.results.has(link.url)) {
        this.results.set(link.url, link);
        const snippet = cleanSnippet(result.snippet ?? result.text);
        if (snippet) this.snippets.set(link.url, snippet);
      }
    }
  }

  /** The retrieved text for a page, when the search returned any. */
  snippetFor(url) { return this.snippets.get(url) ?? ''; }

  /** Pages Meta retrieved, used only when the reply carries no citations of its own. */
  retrievedSources() {
    return [...this.results.values()].slice(0, MAX_FALLBACK_SOURCES).map(link => ({ ...link, basis: 'retrieved', ...(this.snippets.has(link.url) ? { snippet: this.snippets.get(link.url) } : {}) }));
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
      ...(this.needsGeneralLabel ? { labeled_general: true } : {}),
    };
  }
}
