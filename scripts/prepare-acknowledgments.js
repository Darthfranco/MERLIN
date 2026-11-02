// Generates the five prerecorded acknowledgments once with the local Fenrir voice.
// Usage: npm run prepare:acknowledgments [-- --force | --check]
// VOICE_PYTHON and VOICE_MODEL_DIR can point at an existing setup, for example from a worktree.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ACKNOWLEDGMENT_DIRECTORY, ACKNOWLEDGMENT_LINES, MAX_LEADING_SILENCE_MS, SILENCE_THRESHOLD,
  activeRms, durationMs, leadingSilenceMs, manifestVersion, validateAcknowledgmentAssets, wavOf, wavSamples,
} from '../src/acknowledgments.js';
import { prepareSpokenReply } from '../src/spoken-replies.js';
import { KOKORO_VOICE, KokoroTts } from '../src/voice/kokoro.js';
import { DEFAULT_SPEECH_DELIVERY } from '../src/voice/prosody.js';

const LEAD_IN_MS = 20, TAIL_MS = 150, FADE_MS = 5, PEAK_LIMIT = 32000;
const SETTINGS = {
  engine: 'kokoro', model: 'hexgrad/Kokoro-82M', model_revision: 'f3ff3571791e39611d31c381e3a41a3af07b4987',
  voice: KOKORO_VOICE, delivery: DEFAULT_SPEECH_DELIVERY, speed: 1, sample_rate: 24000,
  processing: { lead_in_ms: LEAD_IN_MS, tail_ms: TAIL_MS, fade_ms: FADE_MS, loudness: 'speech RMS matched to the median of the set; no music or effects' },
};

function trimmed(samples) {
  const loud = sample => Math.abs(sample) > SILENCE_THRESHOLD;
  const first = samples.findIndex(loud);
  if (first < 0) throw new Error('The voice produced silence.');
  let last = samples.length - 1;
  while (!loud(samples[last])) last--;
  const start = Math.max(0, first - LEAD_IN_MS * 24), end = Math.min(samples.length, last + 1 + TAIL_MS * 24);
  const result = samples.slice(start, end);
  // Removing silence can leave an edge off zero; a few milliseconds of fade prevents a click.
  const fade = FADE_MS * 24;
  for (let index = 0; index < fade && index < result.length; index++) {
    result[index] = Math.round(result[index] * index / fade);
    result[result.length - 1 - index] = Math.round(result[result.length - 1 - index] * index / fade);
  }
  return result;
}

function leveled(samples, target) {
  const peak = samples.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0);
  const gain = Math.min(target / activeRms(samples), PEAK_LIMIT / peak);
  return samples.map(sample => Math.round(sample * gain));
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const report = clips => { for (const clip of clips) console.log(`${clip.id}  ${(clip.duration_ms / 1000).toFixed(2)} s  ${clip.text}`); };

const args = new Set(process.argv.slice(2));
const current = await validateAcknowledgmentAssets();
if (args.has('--check')) {
  if (current.problems.length) { for (const problem of current.problems) console.error(problem); process.exit(1); }
  report(current.manifest.clips);
  console.log('All five clips match the manifest.');
  process.exit(0);
}
if (!args.has('--force') && !current.problems.length) {
  report(current.manifest.clips);
  console.log('Already prepared; nothing was generated. Use --force to record them again.');
  process.exit(0);
}

for (const line of ACKNOWLEDGMENT_LINES) {
  if (prepareSpokenReply(line.text) !== line.text) throw new Error(`Speech formatting would change ${line.id}.`);
}
const tts = new KokoroTts(process.env.VOICE_MODEL_DIR ? { modelDirectory: process.env.VOICE_MODEL_DIR } : {});
if (!tts.status().configured) {
  // Never substitute silent WAVs or browser speech: without the real voice, nothing is prepared.
  console.error('The local Fenrir voice is not set up, so no clips were generated. Run npm run setup:voice, then try again.');
  process.exit(1);
}
try {
  const raw = [];
  for (const line of ACKNOWLEDGMENT_LINES) {
    raw.push(trimmed(wavSamples(await tts.synthesize(line.text, { delivery: SETTINGS.delivery, speed: SETTINGS.speed }))));
    console.log(`Recorded ${line.id}.`);
  }
  const levels = raw.map(activeRms).sort((a, b) => a - b);
  const target = levels[Math.floor(levels.length / 2)];
  await mkdir(ACKNOWLEDGMENT_DIRECTORY, { recursive: true });
  const clips = [];
  for (const [index, line] of ACKNOWLEDGMENT_LINES.entries()) {
    const samples = leveled(raw[index], target), wav = wavOf(samples), path = `${line.id}.wav`;
    if (leadingSilenceMs(samples) > MAX_LEADING_SILENCE_MS) throw new Error(`${line.id} still starts with too much silence.`);
    await writeFile(join(ACKNOWLEDGMENT_DIRECTORY, path), wav);
    clips.push({ id: line.id, text: line.text, path, duration_ms: durationMs(samples), bytes: wav.length, sha256: sha256(wav) });
  }
  const manifest = { schema: 1, version: manifestVersion(clips), generation: SETTINGS, clips };
  await writeFile(join(ACKNOWLEDGMENT_DIRECTORY, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  report(clips);
  const outside = clips.filter(clip => clip.duration_ms < 2000 || clip.duration_ms > 4000);
  if (outside.length) console.log(`Outside the two-to-four-second aim, kept untruncated: ${outside.map(clip => clip.id).join(', ')}.`);
  const { problems } = await validateAcknowledgmentAssets();
  if (problems.length) throw new Error(problems.join(' '));
  console.log('Five clips prepared and validated against the manifest.');
} finally { tts.close(); }
