import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ACKNOWLEDGMENT_DIRECTORY, ACKNOWLEDGMENT_LINES, acknowledgmentTiming, activeRms, durationMs, eligibleAcknowledgments,
  isAcknowledgmentEcho, leadingSilenceMs, loadAcknowledgmentCatalog, validateAcknowledgmentAssets, wavSamples,
} from '../src/acknowledgments.js';
import { normalizeRule } from '../src/memory-rules.js';
import { personalityContext } from '../src/personality.js';
import { companionAsset } from '../src/companion.js';

const ROOT = new URL('../', import.meta.url).pathname;
const catalog = { version: 'v1', clips: ACKNOWLEDGMENT_LINES.map(({ id, text }) => ({ id, text })) };
const ALL = ACKNOWLEDGMENT_LINES.map(line => line.id);
const rule = (kind, value, extra = {}) => ({ ...normalizeRule({ kind, value, scope: 'assistant_reply', original: 'Synthetic instruction.', source_id: 'manual', source_quote: '', explanation: 'Synthetic fixture.' }), ...extra });
const warm = (settings = {}, message = 'Plan my week') => personalityContext({ settings: { style: 'warm', address: '', ...settings }, message });
const allowed = ({ rules = [], policy = warm(), message = 'Plan my week', facts = [], pending = [] } = {}) =>
  eligibleAcknowledgments({ catalog, rules, policy, message, facts, pending }).clips;

test('the owner default allows all five lines, and nothing is added to them', () => {
  assert.deepEqual(allowed(), ALL);
  assert.equal(eligibleAcknowledgments({ catalog, policy: warm(), message: 'Plan my week' }).version, 'v1');
});

test('no line carries a form of address, so every address setting keeps all five', () => {
  assert.ok(ACKNOWLEDGMENT_LINES.every(line => !/\b(?:mister|sir)\b/iu.test(line.text)));
  assert.deepEqual(allowed({ policy: warm({ address: 'Captain' }) }), ALL, 'no custom name is invented or synthesized');
  assert.deepEqual(allowed({ policy: warm({ address: 'mister' }) }), ALL, 'an older saved address does not need to be spoken');
});

test('plain style and calm turns get silence', () => {
  assert.deepEqual(allowed({ policy: warm({ style: 'plain' }) }), []);
  const message = 'This is an emergency, I am scared';
  assert.deepEqual(allowed({ policy: warm({}, message), message }), []);
});

test('word and phrase bans remove exactly the lines containing them', () => {
  assert.deepEqual(allowed({ rules: [rule('avoid_word', 'mister')] }), ALL);
  assert.deepEqual(allowed({ rules: [rule('avoid_word', 'right')] }), ['ack_03', 'ack_04', 'ack_05']);
  assert.deepEqual(allowed({ rules: [rule('avoid_word', 'sure')] }), ['ack_01', 'ack_02', 'ack_03', 'ack_04'], '"Sure thing" is the only sure');
  assert.deepEqual(allowed({ rules: [rule('avoid_phrase', 'work on that')] }), ['ack_03', 'ack_04', 'ack_05']);
  assert.deepEqual(allowed({ rules: [rule('avoid_word', 'right'), rule('avoid_word', 'bet'), rule('avoid_word', 'let')] }), []);
});

test('a checker that would change the recorded words makes the recording non-compliant', () => {
  assert.deepEqual(allowed({ rules: [rule('response_prefix', 'Status:')] }), [], 'a required prefix is not in the audio');
  assert.deepEqual(allowed({ rules: [rule('response_suffix', 'Over.')] }), []);
  assert.deepEqual(allowed({ rules: [rule('address_as', 'Captain')] }), []);
  assert.deepEqual(allowed({ rules: [rule('address_as', 'mister')] }), [], 'even a matching address would be prepended to these lines');
});

test('conflicting framing stays silent instead of choosing a winner', () => {
  assert.deepEqual(allowed({ rules: [rule('address_as', 'Captain', { id: 'a' }), rule('address_as', 'Chief', { id: 'b' })] }), []);
  assert.deepEqual(allowed({ rules: [rule('response_prefix', 'Status:', { id: 'a' }), rule('avoid_word', 'Status', { id: 'b' })] }), []);
});

test('inactive rules do not restrict anything, and eligibility follows the current rules on each call', () => {
  assert.deepEqual(allowed({ rules: [rule('avoid_word', 'right', { status: 'deleted' })] }), ALL);
  const rules = [];
  assert.deepEqual(allowed({ rules }), ALL);
  rules.push(rule('avoid_word', 'right'));
  assert.deepEqual(allowed({ rules }), ['ack_03', 'ack_04', 'ack_05']);
  rules.length = 0;
  assert.deepEqual(allowed({ rules }), ALL);
});

test('a recently used opening is not repeated by a clip', () => {
  const policy = { ...warm(), recent_openings: ['you_bet', 'you_got_it'] };
  assert.deepEqual(allowed({ policy }), ['ack_02', 'ack_03', 'ack_05']);
});

test('broad instructions that cannot be checked locally silence the optional filler', () => {
  const fact = (kind, content, status = 'active') => ({ kind, content, status });
  assert.deepEqual(allowed({ facts: [fact('guidance', 'Keep the kitchen topics gentle.')] }), []);
  assert.deepEqual(allowed({ facts: [fact('preference', 'Prefers brief answers.')] }), []);
  assert.deepEqual(allowed({ facts: [fact('preference', 'Likes jasmine tea.'), fact('fact', 'Lives near a park.')] }), ALL);
  assert.deepEqual(allowed({ facts: [fact('guidance', 'Old guidance.', 'superseded')] }), ALL);
  assert.deepEqual(allowed({ pending: [{ kind: 'fact' }] }), [], 'v2 conversation state may be guidance it cannot read');
  assert.deepEqual(allowed({ pending: [{ kind: 'statement' }] }), []);
  assert.deepEqual(allowed({ pending: [{ kind: 'something new' }] }), [], 'an unknown note stays silent');
  assert.deepEqual(allowed({ pending: [{ kind: 'rule' }] }), ALL, 'a pending rule is already in the checked rules');
});

test('only whole words about speech count, so a speaker or a chore does not silence the clips', () => {
  const fact = (kind, content) => ({ kind, content, status: 'active' });
  for (const content of ['User wants a workout routine that turns on the gym speakers.', 'Sam is responsible for the recycling.', 'Keeps the briefcase by the door.', 'Wants the speakerphone on for calls.']) {
    assert.deepEqual(allowed({ facts: [fact('preference', content)] }), ALL, content);
  }
  for (const content of ['Prefers brief answers.', 'Wants MERLIN to speak more slowly.', 'Likes shorter responses.', 'Keep it quiet after nine.', 'Do not say good night.', 'Call me Sam.', 'Less talking, please.']) {
    assert.deepEqual(allowed({ facts: [fact('preference', content)] }), [], content);
  }
});

test('v2 conversation notes silence the clips only when they read as being about speech', () => {
  for (const pending of [[{ kind: 'statement', quote: 'Actually, make the timer ten minutes.' }], [{ kind: 'statement', quote: 'Turn on the gym speakers tonight.' }],
    [{ kind: 'statement', quote: "From now on whenever I say I'm going to work out, turn on the gym lights." }], [{ kind: 'statement', quote: 'If we say movie time, dim the lights.' }],
    [{ kind: 'fact', fact_kind: 'preference', content: 'Wants the gym speakers on for workouts.' }], [{ kind: 'fact', fact_kind: 'fact', content: 'Lives near a park.' }]]) {
    assert.deepEqual(allowed({ pending }), ALL, JSON.stringify(pending));
  }
  for (const pending of [[{ kind: 'statement', quote: "Don't say that anymore." }], [{ kind: 'statement', quote: 'Stop calling me mister.' }],
    [{ kind: 'statement', quote: "When I say tea, say 'brewing' and nothing else." }], [{ kind: 'statement', quote: 'I said never talk during the movie.' }],
    [{ kind: 'statement', quote: 'Actually, use a calmer tone tonight.' }], [{ kind: 'fact', fact_kind: 'guidance', content: 'Keep the kitchen topics gentle.' }],
    [{ kind: 'fact', fact_kind: 'preference', content: 'Prefers brief answers.' }], [{ kind: 'fact', fact_kind: 'mystery', content: 'Anything.' }]]) {
    assert.deepEqual(allowed({ pending }), [], JSON.stringify(pending));
  }
});

test('thanks, greetings and requests about how MERLIN talks get no canned line', () => {
  for (const message of ['Thanks', 'thank you so much', 'Hello', 'hi there', 'Good morning', 'yes', 'Never mind.', 'stop',
    'Stop calling me mister', 'Please use a plain tone', 'Do not say right away anymore', 'Call me Captain']) {
    assert.deepEqual(allowed({ message }), [], message);
  }
  for (const message of ['Start a tea timer', 'What is on my schedule?', 'Look up the weather']) assert.deepEqual(allowed({ message }), ALL, message);
});

test('echo detection matches only words from a recorded line', () => {
  for (const text of ["You got it. I'll work on that right now.", 'you got it ill work on that right now', 'You got it, I’ll work on that',
    'Let me see what I can do for you.', 'give me a moment to work through', "I'm on it", 'You got it', 'Sure thing, let me see what I can do for you..',
    // Variations real transcription produced from these lines and their earlier recordings: a changed spelling, a doubled word, the old "mister" wording.
    "Alright, I'll get to work on that right away.", "Let me take a look at at that. I'm on it.:", "You got it, mister. I'll work on that right now."]) assert.equal(isAcknowledgmentEcho(text, catalog), true, text);
  for (const text of ['Start a tea timer', 'right now', 'can you get that done for me', 'set a timer and work on that thing tomorrow please', "You got it. I'll work on that right now. Also start a timer.", '']) assert.equal(isAcknowledgmentEcho(text, catalog), false, text);
  assert.equal(isAcknowledgmentEcho("You got it. I'll work on that right now.", null), false);
});

test('the catalog fails closed on missing files, invented lines and altered words', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'merlin-ack-catalog-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(await loadAcknowledgmentCatalog(directory), null);
  await writeFile(join(directory, 'manifest.json'), 'not json');
  assert.equal(await loadAcknowledgmentCatalog(directory), null);
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ version: 'x', clips: [{ id: 'ack_01', text: 'Done. Timer set.' }, { id: 'ack_99', text: 'New line.' }, { id: 'ack_02', text: ACKNOWLEDGMENT_LINES[1].text }] }));
  assert.deepEqual((await loadAcknowledgmentCatalog(directory)).clips.map(clip => clip.id), ['ack_02']);
});

test('timing defaults are configurable within bounds', () => {
  assert.deepEqual(acknowledgmentTiming({}), { grace_ms: 1000, cooldown_ms: 3000 }, 'about a second before the first phrase');
  assert.deepEqual(acknowledgmentTiming({ MERLIN_ACK_GRACE_MS: '350', MERLIN_ACK_COOLDOWN_MS: '0' }), { grace_ms: 350, cooldown_ms: 0 });
  assert.deepEqual(acknowledgmentTiming({ MERLIN_ACK_GRACE_MS: 'soon', MERLIN_ACK_COOLDOWN_MS: '-1' }), { grace_ms: 1000, cooldown_ms: 3000 });
});

test('all five real recordings match the manifest, the exact lines and the configured voice', async () => {
  const { problems, manifest } = await validateAcknowledgmentAssets();
  assert.deepEqual(problems, []);
  assert.deepEqual(manifest.clips.map(({ id, text }) => ({ id, text })), ACKNOWLEDGMENT_LINES.map(({ id, text }) => ({ id, text })));
  assert.equal(manifest.generation.voice, 'am_fenrir');
  assert.equal(manifest.generation.delivery, 'natural');
  assert.equal(manifest.generation.speed, 1);
  assert.equal((await loadAcknowledgmentCatalog()).version, manifest.version);
  const levels = [];
  for (const clip of manifest.clips) {
    const samples = wavSamples(await readFile(join(ACKNOWLEDGMENT_DIRECTORY, clip.path)));
    assert.equal(durationMs(samples), clip.duration_ms);
    assert.ok(leadingSilenceMs(samples) < 60, `${clip.id} starts promptly`);
    levels.push(activeRms(samples));
  }
  const spread = 20 * Math.log10(Math.max(...levels) / Math.min(...levels));
  assert.ok(spread < 1.5, `speech levels stay within ${spread.toFixed(2)} dB`);
});

test('asset validation catches changed audio, wrong words and silent files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'merlin-ack-assets-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(ACKNOWLEDGMENT_DIRECTORY, directory, { recursive: true });
  const wav = await readFile(join(directory, 'ack_02.wav'));
  wav[wav.length - 3] ^= 0xff;
  await writeFile(join(directory, 'ack_02.wav'), wav);
  await rm(join(directory, 'ack_03.wav'));
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  manifest.clips[3].text = 'You bet. Done.';
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  const { problems } = await validateAcknowledgmentAssets(directory);
  assert.ok(problems.some(problem => problem.includes('ack_02 audio does not match')));
  assert.ok(problems.some(problem => problem.includes('ack_03 audio is missing')));
  assert.ok(problems.some(problem => problem.includes('ack_04 has different recorded words')));
  assert.ok(problems.some(problem => problem.includes('version')));
});

test('the page can fetch the files as audio, and only from the companion folder', async () => {
  const asset = await companionAsset(ROOT, '/companion/acknowledgments/ack_01.wav');
  assert.equal(asset.type, 'audio/wav');
  assert.equal(asset.content.toString('ascii', 0, 4), 'RIFF');
  assert.equal((await companionAsset(ROOT, '/companion/acknowledgments/manifest.json')).type, 'application/json');
  assert.equal(await companionAsset(ROOT, '/companion/acknowledgments/../../../.env'), null);
});
