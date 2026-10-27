import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError } from '../errors.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const LISTENER_SAMPLE_RATE = 16000;
export const MAX_LISTENER_FRAME_BYTES = 16000;
const MODEL_FILES = [
  'encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
  'decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
  'joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
  'tokens.txt', 'keywords.txt', 'silero_vad.onnx',
];

function workerEnvironment() {
  const inherited = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SYSTEMROOT', 'WINDIR', 'LANG', 'LC_ALL', 'LC_CTYPE'];
  return {
    ...Object.fromEntries(inherited.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])),
    HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1',
    DO_NOT_TRACK: '1', PYTHONNOUSERSITE: '1',
  };
}

function validatedResult(message, expectedSample, previousSample) {
  if (message?.sample !== expectedSample || typeof message.speech !== 'boolean' ||
      !Array.isArray(message.events) || message.events.length > 64) return null;
  const events = [];
  let last = Math.max(0, previousSample - 511);
  for (const event of message.events) {
    if (!event || !['wake', 'speech_start', 'speech_end'].includes(event.type) ||
        !Number.isSafeInteger(event.sample) || event.sample < last || event.sample > expectedSample) return null;
    last = event.sample;
    const clean = { type: event.type, sample: event.sample };
    const required = event.type === 'wake' ? ['startSample', 'endSample'] : event.type === 'speech_start' ? ['startSample'] : ['endSample'];
    for (const key of required) {
      if (!Number.isSafeInteger(event[key]) || event[key] < 0 || event[key] > event.sample) return null;
      clean[key] = event[key];
    }
    if (event.type === 'wake' && event.startSample > event.endSample) return null;
    events.push(clean);
  }
  // A fixed schema prevents input-derived diagnostics or unexpected transcripts
  // from crossing the detection boundary, even if a worker misbehaves.
  return { sample: message.sample, speech: message.speech, events };
}

/** One local detector, bounded frames, no recordings, transcripts, or frame queue. */
export class LocalVoiceListener {
  constructor({
    pythonPath = process.env.VOICE_PYTHON || join(ROOT, 'local/voice-venv/bin/python'),
    modelDirectory = join(ROOT, 'local/voice-listener-model'),
    timeoutMs = 5000,
    startupTimeoutMs = 30_000,
    spawnImpl = spawn,
    existsImpl = existsSync,
  } = {}) {
    this.pythonPath = pythonPath;
    this.modelDirectory = modelDirectory;
    this.timeoutMs = timeoutMs;
    this.startupTimeoutMs = startupTimeoutMs;
    this.spawn = spawnImpl;
    this.exists = existsImpl;
    this.worker = null;
    this.pending = null;
    this.ready = false;
    this.sample = 0;
  }

  status() {
    return {
      configured: this.exists(this.pythonPath) && MODEL_FILES.every(file => this.exists(join(this.modelDirectory, file))),
      ready: this.ready, busy: Boolean(this.pending), wakeWord: 'MERLIN', sampleRate: LISTENER_SAMPLE_RATE,
      localOnly: true,
    };
  }

  async start({ signal } = {}) {
    if (signal?.aborted) throw new AppError('Listening was stopped.', 499);
    if (!this.ready) await this.#request({ type: 'reset' }, { signal, expectedSample: 0 });
    return this.status();
  }

  async process(pcm, { keywordEnabled = true, signal } = {}) {
    if (!Buffer.isBuffer(pcm) || pcm.length < 2 || pcm.length > MAX_LISTENER_FRAME_BYTES || pcm.length % 2) {
      throw new AppError('Send a mono PCM16 audio frame of at most half a second.');
    }
    if (typeof keywordEnabled !== 'boolean') throw new AppError('Choose whether wake-word detection is enabled.');
    return this.#request({ type: 'audio', pcm: pcm.toString('base64'), keywordEnabled }, {
      signal, expectedSample: this.sample + pcm.length / 2,
    });
  }

  async reset({ signal } = {}) {
    return this.#request({ type: 'reset' }, { signal, expectedSample: 0 });
  }

  #request(payload, { signal, expectedSample }) {
    if (signal?.aborted) return Promise.reject(new AppError('Listening was stopped.', 499));
    if (this.pending) return Promise.reject(new AppError('The local listener is busy. Wait for the previous frame.', 409));
    if (!this.status().configured) return Promise.reject(new AppError('Set up local listening with npm run setup:voice, then try again.', 503));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const onAbort = () => this.#stop(new AppError('Listening was stopped.', 499));
      const timeout = this.ready ? this.timeoutMs : this.startupTimeoutMs;
      const timer = setTimeout(() => this.#stop(new AppError('The local listener timed out. Enable listening again.', 504)), timeout);
      this.pending = {
        id, expectedSample, previousSample: payload.type === 'reset' ? 0 : this.sample, resolve, reject,
        cleanup: () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); },
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) return onAbort();
      try {
        if (!this.worker) this.#spawn();
        this.worker.stdin.write(`${JSON.stringify({ id, ...payload })}\n`, error => {
          if (error && this.pending?.id === id) this.#stop(new AppError('The local listener stopped. Enable listening again.', 503));
        });
      } catch {
        this.#stop(new AppError('The local listener could not start. Run npm run setup:voice.', 503));
      }
    });
  }

  #spawn() {
    const worker = this.spawn(this.pythonPath, ['-u', join(ROOT, 'scripts/voice-listener.py'), '--model-dir', this.modelDirectory], {
      cwd: ROOT, env: workerEnvironment(), stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.worker = worker;
    let buffered = '';
    worker.stdout.setEncoding('utf8');
    worker.stdout.on('data', chunk => {
      if (this.worker !== worker) return;
      buffered += chunk;
      if (buffered.length > 16000) return this.#stop(new AppError('The local listener returned an invalid response.', 502));
      let end;
      while ((end = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 1);
        let message;
        try { message = JSON.parse(line); }
        catch { return this.#stop(new AppError('The local listener returned an invalid response.', 502)); }
        if (message?.type === 'ready') { this.ready = true; continue; }
        if (message?.type === 'fatal') return this.#stop(new AppError('The local listener could not load. Run npm run setup:voice.', 503));
        const pending = this.pending;
        if (!pending || message?.id !== pending.id || message.error) {
          return this.#stop(new AppError('Local speech detection failed. Enable listening again.', 502));
        }
        const result = validatedResult(message, pending.expectedSample, pending.previousSample);
        if (!result) return this.#stop(new AppError('The local listener returned an invalid response.', 502));
        this.sample = result.sample;
        this.#finish(null, result);
      }
    });
    // Library diagnostics can contain input-derived data: discard them entirely.
    worker.stderr.resume();
    worker.stdin.on('error', () => { if (this.worker === worker) this.#stop(new AppError('The local listener stopped. Enable listening again.', 503)); });
    worker.on('error', () => { if (this.worker === worker) this.#stop(new AppError('The local listener could not start. Run npm run setup:voice.', 503)); });
    worker.on('exit', () => { if (this.worker === worker) this.#stop(new AppError('The local listener stopped. Enable listening again.', 503)); });
  }

  #finish(error, result) {
    const pending = this.pending;
    this.pending = null;
    if (!pending) return;
    pending.cleanup();
    if (error) pending.reject(error);
    else pending.resolve(result);
  }

  #stop(error) {
    const worker = this.worker;
    this.worker = null;
    this.ready = false;
    this.sample = 0;
    worker?.kill('SIGKILL');
    this.#finish(error);
  }

  close() { this.#stop(new AppError('Listening was stopped.', 499)); }
}
