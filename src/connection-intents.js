// Decides, without a model call, when MERLIN should open the connection
// touchscreen: the user asks how to connect something, asks what can be
// connected, or asks for something they have never connected.
import { CATEGORIES, CONNECTIONS } from '../public/connections/catalog.js';

const normalize = text => String(text ?? '').normalize('NFKC').replace(/[’‘`]/gu, "'").replace(/[^\p{L}\p{N}'+]+/gu, ' ').replace(/\s+/gu, ' ').trim().toLowerCase();

export const CATEGORY_IDS = new Set([...CATEGORIES.map(category => category.id), 'music']);
const NONE_FOUND = null;

// Brand words people actually say. Generic catalog aliases ("Plus", "Bot", "Era",
// "bridge", "Android") would match ordinary speech, so only names, companies, and
// these distinctive aliases identify a route.
const BRAND_ALIASES = new Set(['nest', 'homekit', 'hue', 'hue bridge', 'alexa', 'echo dot', 'echo show', 'chromecast', 'kasa', 'tapo', 'caseta', 'smartthings',
  'thinq', 'zwave', 'z wave', 'zigbee2mqtt', 'mosquitto', 'tasmota', 'esphome', 'homepod', 'airplay', 'roomba', 'braava', 'vesync', 'symfonisk', 'tradfri',
  'dirigera', 'unifi', 'eufycam', 'liftmaster', 'amazon ring', 'signify', 'zha', 'webos', 'shelly', 'ecobee']);
const GENERIC_NAMES = new Set(['matter', 'camera standards', 'plus', 'pro']);

const phraseIndex = (() => {
  const entries = [];
  for (const connection of CONNECTIONS) {
    const phrases = new Set();
    for (const value of [connection.name, connection.company]) {
      const phrase = normalize(value);
      if (phrase.length >= 3 && !GENERIC_NAMES.has(phrase)) phrases.add(phrase);
    }
    for (const alias of connection.aliases) {
      const phrase = normalize(alias);
      if (BRAND_ALIASES.has(phrase)) phrases.add(phrase);
    }
    // People say "Alexa", while the catalog's alias is "Alexa Devices".
    if (connection.id === 'amazon-echo') phrases.add('alexa');
    for (const phrase of phrases) entries.push({ id: connection.id, phrase, pattern: new RegExp(`(?:^| )${phrase.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?: |$)`, 'u') });
  }
  return entries;
})();

/** Catalog routes named in the text. One match is a route; several are a search. */
export function namedRoutes(message) {
  const text = ` ${normalize(message)} `.replace(/^ | $/gu, '');
  const ids = new Set(); const phrases = [];
  for (const entry of phraseIndex) {
    if (!entry.pattern.test(text)) continue;
    ids.add(entry.id); phrases.push(entry.phrase);
  }
  return { ids: [...ids], query: phrases.sort((a, b) => b.length - a.length)[0] ?? '' };
}

const CATEGORY_WORDS = [
  ['lights', /\b(?:lights?|lamps?|bulbs?|lighting)\b/u],
  ['cameras', /\b(?:cameras?|cams?|doorbells?|webcams?)\b/u],
  ['locks', /\b(?:locks?|deadbolts?|smart locks?)\b/u],
  ['garage', /\bgarage(?: door| opener)?s?\b/u],
  ['climate', /\b(?:thermostats?|ac|a c|air conditioning|air conditioners?|heating|heaters?|furnace|hvac|heat pumps?|purifiers?|humidifiers?)\b/u],
  ['appliances', /\b(?:ovens?|stoves?|dishwashers?|washers?|washing machines?|dryers?|fridges?|refrigerators?|microwaves?|coffee (?:makers?|machines?)|appliances?)\b/u],
  ['blinds', /\b(?:blinds?|curtains?|shades?)\b/u],
  ['vacuums', /\b(?:vacuums?|roombas?|robot mops?)\b/u],
  ['tvs', /\b(?:tvs?|televisions?)\b/u],
  ['plugs', /\b(?:plugs?|outlets?|sockets?|smart switch(?:es)?)\b/u],
  ['sensors', /\b(?:sensors?|motion detectors?)\b/u],
  ['speakers', /\b(?:speakers?|sound systems?|soundbars?)\b/u],
  ['garden', /\b(?:sprinklers?|irrigation|lawn|garden)\b/u],
  ['energy', /\b(?:solar|ev chargers?|chargers?|energy monitors?)\b/u],
  ['hubs', /\b(?:hubs?|smart home|platforms?|bridges?)\b/u],
  ['music', /\b(?:music|spotify|playlists?|songs?)\b/u],
];

/** The household category a phrase talks about, if any. */
export function categoryFor(message) {
  const text = normalize(message);
  return CATEGORY_WORDS.find(([, pattern]) => pattern.test(text))?.[0] ?? '';
}

const CONNECT_VERB = /\b(?:connect|connecting|link|pair|set ?up|setup|hook ?up|hook|add|integrate|install|sync|register|log ?in|sign ?in|authori[sz]e|configure)\b/u;
const HOW_TO = /\b(?:how (?:do|can|could|would|should|to|about)|can you (?:help|show)|help me|show me how|walk me through|i (?:want|need|would like|d like) to|i'd like to|let's|lets|where (?:do|can|would)|is there a way|can you (?:connect|set ?up|pair|link|add))\b|^(?:please )?(?:connect|link|pair|set ?up|add|hook)\b/u;
const DEVICE_NOUN = /\b(?:device|devices|something|anything|account|service|services|app|integration|integrations|smart|home|appliance|appliances|gadget|gadgets|hardware|equipment)\b/u;
// Words that make "add"/"set up"/"connect" about MERLIN's own features or other tools.
const NOT_A_DEVICE = /\b(?:timers?|alarms?|countdown|routines?|remind(?:s|ers?)?|shopping list|to my (?:list|calendar|cart|queue)|contacts?|password|playlist to|on (?:my )?phone number)\b/u;
const BROWSE = [
  /\b(?:what|which)\b[^.?!]{0,40}\b(?:can|could|do|does|will)\b[^.?!]{0,30}\b(?:connect|work with|integrate|support|pair|link)\b/u,
  /\b(?:show|open|see|list|browse|view|pull up|bring up)\b[^.?!]{0,25}\b(?:connections?|integrations?|add ?ons?|add on|apps|services|smart home options|available devices)\b/u,
  /\b(?:what|which) (?:devices|services|integrations|apps|brands|smart home (?:brands|devices)) (?:do you|can you|does merlin|work|are supported|are available)\b/u,
  /\b(?:connect|add|pair) (?:a |another |new )?(?:device|devices|service|something|gadget)\b/u,
  /\b(?:connections?|integrations?) (?:menu|panel|screen|options|page|center)\b/u,
];

// Requests for something MERLIN has no connection for. First match wins.
const UNCONNECTED = [
  ['locks', /\b(?:lock|unlock)\b[^.?!]{0,25}\b(?:door|doors|house|home|front|back)\b/u],
  ['garage', /\b(?:open|close|shut)\b[^.?!]{0,20}\bgarage\b/u],
  ['cameras', /\b(?:show|open|pull up|check|display|bring up|view|see|watch)\b[^.?!]{0,30}\b(?:cameras?|cams?|doorbell|front door|back door|backyard|driveway|porch|nursery)\b|\bwho's (?:at|by|on) (?:the )?(?:front |back )?(?:door|porch)\b|\bis (?:anyone|someone|somebody) (?:at|by) the (?:front |back )?(?:door|porch)\b/u],
  ['lights', /\b(?:turn|switch|flip|put)\b[^.?!]{0,25}\b(?:lights?|lamps?|bulbs?)\b|\blights? (?:on|off)\b|\b(?:dim|brighten)\b[^.?!]{0,20}\b(?:lights?|lamps?)\b/u],
  ['appliances', /\b(?:preheat|pre heat|bake)\b|\b(?:turn|switch|set|start|run)\b[^.?!]{0,25}\b(?:oven|stove|burner|dishwasher|washer|washing machine|dryer|microwave|coffee (?:maker|machine)|kettle)\b/u],
  ['climate', /\b(?:turn|switch|set|put)\b[^.?!]{0,30}\b(?:thermostat|ac|a c|air conditioning|air conditioner|heating|heater|furnace|hvac|heat pump)\b|\bmake it (?:warmer|cooler|colder|hotter)\b|\b(?:cool|heat|warm) (?:down|up) the (?:house|home|room|apartment)\b/u],
  ['blinds', /\b(?:open|close|raise|lower|shut)\b[^.?!]{0,20}\b(?:blinds?|curtains?|shades?)\b/u],
  ['vacuums', /\b(?:start|run|send|stop|begin)\b[^.?!]{0,25}\b(?:vacuum|roomba|mop|braava)\b|\bvacuum the\b/u],
  ['tvs', /\b(?:turn|switch)\b[^.?!]{0,20}\b(?:tv|television)\b|\b(?:cast|put)\b[^.?!]{0,30}\b(?:to|on) the (?:tv|television)\b/u],
  ['plugs', /\b(?:turn|switch)\b[^.?!]{0,20}\b(?:plug|outlet|socket)\b/u],
  ['garden', /\b(?:water|sprinkle) the (?:lawn|garden|yard)\b|\b(?:turn|start)\b[^.?!]{0,20}\b(?:sprinklers?|irrigation)\b/u],
];
const PLAY_MUSIC = /^(?:please |hey |ok |okay )*(?:merlin[, ]+)?(?:play|put on|queue|shuffle)\b|\b(?:play|put on|queue|shuffle)\b[^.?!]{0,30}\b(?:music|songs?|playlist|album|spotify|tunes)\b/u;

/** Categories that a connected preview route belongs to. */
export function connectedCategories(connectedIds = []) {
  const connected = new Set(connectedIds);
  return new Set(CONNECTIONS.filter(connection => connected.has(connection.id)).flatMap(connection => connection.categoryIds));
}

/**
 * @returns null, or { kind, category, entry, query, reason }
 *   how_to        how do I connect X (entry set when one route is named)
 *   browse        what can I connect / show me the connections
 *   unconnected   asked for something with no connection yet
 *   preview_only  asked for something whose category is only a preview connection (no panel)
 */
export function classifyConnectionIntent(message, { connectedIds = [], spotifyConnected = false, spotifyAvailable = true } = {}) {
  const text = normalize(message);
  if (!text || text.length > 600) return NONE_FOUND;
  if (/\b(?:don't|do not|never|no need to|stop) (?:show|open|pull up)\b/u.test(text)) return NONE_FOUND;

  const named = namedRoutes(text);
  const category = categoryFor(text);
  const entry = named.ids.length === 1 ? named.ids[0] : '';
  const looksLikeSetup = CONNECT_VERB.test(text) && (HOW_TO.test(text) || /^(?:please )?(?:connect|link|pair|set ?up|add|hook)/u.test(text));

  const browsing = BROWSE.some(pattern => pattern.test(text)) && !NOT_A_DEVICE.test(text);
  // "What smart home brands can you pair with?" asks for the list, even though it says "pair".
  if (browsing && !named.ids.length) return { kind: 'browse', category: category === 'hubs' ? 'all' : category || 'all', entry: '', query: '', reason: 'You asked what can be connected.' };
  if (looksLikeSetup && !NOT_A_DEVICE.test(text) && (named.ids.length || category || DEVICE_NOUN.test(text))) {
    // "Connect a device" names nothing specific, so it is a request to browse.
    if (!named.ids.length && !category) return { kind: 'browse', category: 'all', entry: '', query: '', reason: 'You asked what can be connected.' };
    const targetCategory = category || (entry ? CONNECTIONS.find(connection => connection.id === entry).categoryIds[0] : 'all');
    return { kind: 'how_to', category: targetCategory === 'hubs' && !entry && !category ? 'all' : targetCategory, entry, query: entry ? '' : named.query, reason: 'You asked how to connect something.' };
  }
  if (NOT_A_DEVICE.test(text)) return NONE_FOUND;

  if (PLAY_MUSIC.test(text) && !spotifyConnected && spotifyAvailable) {
    return { kind: 'unconnected', category: 'music', entry: '', query: '', reason: 'Music needs a connected service.' };
  }
  const control = UNCONNECTED.find(([, pattern]) => pattern.test(text));
  if (!control) return NONE_FOUND;
  const covered = connectedCategories(connectedIds).has(control[0]);
  return covered
    ? { kind: 'preview_only', category: control[0], entry: '', query: '', reason: 'Only a preview connection exists for this.' }
    : { kind: 'unconnected', category: control[0], entry: '', query: '', reason: 'That needs a connection first.' };
}

const CATEGORY_LABEL = new Map([...CATEGORIES.map(category => [category.id, category.label.toLowerCase()]), ['music', 'music'], ['all', 'smart home']]);
const ROUTE_NAME = new Map(CONNECTIONS.map(route => [route.id, route.name]));
export const categoryLabel = id => CATEGORY_LABEL.get(id) ?? 'smart home';
export const routeName = id => ROUTE_NAME.get(id) ?? '';

/** Facts for the model once the large screen is open. Nothing here claims a device can be controlled. */
export function connectionDirective(intent, { connectedNames = [] } = {}) {
  if (!intent) return '';
  const preview = 'Connections made on the screen are previews: they record a choice, but MERLIN cannot control any connected device yet, so never say or imply that a device now works.';
  if (intent.kind === 'preview_only') {
    return `\nThe user asked for something in the ${categoryLabel(intent.category)} category. ${connectedNames.join(', ')} is marked connected only as a preview, so you cannot do it yet. Say so plainly in one short sentence. Do not claim the action happened. ${preview}`;
  }
  const shows = intent.entry ? `the setup guide for ${routeName(intent.entry)}`
    : intent.kind === 'browse' ? `everything that can be connected${intent.category !== 'all' ? `, starting with ${categoryLabel(intent.category)}` : ''}`
      : `${categoryLabel(intent.category)} options${intent.query ? ` matching “${intent.query}”` : ''}`;
  const lead = intent.kind === 'unconnected' ? 'Say briefly that you cannot do that yet because nothing is connected for it, then invite them to tap an option.'
    : 'Invite them to tap an option, or read the guide, on the big screen.';
  return `\nThe large connection screen is now open for the user, showing ${shows}. ${lead} Use one or two short sentences. Do not list the options or setup steps, and do not send them to another app. ${preview}`;
}
