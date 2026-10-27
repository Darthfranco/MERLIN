import { KokoroTts } from '../src/voice/kokoro.js';
import { MetaTranscriber } from '../src/voice/meta.js';

// Deliberately synthetic; no microphone or household store is accessed.
const text = 'Hello. This is a voice test for Merlin.';
const meta = new MetaTranscriber({ apiKey: process.env.META_API_KEY || process.env.MODEL_API_KEY });
const tts = new KokoroTts();
try {
  await meta.checkAccess();
  const start = performance.now();
  const wav = await tts.synthesize(text);
  const generatedMs = Math.round(performance.now() - start);
  const transcript = await meta.transcribe(wav);
  if (!/voice test/i.test(transcript.text) || !/merlin/i.test(transcript.text)) throw new Error('The synthetic phrase was not recognized as expected.');
  console.log(`Fenrir generated ${wav.length} WAV bytes in ${generatedMs} ms. Meta transcribed the synthetic phrase: ${transcript.text}`);
  console.log('Voice round trip passed. This does not verify physical microphone permission or speaker output.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await tts.close();
}
