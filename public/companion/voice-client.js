const SAMPLE_RATE = 16000;
const playbackPrimes = new WeakMap();

/** Call directly from a user gesture before waiting for a generated reply. */
export function unlockAudioPlayback(audio) {
  const existing = playbackPrimes.get(audio);
  if (existing) return existing.promise;
  // Do not replace or unexpectedly replay an answer already in the player.
  if (audio.src) return Promise.resolve(true);
  const wav = new ArrayBuffer(524), view = new DataView(wav);
  const word = (offset, text) => { for (let index = 0; index < text.length; index++) view.setUint8(offset + index, text.charCodeAt(index)); };
  word(0, 'RIFF'); view.setUint32(4, 516, true); word(8, 'WAVE'); word(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 24000, true); view.setUint32(28, 48000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  word(36, 'data'); view.setUint32(40, 480, true);
  const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
  const prime = { url, promise: null };
  playbackPrimes.set(audio, prime);
  const cleanup = () => {
    if (audio.src === url) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
    URL.revokeObjectURL(url);
    if (playbackPrimes.get(audio) === prime) playbackPrimes.delete(audio);
  };
  audio.src = url;
  try { prime.promise = Promise.resolve(audio.play()).then(() => true, () => false).finally(cleanup); }
  catch { cleanup(); prime.promise = Promise.resolve(false); }
  return prime.promise;
}

function isPriming(audio) { return playbackPrimes.get(audio)?.url === audio.currentSrc; }

/** Explicitly enabled, same-origin local-wake capture and revision-safe playback. */
export class CompanionVoiceClient {
  constructor({ audio = new Audio(), onEvent, playbackGate = async () => {} } = {}) {
    this.audio = audio;
    this.listeners = new Set(onEvent ? [onEvent] : []);
    this.playbackGate = playbackGate;
    this.session = null;
    this.replySpeech = null;
    this.state = 'off';
    this.destroyed = false;
    this.audioHandlers = {
      play: () => {
        if (isPriming(audio)) return;
        const session = this.session, clip = session?.playback;
        if (!clip || session.awaitingRevision || session.awaitingSleep) { if (session) audio.pause(); return; }
        if (audio.currentSrc === clip.url) {
          if (clip.manualFallback && !clip.manualReady) { void this.playFallback(session, clip); return; }
          this.acknowledgePlayback(session, true);
        }
      },
      pause: () => {
        if (isPriming(audio)) return;
        const session = this.session;
        if (audio.paused && audio.currentSrc === session?.playback?.url) this.acknowledgePlayback(session, false);
      },
      ended: () => {
        if (isPriming(audio)) return;
        const session = this.session;
        if (audio.ended && audio.currentSrc === session?.playback?.url) this.acknowledgePlayback(session, false);
      },
      error: () => {
        if (isPriming(audio)) return;
        const session = this.session;
        if (audio.currentSrc !== session?.playback?.url) return;
        this.acknowledgePlayback(session, false);
        this.emit({ type: 'error', message: 'The reply is on screen, but its audio could not play.', fatal: false });
      },
    };
    for (const [event, handler] of Object.entries(this.audioHandlers)) audio.addEventListener(event, handler);
    this.onHidden = () => { if (document.visibilityState === 'hidden') this.stop('Microphone off while this page is hidden.'); };
    this.onPageHide = () => this.stop();
    document.addEventListener('visibilitychange', this.onHidden);
    window.addEventListener('pagehide', this.onPageHide);
  }

  get active() { return Boolean(this.session); }
  get supported() { return Boolean(navigator.mediaDevices?.getUserMedia && window.AudioContext && window.AudioWorkletNode && window.WebSocket); }
  subscribe(callback) { this.listeners.add(callback); return () => this.listeners.delete(callback); }
  setPlaybackGate(callback) { this.playbackGate = callback || (async () => {}); }
  unlockPlayback() { return unlockAudioPlayback(this.audio); }
  emit(event) {
    if (event.type === 'state') this.state = event.state;
    // A renderer error must not disable microphone cleanup or stale-audio guards.
    for (const callback of this.listeners) { try { callback(event); } catch {} }
  }
  send(session, value) {
    if (this.session === session && session.socket?.readyState === WebSocket.OPEN) session.socket.send(JSON.stringify(value));
  }
  clearPlayback(session) {
    session.playbackToken += 1;
    const clip = session.playback;
    session.playback = null;
    session.pendingAudio = null;
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    if (clip?.url) URL.revokeObjectURL(clip.url);
  }
  stop(message = 'Microphone off.') {
    const session = this.session;
    if (!session) return;
    this.finishReplySpeech(false);
    this.session = null;
    clearTimeout(session.startTimer);
    session.controller.abort();
    session.capture?.dispose();
    if (session.socket?.readyState === WebSocket.OPEN) session.socket.send(JSON.stringify({ type: 'stop' }));
    if (session.socket && session.socket.readyState < WebSocket.CLOSING) session.socket.close();
    this.clearPlayback(session);
    this.emit({ type: 'state', state: 'off', message });
  }
  endConversation() {
    const session = this.session;
    if (!session) return;
    this.finishReplySpeech(false);
    session.awaitingSleep = true;
    this.clearPlayback(session);
    this.send(session, { type: 'sleep' });
    if (session.ready && session.capture) this.emit({ type: 'state', state: 'wake', message: 'Local wake only — say MERLIN.' });
  }
  interrupt() {
    const session = this.session;
    if (!session) return;
    if (!session.ready || !session.capture) { this.finishReplySpeech(false); this.clearPlayback(session); this.send(session, { type: 'sleep' }); return; }
    if (this.state === 'wake') { if (this.replySpeech || session.playback) this.endConversation(); return; }
    this.finishReplySpeech(false);
    session.awaitingRevision = session.revision + 1;
    this.clearPlayback(session);
    this.send(session, { type: 'interrupt' });
  }
  announceTimer(timerId) {
    const session = this.session;
    if (!session?.ready || session.awaitingSleep || session.awaitingRevision || !['wake', 'followup'].includes(this.state)) return false;
    this.send(session, { type: 'timer_alert', timerId });
    return true;
  }
  speakReply(requestId) {
    const session = this.session;
    if (this.replySpeech?.requestId === requestId) return this.replySpeech.promise;
    if (!session || this.replySpeech || session.awaitingRevision) return Promise.resolve(false);
    if (session.ready && session.capture && !session.awaitingSleep && !['wake', 'followup'].includes(this.state)) return Promise.resolve(false);
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    this.replySpeech = { requestId, promise, resolve, session, sent: false, revision: null, timer: setTimeout(() => this.finishReplySpeech(false), 180000) };
    this.flushReplySpeech(session);
    return promise;
  }
  flushReplySpeech(session) {
    const pending = this.replySpeech;
    if (!pending || pending.session !== session || pending.sent || !session.ready || !session.capture || session.awaitingSleep || session.awaitingRevision) return;
    if (!['wake', 'followup'].includes(this.state)) { this.finishReplySpeech(false); return; }
    pending.sent = true;
    this.send(session, { type: 'reply_audio', requestId: pending.requestId });
  }
  finishReplySpeech(played) {
    const pending = this.replySpeech;
    if (!pending) return;
    this.replySpeech = null;
    clearTimeout(pending.timer);
    pending.resolve(played);
  }
  fail(session, error) {
    if (this.session !== session) return;
    this.stop();
    const descriptions = {
      NotAllowedError: 'Microphone access was blocked. Allow this page in your browser, or open MERLIN in a browser with microphone access.',
      NotFoundError: 'No microphone was found. You can still type to MERLIN.',
      NotReadableError: 'The microphone is unavailable. Check whether another app is using it.',
    };
    const permissionReason = error.name !== 'NotAllowedError' ? null : /system/i.test(error.message) ? 'system'
      : /permissions? policy|feature policy|embedder/i.test(error.message) ? 'policy' : /dismiss/i.test(error.message) ? 'dismissed' : 'browser';
    this.emit({ type: 'error', fatal: true, message: descriptions[error.name] || error.message || 'Voice stopped. Enable the microphone to try again.',
      ...(permissionReason ? { code: 'microphone_permission_denied', permissionReason } : {}) });
  }
  acknowledgePlayback(session, playing) {
    const clip = session?.playback;
    if (this.session !== session || !clip || clip.revision !== session.revision || clip.playing === playing) return;
    clip.playing = playing;
    // A blocked notification may have returned to local wake while its manual
    // player remains available. It no longer owns a server playback turn.
    if (!clip.manualFallback) this.send(session, { type: 'playback', playing, revision: clip.revision, utteranceId: clip.utteranceId });
    this.emit({ type: 'playback', playing, revision: clip.revision, utteranceId: clip.utteranceId, ...(clip.presentationMode ? { presentationMode: clip.presentationMode } : {}) });
    if (!playing && clip.requestId === this.replySpeech?.requestId) this.finishReplySpeech(Boolean(this.audio.ended));
    if (!playing && clip.manualFallback) { clip.manualReady = false; this.showState(session); }
  }
  async playFallback(session, clip) {
    // A manual retry may happen after the character has left the face. Pause
    // immediately, then apply the same presentation and cancellation gate.
    this.audio.pause();
    if (clip.manualPending) return;
    clip.manualPending = true;
    const token = session.playbackToken;
    const current = () => this.session === session && session.playback === clip && token === session.playbackToken && !session.awaitingSleep && !session.awaitingRevision;
    try {
      const allowed = await this.playbackGate(clip);
      if (!current() || allowed === false) return;
      clip.manualReady = true;
      await this.audio.play();
      if (!current() && this.audio.src === clip.url) this.audio.pause();
    } catch {
      if (current()) this.emit({ type: 'error', fatal: false, message: 'Your browser paused the spoken reply. Use the audio player to hear it.' });
    } finally { clip.manualPending = false; }
  }
  async playAudio(session, header, bytes) {
    if (this.session !== session || session.awaitingSleep || session.awaitingRevision || header.revision !== session.revision) return;
    this.clearPlayback(session);
    const token = session.playbackToken;
    const current = () => this.session === session && token === session.playbackToken && header.revision === session.revision && !session.awaitingSleep && !session.awaitingRevision;
    const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
    session.playback = { revision: header.revision, utteranceId: header.utteranceId, url, playing: null, presentationMode: header.presentationMode, requestId: header.requestId };
    this.audio.src = url;
    let attemptedPlayback = false;
    try {
      const allowed = await this.playbackGate(header);
      if (!current()) return;
      if (allowed === false) { this.acknowledgePlayback(session, false); return; }
      attemptedPlayback = true;
      await this.audio.play();
      if (!current() && this.audio.src === url) this.audio.pause();
    } catch {
      if (!current()) return;
      session.playback.autoplayBlocked = attemptedPlayback;
      this.acknowledgePlayback(session, false);
      this.emit({ type: 'error', fatal: false, message: 'Your browser paused the spoken reply. Use the audio player to hear it.' });
    }
  }
  showState(session) {
    if (this.session === session && session.ready && session.capture && session.serverState) {
      this.emit(session.serverState);
      this.flushReplySpeech(session);
    }
  }
  receive(session, event) {
    if (this.session !== session) return;
    if (typeof event.data !== 'string') {
      const header = session.pendingAudio;
      session.pendingAudio = null;
      if (!header || !(event.data instanceof ArrayBuffer)) return;
      if (event.data.byteLength < 44 || event.data.byteLength > 25_000_000) { this.fail(session, new Error('The voice service returned invalid audio.')); return; }
      void this.playAudio(session, header, event.data);
      return;
    }
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (!message || typeof message !== 'object') return;
    const preserveFallback = message.type === 'interrupt' && ['notification-ended', 'reply-audio-ended'].includes(message.reason)
      && session.playback?.autoplayBlocked && message.revision === session.playback.revision + 1 && !session.awaitingSleep && !session.awaitingRevision;
    if (message.type === 'speech_complete' && message.requestId === this.replySpeech?.requestId) { this.finishReplySpeech(false); return; }
    if (message.type === 'error' && message.requestId === this.replySpeech?.requestId) this.finishReplySpeech(false);
    if (Number.isSafeInteger(message.revision)) {
      if (message.revision < session.revision || (session.awaitingRevision && message.revision < session.awaitingRevision)) {
        if (message.type === 'audio') session.pendingAudio = null;
        return;
      }
      if (message.revision > session.revision) {
        if (this.replySpeech?.revision !== null && this.replySpeech?.revision !== undefined && message.revision > this.replySpeech.revision) this.finishReplySpeech(false);
        session.revision = message.revision;
        session.awaitingRevision = null;
        if (preserveFallback) { session.playback.revision = message.revision; session.playback.manualFallback = true; session.pendingAudio = null; }
        else this.clearPlayback(session);
      }
    }
    if (message.type === 'ready') {
      session.ready = true;
      clearTimeout(session.startTimer);
      this.emit(message);
      this.showState(session);
    } else if (message.type === 'state') {
      session.serverState = message;
      if (message.state === 'wake') session.awaitingSleep = false;
      if (!session.awaitingSleep) this.showState(session);
    } else if (message.type === 'interrupt') {
      if (!preserveFallback) this.clearPlayback(session);
      // End-conversation already moved the presentation to wake standby. Its
      // delayed acknowledgment must not interrupt a typed turn started since.
      if (!session.awaitingSleep) this.emit(message);
    } else if (message.type === 'audio') {
      session.pendingAudio = Number.isSafeInteger(message.revision) && message.revision === session.revision && !session.awaitingSleep && !session.awaitingRevision ? message : null;
    } else if (message.type === 'error') {
      if (message.fatal) this.fail(session, new Error(message.message));
      else this.emit(message);
    } else if (!session.awaitingSleep && !session.awaitingRevision && ['transcript', 'progress', 'response', 'notification'].includes(message.type)) {
      if (message.type === 'notification' && message.kind === 'reply' && message.requestId === this.replySpeech?.requestId) this.replySpeech.revision = message.revision;
      this.emit(message);
    }
  }
  async start({ sessionId, timeZone, delivery = 'natural', speed = 1 } = {}) {
    if (this.destroyed) throw new Error('This voice client was closed.');
    if (this.session) return;
    if (!this.supported) throw new Error('This browser cannot use the microphone. You can still type to MERLIN.');
    if (document.visibilityState === 'hidden') throw new Error('Open this page before enabling the microphone.');
    // Unlock this media element while the explicit microphone gesture is live;
    // later model/animation waits must not consume its only playback gesture.
    void this.unlockPlayback();
    const session = {
      controller: new AbortController(), capture: null, socket: null, ready: false,
      revision: -1, playbackToken: 0, playback: null, pendingAudio: null,
      serverState: null, awaitingSleep: false, awaitingRevision: null, startTimer: null,
    };
    this.session = session;
    this.emit({ type: 'state', state: 'requesting', message: 'Waiting for microphone access…' });
    try {
      const url = new URL('/api/voice/session', window.location.href);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      session.socket = new WebSocket(url);
      session.socket.binaryType = 'arraybuffer';
      session.socket.addEventListener('open', () => this.send(session, { type: 'start', sessionId, timeZone, delivery, speed }));
      session.socket.addEventListener('message', event => this.receive(session, event));
      session.socket.addEventListener('error', () => this.fail(session, new Error('Could not connect to local voice. Check voice setup, then try again.')));
      session.socket.addEventListener('close', () => this.fail(session, new Error('The voice connection closed. Microphone off.')));
      session.startTimer = setTimeout(() => this.fail(session, new Error('Local voice took too long to start. Check voice setup, then try again.')), 60000);
      // Called synchronously from the explicit start gesture so AudioContext
      // resume does not depend on a network response or permission resolution.
      const capture = await createCapture(session.controller.signal, pcm => {
        if (this.session !== session || !session.ready || session.socket.readyState !== WebSocket.OPEN) return;
        if (session.socket.bufferedAmount > SAMPLE_RATE * 2 * 2) { this.fail(session, new Error('Local audio processing fell behind. Microphone off.')); return; }
        session.socket.send(pcm);
      }, () => this.fail(session, new Error('The microphone stopped supplying audio.')), () => {
        if (this.session === session) this.emit({ type: 'state', state: 'starting', message: session.ready ? 'Microphone on. Preparing audio…' : 'Microphone on. Preparing local listening…' });
      });
      if (this.session !== session) { capture.dispose(); return; }
      session.capture = capture;
      this.showState(session);
    } catch (error) {
      if (error.name !== 'AbortError') this.fail(session, error);
    }
  }
  destroy() {
    this.stop();
    this.destroyed = true;
    document.removeEventListener('visibilitychange', this.onHidden);
    window.removeEventListener('pagehide', this.onPageHide);
    for (const [event, handler] of Object.entries(this.audioHandlers)) this.audio.removeEventListener(event, handler);
    this.listeners.clear();
  }
}

async function createCapture(signal, onFrame, onEnded, onGranted) {
  let context;
  try { context = new AudioContext({ sampleRate: SAMPLE_RATE }); } catch { context = new AudioContext(); }
  let resumeError;
  const resume = context.resume().catch(error => { resumeError = error; });
  let stream, source, node, disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    stream?.getTracks().forEach(track => track.stop());
    source?.disconnect();
    if (node) { node.port.onmessage = null; node.port.postMessage('stop'); node.disconnect(); }
    if (context.state !== 'closed') context.close().catch(() => {});
    signal.removeEventListener('abort', dispose);
  };
  const ensureActive = () => { if (signal.aborted) throw new DOMException('Cancelled', 'AbortError'); };
  signal.addEventListener('abort', dispose, { once: true });
  try {
    ensureActive();
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    if (signal.aborted) { stream.getTracks().forEach(track => track.stop()); ensureActive(); }
    onGranted?.();
    await resume;
    if (resumeError) throw resumeError;
    ensureActive();
    await context.audioWorklet.addModule('/voice/recorder-worklet.js');
    ensureActive();
    source = context.createMediaStreamSource(stream);
    node = new AudioWorkletNode(context, 'voice-recorder', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      processorOptions: { mode: 'stream', sourceSampleRate: context.sampleRate, targetSampleRate: SAMPLE_RATE, frameSamples: 1280 },
    });
    node.port.onmessage = ({ data }) => { if (!disposed && !signal.aborted && data.type === 'frame') onFrame(data.pcm); };
    source.connect(node); node.connect(context.destination);
    stream.getAudioTracks().forEach(track => track.addEventListener('ended', () => { if (!disposed) onEnded(); }, { once: true }));
    return { dispose };
  } catch (error) { dispose(); throw error; }
}
