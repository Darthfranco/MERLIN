import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceSession, VOICE_SESSION_LIMITS } from '../src/voice/session.js';
import { validateWav } from '../src/voice/audio.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

function harness(t, { limits = {}, configured = true, startPromise, respond } = {}) {
  let clock = 0, sample = 0;
  const events = [], sent = [], audio = [], uploads = [], synthesis = [], listenerCalls = [];
  const transcripts = [], voices = [];
  const listener = {
    starts: 0, closes: 0,
    async start({ signal }) { this.starts++; this.startSignal = signal; if (startPromise) await startPromise; },
    async process(pcm, options) {
      listenerCalls.push({ pcm: Buffer.from(pcm), ...options });
      const from = sample; sample += pcm.length / 2;
      const next = events.shift() || [];
      const result = await (typeof next === 'function' ? next(from, sample) : next);
      return { sample, ...(Array.isArray(result) ? { speech: false, events: result } : result) };
    },
    close() { this.closes++; },
  };
  const meta = {
    configured,
    async transcribe(wav, { signal }) {
      uploads.push({ wav, signal });
      const response = transcripts.shift() ?? 'Hello from the voice test.';
      return typeof response === 'string' ? { text: response } : await response;
    },
  };
  const tts = {
    async synthesize(text, options) {
      synthesis.push({ text, ...options });
      return await (voices.shift() ?? Buffer.alloc(48044));
    },
  };
  const session = new VoiceSession({ listener, meta, tts, respond, send: value => sent.push(value), sendAudio: value => audio.push(value), now: () => clock, limits });
  t.after(() => session.close());
  const h = {
    session, listener, sent, audio, uploads, synthesis, listenerCalls, transcripts, voices,
    get sample() { return sample; },
    now: value => { clock = value; },
    async frame(count = 8000, next = [], value = 1) {
      events.push(next);
      const pcm = Buffer.alloc(count * 2);
      for (let offset = 0; offset < pcm.length; offset += 2) pcm.writeInt16LE(value, offset);
      await session.process(pcm);
      return pcm;
    },
    async wakeOnly() {
      await h.frame(8000, (from, end) => [
        { type: 'speech_start', sample: from + 1000, startSample: from },
        { type: 'wake', sample: from + 5000, startSample: from, endSample: from + 4000 },
        { type: 'speech_end', sample: end, endSample: from + 4000 },
      ]);
    },
    async wakeStart() {
      await h.frame(8000, (from, end) => ({
        speech: true,
        events: [{ type: 'wake', sample: end, startSample: from, endSample: from + 4000 }],
      }));
    },
    async wakeAndSpeak() {
      await h.frame(8000, (from, end) => [
        { type: 'wake', sample: from + 3000, startSample: from, endSample: from + 2500 },
        { type: 'speech_end', sample: end, endSample: end },
      ], 2);
    },
    async speech({ end = true, value = 3 } = {}) {
      await h.frame(8000, (from, sampleEnd) => [
        { type: 'speech_start', sample: from + 2000, startSample: from },
        ...(end ? [{ type: 'speech_end', sample: sampleEnd, endSample: sampleEnd }] : []),
      ], value);
    },
    finishPlayback() {
      session.playback({ playing: false, revision: session.revision, utteranceId: session.utteranceId });
    },
  };
  return h;
}

test('standby noise and unrelated speech use only the bounded local detector, with zero Meta or TTS calls', async t => {
  const h = harness(t);
  await h.session.start();
  for (let index = 0; index < 24; index++) {
    await h.frame(8000, (from, end) => [
      { type: 'speech_start', sample: from + 1000, startSample: from },
      { type: 'speech_end', sample: end, endSample: end - 1000 },
    ]);
  }
  assert.equal(h.session.state, 'wake');
  assert.equal(h.uploads.length, 0);
  assert.equal(h.synthesis.length, 0);
  assert.ok(h.listenerCalls.every(call => call.keywordEnabled));
  assert.equal(h.session.ring.reduce((bytes, part) => bytes + part.pcm.length, 0), 16000 * 2 * VOICE_SESSION_LIMITS.idleBufferSeconds);
  assert.equal(h.session.capture, null);
  assert.equal(h.session.pendingPcm, null);
  assert.equal(h.sent.some(event => event.type === 'transcript'), false);
});

test('an intentional wake-only utterance may be transcribed once but produces no TTS and returns to standby after 10 seconds of silence', async t => {
  const h = harness(t);
  h.transcripts.push('Merlin.');
  await h.session.start();
  await h.wakeOnly();
  await h.session.work;
  assert.equal(h.session.state, 'followup');
  assert.equal(h.session.capture, null);
  assert.equal(h.session.pendingPcm, null);
  assert.equal(h.uploads.length, 1);
  assert.equal(h.synthesis.length, 0);
  assert.equal(h.audio.length, 0);
  assert.equal(h.sent.some(event => event.type === 'transcript'), false);
  const expiry = 10_000;
  h.now(expiry - 1); h.session.tick();
  assert.equal(h.session.state, 'followup');
  h.now(expiry); h.session.tick();
  assert.equal(h.session.state, 'wake');
  assert.equal(h.session.ring.length, 0);
  await h.speech();
  assert.equal(h.uploads.length, 1, 'speech after the window closes stays local until another wake word');
});

test('postwake speech makes one Meta request and one Fenrir echo using selected delivery', async t => {
  const h = harness(t);
  h.transcripts.push('Hey Merlin, that is so good!');
  await h.session.start({ delivery: 'lively', speed: 1.1 });
  await h.frame(8000, [], 91); // Ambient audio preceding activation must not be uploaded.
  await h.wakeAndSpeak();
  await h.session.work;
  assert.equal(h.uploads.length, 1);
  const wav = validateWav(h.uploads[0].wav);
  assert.equal(wav.sampleRate, 16000);
  assert.equal(wav.durationMs, 500);
  for (let offset = 44; offset < wav.audio.length; offset += 2) assert.equal(wav.audio.readInt16LE(offset), 2);
  assert.equal(h.synthesis.length, 1);
  assert.equal(h.synthesis[0].text, 'that is so good!');
  assert.equal(h.synthesis[0].delivery, 'lively');
  assert.equal(h.synthesis[0].speed, 1.1);
  assert.equal(h.audio.length, 1);
  assert.equal(h.session.state, 'speaking');
});

test('a separate request after a wake-only utterance uploads only that new speech', async t => {
  const h = harness(t);
  h.transcripts.push('Merlin.', 'Read these words.');
  await h.session.start();
  await h.wakeOnly();
  await h.session.work;
  assert.equal(h.synthesis.length, 0);
  await h.speech({ value: 47 });
  await h.session.work;
  assert.equal(h.uploads.length, 2);
  assert.equal(h.synthesis[0].text, 'Read these words.');
  for (let offset = 44; offset < h.uploads[1].wav.length; offset += 2) assert.equal(h.uploads[1].wav.readInt16LE(offset), 47);
  assert.equal(h.listenerCalls.at(-1).keywordEnabled, false);
});

test('a short word after MERLIN is not discarded when keyword timing overlaps the end of the request', async t => {
  const h = harness(t);
  h.transcripts.push('Merlin, hi.');
  await h.session.start();
  await h.frame(8000, (from, end) => [
    // Keyword detector timestamps can extend into a short following word.
    { type: 'wake', sample: from + 7000, startSample: from, endSample: from + 7000 },
    { type: 'speech_end', sample: end, endSample: from + 7200 },
  ]);
  await h.session.work;
  assert.equal(h.uploads.length, 1);
  assert.equal(h.synthesis[0].text, 'hi.');
});

test('continuous speech after activation can exceed the follow-up silence window', async t => {
  const h = harness(t);
  await h.session.start();
  await h.frame(8000, (from, end) => ({
    speech: true,
    events: [{ type: 'wake', sample: end, startSample: from, endSample: from + 4000 }],
  }));
  for (let index = 1; index <= Math.ceil(VOICE_SESSION_LIMITS.followupMs / 500) + 2; index++) {
    h.now(index * 500);
    await h.frame(8000, { speech: true, events: [] });
  }
  assert.equal(h.session.state, 'listening');
  assert.equal(h.uploads.length, 0);
  assert.ok(h.session.capture.bytes > VOICE_SESSION_LIMITS.followupMs / 1000 * 16000 * 2);
  h.transcripts.push('Merlin, a longer synthetic speech turn.');
  await h.frame(8000, (_from, end) => [{ type: 'speech_end', sample: end, endSample: end - 4000 }]);
  await h.session.work;
  assert.equal(h.uploads.length, 1);
  assert.equal(h.synthesis[0].text, 'a longer synthetic speech turn.');
});

test('follow-up speech needs no repeated wake word, and a full quiet window returns to local standby', async t => {
  const h = harness(t);
  h.transcripts.push('Merlin, first sentence.', 'Second sentence.');
  await h.session.start();
  await h.wakeAndSpeak(); await h.session.work;
  h.finishPlayback();
  assert.equal(h.session.state, 'followup');
  const resumedAt = VOICE_SESSION_LIMITS.longPauseMs - 1;
  h.now(resumedAt);
  await h.speech(); await h.session.work;
  assert.equal(h.synthesis[1].text, 'Second sentence.');
  assert.equal(h.uploads.length, 2);
  h.finishPlayback();
  const expiry = resumedAt + 10_000;
  h.now(expiry - 1); h.session.tick(); assert.equal(h.session.state, 'followup');
  h.now(expiry); h.session.tick(); assert.equal(h.session.state, 'wake');
  await h.speech();
  assert.equal(h.uploads.length, 2);
  assert.equal(h.synthesis.length, 2);
});

test('speech during pending transcription aborts it and discards late transcript or audio', async t => {
  const h = harness(t), stale = deferred();
  h.transcripts.push(stale.promise, 'Merlin, first words and some more.');
  await h.session.start();
  await h.wakeAndSpeak();
  const oldWork = h.session.work;
  assert.equal(h.session.state, 'transcribing');
  const firstSamples = Buffer.from(h.uploads[0].wav.subarray(44));
  await h.speech({ end: false, value: 6 });
  assert.equal(h.uploads[0].signal.aborted, true);
  assert.equal(h.session.state, 'listening');
  stale.resolve({ text: 'PRIVATE STALE RESULT' }); await oldWork;
  assert.equal(h.audio.length, 0);
  assert.equal(h.synthesis.length, 0);
  assert.equal(h.sent.some(event => event.text?.includes('STALE')), false);
  await h.frame(4000, (_from, end) => [{ type: 'speech_end', sample: end, endSample: end }], 7);
  await h.session.work;
  assert.equal(h.uploads.length, 2);
  assert.ok(h.uploads[1].wav.subarray(44).subarray(0, firstSamples.length).equals(firstSamples));
  assert.equal(h.synthesis[0].text, 'first words and some more.', 'a continued first utterance must still strip its wake word');
  assert.equal(h.audio.length, 1);
});

test('speech during pending synthesis cancels old output and combines unfinished speech', async t => {
  const h = harness(t), stale = deferred();
  h.transcripts.push('Merlin, first words.', 'Merlin, first words plus more.');
  h.voices.push(stale.promise);
  await h.session.start();
  await h.wakeAndSpeak(); await flush();
  assert.equal(h.session.state, 'generating');
  const oldWork = h.session.work;
  await h.speech();
  assert.equal(h.synthesis[0].signal.aborted, true);
  stale.resolve(Buffer.alloc(96044)); await oldWork;
  await h.session.work;
  assert.equal(h.synthesis.length, 2);
  assert.equal(h.synthesis[1].text, 'first words plus more.');
  assert.equal(h.audio.length, 1);
  assert.equal(h.audio[0].length, 48044);
});

test('interrupting audible playback starts a fresh turn and ignores stale playback receipts', async t => {
  const h = harness(t);
  h.transcripts.push('Merlin, first.', 'New words.');
  await h.session.start();
  await h.wakeAndSpeak(); await h.session.work;
  const oldReceipt = { playing: false, revision: h.session.revision, utteranceId: h.session.utteranceId };
  const interruptCount = h.sent.filter(event => event.type === 'interrupt').length;
  await h.speech({ end: false, value: 21 });
  assert.equal(h.session.state, 'listening');
  assert.equal(h.sent.filter(event => event.type === 'interrupt').length, interruptCount + 1);
  h.session.playback(oldReceipt);
  assert.equal(h.session.state, 'listening');
  await h.frame(4000, (_from, end) => [{ type: 'speech_end', sample: end, endSample: end }], 21);
  await h.session.work;
  assert.equal(h.synthesis[1].text, 'New words.');
  for (let offset = 44; offset < h.uploads[1].wav.length; offset += 2) assert.equal(h.uploads[1].wav.readInt16LE(offset), 21);
  assert.equal(h.audio.length, 2);
});

test('goodbye, thanks, and former end phrases echo normally without ending a conversation', async t => {
  for (const phrase of ['stop listening.', 'thanks, that’s all!', 'end the conversation.', 'go to sleep.', 'goodbye.', 'bye Merlin!', 'thanks Merlin.']) {
    const h = harness(t);
    h.transcripts.push(`Merlin, ${phrase}`);
    await h.session.start();
    await h.wakeAndSpeak(); await h.session.work;
    assert.equal(h.session.state, 'speaking', phrase);
    assert.equal(h.uploads.length, 1);
    assert.equal(h.synthesis.length, 1);
    assert.equal(h.synthesis[0].text, phrase);
    assert.equal(h.audio.length, 1);
    assert.equal(h.session.capture, null);
    assert.equal(h.session.pendingPcm, null);
    h.finishPlayback();
    assert.equal(h.session.state, 'followup');
    assert.equal(h.session.deadline, VOICE_SESSION_LIMITS.followupMs - VOICE_SESSION_LIMITS.onsetGraceMs);
  }
});

test('mentioning an end phrase inside a sentence still echoes the sentence', async t => {
  const h = harness(t);
  h.transcripts.push('Merlin, the phrase stop listening is useful.');
  await h.session.start(); await h.wakeAndSpeak(); await h.session.work;
  assert.equal(h.session.state, 'speaking');
  assert.equal(h.synthesis[0].text, 'the phrase stop listening is useful.');
});

test('a late follow-up earns extra thinking time, then an ordinary turn restores the normal quiet window', async t => {
  const h = harness(t);
  await h.session.start(); await h.wakeAndSpeak(); await h.session.work;
  h.finishPlayback();
  h.now(VOICE_SESSION_LIMITS.longPauseMs);
  await h.speech(); await h.session.work; h.finishPlayback();
  const extendedDeadline = VOICE_SESSION_LIMITS.longPauseMs + VOICE_SESSION_LIMITS.extendedFollowupMs - VOICE_SESSION_LIMITS.onsetGraceMs;
  assert.equal(h.session.deadline, extendedDeadline);
  h.now(VOICE_SESSION_LIMITS.longPauseMs + 1000);
  await h.speech(); await h.session.work; h.finishPlayback();
  assert.equal(h.session.deadline, VOICE_SESSION_LIMITS.longPauseMs + 1000 + VOICE_SESSION_LIMITS.followupMs - VOICE_SESSION_LIMITS.onsetGraceMs);
  assert.equal(h.uploads.length, 3);
});

test('interrupting playback extends the next quiet window to at most 15 seconds without changing provider call counts', async t => {
  const h = harness(t);
  await h.session.start(); await h.wakeAndSpeak(); await h.session.work;
  h.now(1000);
  await h.speech(); await h.session.work; h.finishPlayback();
  assert.equal(h.session.deadline, 1000 + VOICE_SESSION_LIMITS.extendedFollowupMs - VOICE_SESSION_LIMITS.onsetGraceMs);
  h.now(1000 + 15_000 - 1);
  h.session.tick();
  assert.equal(h.session.state, 'followup');
  h.now(1000 + 15_000);
  h.session.tick();
  assert.equal(h.session.state, 'wake');
  assert.equal(h.uploads.length, 2);
  assert.equal(h.synthesis.length, 2);
});

test('continuing during transcription or generation earns extra quiet time after the completed reply', async t => {
  for (const phase of ['transcribing', 'generating']) {
    const h = harness(t), pending = deferred();
    if (phase === 'transcribing') h.transcripts.push(pending.promise);
    else h.voices.push(pending.promise);
    await h.session.start(); await h.wakeAndSpeak(); await flush();
    assert.equal(h.session.state, phase);
    const oldWork = h.session.work;
    h.now(1000);
    await h.speech(); await h.session.work;
    pending.resolve(phase === 'transcribing' ? { text: 'Cancelled old text.' } : Buffer.alloc(48044));
    await oldWork;
    h.finishPlayback();
    assert.equal(h.session.deadline, 1000 + VOICE_SESSION_LIMITS.extendedFollowupMs - VOICE_SESSION_LIMITS.onsetGraceMs);
    assert.equal(h.audio.length, 1);
    assert.equal(h.uploads.length, 2);
  }
});

test('sleep and a new wake discard timing context from the previous conversation', async t => {
  const h = harness(t);
  await h.session.start(); await h.wakeAndSpeak(); await h.session.work;
  await h.speech(); await h.session.work; h.finishPlayback();
  assert.equal(h.session.deadline, VOICE_SESSION_LIMITS.extendedFollowupMs - VOICE_SESSION_LIMITS.onsetGraceMs);
  h.session.sleep();
  h.now(1000);
  await h.wakeAndSpeak(); await h.session.work; h.finishPlayback();
  assert.equal(h.session.deadline, 1000 + VOICE_SESSION_LIMITS.followupMs - VOICE_SESSION_LIMITS.onsetGraceMs);
});

test('provider generation time does not consume the quiet window after playback', async t => {
  const h = harness(t), synthesis = deferred();
  h.voices.push(synthesis.promise);
  await h.session.start(); await h.wakeAndSpeak(); await flush();
  assert.equal(h.session.state, 'generating');
  h.now(60_000); h.session.tick();
  assert.equal(h.session.state, 'generating');
  synthesis.resolve(Buffer.alloc(48044)); await h.session.work;
  h.finishPlayback();
  assert.equal(h.session.deadline, 60_000 + VOICE_SESSION_LIMITS.followupMs - VOICE_SESSION_LIMITS.onsetGraceMs);
  h.now(60_000 + VOICE_SESSION_LIMITS.followupMs);
  h.session.tick();
  assert.equal(h.session.state, 'wake');
  assert.equal(h.uploads.length, 1);
});

test('duplicate playback completion cannot extend quiet time, while replay starts a fresh quiet window', async t => {
  const h = harness(t);
  await h.session.start(); await h.wakeAndSpeak(); await h.session.work;
  const receipt = { revision: h.session.revision, utteranceId: h.session.utteranceId };
  h.finishPlayback();
  h.now(5000); h.finishPlayback();
  assert.equal(h.session.deadline, VOICE_SESSION_LIMITS.followupMs - VOICE_SESSION_LIMITS.onsetGraceMs);
  h.session.playback({ ...receipt, playing: true });
  assert.equal(h.session.state, 'speaking');
  h.now(6000); h.session.playback({ ...receipt, playing: false });
  assert.equal(h.session.state, 'followup');
  assert.equal(h.session.deadline, 6000 + VOICE_SESSION_LIMITS.followupMs - VOICE_SESSION_LIMITS.onsetGraceMs);
  assert.equal(h.uploads.length, 1);
  assert.equal(h.synthesis.length, 1);
});

test('brief rejected noise preserves the original quiet deadline and timing budget', async t => {
  for (const extended of [false, true]) {
    const h = harness(t);
    await h.session.start(); await h.wakeAndSpeak(); await h.session.work;
    if (extended) { await h.speech(); await h.session.work; }
    h.finishPlayback();
    const deadline = h.session.deadline;
    const uploads = h.uploads.length;
    h.now(VOICE_SESSION_LIMITS.longPauseMs + 1000);
    await h.frame(1280, (from, end) => [
      { type: 'speech_start', sample: end, startSample: from },
      { type: 'speech_end', sample: end, endSample: from + 800 },
    ]);
    assert.equal(h.session.state, 'followup');
    assert.equal(h.session.deadline, deadline);
    assert.equal(h.uploads.length, uploads);
    h.now(deadline + VOICE_SESSION_LIMITS.onsetGraceMs); h.session.tick();
    assert.equal(h.session.state, 'wake');
    assert.equal(h.uploads.length, uploads);
  }
});

test('speech detected just after the nominal quiet deadline keeps the conversation open', async t => {
  const h = harness(t), detector = deferred();
  await h.session.start(); await h.wakeAndSpeak(); await h.session.work;
  h.finishPlayback();
  const deadline = h.session.deadline;
  h.now(deadline - 10);
  const from = h.sample;
  const frame = h.frame(1280, () => detector.promise);
  h.now(deadline + 300); h.session.tick();
  assert.equal(h.session.state, 'followup');
  detector.resolve({ speech: true, events: [{ type: 'speech_start', sample: from + 1280, startSample: from }] });
  await frame;
  assert.equal(h.session.state, 'listening');
  assert.equal(h.session.deadline, null);
  await h.frame(8000, (_from, end) => [{ type: 'speech_end', sample: end, endSample: end }]);
  await h.session.work; h.finishPlayback();
  assert.equal(h.uploads.length, 2);
  assert.equal(h.session.deadline, deadline + 300 + VOICE_SESSION_LIMITS.extendedFollowupMs - VOICE_SESSION_LIMITS.onsetGraceMs);
});

test('speech at the 10-second quiet limit remains local until another wake', async t => {
  const h = harness(t);
  await h.session.start(); await h.wakeAndSpeak(); await h.session.work;
  h.finishPlayback();
  h.now(10_000);
  await h.speech();
  assert.equal(h.session.state, 'wake');
  assert.equal(h.uploads.length, 1);
  assert.equal(h.synthesis.length, 1);
  assert.equal(h.listenerCalls.at(-1).keywordEnabled, true);
});

test('manual sleep overrides a delayed speech onset during the quiet timeout grace', async t => {
  const h = harness(t), detector = deferred();
  await h.session.start(); await h.wakeAndSpeak(); await h.session.work;
  h.finishPlayback();
  const deadline = h.session.deadline;
  h.now(deadline - 10);
  const from = h.sample;
  const frame = h.frame(1280, () => detector.promise);
  h.now(deadline + 300); h.session.sleep();
  const revision = h.session.revision;
  detector.resolve({ speech: true, events: [{ type: 'speech_start', sample: from + 1280, startSample: from }] });
  await frame;
  assert.equal(h.session.state, 'wake');
  assert.equal(h.session.revision, revision);
  assert.equal(h.session.capture, null);
  assert.equal(h.session.ring.length, 0);
  assert.equal(h.uploads.length, 1);
  assert.equal(h.synthesis.length, 1);
});

test('turn-length and maximum conversation boundaries discard audio and return to local wake mode', async t => {
  const h = harness(t, { limits: { maxUtteranceSeconds: 1 } });
  await h.session.start(); await h.wakeStart();
  await h.speech({ end: false });
  await h.frame();
  assert.equal(h.session.state, 'wake');
  assert.equal(h.uploads.length, 0);
  assert.equal(h.session.capture, null);
  assert.equal(h.session.ring.length, 0);

  await h.wakeStart();
  h.now(VOICE_SESSION_LIMITS.maxConversationMs); h.session.tick();
  assert.equal(h.session.state, 'wake');
  assert.equal(h.uploads.length, 0);
});

test('an utterance exceeding the length cap on its end frame never reaches Meta', async t => {
  const h = harness(t, { limits: { maxUtteranceSeconds: 0.4 } });
  await h.session.start(); await h.wakeAndSpeak();
  assert.equal(h.session.state, 'wake');
  assert.equal(h.uploads.length, 0);
  assert.equal(h.synthesis.length, 0);
});

test('conversation time expiry aborts pending work and no late provider result is delivered', async t => {
  const h = harness(t), stale = deferred();
  h.transcripts.push(stale.promise);
  await h.session.start(); await h.wakeAndSpeak();
  const work = h.session.work;
  h.now(VOICE_SESSION_LIMITS.maxConversationMs); h.session.tick();
  assert.equal(h.session.state, 'wake');
  assert.equal(h.uploads[0].signal.aborted, true);
  stale.resolve({ text: 'Should not be spoken.' }); await work;
  assert.equal(h.synthesis.length, 0);
  assert.equal(h.audio.length, 0);
});

test('continued captures share one utterance length bound rather than growing without limit', async t => {
  const h = harness(t, { limits: { maxUtteranceSeconds: 1 } }), pending = [deferred(), deferred()];
  h.transcripts.push(...pending.map(item => item.promise));
  await h.session.start(); await h.wakeAndSpeak();
  await h.speech();
  assert.equal(h.uploads.length, 2);
  await h.speech();
  assert.equal(h.uploads.length, 2);
  assert.equal(h.session.state, 'wake');
  assert.equal(h.session.capture, null);
  assert.equal(h.session.pendingPcm, null);
  for (const item of pending) item.resolve({ text: 'Cancelled.' });
  await flush();
  assert.equal(h.synthesis.length, 0);
});

test('completed turn budget returns to wake mode instead of allowing another follow-up', async t => {
  const h = harness(t, { limits: { maxTurns: 2 } });
  await h.session.start(); await h.wakeAndSpeak(); await h.session.work;
  h.finishPlayback(); await h.speech(); await h.session.work; h.finishPlayback();
  assert.equal(h.session.state, 'wake');
  await h.speech();
  assert.equal(h.uploads.length, 2);
});

test('turn budget also limits repeated interruptions before any reply completes', async t => {
  const h = harness(t, { limits: { maxTurns: 2 } }), pending = [deferred(), deferred(), deferred()];
  h.transcripts.push(...pending.map(item => item.promise));
  await h.session.start(); await h.wakeAndSpeak();
  await h.speech(); await h.speech();
  assert.equal(h.uploads.length, 2, 'interrupted uploads count toward the conversation cost bound');
  assert.equal(h.session.state, 'wake');
  for (const item of pending) item.resolve({ text: 'Late result.' });
  await flush();
  assert.equal(h.synthesis.length, 0);
});

test('expired conversation cannot start an upload on the frame that detects speech end', async t => {
  const h = harness(t, { limits: { maxConversationMs: 1000 } });
  await h.session.start(); await h.wakeStart();
  await h.speech({ end: false });
  h.now(1000);
  await h.frame(4000, (_from, end) => [{ type: 'speech_end', sample: end, endSample: end }]);
  assert.equal(h.uploads.length, 0);
  assert.equal(h.session.state, 'wake');
});

test('closing aborts active transcription and releases local capture without allowing late output', async t => {
  const h = harness(t), stale = deferred();
  h.transcripts.push(stale.promise);
  await h.session.start(); await h.wakeAndSpeak();
  const work = h.session.work, count = h.sent.length;
  h.session.close();
  assert.equal(h.session.state, 'off');
  assert.equal(h.listener.closes, 1);
  assert.equal(h.listener.startSignal.aborted, true);
  assert.equal(h.uploads[0].signal.aborted, true);
  assert.equal(h.session.capture, null);
  assert.equal(h.session.pendingPcm, null);
  assert.equal(h.session.ring.length, 0);
  stale.resolve({ text: 'Late.' }); await work;
  await h.frame();
  h.session.close();
  assert.equal(h.listener.closes, 1);
  assert.equal(h.sent.length, count);
  assert.equal(h.audio.length, 0);
  assert.equal(h.synthesis.length, 0);
});

test('closing during listener startup prevents a late ready state', async t => {
  const startup = deferred(), h = harness(t, { startPromise: startup.promise });
  const start = h.session.start();
  h.session.close(); startup.resolve(); await start;
  assert.equal(h.session.state, 'off');
  assert.equal(h.sent.length, 0);
  assert.equal(h.listener.startSignal.aborted, true);
});

test('manual sleep discards a pending detector result without losing alignment or reactivating on an old wake match', async t => {
  const h = harness(t), detector = deferred();
  await h.session.start();
  const pendingFrame = h.frame(8000, () => detector.promise);
  assert.equal(h.listenerCalls.length, 1);
  h.session.sleep();
  const revision = h.session.revision;
  detector.resolve({ speech: false, events: [
    { type: 'wake', sample: 5000, startSample: 0, endSample: 4000 },
    { type: 'speech_end', sample: 8000, endSample: 7200 },
  ] });
  await pendingFrame;
  assert.equal(h.session.state, 'wake');
  assert.equal(h.session.revision, revision, 'a result from before sleep cannot start another conversation');
  assert.equal(h.session.capture, null);
  assert.equal(h.session.ring.length, 0);
  assert.equal(h.uploads.length, 0);
  assert.equal(h.synthesis.length, 0);
  assert.equal(h.session.sample, 8000, 'discarded events must still advance the sample clock');
  await h.frame(1280);
  assert.equal(h.session.sample, 9280);
  h.transcripts.push('Merlin, a fresh request.');
  await h.wakeAndSpeak(); await h.session.work;
  assert.equal(h.uploads.length, 1);
  assert.equal(h.synthesis[0].text, 'a fresh request.');
});

test('invalid configuration and audio fail before provider work, and provider diagnostics stay private', async t => {
  const h = harness(t);
  assert.throws(() => h.session.configure({ delivery: 'sad' }), /Choose natural/);
  assert.throws(() => h.session.configure({ speed: Infinity }), /speech speed/i);
  await h.session.start();
  for (const pcm of [Buffer.alloc(0), Buffer.alloc(3), Buffer.alloc(16002), 'audio']) {
    await assert.rejects(h.session.process(pcm), /Invalid local microphone frame/);
  }
  assert.equal(h.listenerCalls.length, 0);
  const rejected = deferred(); h.transcripts.push(rejected.promise);
  await h.wakeAndSpeak();
  rejected.reject(new Error('PRIVATE provider text')); await h.session.work;
  assert.equal(h.session.state, 'followup');
  assert.ok(h.sent.some(event => event.type === 'error'));
  assert.equal(JSON.stringify(h.sent).includes('PRIVATE'), false);
  assert.equal(h.synthesis.length, 0);
});

test('unconfigured Meta does not open the microphone listener', async t => {
  const h = harness(t, { configured: false });
  await assert.rejects(h.session.start(), error => error.status === 503);
  assert.equal(h.listener.starts, 0);
  assert.equal(h.uploads.length, 0);
});

const assistantContext = { sessionId: '12345678-1234-1234-1234-123456789abc', timeZone: 'America/New_York' };

test('assistant voice validates context before starting and standby never invokes the responder', async t => {
  const calls = [], h = harness(t, { respond: (...args) => calls.push(args) });
  await assert.rejects(h.session.start(), /identifier/);
  await assert.rejects(h.session.start({ ...assistantContext, timeZone: 'invalid' }), /time zone/);
  assert.equal(h.listener.starts, 0);
  await h.session.start(assistantContext);
  await h.speech();
  assert.equal(calls.length, 0);
  assert.equal(h.uploads.length, 0);
});

test('assistant voice passes one exact transcript and speaks only the checked response with revision-tagged progress', async t => {
  const calls = [], h = harness(t, { respond: async (text, context) => {
    calls.push({ text, ...context });
    context.onProgress({ stage: 'action', domain: 'timer' });
    return { reply: 'Your tea timer is set.', tool_events: [{ tool: 'create_timer', status: 'completed' }] };
  } });
  h.transcripts.push('Merlin, start my tea timer.');
  await h.session.start(assistantContext); await h.wakeAndSpeak(); await h.session.work;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, 'start my tea timer.');
  assert.equal(calls[0].sessionId, assistantContext.sessionId);
  assert.equal(calls[0].timeZone, assistantContext.timeZone);
  assert.match(calls[0].requestId, /^[a-f0-9-]{36}$/);
  assert.equal(h.synthesis[0].text, 'Your tea timer is set.');
  const events = h.sent.filter(event => ['transcript', 'progress', 'response'].includes(event.type));
  assert.deepEqual(events.map(event => event.type), ['transcript', 'progress', 'response']);
  assert.ok(events.every(event => event.revision === h.session.revision && event.requestId === calls[0].requestId));
  assert.equal(events.at(-1).response.tool_events[0].status, 'completed');
});

test('assistant interruption after execution begins never replays prior command audio or stale progress and response', async t => {
  const pending = deferred(), calls = [];
  const h = harness(t, { respond: async (text, context) => {
    calls.push({ text, ...context });
    return calls.length === 1 ? await pending.promise : { reply: 'Here is the next answer.' };
  } });
  h.transcripts.push('Merlin, start a timer.', 'How many timers are running?');
  await h.session.start(assistantContext); await h.wakeAndSpeak(); await flush();
  const oldWork = h.session.work;
  assert.equal(h.session.state, 'processing');
  assert.equal(h.session.pendingPcm, null);
  await h.speech({ value: 47 });
  await h.session.work;
  assert.equal(calls[0].signal.aborted, true);
  calls[0].onProgress({ stage: 'PRIVATE STALE PROGRESS' });
  pending.resolve({ reply: 'PRIVATE STALE RESPONSE' }); await oldWork;
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].requestId, calls[1].requestId);
  for (let offset = 44; offset < h.uploads[1].wav.length; offset += 2) assert.equal(h.uploads[1].wav.readInt16LE(offset), 47);
  assert.equal(JSON.stringify(h.sent).includes('PRIVATE'), false);
  assert.deepEqual(h.synthesis.map(item => item.text), ['Here is the next answer.']);
});

test('assistant interruption while synthesizing starts a new turn instead of replaying an executed request', async t => {
  const pending = deferred(), calls = [];
  const h = harness(t, { respond: async text => { calls.push(text); return { reply: `Answered: ${text}` }; } });
  h.transcripts.push('Merlin, set a timer.', 'Cancel that timer.');
  h.voices.push(pending.promise);
  await h.session.start(assistantContext); await h.wakeAndSpeak(); await flush();
  const oldWork = h.session.work;
  assert.equal(h.session.state, 'generating');
  await h.speech({ value: 29 }); await h.session.work;
  pending.resolve(Buffer.alloc(48044)); await oldWork;
  assert.deepEqual(calls, ['set a timer.', 'Cancel that timer.']);
  for (let offset = 44; offset < h.uploads[1].wav.length; offset += 2) assert.equal(h.uploads[1].wav.readInt16LE(offset), 29);
  assert.equal(h.synthesis[0].signal.aborted, true);
  assert.equal(h.audio.length, 1);
});

test('assistant continuation during transcription still combines unfinished audio before any execution', async t => {
  const pending = deferred(), calls = [];
  const h = harness(t, { respond: async text => { calls.push(text); return { reply: 'Done.' }; } });
  h.transcripts.push(pending.promise, 'Merlin, set a five minute timer.');
  await h.session.start(assistantContext); await h.wakeAndSpeak();
  const oldWork = h.session.work;
  await h.speech({ value: 7 }); await h.session.work;
  pending.resolve({ text: 'Merlin, set a five' }); await oldWork;
  assert.deepEqual(calls, ['set a five minute timer.']);
  assert.equal(h.uploads[1].wav.readInt16LE(44), 2);
  assert.equal(h.uploads[0].signal.aborted, true);
});

test('explicit voice interruption cancels assistant work and preserves the bounded follow-up window', async t => {
  const pending = deferred(), calls = [];
  const h = harness(t, { respond: async (_text, context) => { calls.push(context); return await pending.promise; } });
  await h.session.start(assistantContext); await h.wakeAndSpeak(); await flush();
  const oldWork = h.session.work;
  h.session.interrupt();
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(h.session.state, 'followup');
  assert.equal(h.session.deadline, 15_000 - VOICE_SESSION_LIMITS.onsetGraceMs);
  pending.resolve({ reply: 'Late reply.' }); await oldWork;
  assert.equal(h.synthesis.length, 0);
  assert.equal(h.sent.some(event => event.type === 'response'), false);
});

test('long assistant answers remain on screen without silently changing their checked spoken wording', async t => {
  const reply = 'A'.repeat(2001);
  const h = harness(t, { respond: async () => ({ reply }) });
  await h.session.start(assistantContext); await h.wakeAndSpeak(); await h.session.work;
  assert.equal(h.sent.find(event => event.type === 'response').response.reply, reply);
  assert.equal(h.synthesis.length, 0);
  assert.equal(h.session.state, 'followup');
  assert.match(h.sent.find(event => event.type === 'error').message, /on screen/);
});

test('timer notification speaks a checked body-mode receipt without transcription, reasoning, or follow-up activation', async t => {
  const calls = [], h = harness(t, { respond: (...args) => calls.push(args) });
  await h.session.start(assistantContext);
  const panel = { type: 'timer', id: 'synthetic', status: 'completed' };
  assert.equal(h.session.announce('Your tea timer is finished.', [panel]), true);
  await h.session.work;
  assert.equal(h.uploads.length, 0);
  assert.equal(calls.length, 0);
  assert.equal(h.synthesis[0].text, 'Your tea timer is finished.');
  assert.equal(h.sent.find(event => event.type === 'notification').response.presentation[0], panel);
  assert.equal(h.sent.find(event => event.type === 'audio').presentationMode, 'body');
  assert.equal(h.sent.find(event => event.type === 'interrupt').reason, 'notification');
  h.finishPlayback();
  assert.equal(h.session.state, 'wake');
  await h.speech();
  assert.equal(h.uploads.length, 0);
});

test('timer notification pauses the existing follow-up quiet budget without restarting it', async t => {
  const h = harness(t);
  h.transcripts.push('Merlin.');
  await h.session.start(); await h.wakeOnly(); await h.session.work;
  h.now(2000);
  assert.equal(h.session.announce('Your timer is finished.', []), true);
  await h.session.work;
  h.now(5000); h.finishPlayback();
  assert.equal(h.session.state, 'followup');
  assert.equal(h.session.deadline + VOICE_SESSION_LIMITS.onsetGraceMs, 13_000);
  h.now(12_999); h.session.tick(); assert.equal(h.session.state, 'followup');
  h.now(13_000); h.session.tick(); assert.equal(h.session.state, 'wake');
  assert.equal(h.uploads.length, 1, 'the alert made no new transcription request');
});

test('timer notifications defer silently during active listening or assistant processing', async t => {
  const pending = deferred(), h = harness(t, { respond: async () => await pending.promise });
  await h.session.start(assistantContext); await h.wakeStart();
  assert.equal(h.session.announce('Your timer is finished.', []), false);
  await h.frame(8000, (_from, end) => [{ type: 'speech_end', sample: end, endSample: end }]); await flush();
  assert.equal(h.session.state, 'processing');
  assert.equal(h.session.announce('Your timer is finished.', []), false);
  assert.equal(h.sent.some(event => event.type === 'notification'), false);
  pending.resolve({ reply: 'Current reply.' }); await h.session.work;
  assert.equal(h.synthesis.length, 1);
});

test('unrelated speech interrupts a wake-origin timer alert but never becomes a cloud utterance', async t => {
  const pending = deferred(), h = harness(t);
  h.voices.push(pending.promise);
  await h.session.start(); h.session.announce('Your timer is finished.', []);
  const oldWork = h.session.work;
  await h.speech();
  assert.equal(h.session.state, 'wake');
  assert.equal(h.synthesis[0].signal.aborted, true);
  assert.equal(h.listenerCalls[0].keywordEnabled, true);
  assert.equal(h.uploads.length, 0);
  pending.resolve(Buffer.alloc(48044)); await oldWork;
  assert.equal(h.audio.length, 0);
});

test('MERLIN can interrupt a timer alert into a fresh directed request without losing wake audio', async t => {
  const pending = deferred(), h = harness(t);
  h.voices.push(pending.promise);
  h.transcripts.push('Merlin, hello.');
  await h.session.start(); h.session.announce('Your timer is finished.', []);
  const oldWork = h.session.work;
  await h.wakeAndSpeak(); await h.session.work;
  pending.resolve(Buffer.alloc(48044)); await oldWork;
  assert.equal(h.uploads.length, 1);
  assert.equal(h.synthesis[1].text, 'hello.');
  assert.equal(h.audio.length, 1);
  assert.equal(h.session.state, 'speaking');
});

test('explicit Stop and close cancel pending timer speech without permitting a late clip or ambient follow-up', async t => {
  for (const close of [false, true]) {
    const pending = deferred(), h = harness(t); h.voices.push(pending.promise);
    await h.session.start(); h.session.announce('Your timer is finished.', []);
    const oldWork = h.session.work;
    if (close) h.session.close(); else h.session.interrupt();
    assert.equal(h.synthesis[0].signal.aborted, true);
    pending.resolve(Buffer.alloc(48044)); await oldWork;
    assert.equal(h.audio.length, 0);
    assert.equal(h.session.state, close ? 'off' : 'wake');
    assert.equal(h.uploads.length, 0);
  }
});

test('checked typed read-aloud uses face mode with its own cancellation reason and no assistant call', async t => {
  const h = harness(t);
  await h.session.start();
  assert.equal(h.session.announce('Checked typed answer.', [], { presentationMode: 'face', kind: 'reply', requestId: assistantContext.sessionId }), true);
  await h.session.work;
  assert.equal(h.uploads.length, 0);
  assert.equal(h.sent.find(event => event.type === 'interrupt').reason, 'reply-audio');
  assert.equal(h.sent.find(event => event.type === 'notification').kind, 'reply');
  const audio = h.sent.find(event => event.type === 'audio');
  assert.equal(audio.presentationMode, 'face');
  assert.equal(audio.requestId, assistantContext.sessionId);
  h.finishPlayback();
  assert.equal(h.sent.filter(event => event.type === 'interrupt').at(-1).reason, 'reply-audio-ended');
  assert.equal(h.session.state, 'wake');
});
