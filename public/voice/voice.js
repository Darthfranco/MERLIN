const $ = (selector) => document.querySelector(selector);
const words = $('#words');
const speakButton = $('#speak');
const recordButton = $('#record');
const stopButton = $('#stop');
const audio = $('#audio');
const activity = $('#activity');
const errorMessage = $('#error');
const timeDisplay = $('#recording-time');
const TARGET_SAMPLE_RATE = 24000;
const limits = { maxTextCharacters: 2000, maxRecordingSeconds: 60, maxAudioBytes: 2_881_024 };

let services = null;
let state = 'idle';
let operation = 0;
let requestController = null;
let recorder = null;
let recordingTimer = null;
let audioUrl = null;

const microphoneSupported = Boolean(navigator.mediaDevices?.getUserMedia && window.AudioContext && window.AudioWorkletNode);
const busyStates = new Set(['requesting', 'recording', 'finishing', 'transcribing', 'generating']);

function updateControls() {
  const busy = busyStates.has(state);
  words.readOnly = busy;
  speakButton.disabled = busy || !words.value.trim() || words.value.length > limits.maxTextCharacters || !services || services.tts?.configured === false;
  recordButton.disabled = state === 'recording' ? false : busy || !microphoneSupported || !services?.metaConfigured;
  recordButton.dataset.recording = String(state === 'recording');
  $('#record-label').textContent = state === 'recording' ? 'Stop & speak' : 'Start recording';
  stopButton.disabled = !busy && state !== 'playing';
  stopButton.textContent = busy ? 'Cancel' : 'Stop';
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
    body: JSON.stringify({ text, speed: 1 }),
    signal,
    responseType: 'audio',
  }, 190000);
  if (id !== operation) return;
  if (!blob.size || !/^audio\//.test(blob.type)) throw new Error('Kokoro returned no playable audio. Please try again.');
  removeAudio();
  audioUrl = URL.createObjectURL(blob);
  audio.src = audioUrl;
  $('#playback').hidden = false;
  $('#playback-help').textContent = 'Use the player to listen again.';
  setState('idle', 'Speech is ready.');
  try {
    await audio.play();
    if (id !== operation) audio.pause();
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
stopButton.addEventListener('click', () => cancelOperation());
$('#refresh-status').addEventListener('click', checkServices);
$('#clear').addEventListener('click', () => {
  cancelOperation('Cleared. Type or record something new.');
  removeAudio();
  words.value = '';
  clearError();
  updateControls();
  words.focus();
});
audio.addEventListener('play', () => {
  if (busyStates.has(state)) { audio.pause(); return; }
  setState('playing', 'Fenrir is speaking.');
});
audio.addEventListener('pause', () => {
  if (state === 'playing') setState('idle', audio.ended ? 'Finished. Type or record something else.' : 'Playback paused.');
});
audio.addEventListener('ended', () => {
  if (!busyStates.has(state)) setState('idle', 'Finished. Type or record something else.');
});
audio.addEventListener('error', () => {
  // A stale player error must not hide Cancel or abandon a live microphone.
  if (audioUrl && !busyStates.has(state)) reportError(new Error('The browser couldn’t play this audio. Press Speak with Fenrir to generate it again.'));
});
window.addEventListener('pagehide', () => {
  cancelOperation();
  removeAudio();
});

checkServices();
