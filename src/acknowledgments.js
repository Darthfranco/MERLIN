import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPureAcknowledgment } from './conversation-intents.js';
import { checkPersonalityDraft, parsePersonalityRequest } from './personality.js';
import { prepareSpokenReply } from './spoken-replies.js';

export const ACKNOWLEDGMENT_DIRECTORY = fileURLToPath(new URL('../public/companion/acknowledgments/', import.meta.url));

/** The owner's exact lines. They acknowledge receipt, never a finished search, connection, or action. */
export const ACKNOWLEDGMENT_LINES = Object.freeze([
  Object.freeze({ id: 'ack_01', text: "You got it. I'll work on that right now." }),
  Object.freeze({ id: 'ack_02', text: "All right, I'll get to work on that right away." }),
  Object.freeze({ id: 'ack_03', text: "Let me take a look at that. I'm on it." }),
  Object.freeze({ id: 'ack_04', text: 'You bet. Give me a moment to work through that.' }),
  Object.freeze({ id: 'ack_05', text: 'Sure thing. Let me see what I can do for you.' }),
]);

// Tunable starting points, not measured latency promises. The owner chose about a second
// of quiet before the first phrase (November 3, 2026); fast answers skip the clip entirely.
export const ACKNOWLEDGMENT_TIMING = Object.freeze({ grace_ms: 1000, cooldown_ms: 3000 });

export function acknowledgmentTiming(env = process.env) {
  const bounded = (value, fallback, maximum) => {
    if (value === undefined || value === '') return fallback;
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 && number <= maximum ? number : fallback;
  };
  return {
    grace_ms: bounded(env.MERLIN_ACK_GRACE_MS, ACKNOWLEDGMENT_TIMING.grace_ms, 5000),
    cooldown_ms: bounded(env.MERLIN_ACK_COOLDOWN_MS, ACKNOWLEDGMENT_TIMING.cooldown_ms, 600_000),
  };
}

export const manifestVersion = clips => createHash('sha256')
  .update(JSON.stringify(clips.map(({ id, text, sha256 }) => [id, text, sha256]))).digest('hex').slice(0, 16);

/** Only a manifest entry whose recorded words still equal the approved line can ever be offered. */
export async function loadAcknowledgmentCatalog(directory = ACKNOWLEDGMENT_DIRECTORY) {
  try {
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
    if (typeof manifest.version !== 'string' || !Array.isArray(manifest.clips)) return null;
    const clips = manifest.clips
      .filter(clip => ACKNOWLEDGMENT_LINES.some(line => line.id === clip?.id && line.text === clip?.text))
      .map(({ id, text }) => ({ id, text }));
    return clips.length ? { version: manifest.version, clips } : null;
  } catch { return null; }
}

// A canned "working on it" line would be wrong for these, so they stay silent. This is a
// small local filter (an agent choice), not a classifier; a false match only costs the filler.
const SOCIAL_ONLY = /^(?:merlin[,\s]+)?(?:hi|hello|hey|yes|yeah|yep|no|nope|ok|okay|sure|good (?:morning|afternoon|evening|night)|goodbye|bye|never ?mind|stop|wait)(?:[,\s]+(?:there|merlin))?[.!?]*$/iu;
// A request about how MERLIN talks should not be answered with the wording it may be objecting to.
const ABOUT_SPEECH = /\b(?:mister|call(?:ing)? me|address(?:ing)? me|say|saying|said|words?|phrases?|wording|filler|acknowledg\w*|tone|style|speak|speaking|talk|talking|quiet|shut up)\b/iu;
// Broad preferences have no exact check, and a model call is not allowed for optional audio.
const SPEECH_PREFERENCE = /answer|respon[ds]|communicat|concise|brief|verbos|filler|acknowledg|wording|talk|speak|speech|\bsay\b|quiet|silent|chatty|call me|address(?:ed)? (?:me|as)/iu;

const uncheckedInstruction = item => item?.status === 'active'
  && (item?.kind === 'guidance' || (item?.kind === 'preference' && SPEECH_PREFERENCE.test(item.content ?? '')));

function recordedWordsPass(text, rules, policy) {
  // A checker that adds a prefix or changes an address describes different words
  // from this recording, so the asset is not compliant. There is no exemption.
  try { return prepareSpokenReply(text, rules) === text && !checkPersonalityDraft(text, policy, rules).length; }
  catch { return false; }
}

/**
 * Trusted local selection at request acceptance. Fails closed: when in doubt the
 * optional filler stays silent, and the ordinary reply is unaffected either way.
 * `pending` is the v2 engine's active conversation state: anything there other than
 * a compiled rule (already in `rules`) may be guidance this code cannot read or check.
 */
export function eligibleAcknowledgments({ catalog, rules = [], policy, message = '', facts = [], pending = [] }) {
  const none = { version: catalog.version, clips: [] };
  // Plain and calm turns omit ceremonial acknowledgments, so no clip fits them.
  if (policy?.style !== 'warm' || policy.calm) return none;
  const text = message.trim();
  if (isPureAcknowledgment(text) || SOCIAL_ONLY.test(text) || ABOUT_SPEECH.test(text) || parsePersonalityRequest(text)) return none;
  if (facts.some(uncheckedInstruction) || pending.some(row => row?.kind !== 'rule')) return none;
  return { version: catalog.version, clips: catalog.clips.filter(clip => recordedWordsPass(clip.text, rules, policy)).map(clip => clip.id) };
}

const words = text => (text.normalize('NFKC').toLowerCase().replace(/['’]/gu, '').match(/[\p{L}\p{N}]+/gu) ?? [])
  .map(word => (word === 'mr' ? 'mister' : word));

function commonWords(a, b) {
  let row = new Array(b.length + 1).fill(0);
  for (const word of a) {
    const next = [0];
    for (let index = 0; index < b.length; index++) next.push(word === b[index] ? row[index] + 1 : Math.max(row[index + 1], next[index]));
    row = next;
  }
  return row[b.length];
}

/**
 * True when a transcript is essentially words from a recorded line, in order: MERLIN hearing
 * itself. Tolerant because real transcription varies ("Alright", "Right, oh", a doubled word).
 * The session only asks while a filler was audible, so a similar request at other times is safe.
 */
export function isAcknowledgmentEcho(text, catalog) {
  const heard = words(text);
  if (heard.length < 3 || !catalog) return false;
  return catalog.clips.some(clip => commonWords(heard, words(clip.text)) >= heard.length * 0.8);
}

// ---- Asset format, shared by the preparation script and its checks ----

export const WAV_HEADER_BYTES = 44;
export const MAX_LEADING_SILENCE_MS = 60;
export const SILENCE_THRESHOLD = 164; // About 0.5% of full scale.

export function wavSamples(wav) {
  const valid = wav.length > WAV_HEADER_BYTES && wav.toString('ascii', 0, 4) === 'RIFF' && wav.toString('ascii', 8, 12) === 'WAVE'
    && wav.readUInt16LE(20) === 1 && wav.readUInt16LE(22) === 1 && wav.readUInt32LE(24) === 24000 && wav.readUInt16LE(34) === 16
    && wav.toString('ascii', 36, 40) === 'data' && wav.readUInt32LE(40) === wav.length - WAV_HEADER_BYTES && wav.length % 2 === 0;
  if (!valid) throw new Error('Expected a 24 kHz mono PCM16 WAV.');
  return new Int16Array(wav.buffer.slice(wav.byteOffset + WAV_HEADER_BYTES, wav.byteOffset + wav.length));
}

export function wavOf(samples) {
  const header = Buffer.alloc(WAV_HEADER_BYTES), bytes = samples.length * 2;
  header.write('RIFF'); header.writeUInt32LE(36 + bytes, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(bytes, 40);
  return Buffer.concat([header, Buffer.from(samples.buffer, samples.byteOffset, bytes)]);
}

export function leadingSilenceMs(samples) {
  const first = samples.findIndex(sample => Math.abs(sample) > SILENCE_THRESHOLD);
  return first < 0 ? samples.length / 24 : first / 24;
}

/** RMS over 20 ms frames that contain speech, so pauses do not read as lower volume. */
export function activeRms(samples) {
  const frame = 480;
  let energy = 0, count = 0;
  for (let start = 0; start + frame <= samples.length; start += frame) {
    let sum = 0;
    for (let index = start; index < start + frame; index++) sum += samples[index] ** 2;
    if (Math.sqrt(sum / frame) > SILENCE_THRESHOLD) { energy += sum; count += frame; }
  }
  return count ? Math.sqrt(energy / count) : 0;
}

export function durationMs(samples) { return Math.round(samples.length / 24); }

/** Every problem with the prepared assets. An empty list means they match the manifest. */
export async function validateAcknowledgmentAssets(directory = ACKNOWLEDGMENT_DIRECTORY) {
  let manifest;
  try { manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')); }
  catch { return { problems: ['manifest.json is missing or unreadable.'], manifest: null }; }
  const problems = [];
  if (!Array.isArray(manifest.clips)) return { problems: ['manifest.json has no clips.'], manifest };
  if (manifest.version !== manifestVersion(manifest.clips)) problems.push('The manifest version does not match its clips.');
  if (manifest.clips.length !== ACKNOWLEDGMENT_LINES.length) problems.push(`Expected ${ACKNOWLEDGMENT_LINES.length} clips.`);
  for (const line of ACKNOWLEDGMENT_LINES) {
    const clip = manifest.clips.find(item => item.id === line.id);
    if (!clip) { problems.push(`${line.id} is missing from the manifest.`); continue; }
    if (clip.text !== line.text) problems.push(`${line.id} has different recorded words.`);
    if (clip.path !== `${line.id}.wav`) problems.push(`${line.id} has an unexpected path.`);
    let wav;
    try { wav = await readFile(join(directory, clip.path)); }
    catch { problems.push(`${line.id} audio is missing.`); continue; }
    if (createHash('sha256').update(wav).digest('hex') !== clip.sha256) { problems.push(`${line.id} audio does not match its hash.`); continue; }
    let samples;
    try { samples = wavSamples(wav); }
    catch { problems.push(`${line.id} is not valid audio.`); continue; }
    if (durationMs(samples) !== clip.duration_ms) problems.push(`${line.id} duration does not match its audio.`);
    if (leadingSilenceMs(samples) > MAX_LEADING_SILENCE_MS) problems.push(`${line.id} starts with too much silence.`);
    if (activeRms(samples) === 0) problems.push(`${line.id} is silent.`);
  }
  return { problems, manifest };
}
