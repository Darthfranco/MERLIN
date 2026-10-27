import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AppError, objectArgs } from './errors.js';
import { MetaTranscriber } from './voice/meta.js';
import { KokoroTts } from './voice/kokoro.js';
import { LocalVoiceListener } from './voice/listener.js';
import { attachVoiceSocket } from './voice/transport.js';
import { validateSpeechDelivery } from './voice/prosody.js';
import { VOICE_SESSION_LIMITS } from './voice/session.js';
import { MAX_AUDIO_BYTES, MAX_RECORDING_SECONDS, MAX_TEXT_CHARACTERS, validateWav } from './voice/audio.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/voice.css', ['voice.css', 'text/css; charset=utf-8']],
  ['/voice.js', ['voice.js', 'text/javascript; charset=utf-8']],
  ['/recorder-worklet.js', ['recorder-worklet.js', 'text/javascript; charset=utf-8']],
]);

async function readBody(request, limit) {
  if (Number(request.headers['content-length']) > limit) throw new AppError('Request is too large.', 413);
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new AppError('Request is too large.', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function createVoiceApp({
  meta = new MetaTranscriber({ apiKey: process.env.META_API_KEY || process.env.MODEL_API_KEY }),
  tts = new KokoroTts(),
  listener = new LocalVoiceListener(),
} = {}) {
  const pending = new Set();
  let transcribing = false;
  let speaking = false;
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'microphone=(self), camera=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; img-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    req.once('aborted', abort);
    res.once('close', abort);
    const json = (status, value) => {
      if (res.destroyed) return;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    };
    try {
      const port = server.address()?.port;
      if (![`localhost:${port}`, `127.0.0.1:${port}`].includes(req.headers.host)) throw new AppError('Only local access is allowed.', 403);
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) throw new AppError('Cross-origin requests are not allowed.', 403);
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new AppError('Cross-site requests are not allowed.', 403);
      const { pathname } = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && FILES.has(pathname)) {
        const [name, type] = FILES.get(pathname);
        const content = await readFile(join(ROOT, 'public', 'voice', name));
        res.writeHead(200, { 'Content-Type': type }); res.end(content); return;
      }
      if (req.method === 'GET' && pathname === '/api/voice/status') {
        json(200, { metaConfigured: meta.configured, transcriptionModel: meta.model,
          voice: 'am_fenrir', tts: await tts.status(), listener: listener.status(), sessionLimits: VOICE_SESSION_LIMITS,
          limits: { maxTextCharacters: MAX_TEXT_CHARACTERS, maxRecordingSeconds: MAX_RECORDING_SECONDS, maxAudioBytes: MAX_AUDIO_BYTES } });
        return;
      }
      if (req.method === 'POST' && pathname === '/api/voice/transcribe') {
        if (voiceSocket.active) throw new AppError('Turn off local wake mode before using manual recording.', 409);
        if (!/^audio\/wav(?:;|$)/i.test(req.headers['content-type'] || '')) throw new AppError('Send a WAV recording.', 415);
        if (transcribing) throw new AppError('Another recording is being transcribed. Try again when it finishes.', 429);
        transcribing = true; pending.add(controller);
        try {
          const audio = await readBody(req, MAX_AUDIO_BYTES);
          validateWav(audio);
          const start = performance.now();
          const result = await meta.transcribe(audio, { signal: controller.signal });
          json(200, { ...result, elapsedMs: Math.round(performance.now() - start) });
        } finally { transcribing = false; pending.delete(controller); }
        return;
      }
      if (req.method === 'POST' && pathname === '/api/voice/speak') {
        if (voiceSocket.active) throw new AppError('Turn off local wake mode before using typed speech.', 409);
        if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new AppError('Send JSON text.', 415);
        if (speaking) throw new AppError('Fenrir is already generating speech. Try again when it finishes.', 429);
        speaking = true; pending.add(controller);
        try {
          let data;
          try { data = JSON.parse((await readBody(req, 16_384)).toString('utf8')); }
          catch (error) { if (error instanceof AppError) throw error; throw new AppError('Request is not valid JSON.'); }
          objectArgs(data, ['text', 'speed', 'delivery']);
          if (typeof data.text !== 'string' || !data.text.trim() || data.text.length > MAX_TEXT_CHARACTERS) throw new AppError('Enter between 1 and 2,000 characters to speak.');
          const speed = data.speed ?? 1;
          const delivery = validateSpeechDelivery(data.delivery);
          if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0.75 || speed > 1.25) throw new AppError('Speech speed must be between 0.75 and 1.25.');
          const start = performance.now();
          const audio = await tts.synthesize(data.text, { speed, delivery, signal: controller.signal });
          if (controller.signal.aborted || res.destroyed) return;
          res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': audio.length,
            'X-Voice': 'am_fenrir', 'X-Generation-Ms': Math.round(performance.now() - start) });
          res.end(audio);
        } finally { speaking = false; pending.delete(controller); }
        return;
      }
      throw new AppError('Not found.', 404);
    } catch (error) {
      json(error instanceof AppError ? error.status : 500, { error: error instanceof AppError ? error.message : 'The voice lab could not complete this request. Check the local setup and try again.' });
    } finally {
      req.off('aborted', abort); res.off('close', abort);
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  const voiceSocket = attachVoiceSocket({ server, listener, meta, tts, isBusy: () => transcribing || speaking });
  const close = async () => {
    voiceSocket.close();
    listener.close();
    for (const controller of pending) controller.abort();
    await tts.close();
    if (server.listening) await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  };
  return { server, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.VOICE_PORT || 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('VOICE_PORT must be a valid port.');
  const app = createVoiceApp();
  app.server.once('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `Voice port ${port} is in use. Set VOICE_PORT to another port.` : 'The voice lab could not start.');
    process.exitCode = 1;
  });
  app.server.listen(port, '127.0.0.1', () => console.log(`MERLIN Voice Lab: http://127.0.0.1:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { app.close().catch(() => { process.exitCode = 1; }); });
}
