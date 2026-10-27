const $ = (selector) => document.querySelector(selector);
const words = $('#words');
const speakButton = $('#speak');
const recordButton = $('#record');
const stopButton = $('#stop');
const audio = $('#audio');
const activity = $('#activity');
const errorMessage = $('#error');
const timeDisplay = $('#recording-time');
const wakeButton = $('#wake-toggle');
const wakeStatus = $('#wake-status');
const deliveryInput = $('#delivery');
const speedInput = $('#speed');
const TARGET_SAMPLE_RATE = 24000;
const WAKE_SAMPLE_RATE = 16000;
const limits = { maxTextCharacters: 2000, maxRecordingSeconds: 60, maxAudioBytes: 2_881_024 };

let services = null;
let state = 'idle';
let operation = 0;
let requestController = null;
let recorder = null;
let recordingTimer = null;
let audioUrl = null;
let wakeSession = null;

const microphoneSupported = Boolean(navigator.mediaDevices?.getUserMedia && window.AudioContext && window.AudioWorkletNode);
const busyStates = new Set(['requesting', 'recording', 'finishing', 'transcribing', 'generating']);

function updateControls() {
  const busy = busyStates.has(state);
  const armed = Boolean(wakeSession);
  words.readOnly = busy || armed;
  speakButton.disabled = armed || busy || !words.value.trim() || words.value.length > limits.maxTextCharacters || !services || services.tts?.configured === false;
  recordButton.disabled = armed || (state === 'recording' ? false : busy || !microphoneSupported || !services?.metaConfigured);
  recordButton.dataset.recording = String(state === 'recording');
  $('#record-label').textContent = state === 'recording' ? 'Stop & speak' : 'Start recording';
  stopButton.disabled = !armed && !busy && state !== 'playing';
  stopButton.textContent = armed ? 'Mic off' : busy ? 'Cancel' : 'Stop';
  wakeButton.disabled = !armed && (busy || !microphoneSupported || !window.WebSocket || !services?.listener?.configured || !services?.metaConfigured || services?.tts?.configured === false);
  wakeButton.textContent = armed ? 'Turn microphone off' : 'Enable local wake';
  wakeButton.setAttribute('aria-pressed', String(armed));
  wakeStatus.dataset.active = String(armed);
  $('#end-conversation').hidden = !armed || ['requesting', 'wake'].includes(state);
  deliveryInput.disabled = busy && !armed;
  speedInput.disabled = busy && !armed;
  $('#character-count').textContent = `${words.value.length.toLocaleString()} / ${limits.maxTextCharacters.toLocaleString()}`;
  $('#character-count').style.color = words.value.length > limits.maxTextCharacters ? '#943414' : '';
  timeDisplay.hidden = state !== 'recording';
  activity.parentElement.dataset.state = state;
}

function setState(next, message) {
  state = next;
  if (message) activity.textContent = message;
  updateControls();
}

function clearError() {
  errorMessage.hidden = true;
  errorMessage.textContent = '';
}

function reportError(error) {
  const descriptions = {
    NotAllowedError: 'Microphone permission was denied. Allow microphone access in your browser, then try again.',
    NotFoundError: 'No microphone was found. Connect one, or type your words instead.',
    NotReadableError: 'The microphone is unavailable. Close any other app using it, then try again.',
    SecurityError: 'Microphone access is blocked. Open this page on localhost and check your browser permissions.',
  };
  errorMessage.textContent = descriptions[error.name] || error.message || 'The voice request failed. Please try again.';
  errorMessage.hidden = false;
  setState('idle', 'Ready to try again.');
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const message = typeof body.error === 'string' ? body.error : body.error?.message || body.message;
      throw new Error(message || `The voice service returned an error (${response.status}). Please try again.`);
    }
    // Read the response body inside the timeout and cancellation scope too.
    return options.responseType === 'audio' ? await response.blob() : await response.json();
  } catch (error) {
    if (timedOut) throw new Error('The voice service took too long. Please try again; the first speech request can take longer while Kokoro loads.');
    if (error instanceof TypeError) throw new Error('Couldn’t reach the voice service. Check that the local voice server is running, then try again.');
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
  }
}

async function checkServices() {
  const button = $('#refresh-status');
  button.disabled = true;
  try {
    services = await fetchWithTimeout('/api/voice/status', {}, 10000);
    for (const key of Object.keys(limits)) {
      if (Number.isSafeInteger(services.limits?.[key]) && services.limits[key] > 0) limits[key] = services.limits[key];
    }
    words.maxLength = limits.maxTextCharacters;
    $('#limit-help').textContent = `Up to ${limits.maxRecordingSeconds} seconds per recording. ⌘ / Ctrl + Enter to speak.`;
    const notes = [];
    notes.push(services.metaConfigured ? 'Meta configured' : 'Meta key missing — typing still works');
    notes.push(services.tts?.configured === false ? 'Kokoro setup needed' : 'Kokoro · Fenrir');
    $('#connection').textContent = notes.join(' · ');
    $('#connection').dataset.state = services.tts?.configured === false || !services.metaConfigured ? 'error' : 'ready';
    if (!microphoneSupported) {
      $('#words-help').textContent = 'Microphone recording isn’t supported in this browser. Type your words, or open this page in a current Chrome, Edge, or Safari browser.';
    }
    if (services.tts?.configured === false) {
      errorMessage.textContent = services.tts.error || 'Kokoro needs local setup before it can speak. See the voice setup instructions in the repository.';
      errorMessage.hidden = false;
    }
    const setup = $('#wake-setup');
    setup.hidden = Boolean(services.listener?.configured && microphoneSupported && window.WebSocket && services.metaConfigured);
    if (!setup.hidden) {
      setup.textContent = !microphoneSupported || !window.WebSocket
        ? 'Hands-free mode needs a browser with microphone and WebSocket support. You can still type below.'
        : !services.metaConfigured
          ? 'Hands-free mode needs the Meta key for active speech transcription. Add it to the local .env file, then check again.'
          : services.listener?.error || 'Local wake setup is needed. Run npm run setup:voice, restart npm run voice, then check again.';
    }
  } catch (error) {
    $('#connection').textContent = error.message;
    $('#connection').dataset.state = 'error';
  } finally {
    button.disabled = false;
    updateControls();
  }
}

function removeAudio() {
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = null;
  $('#playback').hidden = true;
}

function pauseAudio() {
  audio.pause();
  if (audioUrl) audio.currentTime = 0;
}

function cancelOperation(message = 'Stopped. Your text is still here.') {
  operation += 1;
  requestController?.abort();
  requestController = null;
  clearInterval(recordingTimer);
  recordingTimer = null;
  recorder?.dispose();
  recorder = null;
  pauseAudio();
  setState('idle', message);
}

async function synthesize(text, id, signal) {
  setState('generating', 'Preparing Fenrir’s voice…');
  const blob = await fetchWithTimeout('/api/voice/speak', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, ...deliverySettings() }),
    signal,
    responseType: 'audio',
  }, 190000);
  if (id !== operation) return;
  if (!blob.size || !/^audio\//.test(blob.type)) throw new Error('Kokoro returned no playable audio. Please try again.');
  removeAudio();
  audioUrl = URL.createObjectURL(blob);
  const generatedUrl = audioUrl;
  audio.src = audioUrl;
  $('#playback').hidden = false;
  $('#playback-help').textContent = 'Use the player to listen again.';
  setState('idle', 'Speech is ready.');
  try {
    await audio.play();
    if (id !== operation && audioUrl === generatedUrl) audio.pause();
  } catch {
    if (id !== operation) return;
    $('#playback-help').textContent = 'Your browser paused automatic playback. Press Play to hear Fenrir.';
    setState('idle', 'Speech is ready. Press Play below.');
  }
}

async function speakText(event) {
  event?.preventDefault();
  if (speakButton.disabled) return;
  clearError();
  pauseAudio();
  const id = ++operation;
  const controller = new AbortController();
  requestController = controller;
  try {
    await synthesize(words.value, id, controller.signal);
  } catch (error) {
    if (id === operation && error.name !== 'AbortError') reportError(error);
  } finally {
    if (id === operation) requestController = null;
  }
}

function formatTime(seconds) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

async function startRecording() {
  if (recordButton.disabled) return;
  clearError();
  pauseAudio();
  const id = ++operation;
  const controller = new AbortController();
  requestController = controller;
  setState('requesting', 'Waiting for microphone access…');
  try {
    const capture = await createRecorder(controller.signal, () => {
      if (id === operation) finishRecording();
    });
    if (id !== operation) {
      capture.dispose();
      return;
    }
    recorder = capture;
    const started = performance.now();
    const updateTime = () => {
      const elapsed = Math.min(limits.maxRecordingSeconds, Math.floor((performance.now() - started) / 1000));
      timeDisplay.textContent = `${formatTime(elapsed)} / ${formatTime(limits.maxRecordingSeconds)}`;
      // Also cap wall time if the device stops supplying audio frames.
      if (elapsed >= limits.maxRecordingSeconds) finishRecording();
    };
    updateTime();
    recordingTimer = setInterval(updateTime, 250);
    setState('recording', 'Recording. Speak now.');
  } catch (error) {
    if (id === operation) {
      requestController = null;
      if (error.name !== 'AbortError') reportError(error);
    }
  }
}

async function finishRecording() {
  if (state !== 'recording' || !recorder) return;
  const id = operation;
  const capture = recorder;
  const controller = requestController;
  clearInterval(recordingTimer);
  recordingTimer = null;
  setState('finishing', 'Finishing recording…');
  try {
    const wav = await capture.stop();
    if (id !== operation) return;
    recorder = null;
    if (wav.size > limits.maxAudioBytes) throw new Error('That recording is too large. Please record a shorter message.');
    setState('transcribing', 'Meta is transcribing your recording…');
    const result = await fetchWithTimeout('/api/voice/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: wav,
      signal: controller.signal,
    }, 90000);
    if (id !== operation) return;
    if (typeof result.text !== 'string' || !result.text.trim()) throw new Error('No speech was recognized. Try speaking closer to the microphone, or type your words.');
    words.value = result.text;
    updateControls();
    if (result.text.length > limits.maxTextCharacters) throw new Error(`The transcript is longer than ${limits.maxTextCharacters.toLocaleString()} characters. Shorten the text, then press Speak with Fenrir.`);
    await synthesize(result.text, id, controller.signal);
  } catch (error) {
    if (id === operation && error.name !== 'AbortError') reportError(error);
  } finally {
    capture.dispose();
    if (id === operation) {
      recorder = null;
      requestController = null;
    }
  }
}

async function createRecorder(signal, onLimit) {
  // Prefer Meta's accepted sample rate directly; resample if the device/browser
  // uses another rate. No browser SpeechRecognition or alternate model is used.
  let context;
  try {
    context = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
  } catch {
    context = new AudioContext();
  }
  let resumeError;
  const resume = context.resume().catch((error) => { resumeError = error; });
  let stream;
  let source;
  let node;
  let samples = [];
  let sampleCount = 0;
  let stopped;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    stream?.getTracks().forEach((track) => track.stop());
    source?.disconnect();
    node?.disconnect();
    if (node) node.port.onmessage = null;
    if (context.state !== 'closed') context.close().catch(() => {});
    signal.removeEventListener('abort', dispose);
    samples = [];
    stopped?.();
  };
  signal.addEventListener('abort', dispose, { once: true });
  const ensureActive = () => {
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
  };
  try {
    ensureActive();
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    if (signal.aborted) {
      stream.getTracks().forEach((track) => track.stop());
      ensureActive();
    }
    await resume;
    if (resumeError) throw resumeError;
    ensureActive();
    await context.audioWorklet.addModule(new URL('./recorder-worklet.js', import.meta.url));
    ensureActive();
    source = context.createMediaStreamSource(stream);
    node = new AudioWorkletNode(context, 'voice-recorder', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { maxSamples: Math.floor(context.sampleRate * limits.maxRecordingSeconds) },
    });
    node.port.onmessage = ({ data }) => {
      if (data.type === 'samples') {
        samples.push(data.samples);
        sampleCount += data.samples.length;
      } else if (data.type === 'limit') {
        onLimit();
      } else if (data.type === 'stopped') {
        stopped?.();
      }
    };
    source.connect(node);
    node.connect(context.destination);
    stream.getAudioTracks().forEach((track) => track.addEventListener('ended', onLimit, { once: true }));
    return {
      dispose,
      async stop() {
        // Stop the physical mic promptly, then flush the already captured PCM.
        stream.getTracks().forEach((track) => track.stop());
        source.disconnect();
        await new Promise((resolve) => {
          const timeout = setTimeout(resolve, 1000);
          stopped = () => { clearTimeout(timeout); resolve(); };
          node.port.postMessage('stop');
        });
        ensureActive();
        if (sampleCount < context.sampleRate / 4) throw new Error('The recording was too short. Record at least a moment of speech, then try again.');
        const merged = new Float32Array(sampleCount);
        let offset = 0;
        for (const chunk of samples) {
          merged.set(chunk, offset);
          offset += chunk.length;
        }
        const wav = encodeWav(merged, context.sampleRate);
        dispose();
        return wav;
      },
    };
  } catch (error) {
    dispose();
    // A context can be closed while browser permission is still pending.
    resume.catch(() => {});
    throw error;
  }
}

function deliverySettings() {
  const delivery = ['natural', 'neutral', 'lively', 'gentle'].includes(deliveryInput.value) ? deliveryInput.value : 'natural';
  const speed = Number(speedInput.value);
  return { delivery, speed: [0.9, 1, 1.1].includes(speed) ? speed : 1 };
}

function sendWakeMessage(session, message) {
  if (wakeSession === session && session.socket?.readyState === WebSocket.OPEN) {
    session.socket.send(JSON.stringify(message));
  }
}

function clearWakePlayback(session) {
  session.playbackToken += 1;
  session.playback = null;
  session.pendingAudio = null;
  removeAudio();
}

function stopWakeMode(message = 'Microphone off. Type, record, or enable local wake again.') {
  const session = wakeSession;
  if (!session) return;
  // Clear the live session first: queued media, socket, and permission events
  // cannot restart capture or playback after the user turns the microphone off.
  wakeSession = null;
  clearTimeout(session.startTimer);
  session.controller.abort();
  session.capture?.dispose();
  if (session.socket?.readyState === WebSocket.OPEN) session.socket.send(JSON.stringify({ type: 'stop' }));
  if (session.socket && session.socket.readyState < WebSocket.CLOSING) session.socket.close();
  clearWakePlayback(session);
  wakeStatus.textContent = 'Microphone off';
  setState('idle', message);
}

function failWakeMode(session, error) {
  if (wakeSession !== session) return;
  stopWakeMode();
  reportError(error);
  setState('idle', 'Microphone off. Fix the issue, then enable local wake again.');
}

function showWakeState(session) {
  if (wakeSession !== session || !session.capture || !session.ready) return;
  const labels = {
    wake: 'Local wake only — say MERLIN',
    listening: 'Listening to you — pause when you’re done',
    transcribing: 'Transcribing your speech with Meta',
    generating: 'Preparing Fenrir’s voice — you can interrupt',
    speaking: 'Fenrir is speaking — speak to interrupt',
    followup: 'Listening for a follow-up — or say “goodbye”',
  };
  const next = session.serverState;
  if (!labels[next]) return;
  wakeStatus.textContent = labels[next];
  setState(next === 'speaking' ? 'playing' : next, session.serverMessage || labels[next]);
}

function acknowledgePlayback(session, playing) {
  const clip = session?.playback;
  if (wakeSession !== session || !clip || clip.revision !== session.revision) return;
  if (clip.playing === playing) return;
  clip.playing = playing;
  sendWakeMessage(session, { type: 'playback', playing, revision: clip.revision, utteranceId: clip.utteranceId });
}

async function playWakeAudio(session, header, bytes) {
  if (wakeSession !== session || session.awaitingSleep || header.revision !== session.revision) return;
  clearWakePlayback(session);
  const token = session.playbackToken;
  const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
  audioUrl = url;
  session.playback = { revision: header.revision, utteranceId: header.utteranceId, token, url, playing: null };
  audio.src = url;
  $('#playback').hidden = false;
  $('#playback-help').textContent = 'Speak to interrupt, or use the player to pause.';
  try {
    await audio.play();
    // A play() promise from an interrupted clip must never pause a newer clip.
    if ((wakeSession !== session || token !== session.playbackToken) && audioUrl === url) audio.pause();
  } catch {
    if (wakeSession !== session || token !== session.playbackToken) return;
    acknowledgePlayback(session, false);
    $('#playback-help').textContent = 'Your browser paused automatic playback. Press Play to hear Fenrir.';
  }
}

function receiveWakeMessage(session, event) {
  if (wakeSession !== session) return;
  if (typeof event.data !== 'string') {
    const header = session.pendingAudio;
    session.pendingAudio = null;
    if (header && header.revision === session.revision && !session.awaitingSleep && event.data instanceof ArrayBuffer) {
      if (event.data.byteLength < 44 || event.data.byteLength > 25_000_000) {
        failWakeMode(session, new Error('The local voice service returned invalid audio. Restart the voice server and try again.'));
        return;
      }
      void playWakeAudio(session, header, event.data);
    }
    return;
  }
  let message;
  try { message = JSON.parse(event.data); } catch { return; }
  if (!message || typeof message !== 'object') return;
  if (Number.isSafeInteger(message.revision)) {
    if (message.revision < session.revision) {
      if (message.type === 'audio') session.pendingAudio = null;
      return;
    }
    if (message.revision > session.revision) {
      session.revision = message.revision;
      clearWakePlayback(session);
    }
  }
  if (message.type === 'ready') {
    session.ready = true;
    clearTimeout(session.startTimer);
    showWakeState(session);
  } else if (message.type === 'state') {
    session.serverState = message.state;
    session.serverMessage = typeof message.message === 'string' ? message.message : '';
    if (message.state === 'wake') session.awaitingSleep = false;
    showWakeState(session);
  } else if (message.type === 'interrupt') {
    clearWakePlayback(session);
  } else if (message.type === 'transcript') {
    if (typeof message.text === 'string' && !session.awaitingSleep) {
      words.value = message.text;
      clearError();
      updateControls();
    }
  } else if (message.type === 'audio') {
    session.pendingAudio = Number.isSafeInteger(message.revision) && message.revision === session.revision ? message : null;
  } else if (message.type === 'error') {
    const error = new Error(typeof message.message === 'string' ? message.message : 'The voice request failed. Try again.');
    if (message.fatal) failWakeMode(session, error);
    else {
      errorMessage.textContent = error.message;
      errorMessage.hidden = false;
    }
  }
}

async function startWakeMode() {
  if (wakeButton.disabled || wakeSession) return;
  cancelOperation();
  removeAudio();
  clearError();
  const session = {
    controller: new AbortController(), capture: null, socket: null, ready: false,
    revision: -1, playbackToken: 0, playback: null, pendingAudio: null,
    serverState: 'wake', serverMessage: '', awaitingSleep: false, startTimer: null,
  };
  wakeSession = session;
  wakeStatus.textContent = 'Starting local wake detection…';
  setState('requesting', 'Waiting for microphone access and the local wake detector…');
  try {
    const socketUrl = new URL('/api/voice/session', window.location.href);
    socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    session.socket = new WebSocket(socketUrl);
    session.socket.binaryType = 'arraybuffer';
    session.socket.addEventListener('open', () => sendWakeMessage(session, { type: 'start', ...deliverySettings() }));
    session.socket.addEventListener('message', event => receiveWakeMessage(session, event));
    session.socket.addEventListener('error', () => failWakeMode(session, new Error('Couldn’t connect to local wake detection. Check the voice server, then try again.')));
    session.socket.addEventListener('close', () => failWakeMode(session, new Error('The local voice connection closed. The microphone is off; enable local wake to reconnect.')));
    session.startTimer = setTimeout(() => failWakeMode(session, new Error('The local wake detector took too long to start. Check the voice server, then try again.')), 60000);
    // Start the AudioContext within this button gesture so browsers can resume
    // it. Until the local detector is ready, incoming microphone frames drop.
    const capture = await createWakeRecorder(session.controller.signal, (pcm) => {
      if (wakeSession !== session || !session.ready || session.socket.readyState !== WebSocket.OPEN) return;
      if (session.socket.bufferedAmount > WAKE_SAMPLE_RATE * 2 * 2) {
        failWakeMode(session, new Error('Local audio processing fell behind. The microphone is off; restart the voice server and try again.'));
        return;
      }
      session.socket.send(pcm);
    }, () => failWakeMode(session, new Error('The microphone stopped supplying audio. Check its connection, then enable local wake again.')));
    if (wakeSession !== session) { capture.dispose(); return; }
    session.capture = capture;
    wakeStatus.textContent = session.ready ? 'Local wake only — say MERLIN' : 'Microphone on — starting local wake detection…';
    showWakeState(session);
  } catch (error) {
    if (error.name !== 'AbortError') failWakeMode(session, error);
  }
}

async function createWakeRecorder(signal, onFrame, onEnded) {
  let context;
  try { context = new AudioContext({ sampleRate: WAKE_SAMPLE_RATE }); }
  catch { context = new AudioContext(); }
  let resumeError;
  const resume = context.resume().catch(error => { resumeError = error; });
  let stream;
  let source;
  let node;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    stream?.getTracks().forEach(track => track.stop());
    source?.disconnect();
    if (node) {
      node.port.onmessage = null;
      node.port.postMessage('stop');
      node.disconnect();
    }
    if (context.state !== 'closed') context.close().catch(() => {});
    signal.removeEventListener('abort', dispose);
  };
  const ensureActive = () => {
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
  };
  signal.addEventListener('abort', dispose, { once: true });
  try {
    ensureActive();
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    if (signal.aborted) {
      stream.getTracks().forEach(track => track.stop());
      ensureActive();
    }
    await resume;
    if (resumeError) throw resumeError;
    ensureActive();
    await context.audioWorklet.addModule(new URL('./recorder-worklet.js', import.meta.url));
    ensureActive();
    source = context.createMediaStreamSource(stream);
    node = new AudioWorkletNode(context, 'voice-recorder', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      processorOptions: { mode: 'stream', sourceSampleRate: context.sampleRate, targetSampleRate: WAKE_SAMPLE_RATE, frameSamples: 1280 },
    });
    node.port.onmessage = ({ data }) => {
      if (!disposed && !signal.aborted && data.type === 'frame') onFrame(data.pcm);
    };
    source.connect(node);
    node.connect(context.destination);
    stream.getAudioTracks().forEach(track => track.addEventListener('ended', () => {
      if (!disposed) onEnded();
    }, { once: true }));
    return { dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}

function encodeWav(samples, sourceRate) {
  const length = Math.min(Math.floor(samples.length * TARGET_SAMPLE_RATE / sourceRate), TARGET_SAMPLE_RATE * limits.maxRecordingSeconds);
  const buffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(buffer);
  const string = (offset, value) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };
  string(0, 'RIFF');
  view.setUint32(4, 36 + length * 2, true);
  string(8, 'WAVE');
  string(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, TARGET_SAMPLE_RATE, true);
  view.setUint32(28, TARGET_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  string(36, 'data');
  view.setUint32(40, length * 2, true);
  const ratio = sourceRate / TARGET_SAMPLE_RATE;
  for (let i = 0; i < length; i += 1) {
    // Weighted averaging avoids skipping samples when downsampling 44.1/48 kHz.
    // At 24 kHz this preserves the captured sample exactly.
    const start = i * ratio;
    const end = Math.min(samples.length, (i + 1) * ratio);
    let value = 0;
    for (let index = Math.floor(start); index < Math.ceil(end); index += 1) {
      const weight = Math.max(0, Math.min(index + 1, end) - Math.max(index, start));
      value += samples[index] * weight;
    }
    value = Math.max(-1, Math.min(1, value / (end - start)));
    view.setInt16(44 + i * 2, Math.round(value < 0 ? value * 32768 : value * 32767), true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

$('#voice-form').addEventListener('submit', speakText);
words.addEventListener('input', updateControls);
words.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) speakText(event);
});
recordButton.addEventListener('click', () => state === 'recording' ? finishRecording() : startRecording());
stopButton.addEventListener('click', () => wakeSession ? stopWakeMode() : cancelOperation());
wakeButton.addEventListener('click', () => wakeSession ? stopWakeMode() : startWakeMode());
$('#end-conversation').addEventListener('click', () => {
  if (!wakeSession) return;
  wakeSession.awaitingSleep = true;
  clearWakePlayback(wakeSession);
  sendWakeMessage(wakeSession, { type: 'sleep' });
  wakeStatus.textContent = 'Local wake only — say MERLIN';
  setState('wake', 'Conversation ended. Local wake only — say MERLIN.');
});
for (const input of [deliveryInput, speedInput]) input.addEventListener('change', () => {
  if (wakeSession) sendWakeMessage(wakeSession, { type: 'configure', ...deliverySettings() });
});
$('#refresh-status').addEventListener('click', checkServices);
$('#clear').addEventListener('click', () => {
  stopWakeMode();
  cancelOperation('Cleared. Type or record something new.');
  removeAudio();
  words.value = '';
  clearError();
  updateControls();
  words.focus();
});
audio.addEventListener('play', () => {
  if (wakeSession) {
    const clip = wakeSession.playback;
    if (!clip || clip.revision !== wakeSession.revision || wakeSession.awaitingSleep) {
      audio.pause();
      return;
    }
    // A queued play event from the replaced source cannot pause its successor.
    if (audio.currentSrc !== clip.url) return;
    acknowledgePlayback(wakeSession, true);
    return;
  }
  if (busyStates.has(state)) { audio.pause(); return; }
  setState('playing', 'Fenrir is speaking.');
});
audio.addEventListener('pause', () => {
  if (wakeSession) {
    if (audio.paused && audio.currentSrc === wakeSession.playback?.url) acknowledgePlayback(wakeSession, false);
    return;
  }
  if (state === 'playing') setState('idle', audio.ended ? 'Finished. Type or record something else.' : 'Playback paused.');
});
audio.addEventListener('ended', () => {
  if (wakeSession) {
    if (audio.ended && audio.currentSrc === wakeSession.playback?.url) acknowledgePlayback(wakeSession, false);
    return;
  }
  if (!busyStates.has(state)) setState('idle', 'Finished. Type or record something else.');
});
audio.addEventListener('error', () => {
  if (wakeSession) {
    if (audioUrl && audio.currentSrc === wakeSession.playback?.url) {
      acknowledgePlayback(wakeSession, false);
      errorMessage.textContent = 'The browser couldn’t play this audio. Speak again to try another phrase, or turn the microphone off and use the text controls.';
      errorMessage.hidden = false;
    }
    return;
  }
  // A stale player error must not hide Cancel or abandon a live microphone.
  if (audioUrl && !busyStates.has(state)) reportError(new Error('The browser couldn’t play this audio. Press Speak with Fenrir to generate it again.'));
});
window.addEventListener('pagehide', () => {
  stopWakeMode();
  cancelOperation();
  removeAudio();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    stopWakeMode('Microphone off because this page was hidden. Enable local wake when you return.');
    if (recorder || state === 'requesting') cancelOperation('Recording cancelled because this page was hidden.');
  }
});

checkServices();
