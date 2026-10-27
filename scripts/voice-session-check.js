import assert from 'node:assert/strict';
import { KokoroTts } from '../src/voice/kokoro.js';
import { MetaTranscriber } from '../src/voice/meta.js';
import { LocalVoiceListener } from '../src/voice/listener.js';
import { VoiceSession } from '../src/voice/session.js';
import { validateWav } from '../src/voice/audio.js';

// Authored synthetic speech only. No microphone, household store, or audio files.
const tts = new KokoroTts();
const provider = new MetaTranscriber({ apiKey: process.env.META_API_KEY || process.env.MODEL_API_KEY });
const listener = new LocalVoiceListener();
const messages = [];
let uploads = 0;
let replies = 0;
let allowUpload = false;
const meta = { configured: provider.configured, transcribe(wav, options) {
  uploads += 1;
  assert.ok(allowUpload, 'Standby audio must never reach transcription.');
  return provider.transcribe(wav, options);
} };
const session = new VoiceSession({ listener, meta, tts,
  send: message => messages.push(message), sendAudio: audio => { validateWav(audio); replies += 1; },
});

function to16k(wav) {
  const { audio, sampleRate } = validateWav(wav);
  const source = audio.subarray(44);
  const count = Math.floor(source.length / 2 * 16000 / sampleRate);
  const pcm = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i += 1) {
    const position = i * sampleRate / 16000;
    const left = Math.floor(position);
    const a = source.readInt16LE(left * 2);
    const b = source.readInt16LE(Math.min(left + 1, source.length / 2 - 1) * 2);
    pcm.writeInt16LE(Math.round(a + (b - a) * (position - left)), i * 2);
  }
  return pcm;
}

async function feed(pcm) {
  const padded = Buffer.concat([Buffer.alloc(16000), pcm, Buffer.alloc(64000)]);
  for (let offset = 0; offset < padded.length; offset += 2560) {
    const frame = Buffer.alloc(2560);
    padded.copy(frame, 0, offset, Math.min(offset + frame.length, padded.length));
    await session.process(frame);
  }
}

try {
  await provider.checkAccess();
  const phrases = ['The blue kettle is ready.', 'Merlin.', 'Merlin, the blue kettle is ready.', 'Please speak a little more gently.'];
  const clips = [];
  for (const phrase of phrases) clips.push(to16k(await tts.synthesize(phrase, { delivery: 'natural' })));
  await session.start({ delivery: 'lively' });
  await feed(clips[0]);
  assert.equal(session.state, 'wake'); assert.equal(uploads, 0);
  console.log('Ordinary speech in standby: zero Meta calls.');
  allowUpload = true;
  await feed(clips[1]);
  await session.work;
  assert.equal(session.state, 'followup'); assert.equal(uploads, 1); assert.equal(replies, 0);
  console.log('Wake-only activation: one short transcription, no spoken echo, waiting for the request.');
  session.sleep();
  await feed(clips[2]);
  await session.work;
  assert.equal(session.state, 'speaking', JSON.stringify(messages.filter(m => m.type === 'error')));
  assert.equal(uploads, 2); assert.equal(replies, 1);
  assert.match(messages.findLast(m => m.type === 'transcript').text, /blue kettle.*ready/i);
  assert.doesNotMatch(messages.findLast(m => m.type === 'transcript').text, /^merlin/i);
  session.playback({ playing: false, revision: session.revision, utteranceId: session.utteranceId });
  await feed(clips[3]);
  await session.work;
  assert.equal(session.state, 'speaking'); assert.equal(uploads, 3); assert.equal(replies, 2);
  assert.match(messages.findLast(m => m.type === 'transcript').text, /more gently/i);
  console.log('MERLIN → speech endpoint → Meta → Fenrir, then follow-up without another wake word: passed.');
  console.log('Three synthetic clips uploaded. This check does not validate room acoustics or physical microphone/speaker echo cancellation.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  session.close();
  await tts.close();
}
