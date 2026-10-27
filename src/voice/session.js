import { randomUUID } from 'node:crypto';
import { AppError } from '../errors.js';
import { validateSpeechDelivery } from './prosody.js';

export const VOICE_SESSION_LIMITS = Object.freeze({
  sampleRate: 16000, idleBufferSeconds: 4, followupMs: 10_000,
  extendedFollowupMs: 15_000, longPauseMs: 8000, onsetGraceMs: 400,
  maxConversationMs: 180_000, maxUtteranceSeconds: 60, maxTurns: 12,
});
const RATE = VOICE_SESSION_LIMITS.sampleRate;

function wavOf(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24); header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Local turn boundaries only. No provider calls are permitted in wake standby. */
export class VoiceSession {
  constructor({ listener, meta, tts, send, sendAudio, now = () => performance.now(), limits = {} }) {
    this.listener = listener; this.meta = meta; this.tts = tts;
    this.send = send; this.sendAudio = sendAudio; this.now = now;
    this.limits = { ...VOICE_SESSION_LIMITS, ...limits };
    this.state = 'off'; this.revision = 0; this.sample = 0;
    this.ring = []; this.capture = null; this.pendingPcm = null;
    this.controller = null; this.work = null; this.closed = false;
    this.delivery = 'natural'; this.speed = 1; this.turns = 0;
    this.lastFrameAt = now(); this.activeSince = null; this.deadline = null;
    this.utteranceId = null; this.firstUtterance = false; this.wakeEnd = null;
    this.sleepEpoch = 0;
    this.followupWaitMs = this.limits.followupMs;
    this.quietSince = null; this.quietBeforeSpeech = null;
  }

  configure({ delivery = this.delivery, speed = this.speed } = {}) {
    this.delivery = validateSpeechDelivery(delivery);
    if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < .75 || speed > 1.25) throw new AppError('Speech speed must be between 0.75 and 1.25.');
    this.speed = speed;
  }

  emit(type, value = {}) { if (!this.closed) this.send({ type, revision: this.revision, ...value }); }
  setState(state, message) { this.state = state; this.emit('state', { state, message }); }

  #quietDeadline(waitMs = this.followupWaitMs) {
    // The onset allowance fits inside the advertised quiet window, including
    // the owner's 15-second maximum, rather than extending it.
    return this.now() + Math.max(0, waitMs - this.limits.onsetGraceMs);
  }

  async start(options = {}) {
    if (this.state !== 'off' || this.closed) throw new AppError('Voice session is already started.');
    this.configure(options);
    if (!this.meta.configured) throw new AppError('Add META_API_KEY before enabling wake mode.', 503);
    this.startController = new AbortController();
    await this.listener.start({ signal: this.startController.signal });
    if (this.closed) return;
    this.lastFrameAt = this.now();
    this.emit('ready');
    this.setState('wake', 'Local wake only — say MERLIN.');
  }

  #invalidate() {
    this.revision += 1;
    this.controller?.abort(); this.controller = null;
    this.utteranceId = null;
    this.emit('interrupt');
  }

  sleep(message = 'Conversation ended. Local wake only — say MERLIN.') {
    if (this.closed || this.state === 'off') return;
    this.sleepEpoch += 1;
    this.#invalidate();
    this.capture = null; this.pendingPcm = null; this.ring = [];
    this.activeSince = null; this.deadline = null; this.firstUtterance = false;
    this.turns = 0; this.wakeEnd = null;
    this.followupWaitMs = this.limits.followupMs;
    this.quietSince = null; this.quietBeforeSpeech = null;
    this.setState('wake', message);
  }

  #appendRing(pcm) {
    this.ring.push({ start: this.sample, end: this.sample + pcm.length / 2, pcm });
    const earliest = this.sample + pcm.length / 2 - RATE * this.limits.idleBufferSeconds;
    while (this.ring.length && this.ring[0].end <= earliest) this.ring.shift();
    if (this.ring.length && this.ring[0].start < earliest) {
      const chunk = this.ring[0];
      this.ring[0] = { ...chunk, start: earliest, pcm: Buffer.from(chunk.pcm.subarray((earliest - chunk.start) * 2)) };
    }
  }

  #startCapture(startSample, prefix = null, stripWake = false) {
    const from = Math.max(this.ring[0]?.start ?? this.sample, Math.floor(startSample));
    const chunks = this.ring.filter(chunk => chunk.end > from).map(chunk =>
      Buffer.from(chunk.pcm.subarray(Math.max(0, from - chunk.start) * 2)));
    if (prefix?.length) chunks.unshift(prefix);
    this.capture = { start: from, chunks, bytes: chunks.reduce((n, chunk) => n + chunk.length, 0), prefixBytes: prefix?.length || 0, stripWake };
  }

  #beginSpeech(event) {
    // Continuing before a reply preserves the earlier utterance; interrupting
    // audible playback begins a fresh turn. No late provider result can speak.
    const prefix = ['transcribing', 'generating'].includes(this.state) ? this.pendingPcm : null;
    if (this.state !== 'listening' || !this.capture) {
      this.quietBeforeSpeech = this.state === 'followup'
        ? { since: this.quietSince, deadline: this.deadline, waitMs: this.followupWaitMs } : null;
      const interrupted = ['transcribing', 'generating', 'speaking'].includes(this.state);
      const resumedAfterPause = this.quietSince !== null && this.now() - this.quietSince >= this.limits.longPauseMs;
      // Timing context can give someone more thinking time, never close a
      // conversation based on words or require another model request.
      this.followupWaitMs = interrupted || resumedAfterPause ? this.limits.extendedFollowupMs : this.limits.followupMs;
      this.quietSince = null;
    }
    if (this.state !== 'listening') {
      this.#invalidate();
      this.#startCapture(event.startSample ?? event.sample, prefix, Boolean(prefix && this.pendingStripWake));
      this.pendingPcm = null;
      this.setState('listening', 'Listening. Pause when you’re finished.');
    } else if (!this.capture) this.#startCapture(event.startSample ?? event.sample);
    this.deadline = null;
  }

  async process(pcm) {
    if (this.closed || this.state === 'off') return;
    this.tick();
    if (!Buffer.isBuffer(pcm) || pcm.length < 2 || pcm.length > 16000 || pcm.length % 2) throw new AppError('Invalid local microphone frame.');
    this.lastFrameAt = this.now();
    const captureBefore = this.capture;
    this.#appendRing(pcm);
    if (captureBefore) {
      captureBefore.chunks.push(Buffer.from(pcm)); captureBefore.bytes += pcm.length;
    }
    const sleepEpoch = this.sleepEpoch;
    const result = await this.listener.process(pcm, { keywordEnabled: this.state === 'wake' });
    if (this.closed) return;
    if (!Number.isSafeInteger(result.sample) || result.sample !== this.sample + pcm.length / 2) throw new AppError('Local speech detection lost audio alignment.', 502);
    this.sample = result.sample;
    this.tick();
    if (sleepEpoch !== this.sleepEpoch) return;
    for (const event of result.events) {
      if (event.type === 'wake' && this.state === 'wake') {
        this.#invalidate();
        this.activeSince = this.now(); this.turns = 0;
        this.followupWaitMs = this.limits.followupMs;
        this.quietSince = null; this.quietBeforeSpeech = null;
        this.firstUtterance = true;
        this.wakeEnd = event.endSample ?? event.sample;
        this.#startCapture(event.startSample ?? event.sample);
        this.deadline = result.speech ? null : this.#quietDeadline();
        this.setState('listening', 'MERLIN heard. Listening…');
      } else if (event.type === 'speech_start' && this.state !== 'wake') this.#beginSpeech(event);
      else if (event.type === 'speech_end' && this.state === 'listening' && this.capture) this.#endSpeech(event);
    }
    if (this.capture?.bytes > RATE * 2 * this.limits.maxUtteranceSeconds) {
      this.sleep('That turn reached the 60-second limit. Say MERLIN to start again.');
    }
    this.tick();
  }

  #endSpeech(event) {
    const capture = this.capture;
    this.capture = null;
    const end = Math.min(this.sample, event.endSample ?? event.sample);
    const spokenSamples = end - capture.start;
    // Keyword timestamps are approximate token positions, not acoustic word
    // boundaries. Preserve brief words after MERLIN instead of guessing that a
    // short activation contained only the wake word. This may upload one short
    // clip after activation; standby never reaches this path.
    if (spokenSamples < RATE * .2 && !capture.prefixBytes) {
      // A rejected tiny noise must not keep extending an otherwise quiet room.
      if (this.quietBeforeSpeech) {
        this.deadline = this.quietBeforeSpeech.deadline;
        this.quietSince = this.quietBeforeSpeech.since;
        this.followupWaitMs = this.quietBeforeSpeech.waitMs;
        this.quietBeforeSpeech = null;
        this.setState('followup', 'Still here. Take your time.');
      } else this.deadline = this.#quietDeadline();
      return;
    }
    this.quietBeforeSpeech = null;
    const full = Buffer.concat(capture.chunks, capture.bytes);
    // Keep a short trailing pad, not the entire endpointing silence.
    const bytes = Math.min(full.length, capture.prefixBytes + Math.max(0, end - capture.start + RATE * .12) * 2);
    const clip = Buffer.from(full.subarray(0, bytes));
    if (clip.length > RATE * 2 * this.limits.maxUtteranceSeconds) { this.sleep('That turn was too long. Say MERLIN to try again.'); return; }
    if (this.turns >= this.limits.maxTurns) { this.sleep('Conversation limit reached. Say MERLIN to continue.'); return; }
    this.pendingPcm = clip;
    const stripWake = this.firstUtterance || capture.stripWake;
    this.pendingStripWake = stripWake;
    this.firstUtterance = false; this.wakeEnd = null;
    this.turns += 1;
    const revision = ++this.revision;
    const controller = new AbortController(); this.controller = controller;
    this.deadline = null;
    this.setState('transcribing', 'Meta is transcribing your request…');
    this.work = this.#respond(clip, { revision, controller, stripWake });
  }

  async #respond(pcm, { revision, controller, stripWake }) {
    const current = () => !this.closed && revision === this.revision && !controller.signal.aborted;
    try {
      const result = await this.meta.transcribe(wavOf(pcm), { signal: controller.signal });
      if (!current()) return;
      const text = (stripWake ? result.text.replace(/^\s*(?:hey\s+)?merlin\b[\s,.!?:;—-]*/iu, '') : result.text).trim();
      if (!text) { this.pendingPcm = null; this.#followup('I’m listening.'); return; }
      this.emit('transcript', { text });
      if (text.length > 2000) throw new AppError('The transcript is too long to read aloud. Shorten the next turn.');
      this.setState('generating', 'Preparing Fenrir’s voice…');
      const audio = await this.tts.synthesize(text, { delivery: this.delivery, speed: this.speed, signal: controller.signal });
      if (!current()) return;
      this.pendingPcm = null; this.controller = null;
      this.utteranceId = randomUUID();
      this.setState('speaking', 'Fenrir is speaking. You can interrupt.');
      this.emit('audio', { utteranceId: this.utteranceId });
      this.sendAudio(audio);
      this.playbackBudgetMs = Math.max(10_000, audio.length / 48000 * 1000 + 5000);
      this.deadline = this.now() + this.playbackBudgetMs;
    } catch (error) {
      if (!current()) return;
      this.pendingPcm = null; this.controller = null;
      this.emit('error', { message: error instanceof AppError ? error.message : 'That voice turn could not finish. Please try again.' });
      this.#followup('Ready for another try.');
    }
  }

  #followup(message = 'Still here. Speak when you’re ready; a longer quiet pause ends the conversation.') {
    if (this.turns >= this.limits.maxTurns) { this.sleep('Conversation limit reached. Say MERLIN to continue.'); return; }
    this.quietSince = this.now();
    this.deadline = this.#quietDeadline();
    this.setState('followup', message);
  }

  playback({ playing, revision, utteranceId }) {
    if (typeof playing !== 'boolean' || revision !== this.revision || !utteranceId || utteranceId !== this.utteranceId || !['speaking', 'followup'].includes(this.state)) return;
    if (playing) {
      this.quietSince = null;
      this.deadline = this.now() + this.playbackBudgetMs;
      this.setState('speaking', 'Fenrir is speaking. You can interrupt.');
    } else if (this.state === 'speaking') this.#followup();
  }

  tick() {
    if (this.closed || this.state === 'off') return;
    const now = this.now();
    if (this.activeSince !== null && now - this.activeSince >= this.limits.maxConversationMs) {
      this.sleep('Conversation time limit reached. Local wake only — say MERLIN.'); return;
    }
    if (this.deadline !== null && now >= this.deadline) {
      if (this.state === 'speaking') this.#followup();
      // VAD needs a little onset audio before reporting speech. Allow a bounded
      // grace period so starting near the quiet deadline doesn't lose the turn.
      else if (['listening', 'followup'].includes(this.state) && now >= this.deadline + this.limits.onsetGraceMs) this.sleep();
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true; this.revision += 1; this.state = 'off';
    this.startController?.abort(); this.controller?.abort();
    this.listener.close();
    this.ring = []; this.capture = null; this.pendingPcm = null;
    this.controller = null; this.utteranceId = null;
  }
}
