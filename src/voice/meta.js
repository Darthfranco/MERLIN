import { randomUUID } from 'node:crypto';
import { AppError } from '../errors.js';
import { validateWav } from './audio.js';

export class MetaTranscriber {
  constructor({ apiKey = '', fetchImpl = fetch, timeoutMs = 60_000 } = {}) {
    this.apiKey = apiKey.trim();
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.model = 'muse-voice-transcribe-1.0';
  }

  get configured() { return Boolean(this.apiKey); }

  async checkAccess() {
    if (!this.configured) throw new AppError('Add META_API_KEY to .env and restart the voice lab.', 503);
    let response;
    try {
      response = await this.fetch('https://api.meta.ai/v1/models', {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(this.timeoutMs), redirect: 'error',
      });
      if (!response.ok) throw new Error();
      const body = await response.json();
      if (!body.data?.some(item => item.id === this.model)) throw new Error();
    } catch {
      throw new AppError('Meta did not confirm access to Muse Voice Transcribe. Check the API key and account access.', 503);
    }
    return { model: this.model, available: true };
  }

  async transcribe(buffer, { signal } = {}) {
    const wav = validateWav(buffer);
    if (!this.configured) throw new AppError('Add META_API_KEY to .env and restart the voice lab. Typed speech still works.', 503);
    const form = new FormData();
    form.append('request', new Blob([JSON.stringify({ model: this.model, audioEncoding: 'WAV', mode: 'PUSH_TO_TALK' })], { type: 'application/json' }));
    form.append('audio', new Blob([wav.audio], { type: 'audio/wav' }), 'recording.wav');
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response;
    let body;
    try {
      requestSignal.throwIfAborted();
      response = await this.fetch(`https://api.meta.ai/v1/asr/transcribe?sessionId=${randomUUID()}`, {
        method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' },
        body: form, signal: requestSignal, redirect: 'error',
      });
      if (response.ok) body = await response.json();
    } catch {
      if (signal?.aborted) throw new AppError('Transcription cancelled.', 499);
      throw new AppError('Meta transcription could not be reached or timed out. Try recording again.', 502);
    }
    if (!response.ok) {
      const detail = [401, 403].includes(response.status) ? 'Check the API key and voice model access.'
        : response.status === 429 ? 'Wait a moment and check your account quota.'
          : 'Try a shorter recording and check model availability.';
      // Upstream bodies may echo audio, transcripts, or credentials.
      throw new AppError(`Meta transcription returned HTTP ${response.status}. ${detail}`, 502);
    }
    if (typeof body?.transcript !== 'string' || body.transcript.length > 20_000) {
      throw new AppError('Meta returned an unreadable transcript. Try recording again.', 502);
    }
    const text = body.transcript.trim();
    if (!text) throw new AppError('No speech was detected. Record again and speak near the microphone.', 422);
    return { text, model: this.model, audioDurationMs: wav.durationMs };
  }
}
