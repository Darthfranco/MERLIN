// Decides, without a model call, which camera a request is about. Someone showing MERLIN
// their outfit means the home device's own camera; someone asking who is at the door means a
// home camera. The two are different capabilities, and nothing here ever opens a camera.
const normalize = text => String(text ?? '').normalize('NFKC').replace(/[’‘`]/gu, "'").replace(/[^\p{L}\p{N}'+]+/gu, ' ').replace(/\s+/gu, ' ').trim().toLowerCase();

const GARMENT = "shirts?|t shirts?|tees?|tops?|blouses?|dress(?:es)?|skirts?|ties?|bow ties?|jackets?|coats?|blazers?|sweaters?|cardigans?|hoodies?|suits?|vests?|belts?|hats?|caps?|scarf|scarves|pants|trousers|jeans|chinos|shorts|leggings|shoes|sneakers|boots|heels|sandals|socks|bags?|purses?|necklaces?|earrings|watch(?:es)?|glasses";
const COLOR = /\b(?:black|white|red|blue|navy|green|yellow|orange|pink|purple|brown|beige|khaki|grey|gray|tan|teal|maroon|burgundy|gold|silver|olive|cream|striped|plaid)\b/u;
const JUDGE = /\b(?:match(?:es|ing)?|go(?:es)?|work(?:s)?|clash(?:es)?|coordinate|look(?:s)?|suit(?:s)?|fit(?:s)?|okay|ok|good|fine|nice|alright|think|rate|check|wear|appropriate)\b/u;
const MATCHING = /\b(?:match(?:es|ing)?|go(?:es)? with|go(?:es)? together|work(?:s)? with|work(?:s)? together|clash(?:es)?|coordinate)\b/u;
const DEICTIC_GARMENT = new RegExp(`\\b(?:this|these|those|that) (?:\\p{L}+ )?(?:${GARMENT})\\b`, 'u');
const MY_GARMENT = new RegExp(`\\bmy (?:${GARMENT})\\b`, 'u');
const NAMED_GARMENT = new RegExp(`\\b(?:${GARMENT})\\b`, 'gu');

// Statements and instructions about the camera are not requests to look through it.
const DECLINED = /\b(?:don't|dont|do not|never|no need to|stop|without|no) (?:\p{L}+ ){0,3}(?:camera|cam|webcam|look(?:ing)?|show)\b|\b(?:turn|switch|shut) (?:\p{L}+ ){0,2}(?:camera|cam|webcam) off\b|\b(?:turn|switch|shut) off (?:\p{L}+ ){0,2}(?:camera|cam|webcam)\b/u;
const ABOUT_CAMERA = /\b(?:do|does|did) (?:you|merlin|this \p{L}+) have (?:a |any )?(?:cameras?|cam|webcam)\b|\bis (?:the|your|my) (?:camera|cam|webcam) (?:on|off|working|available)\b|\bhow (?:do|does|did) (?:the|your) (?:camera|cam|webcam)\b|\b(?:what|which) cameras?\b/u;
const SETUP = /\b(?:connect|connecting|pair|link|set ?up|setup|install|hook ?up|integrate|add)\b[^.?!]{0,40}\b(?:cameras?|cams?|webcams?|doorbells?|ring|nest|arlo|blink|wyze|eufy|reolink)\b/u;
const STATEMENT = /^(?:please )?(?:remember|note|save|i (?:bought|like|love|hate|wore|got|ordered|want|need))\b/u;
const NOT_VISIBLE = /\b(?:schedule|calendar|timers?|routines?|memory|notes?|documents?|plan|playlists?|music|email|inbox|settings|preferences|lights?|devices?|website|link|page|code|results?|history|account)\b/u;

const PLACE = 'living room|bedroom|kitchen|garage|nursery|backyard|back yard|front yard|driveway|porch|patio|hallway|basement|front door|back door|office|dining room|garden|yard|doorstep';
const HOME = [
  /\b(?:doorbells?|security cam(?:era)?s?|home cam(?:era)?s?|cctv|baby monitors?|nanny cam(?:era)?s?|outdoor cam(?:era)?s?)\b/u,
  /\b(?:ring|nest|arlo|blink|wyze|eufy|reolink) (?:doorbells?|cams?|cameras?|feeds?|video)\b/u,
  /\b(?:check|pull up|bring up|open|view|watch) (?:the |my |our )?(?:ring|arlo|blink|wyze|eufy|reolink)\b/u,
  new RegExp(`\\b(?:${PLACE}) (?:cams?|cameras?|feeds?|view)\\b`, 'u'),
  new RegExp(`\\b(?:show|pull up|bring up|check|look at|see|watch|view|display|open)(?: me)?(?: the| my| our)? (?:${PLACE})$`, 'u'),
  /\b(?:who|what)(?:'s| is)? (?:at|by|on|outside) (?:the )?(?:front |back )?(?:door|porch|driveway|gate|doorstep)\b/u,
  /\bis (?:anyone|someone|somebody|there anyone|there someone) (?:at|by|on|outside) (?:the )?(?:front |back )?(?:door|porch|driveway|gate|doorstep)\b/u,
  /\bwho(?:'s| is)? (?:ringing|knocking)\b|\bwho (?:rang|knocked)\b/u,
  /\b(?:packages?|deliver(?:y|ies)|parcels?)\b[^.?!]{0,25}\b(?:porch|door|doorstep|driveway)\b/u,
  /\b(?:show|pull up|bring up|check|view|watch|display|see)(?: me)?(?: the| my| our)? (?:cameras?|cams?|camera feeds?|feeds?)\b/u,
];

const EXPLICIT = [
  /\b(?:use|turn on|switch on|open|start|enable|activate|fire up) (?:the |your |ur |my )?(?:camera|cam|webcam)\b/u,
  /\b(?:turn|switch) (?:the |your |ur |my )?(?:camera|cam|webcam) on\b/u,
  /\b(?:through|with|using|on) (?:your|the) (?:camera|cam|webcam)\b/u,
  /\bwhat (?:do|can) you see\b/u,
  /\bcan you see (?:me|this|these|that|those|what|my)\b/u,
  /\b(?:look at|take a look at|have a look at|check out) (?:me|this|these|that|those|what i)\b/u,
];

function topicOf(text) {
  if (/\bhow (?:do|does) i look\b|\bdo i look\b|\bwhat (?:am i|i'm|im|i am) wearing\b|\bam i dressed\b/u.test(text)) return 'outfit';
  if (/\bmy (?:outfit|clothes|clothing|attire|ensemble|getup)\b/u.test(text) && JUDGE.test(text) && !COLOR.test(text)) return 'outfit';
  if (/\b(?:this|these|those|that) (?:\p{L}+ )?(?:outfit|clothes|clothing|attire|ensemble|getup)\b/u.test(text) && JUDGE.test(text)) return 'outfit';
  if (DEICTIC_GARMENT.test(text) && JUDGE.test(text)) return 'outfit';
  if (/\b(?:does|do) (?:this|these) (?:all )?(?:match|go|work|clash|look)\b/u.test(text)) return 'outfit';
  if (MY_GARMENT.test(text) && MATCHING.test(text) && !COLOR.test(text)) return 'outfit';
  if (/\bhow many calories\b[^.?!]{0,30}\b(?:this|these|that|those|here)\b|\bwhat(?:'s| is) on my plate\b/u.test(text)) return 'food';
  if (/\b(?:help me|help with|check|solve|do|look at)\b[^.?!]{0,25}\b(?:this|my)\b[^.?!]{0,15}\b(?:homework|worksheet|math problem|equation|assignment)\b|\bsolve this\b$/u.test(text)) return 'homework';
  if (/^(?:(?:hey|ok|okay|merlin) )*what(?:'s| is) (?:this|that)(?: thing| object| item| plant| bug| insect| called| here)?$/u.test(text)) return 'object';
  if (/\bwhat am i holding\b|\bwhat(?:'s| is) in my hand\b|\bwhat(?:'s| is) (?:this|that) i'm holding\b|\bidentify (?:this|that|these|what)\b|\bwhat does (?:this|that) say\b/u.test(text)) return 'object';
  if (EXPLICIT.some(pattern => pattern.test(text))) return NOT_VISIBLE.test(text) ? null : 'general';
  return null;
}

// SAM 3.1 takes one short concrete noun phrase per request. "object" matched nothing in a live probe,
// so a topic with no concrete phrase leaves the list empty and Muse Spark names what matters first.
const CONCEPTS = { outfit: ['shirt', 'pants', 'shoes', 'dress'], food: ['food', 'plate'], homework: ['paper', 'worksheet'], object: [], general: [] };
function conceptsFor(topic, text) {
  const named = topic === 'outfit' ? [...new Set(text.match(NAMED_GARMENT) ?? [])] : [];
  return named.length ? named.slice(0, 4) : CONCEPTS[topic];
}

// Doing more than looking, such as also starting a timer, needs the model to plan the rest.
const COMPOUND = /\b(?:and|also|then|plus)\b[^.?!]*\b(?:set|start|cancel|turn|play|search|look up|remind|remember|tell|call|add|stop|pause|open|show|create|what|who|when|where|how)\b/iu;
const isCompound = message => COMPOUND.test(message) || String(message).split(/[.?!]+/u).filter(part => part.trim() && !/^(?:hey |ok |okay )*merlin$/iu.test(part.trim())).length > 1;

/**
 * @returns null, or
 *   { kind: 'device', topic, question, find, pure, refused_home }  the person is showing MERLIN something
 *   { kind: 'home' }                                               a home camera, doorbell, or room
 * A request that names a home camera for something the person is showing is still a device request,
 * flagged so MERLIN can say it does not use that camera for this.
 */
export function classifyCameraIntent(message) {
  const text = normalize(message);
  if (!text || text.length > 600 || /https?:\/\//iu.test(String(message))) return null;
  if (DECLINED.test(text) || ABOUT_CAMERA.test(text) || SETUP.test(text) || STATEMENT.test(text)) return null;
  const home = HOME.some(pattern => pattern.test(text));
  const topic = topicOf(text);
  if (!topic) return home ? { kind: 'home' } : null;
  // "Look at this camera feed" reads as a look only through its verb; a named home camera with no personal subject stays home.
  if (home && topic === 'general') return { kind: 'home' };
  return { kind: 'device', topic, question: String(message).trim().slice(0, 400), find: conceptsFor(topic, text), pure: !isCompound(message), refused_home: home };
}

const YES = "yes|yeah|yep|yup|sure|ok|okay|alright|all right|please|please do|do it|go ahead|go for it|go on|absolutely|of course|definitely|certainly|fine|affirmative|sounds good|why not|by all means|turn it on|switch it on|turn on the camera|turn on your camera|turn the camera on|turn your camera on|use the camera|use your camera|take a look|have a look|look";
const YES_REPLY = new RegExp(`^(?:(?:${YES}) ?){1,5}$`, 'u');
const NO_REPLY = /^(?:no|nope|nah|negative|not now|not yet|not right now|no thanks|no thank you|don't|dont|do not|please don't|never mind|nevermind|cancel|stop|leave it off|keep it off|maybe later|later|no way|rather not|i'd rather not|i would rather not|skip it|forget it)\b/u;

/** Answers MERLIN's camera question. Only a whole plain yes counts: anything longer or unclear is not consent. */
export function parseCameraConsent(message) {
  const text = normalize(message).replace(/^(?:hey |ok then |merlin )+/u, '').replace(/(?: merlin| mister| sir| ma'am| thanks| thank you)+$/u, '').trim();
  if (NO_REPLY.test(text)) return 'no';
  return text.length <= 80 && YES_REPLY.test(text) ? 'yes' : null;
}

const OFFER = /\b(?:turn on|switch on|use|open|start)\b[^.?!]{0,40}\b(?:camera|cam|webcam)\b[^.?!]{0,80}\?|\b(?:camera|cam|webcam)\b[^.?!]{0,40}\b(?:turn|switch)(?:ed)? on\b[^.?!]{0,40}\?/iu;
/** The model asked in its own words instead of through the tool. The next yes still needs an exact target. */
export const isCameraOffer = reply => OFFER.test(String(reply ?? ''));
