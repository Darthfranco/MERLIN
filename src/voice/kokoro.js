import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError } from '../errors.js';
import { createSpeechPlan, DEFAULT_SPEECH_DELIVERY, SPEECH_DELIVERIES } from './prosody.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const KOKORO_VOICE = 'am_fenrir';
export const MAX_SPEECH_CHARACTERS = 2000;
const MAX_AUDIO_BYTES = 24000 * 2 * 240 + 44;
const MAX_MESSAGE_BYTES = Math.ceil(MAX_AUDIO_BYTES / 3) * 4 + 1024;

function workerEnvironment() {
  // Python needs local runtime paths/locale, never the parent's provider credentials.
  const inherited = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SYSTEMROOT', 'WINDIR', 'LANG', 'LC_ALL', 'LC_CTYPE'];
  return {
    ...Object.fromEntries(inherited.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])),
    HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1',
    DO_NOT_TRACK: '1', TOKENIZERS_PARALLELISM: 'false', PYTHONNOUSERSITE: '1',
  };
}

export function validateSpeechText(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_SPEECH_CHARACTERS || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
    throw new AppError(`Enter between 1 and ${MAX_SPEECH_CHARACTERS} characters to speak.`);
  }
  return text.trim();
}

function validWav(audio) {
  return audio.length > 44 && audio.length <= MAX_AUDIO_BYTES &&
    audio.toString('ascii', 0, 4) === 'RIFF' && audio.toString('ascii', 8, 12) === 'WAVE' &&
    audio.toString('ascii', 12, 16) === 'fmt ' && audio.readUInt32LE(16) === 16 &&
    audio.readUInt16LE(20) === 1 && audio.readUInt16LE(22) === 1 &&
    audio.readUInt32LE(24) === 24000 && audio.readUInt32LE(28) === 48000 &&
    audio.readUInt16LE(32) === 2 && audio.readUInt16LE(34) === 16 &&
    audio.toString('ascii', 36, 40) === 'data' && audio.readUInt32LE(40) === audio.length - 44 &&
    audio.readUInt32LE(4) === audio.length - 8 && audio.length % 2 === 0;
}

/** One local, persistent CPU worker. Requests are never queued or written to disk. */
export class KokoroTts {
  constructor({
    pythonPath = process.env.VOICE_PYTHON || join(ROOT, 'local/voice-venv/bin/python'),
    modelDirectory = join(ROOT, 'local/voice-model'),
    timeoutMs = 180_000,
    spawnImpl = spawn,
    existsImpl = existsSync,
  } = {}) {
    this.pythonPath = pythonPath;
    this.modelDirectory = modelDirectory;
    this.timeoutMs = timeoutMs;
    this.spawn = spawnImpl;
    this.exists = existsImpl;
    this.worker = null;
    this.pending = null;
    this.ready = false;
  }

  status() {
    return {
      configured: this.exists(this.pythonPath) && ['config.json', 'kokoro-v1_0.pth', 'voices/am_fenrir.pt'].every(file => this.exists(join(this.modelDirectory, file))),
      ready: this.ready,
      busy: Boolean(this.pending),
      model: 'hexgrad/Kokoro-82M',
      voice: KOKORO_VOICE,
      sampleRate: 24000,
      deliveries: SPEECH_DELIVERIES,
      defaultDelivery: DEFAULT_SPEECH_DELIVERY,
    };
  }

  async synthesize(text, { speed = 1, delivery = DEFAULT_SPEECH_DELIVERY, signal } = {}) {
    text = validateSpeechText(text);
    const segments = createSpeechPlan(text, { speed, delivery });
    if (signal?.aborted) throw new AppError('Speech was cancelled.', 499);
    if (this.pending) throw new AppError('Fenrir is busy. Stop the current request or try again shortly.', 409);
    if (!this.status().configured) throw new AppError('Set up the local Fenrir voice with npm run setup:voice, then try again.', 503);

    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const onAbort = () => this.#stop(new AppError('Speech was cancelled.', 499));
      const timer = setTimeout(() => this.#stop(new AppError('Local speech generation timed out. Try a shorter passage.', 504)), this.timeoutMs);
      this.pending = { id, resolve, reject, cleanup: () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); } };
      signal?.addEventListener('abort', onAbort, { once: true });
      // Abort can race with listener registration.
      if (signal?.aborted) return onAbort();
      try {
        if (!this.worker) this.#start();
        this.worker.stdin.write(`${JSON.stringify({ id, text, speed, segments })}\n`, error => {
          if (error && this.pending?.id === id) this.#stop(new AppError('The local voice worker stopped. Try again.', 503));
        });
      } catch {
        this.#stop(new AppError('The local voice worker could not start. Run npm run setup:voice.', 503));
      }
    });
  }

  #start() {
    const worker = this.spawn(this.pythonPath, ['-u', join(ROOT, 'scripts/voice-worker.py'), '--model-dir', this.modelDirectory], {
      cwd: ROOT,
      // Offline inference also avoids accidental model-loader telemetry.
      env: workerEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.worker = worker;
    let buffered = '';
    worker.stdout.setEncoding('utf8');
    worker.stdout.on('data', chunk => {
      if (this.worker !== worker) return;
      buffered += chunk;
      if (buffered.length > MAX_MESSAGE_BYTES) return this.#stop(new AppError('The local voice returned too much audio. Try a shorter passage.', 502));
      let end;
      while ((end = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 1);
        let message;
        try { message = JSON.parse(line); }
        catch { return this.#stop(new AppError('The local voice returned an unreadable response.', 502)); }
        if (message?.type === 'ready') { this.ready = true; continue; }
        if (message?.type === 'fatal') return this.#stop(new AppError('The local voice could not load. Run npm run setup:voice.', 503));
        const pending = this.pending;
        if (!pending || message?.id !== pending.id) return this.#stop(new AppError('The local voice returned an unexpected response.', 502));
        if (message.error) {
          const error = message.error === 'no_speech'
            ? new AppError('That text did not produce speech. Try an English word or sentence.')
            : message.error === 'too_long'
              ? new AppError('That passage produced too much audio. Try a shorter passage.')
              : new AppError('Local speech generation failed. Try a shorter English passage.', 502);
          return this.#finish(error);
        }
        if (typeof message.audio !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/u.test(message.audio)) return this.#stop(new AppError('The local voice returned invalid audio.', 502));
        const audio = Buffer.from(message.audio, 'base64');
        if (!validWav(audio)) return this.#stop(new AppError('The local voice returned invalid audio.', 502));
        this.#finish(null, audio);
      }
    });
    // Dependencies may log input-derived diagnostics. Drain without retaining or printing them.
    worker.stderr.resume();
    worker.stdin.on('error', () => { if (this.worker === worker) this.#stop(new AppError('The local voice worker stopped. Try again.', 503)); });
    worker.on('error', () => { if (this.worker === worker) this.#stop(new AppError('The local voice worker could not start. Run npm run setup:voice.', 503)); });
    worker.on('exit', () => {
      if (this.worker !== worker) return;
      this.worker = null;
      this.ready = false;
      this.#finish(new AppError('The local voice worker stopped. Try again.', 503));
    });
  }

  #finish(error, audio) {
    const pending = this.pending;
    this.pending = null;
    if (!pending) return;
    pending.cleanup();
    if (error) pending.reject(error);
    else pending.resolve(audio);
  }

  #stop(error) {
    const worker = this.worker;
    this.worker = null;
    this.ready = false;
    // Kill inference immediately on disconnect/stop; next request starts a fresh worker.
    worker?.kill('SIGKILL');
    this.#finish(error);
  }

  close() { this.#stop(new AppError('Speech was cancelled.', 499)); }
}
