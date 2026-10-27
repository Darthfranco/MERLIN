import { CONNECTIONS } from '../connections/catalog.js';

// An intentionally local, deterministic demo. These helpers have no storage,
// DOM, network, model, microphone, scheduler, or physical-device side effects.
// respond() and removeMemory() mutate their state argument; callers own persistence.
export const STATE_VERSION = 1;
export const MAX_MESSAGE_LENGTH = 6000;
const ACCOUNT_IDS = ['spotify', 'apple-music', 'google-calendar', 'gmail', 'outlook-calendar', 'outlook', 'google-drive', 'dropbox', 'notion'];
const CONNECTION_IDS = new Set([...CONNECTIONS.map(item => item.id), ...ACCOUNT_IDS]);
const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,120}$/.test(value);
const cleanText = (value, limit = MAX_MESSAGE_LENGTH) => typeof value === 'string'
  ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, limit) : '';
const stamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : '2026-01-01T00:00:00.000Z';
const nextId = state => `phone-${++state.sequence}`;
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function createInitialState() {
  return { version: STATE_VERSION, sequence: 0, messages: [], memories: [], instructions: [], connections: {}, devices: { lights: false, brightness: 100, thermostat: null, vacuum: false } };
}

export function normalizeAttachments(value) {
  if (!Array.isArray(value)) return [];
  // Only attachment metadata enters chat state. Blob contents live in the UI's
  // local attachment store and are never interpreted as commands by this demo.
  return value.slice(0, 8).filter(item => plainObject(item) && safeId(item.id) && cleanText(item.name, 240)).map(item => ({
    id: item.id, name: cleanText(item.name, 240), type: cleanText(item.type, 120),
    size: Number.isSafeInteger(item.size) && item.size >= 0 ? item.size : 0,
  }));
}

function normalizeReceipt(receipt) {
  if (!plainObject(receipt) || receipt.simulated !== true) return undefined;
  const result = { kind: cleanText(receipt.kind, 40), title: cleanText(receipt.title, 160), detail: cleanText(receipt.detail, 600), simulated: true };
  if (CONNECTION_IDS.has(receipt.connection_id)) result.connection_id = receipt.connection_id;
  if (typeof receipt.status === 'string' && ['preview', 'disconnected', 'blocked'].includes(receipt.status)) result.status = receipt.status;
  return result;
}

export function normalizeState(saved) {
  const state = createInitialState();
  if (!plainObject(saved) || saved.version !== STATE_VERSION) return state;
  state.sequence = Number.isSafeInteger(saved.sequence) && saved.sequence >= 0 && saved.sequence < Number.MAX_SAFE_INTEGER - 1000 ? saved.sequence : 0;
  const used = new Set();
  function id(value) {
    const number = /^phone-(\d+)$/.exec(typeof value === 'string' ? value : '');
    if (number && Number.isSafeInteger(Number(number[1])) && Number(number[1]) < Number.MAX_SAFE_INTEGER - 1000) state.sequence = Math.max(state.sequence, Number(number[1]));
    if (safeId(value) && !used.has(value)) { used.add(value); return value; }
    let fresh = nextId(state);
    while (used.has(fresh)) fresh = nextId(state);
    used.add(fresh);
    return fresh;
  }
  if (plainObject(saved.connections)) {
    for (const [key, connected] of Object.entries(saved.connections)) if (CONNECTION_IDS.has(key) && connected === true) state.connections[key] = true;
  }
  if (plainObject(saved.devices)) {
    state.devices.lights = saved.devices.lights === true;
    state.devices.vacuum = saved.devices.vacuum === true;
    if (Number.isInteger(saved.devices.brightness) && saved.devices.brightness >= 0 && saved.devices.brightness <= 100) state.devices.brightness = saved.devices.brightness;
    const thermostat = saved.devices.thermostat;
    if (plainObject(thermostat) && validTemperature(thermostat.temperature, thermostat.unit)) state.devices.thermostat = { temperature: thermostat.temperature, unit: thermostat.unit };
  }
  if (Array.isArray(saved.memories)) {
    state.memories = saved.memories.filter(item => plainObject(item) && cleanText(item.text, 1000) && !/\bspotify\b/i.test(item.text)).map(item => ({
      id: id(item.id), text: cleanText(item.text, 1000), createdAt: stamp(item.createdAt), ...(safeId(item.sourceId) ? { sourceId: item.sourceId } : {}),
    }));
  }
  // Unsupported standing instructions are never imported as enforced rules.
  // History is retained in full; storage-quota failures must be surfaced by UI.
  if (Array.isArray(saved.messages)) {
    state.messages = saved.messages.filter(item => plainObject(item) && ['user', 'assistant'].includes(item.role)).map(item => ({
      id: id(item.id), role: item.role, text: cleanText(item.text, Number.MAX_SAFE_INTEGER), channel: item.channel === 'voice' ? 'voice' : 'text',
      createdAt: stamp(item.createdAt), attachments: normalizeAttachments(item.attachments),
      ...(normalizeReceipt(item.receipt) ? { receipt: normalizeReceipt(item.receipt) } : {}),
      ...(Array.isArray(item.memoryIds) ? { memoryIds: item.memoryIds.filter(value => state.memories.some(memory => memory.id === value)) } : {}),
    }));
  }
  return state;
}

export function removeMemory(state, memoryId) {
  const removed = state.memories.find(memory => memory.id === memoryId);
  if (!removed) return false;
  state.memories = state.memories.filter(memory => memory.id !== memoryId);
  // Remove source turns and recalled copies, preventing a deleted preference
  // from being reintroduced through the local transcript on reload.
  state.messages = state.messages.filter(message => message.id !== removed.sourceId
    && !message.memoryIds?.includes(memoryId)
    && !message.text.toLowerCase().includes(removed.text.toLowerCase()));
  return true;
}

function connectedFor(state, category, preferred) {
  if (preferred && state.connections[preferred] === true) return preferred;
  return CONNECTIONS.find(item => item.categoryIds.includes(category) && state.connections[item.id] === true)?.id;
}
function receipt(kind, title, detail, extra = {}) { return { kind, title, detail, simulated: true, status: 'preview', ...extra }; }
function disconnected(name, connection_id) {
  return { text: `Connect ${name} in Connections to try this demo action.`, receipt: receipt('connection', `${name} is not connected`, 'Demo connection only. No account or device will be accessed.', { connection_id, status: 'disconnected' }) };
}
const validTemperature = (temperature, unit) => Number.isFinite(temperature) && (unit === 'C' && temperature >= 5 && temperature <= 35 || unit === 'F' && temperature >= 41 && temperature <= 95);
const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20, thirty: 30, sixty: 60 };
function timerDuration(text) {
  if (/[-−]\s*\d|\b(?:minus|negative)\b/.test(text)) return null;
  const match = /\b(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|sixty)\s*[- ]?\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)\b/i.exec(text);
  if (!match) return null;
  const amount = words[match[1].toLowerCase()] ?? Number(match[1]);
  const unit = /^(second|sec)/i.test(match[2]) ? 'second' : /^(minute|min)/i.test(match[2]) ? 'minute' : 'hour';
  const seconds = amount * (unit === 'second' ? 1 : unit === 'minute' ? 60 : 3600);
  return Number.isInteger(seconds) && seconds >= 1 && seconds <= 604800 ? `${amount} ${unit}${amount === 1 ? '' : 's'}` : null;
}

function isDeferredAction(text) {
  return /\b(?:every|tomorrow|later|when|if|after)\b|\bat \d{1,2}(?::\d{2}|\s*(?:am|pm))\b|\bin (?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|thirty)\s*(?:seconds?|minutes?|hours?)\b/.test(text);
}

function answer(state, text, channel, attachments, sourceId, now) {
  const lower = text.toLowerCase().replace(/[’‘]/g, "'");
  if (/\b(?:always|never|don't ever|do not ever|from now on|unless i say otherwise|default timer)\b/.test(lower) || /^(?:please\s+)?(?:don't|do not)\b/.test(lower) || /^(?:if|when) i say\b/.test(lower)) {
    return { text: 'Standing instructions and routines need the connected assistant. I haven’t saved or applied a rule in this demo.' };
  }
  if (/\b(?:and|then)\s+(?:please\s+)?(?:turn|switch|set|start|stop|pause|play|send|unlock|open|close|remind)\b/.test(lower)) return { text: 'This demo handles one action at a time. Try each part as a separate request.' };
  const hasSpotify = /\bspotify\b/.test(lower);
  const isMusic = hasSpotify || /^(?:please\s+)?(?:play|pause|resume|skip|stop)\b.*\b(?:music|song|track|playlist)\b/.test(lower);
  if (/\bapple music\b/.test(lower)) return { text: 'Apple Music is available as a demo connection. Its playback controls haven’t been built yet.' };
  if (isMusic) {
    if (channel === 'voice') return { text: 'Spotify voice control is unavailable. Use text chat or the service’s own app.' };
    if (/\b(?:alarm|wake me|every|daily|schedule|remind)\b/.test(lower)) return { text: 'Spotify alarms and scheduled playback are unavailable in this demo.' };
    if (/\b(?:remember|prefer|favorite|favourite|learn|save)\b/.test(lower)) return { text: 'Spotify listening details stay out of my memory. Nothing was saved.' };
    if (!/^(?:please\s+)?(?:play|pause|resume|skip|stop|next|previous|shuffle|repeat|set|change|search|find|show)\b/.test(lower)) return { text: 'Spotify is a demo connection here. Text controls show previews; voice control is unavailable.' };
    if (!state.connections.spotify) return disconnected('Spotify', 'spotify');
    return { text: 'Music control preview, mister. Nothing is playing on a real device.', receipt: receipt('music', 'Spotify · Demo preview', 'A playback request was simulated. No music or account data was accessed.', { connection_id: 'spotify' }) };
  }
  if (/^(?:please\s+)?(?:forget|clear|delete|erase)\s+(?:everything|all(?: of)? (?:my )?(?:memories|memory|history)|what you (?:know|remember)(?: about me)?)[.!]?$/i.test(text)) {
    state.memories = []; state.instructions = []; state.messages = [];
    return { text: 'I’ve cleared your saved memories and earlier chat from this demo.', clearedHistory: true };
  }
  const forget = /^(?:please\s+)?forget\s+(?:that\s+)?(.+?)[.!]?$/i.exec(text);
  if (forget) {
    const wanted = forget[1].toLowerCase().trim();
    const matches = state.memories.filter(memory => memory.text.toLowerCase().includes(wanted) || wanted.includes(memory.text.toLowerCase()));
    if (!matches.length) return { text: 'I couldn’t find that saved memory. You can review and remove memories in the app.' };
    for (const memory of matches) removeMemory(state, memory.id);
    return { text: 'Forgotten. I removed that memory and its saved conversation copies.', redactUserText: true };
  }
  if (/\b(?:what do you (?:remember|know)(?: about me)?|(?:show|list|read) (?:my |your )?(?:memories|memory|preferences)|what (?:are|is) my (?:preferences|name)|what do i (?:like|prefer)|how do i like my lights|do you remember)\b/.test(lower)) {
    if (!state.memories.length) return { text: 'Nothing saved yet, mister. Tell me a preference and I’ll remember it here.' };
    return { text: `Here’s what I remember:\n${state.memories.map(memory => `• ${memory.text}`).join('\n')}`, memoryIds: state.memories.map(memory => memory.id) };
  }
  const remember = /^(?:please\s+)?remember\s+(?:that\s+)?(.+?)[.!]?$/i.exec(text);
  const preference = /^(i (?:like|prefer|love)\s+.+|my (?:name|favorite\s+\w+|favourite\s+\w+) is\s+.+)[.!]?$/i.exec(text);
  if (remember || preference) {
    const value = cleanText((remember || preference)[1], 1000).replace(/[.!]$/, '');
    if (!value || /^(?:you|to)\b/i.test(value) || /\b(?:must|should|turn|switch|set|start|stop|send|delete|unlock|open|connect|disconnect|call)\b/i.test(value)) return { text: 'I can remember a simple preference here. Actions and standing instructions need a separate request.' };
    const existing = state.memories.find(memory => memory.text.toLowerCase() === value.toLowerCase());
    if (existing) return { text: 'Already remembered, mister. It’s available in text and voice.', memoryIds: [existing.id] };
    const memory = { id: nextId(state), text: value, sourceId, createdAt: now };
    state.memories.push(memory);
    return { text: 'Remembered, mister. I’ll keep that with me in text and voice.', memoryIds: [memory.id] };
  }
  if (/\b(?:what|show|list|check)\b.*\b(?:calendar|schedule|agenda)\b|\bwhat'?s on (?:my |the )?(?:calendar|schedule|agenda)\b/.test(lower)) {
    const connectionId = state.connections['google-calendar'] ? 'google-calendar' : state.connections['outlook-calendar'] ? 'outlook-calendar' : null;
    if (!connectionId) return disconnected('Google Calendar', 'google-calendar');
    return { text: 'Your sample day is looking rather manageable, mister.', receipt: receipt('calendar', 'Today · Sample calendar', '10:00 AM · Team catch-up\n6:30 PM · Dinner at home\nThese are fictional demo events, not your real calendar.', { connection_id: connectionId }) };
  }
  if (/^(?:please\s+)?(?:turn|switch|dim|set|brighten)\b.*\blights?\b/.test(lower)) {
    const connectionId = connectedFor(state, 'lights', 'philips-hue');
    if (!connectionId) return disconnected('Philips Hue', 'philips-hue');
    if (isDeferredAction(lower)) return { text: 'Timed and conditional light actions aren’t scheduled in this demo. Try turning the lights on or off now.' };
    const off = /\boff\b/.test(lower), on = /\bon\b/.test(lower), dim = /\b(\d{1,3})\s*(?:%|percent\b)/.exec(lower);
    if (!off && !on && !dim) return { text: 'Would you like the lights on, off, or at a particular brightness?' };
    if (on && off || dim && Number(dim[1]) > 100) return { text: 'Choose on, off, or a brightness from 0 to 100 percent.' };
    state.devices.lights = dim ? Number(dim[1]) > 0 : !off;
    if (dim) state.devices.brightness = Number(dim[1]);
    const room = /\b(living room|bedroom|kitchen|hallway|office|dining room|bathroom|garden)\b/.exec(lower)?.[1];
    const label = room ? `${room[0].toUpperCase()}${room.slice(1)} lights` : 'Lights';
    const setting = dim ? `${dim[1]}% brightness` : off ? 'Off' : 'On';
    const warm = state.memories.some(memory => /\blights?\b/i.test(memory.text) && /\bwarm\b/i.test(memory.text));
    return { text: `${label} ${setting.toLowerCase()} in the demo.${warm && !off ? ' Keeping them warm, just as you like.' : ''}`, receipt: receipt('lights', `${label} · ${setting}`, `${warm && !off ? 'Warm tone · ' : ''}Simulated change only. No physical lights were operated.`, { connection_id: connectionId }), ...(warm && !off ? { memoryIds: state.memories.filter(memory => /lights?.*warm|warm.*lights?/i.test(memory.text)).map(memory => memory.id) } : {}) };
  }
  if (/^(?:please\s+)?(?:set|change|adjust)\b.*\b(?:thermostat|temperature|heating|ac)\b/.test(lower)) {
    if (isDeferredAction(lower)) return { text: 'Scheduled thermostat changes aren’t available in this demo.' };
    const connectionId = connectedFor(state, 'climate', 'ecobee');
    if (!connectionId) return disconnected('ecobee', 'ecobee');
    const match = /\b(\d+(?:\.\d+)?)\s*°?\s*(celsius|fahrenheit|c|f)\b/.exec(lower);
    if (!match) return { text: 'What temperature would you like, in Celsius or Fahrenheit?' };
    const temperature = Number(match[1]), unit = match[2][0].toUpperCase();
    if (!validTemperature(temperature, unit)) return { text: 'The thermostat preview supports 5–35°C or 41–95°F.' };
    state.devices.thermostat = { temperature, unit };
    return { text: `Thermostat preview set to ${temperature}°${unit}.`, receipt: receipt('climate', `${temperature}°${unit} · Demo temperature`, 'No physical thermostat was changed.', { connection_id: connectionId }) };
  }
  if (/^(?:please\s+)?(?:start|stop|pause)\b.*\b(?:vacuum|cleaning)\b/.test(lower)) {
    if (isDeferredAction(lower)) return { text: 'Scheduled cleaning isn’t available in this demo.' };
    const connectionId = connectedFor(state, 'vacuums', 'roborock');
    if (!connectionId) return disconnected('Roborock', 'roborock');
    state.devices.vacuum = /^start/.test(lower.replace(/^please\s+/, ''));
    return { text: state.devices.vacuum ? 'Cleaning preview started. Your real vacuum hasn’t moved.' : 'Cleaning preview stopped.', receipt: receipt('vacuum', state.devices.vacuum ? 'Vacuum · Cleaning preview' : 'Vacuum · Stopped', 'Simulated status only.', { connection_id: connectionId }) };
  }
  if (/\b(?:remind me|reminder|timer|alarm)\b/.test(lower)) {
    if (/\b(?:cancel|delete|stop)\b/.test(lower)) return { text: 'There’s no live timer or reminder to cancel. These previews never schedule alerts.' };
    const duration = timerDuration(lower);
    if (!/remind|alarm/.test(lower) && (lower.match(/\b(?:seconds?|secs?|minutes?|mins?|hours?|hrs?)\b/g)?.length || 0) > 1) return { text: 'Use one duration for this timer preview, such as 90 minutes.' };
    const reminder = /remind|alarm/.test(lower);
    if (!reminder && !duration) return { text: 'How long should the timer preview be? Include seconds, minutes, or hours.' };
    return { text: reminder ? 'Here’s a reminder preview. No notification has been scheduled.' : `A ${duration} timer preview, mister. No countdown or alert is running.`, receipt: receipt(reminder ? 'reminder' : 'timer', reminder ? 'Reminder · Preview only' : `${duration} · Timer preview`, 'This local demo does not run timers, notifications, or scheduled actions.') };
  }
  if (attachments.length) return { text: `I’ve attached ${attachments.length === 1 ? 'your file' : `your ${attachments.length} files`} to our conversation. This demo keeps files locally; it can’t read or analyze their contents yet.` };
  if (/^(?:hi|hello|hey|good morning|good evening)(?:\s+merlin)?[!.]?$/i.test(text)) return { text: 'At your service, mister. What can I help with at home?' };
  if (/^(?:thanks|thank you|cheers|great|perfect)[!.]?$/i.test(text)) return { text: 'A pleasure, mister.' };
  if (/\b(?:who are you|what can you do|help me|get started|how does this work)\b/.test(lower)) return { text: 'I’m MERLIN, your home companion. Try saving a preference, checking the sample calendar, or controlling demo lights. Text and voice share the same local memory.' };
  if (/\b(?:weather|forecast|news|stock|price|score)\b/.test(lower)) return { text: 'I don’t have live information in this local demo. A connected MERLIN will look that up for you.' };
  if (/\b(?:oven|unlock|door|camera|send|email|message|buy|purchase|routine|schedule|call|connect|disconnect)\b/.test(lower)) return { text: 'That action isn’t available in this local demo. You can try demo lights, a sample calendar, and shared memory.' };
  if (/\b(?:boil|boiling)\b/.test(lower) && /\bwater\b/.test(lower)) return { text: 'Water boils at about 100°C or 212°F at sea level. At higher altitudes, it boils at a lower temperature.' };
  if (/\b(?:how many|what is|what's)\b.*\bminutes?\b.*\bhour\b/.test(lower)) return { text: 'There are 60 minutes in an hour, mister.' };
  if (/\b(?:i ?pad|same assistant|sync|memory shared)\b/.test(lower)) return { text: 'Text and voice share memory on this phone demo. Connection to the home assistant and iPad will come later.' };
  return { text: 'I’m running a small local demo, mister. Try “Remember I like the lights warm,” “Turn on the lights,” or “What’s on my calendar today?”' };
}

export function respond(state, text, { channel = 'text', attachments = [], now = new Date().toISOString() } = {}) {
  if (!plainObject(state) || state.version !== STATE_VERSION) throw new TypeError('Use createInitialState() or normalizeState() before responding.');
  if (typeof text !== 'string' || text.length > MAX_MESSAGE_LENGTH) throw new RangeError(`Messages must be strings up to ${MAX_MESSAGE_LENGTH} characters.`);
  const content = cleanText(text);
  const files = normalizeAttachments(attachments);
  if (!content && !files.length) throw new TypeError('Enter a message or attach a file.');
  const activeChannel = channel === 'voice' ? 'voice' : 'text';
  const createdAt = stamp(now);
  const userMessage = { id: nextId(state), role: 'user', text: content, channel: activeChannel, createdAt, attachments: files };
  const result = answer(state, content, activeChannel, files, userMessage.id, createdAt);
  if (result.redactUserText) userMessage.text = 'Forget a saved memory';
  const assistantMessage = { id: nextId(state), role: 'assistant', text: result.text, channel: activeChannel, createdAt, attachments: [], ...(result.receipt ? { receipt: result.receipt } : {}), ...(result.memoryIds ? { memoryIds: result.memoryIds } : {}) };
  state.messages.push(userMessage, assistantMessage);
  return { text: result.text, ...(result.receipt ? { receipt: result.receipt } : {}), ...(result.clearedHistory ? { clearedHistory: true } : {}), state, userMessage, assistantMessage };
}
