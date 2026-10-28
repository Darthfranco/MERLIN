import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const MODEL_LIST = [
  { id: 'kokoro', name: 'Kokoro · Fenrir', size: '82M', description: 'Your existing voice, kept as the baseline.', source: 'https://huggingface.co/hexgrad/Kokoro-82M' },
  { id: 'pocket', name: 'Pocket TTS', size: '100M', description: 'Small English speech model with reference voice conditioning.', source: 'https://github.com/kyutai-labs/pocket-tts' },
  { id: 'chatterbox', name: 'Chatterbox Nano', size: 'Nano', description: 'Community Core ML conversion with voice conditioning.', source: 'https://github.com/iliasaz/chatterbox-coreml' },
  { id: 'qwen', name: 'Qwen3-TTS Base', size: '0.6B', description: 'The requested Apple Neural Engine conversion.', source: 'https://huggingface.co/tinytrashlabs/Qwen3-TTS-0.6B-Base-ANE' },
];

export function wavInfo(bytes, { reference = false } = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 44 || bytes.length > 24_000_000 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE' || bytes.readUInt32LE(4) + 8 !== bytes.length) throw new Error('Use a valid uncompressed WAV file.');
  let format, dataLength;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const end = offset + 8 + length;
    if (end > bytes.length) throw new Error('The WAV file is incomplete.');
    if (id === 'fmt ' && length >= 16) { if (format) throw new Error('The WAV contains duplicate format chunks.'); format = { type: bytes.readUInt16LE(offset + 8), channels: bytes.readUInt16LE(offset + 10), rate: bytes.readUInt32LE(offset + 12), byteRate: bytes.readUInt32LE(offset + 16), align: bytes.readUInt16LE(offset + 20), bits: bytes.readUInt16LE(offset + 22) }; }
    if (id === 'data') { if (dataLength !== undefined) throw new Error('The WAV contains duplicate audio chunks.'); dataLength = length; }
    offset = end + (length % 2);
  }
  if (!format || !dataLength || format.type !== 1 || format.bits !== 16 || ![1, 2].includes(format.channels) || format.rate < 8000 || format.rate > 48000 || format.align !== format.channels * 2 || format.byteRate !== format.rate * format.align || dataLength % format.align) throw new Error('Use 16-bit PCM WAV audio between 8 and 48 kHz.');
  const durationSeconds = dataLength / format.byteRate;
  if (durationSeconds > (reference ? 30.1 : 120) || durationSeconds < (reference ? 3 : 0.05)) throw new Error(reference ? 'Choose a reference between 3 and 30 seconds.' : 'The generated audio duration is invalid.');
  return { sampleRate: format.rate, durationSeconds };
}

function workerSpec(id) {
  const python = id === 'kokoro' ? join(ROOT, 'local/voice-venv/bin/python') : id === 'pocket' ? join(ROOT, 'local/voice-compare/pocket-env/bin/python') : 'python3';
  return { command: python, args: [join(ROOT, `scripts/voice-compare-${id}.py`)] };
}

function environment() {
  const keys = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'];
  return { ...Object.fromEntries(keys.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])), HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1', PYTHONNOUSERSITE: '1', TOKENIZERS_PARALLELISM: 'false' };
}

export class VoiceWorker {
  constructor(id, { timeoutMs = 600_000 } = {}) { this.id = id; this.timeoutMs = timeoutMs; }
  request(input, signal) {
    if (signal?.aborted) return Promise.reject(new Error('Comparison stopped.'));
    if (this.pending) return Promise.reject(new Error('This model is already running.'));
    const spec = workerSpec(this.id);
    if (!this.child) {
      this.child = spawn(spec.command, spec.args, { cwd: ROOT, env: environment(), stdio: ['pipe', 'pipe', 'pipe'] });
      const child = this.child;
      let buffer = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        if (this.child !== child) return;
        buffer += chunk;
        if (buffer.length > 65536) return this.stop('The model returned an invalid response.');
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          if (!line.trim()) continue;
          try {
            const value = JSON.parse(line);
            if (value.id !== this.pending?.id) throw new Error();
            this.finish(value.ok ? null : new Error(value.error || 'Speech generation failed.'), value);
          } catch { this.stop('The model returned an invalid response.'); }
        }
      });
      // Do not retain text-derived dependency diagnostics or inherit provider credentials.
      child.stderr.resume();
      child.stdin.on('error', () => { if (this.child === child) this.stop('The model worker stopped. Try again.'); });
      child.on('error', () => { if (this.child === child) this.stop(`Set up ${this.id} before running it.`); });
      child.on('exit', () => { if (this.child === child) { this.child = null; this.finish(new Error('The model worker stopped. Try again.')); } });
    }
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const abort = () => this.stop('Comparison stopped.');
      const timeout = setTimeout(() => this.stop('This model timed out after ten minutes. Try a shorter passage.'), this.timeoutMs);
      this.pending = { id, resolve, reject, cleanup: () => { clearTimeout(timeout); signal?.removeEventListener('abort', abort); } };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) return abort();
      this.child.stdin.write(`${JSON.stringify({ ...input, id })}\n`);
    });
  }
  finish(error, result) { const pending = this.pending; this.pending = null; if (pending) { pending.cleanup(); error ? pending.reject(error) : pending.resolve(result); } }
  stop(message = 'Comparison stopped.') { const child = this.child; this.child = null; child?.kill('SIGKILL'); this.finish(new Error(message)); }
}

export async function probeModel(id) {
  const spec = workerSpec(id);
  return new Promise(resolve => {
    const child = spawn(spec.command, [...spec.args, '--probe'], { cwd: ROOT, env: environment() });
    let output = '', finished = false;
    const finish = value => { if (!finished) { finished = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ available: false, reason: 'Setup check timed out. Refresh model status.' }); }, 30_000);
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 65536) child.kill('SIGKILL'); });
    child.stderr.resume();
    child.on('error', () => finish({ available: false, reason: `Run the ${id} setup script.` }));
    child.on('close', () => { try { const result = JSON.parse(output.trim().split('\n').at(-1)); finish({ ...result, available: result.available === true }); } catch { finish({ available: false, reason: `Run the ${id} setup script.` }); } });
  });
}

export class VoiceComparison {
  constructor({ directory = join(ROOT, 'local/voice-compare/data'), createWorker = id => new VoiceWorker(id), probe = probeModel } = {}) {
    this.directory = directory; this.createWorker = createWorker; this.probe = probe;
    this.models = MODEL_LIST.map(model => ({ ...model, available: false, reason: 'Checking local setup…' }));
    this.run = null; this.reference = null; this.job = null; this.worker = null; this.refreshing = null;
  }
  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try { const saved = JSON.parse(await readFile(join(this.directory, 'state.json'), 'utf8')); this.run = saved.run; this.reference = saved.reference; if (this.run?.status === 'running') { this.run.status = 'interrupted'; this.run.results.forEach(result => { if (['running', 'queued'].includes(result.status)) result.status = 'interrupted'; }); } } catch {}
    return this;
  }
  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = Promise.all(MODEL_LIST.map(async model => ({ ...model, ...await this.probe(model.id) }))).then(models => { this.models = models; }).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  snapshot() { return { models: this.models, run: this.run, reference: this.reference, busy: Boolean(this.job || this.mutating), machine: 'This Mac · local inference', maxCharacters: 600 }; }
  async persist() {
    const temporary = join(this.directory, `state-${randomUUID()}.tmp`);
    try { await writeFile(temporary, JSON.stringify({ run: this.run, reference: this.reference }), { mode: 0o600 }); await rename(temporary, join(this.directory, 'state.json')); }
    finally { await rm(temporary, { force: true }); }
  }
  async setReference({ audio, transcript = '', label = 'Custom voice reference' }) {
    if (this.job || this.mutating) throw new Error('Stop the comparison before replacing its reference.');
    if (typeof audio !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(audio) || audio.length > 8_000_000 || typeof transcript !== 'string' || transcript.length > 3000 || typeof label !== 'string' || label.length > 100) throw new Error('The reference is invalid. Use a short audio file and its transcript.');
    const bytes = Buffer.from(audio, 'base64'), info = wavInfo(bytes, { reference: true });
    this.mutating = true;
    try {
      await writeFile(join(this.directory, 'reference.wav'), bytes, { mode: 0o600 });
      this.reference = { label: label.trim() || 'Custom voice reference', transcript: transcript.trim(), ...info };
      await this.persist();
    } finally { this.mutating = false; }
    return this.reference;
  }
  async start({ text, models, passes = 2, useReference = true }) {
    if (this.job || this.mutating) throw new Error('A comparison or reference update is already running.');
    if (typeof text !== 'string' || !text.trim() || text.length > 600 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) throw new Error('Enter between 1 and 600 characters.');
    if (!Array.isArray(models) || !models.length || models.length > 4 || new Set(models).size !== models.length || models.some(id => !MODEL_LIST.some(model => model.id === id)) || ![1, 2].includes(passes) || typeof useReference !== 'boolean') throw new Error('Select at least one model and one or two passes.');
    const id = randomUUID();
    const run = { id, text: text.trim(), startedAt: new Date().toISOString(), status: 'running', reference: useReference ? this.reference?.label || null : null, results: models.flatMap(model => Array.from({ length: passes }, (_, pass) => ({ model, pass, status: 'queued' }))) };
    this.run = run;
    const controller = new AbortController(); this.controller = controller;
    // Set the busy flag before any await so two requests cannot start a competing job.
    const preparation = this.persist();
    this.job = preparation.then(() => this.execute(run, models, passes, useReference, controller.signal)).catch(() => { run.status = 'failed'; run.error = 'The comparison could not save its results. Clear local tests and try again.'; }).finally(() => { this.job = null; this.controller = null; this.worker?.stop(); this.worker = null; });
    return id;
  }
  async execute(run, models, passes, useReference, signal) {
    for (const model of models) {
      if (signal.aborted) break;
      this.worker = this.createWorker(model);
      for (let pass = 0; pass < passes; pass++) {
        if (signal.aborted) break;
        const result = run.results.find(result => result.model === model && result.pass === pass);
        const filename = `${run.id}-${model}-${pass}.wav`;
        const outputPath = join(this.directory, filename);
        result.status = 'running'; result.startedAt = new Date().toISOString(); await this.persist();
        const start = performance.now();
        try {
          if (!this.models.find(item => item.id === model)?.available) throw new Error(this.models.find(item => item.id === model)?.reason || 'This model is not set up.');
          const reference = useReference && this.reference && model !== 'kokoro' ? { referencePath: join(this.directory, 'reference.wav'), referenceText: this.reference.transcript } : {};
          const output = await this.worker.request({ text: run.text, outputPath, ...reference }, signal);
          const wallMs = performance.now() - start;
          if (signal.aborted) throw new Error('Comparison stopped.');
          const info = wavInfo(await readFile(outputPath));
          for (const key of ['loadMs', 'preparationMs', 'synthesisMs']) if (!Number.isFinite(output[key]) || output[key] < 0) throw new Error('The model returned invalid timing data.');
          Object.assign(result, { status: 'complete', ...info, wallMs, loadMs: output.loadMs, preparationMs: output.preparationMs, synthesisMs: output.synthesisMs, firstAudioMs: Number.isFinite(output.firstAudioMs) && output.firstAudioMs >= 0 ? output.firstAudioMs : null, runtime: String(output.runtime || ''), voiceMode: String(output.voiceMode || ''), audioUrl: `/audio/${filename}`, realtimeFactor: output.synthesisMs / (info.durationSeconds * 1000) });
        } catch (error) {
          Object.assign(result, { status: signal.aborted ? 'cancelled' : 'failed', error: String(error.message || 'Generation failed.').slice(0, 500), wallMs: performance.now() - start });
          await rm(outputPath, { force: true });
          // The second pass can only be called warm after a successful first pass.
          if (!pass && passes === 2) Object.assign(run.results.find(item => item.model === model && item.pass === 1), { status: 'skipped', error: 'First pass did not complete.' });
          break;
        }
        await this.persist();
      }
      this.worker.stop(); this.worker = null;
    }
    for (const result of run.results) if (['queued', 'running'].includes(result.status)) result.status = 'cancelled';
    run.status = signal.aborted ? 'cancelled' : run.results.every(result => result.status === 'complete') ? 'complete' : 'partial';
    run.finishedAt = new Date().toISOString();
    await this.persist();
  }
  async stop() { this.controller?.abort(); this.worker?.stop(); await this.job; }
  async clear() {
    if (this.mutating) throw new Error('A local update is already in progress. Try again.');
    this.mutating = true;
    try { await this.stop(); await rm(this.directory, { recursive: true, force: true }); await mkdir(this.directory, { recursive: true, mode: 0o700 }); this.run = null; this.reference = null; await this.persist(); }
    finally { this.mutating = false; }
  }
  async audio(filename) {
    if (filename !== 'reference.wav' && !/^[0-9a-f-]{36}-(kokoro|pocket|chatterbox|qwen)-[01]\.wav$/.test(filename)) throw new Error('Audio not found.');
    const file = await open(join(this.directory, filename), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { if (!(await file.stat()).isFile()) throw new Error('Audio not found.'); return await file.readFile(); } finally { await file.close(); }
  }
}
