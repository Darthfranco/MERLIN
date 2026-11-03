import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AcknowledgmentCoordinator, AcknowledgmentPlayer, loadAcknowledgmentClips } from '../public/companion/acknowledgments.js';
import { ACKNOWLEDGMENT_TIMING } from '../src/acknowledgments.js';

const flush = () => new Promise(setImmediate);
const CLIPS = ['ack_01', 'ack_02', 'ack_03', 'ack_04', 'ack_05'].map(id => ({ id, url: `blob:${id}`, durationMs: 3000 }));
const policy = (clips = CLIPS.map(clip => clip.id), version = 'v1') => ({ version, clips });

function fixture({ clips = CLIPS, cooldownMs = 3000, play } = {}) {
  let clock = 0, nextId = 1;
  const pending = new Map(), reports = [], handlers = new Map();
  const audio = {
    src: '', currentSrc: '', paused: true, ended: false, currentTime: 0, plays: [], pauses: 0,
    addEventListener(name, fn) { handlers.set(name, [...(handlers.get(name) || []), fn]); },
    dispatch(name) { for (const fn of handlers.get(name) || []) fn({}); },
    play() { this.currentSrc = this.src; this.paused = false; this.ended = false; this.plays.push(this.src); return play ? play(this) : Promise.resolve(); },
    pause() { this.pauses++; if (!this.paused) { this.paused = true; this.dispatch('pause'); } },
    removeAttribute(name) { if (name === 'src') this.src = ''; },
    load() { if (!this.src) this.currentSrc = ''; },
    // What a browser does at the natural end of a clip: pause, then ended.
    finishNaturally() { this.ended = true; this.paused = true; this.dispatch('pause'); this.dispatch('ended'); },
  };
  const coordinator = new AcknowledgmentCoordinator({
    player: new AcknowledgmentPlayer(audio), cooldownMs, graceMs: 200,
    onAudible: (audible, detail) => reports.push({ audible, ...detail }),
    now: () => clock, random: () => 0.42,
    setTimer: (fn, ms) => { const id = nextId++; pending.set(id, { at: clock + ms, fn }); return id; },
    clearTimer: id => pending.delete(id),
  });
  coordinator.setClips('v1', clips);
  return {
    coordinator, audio, reports, pending,
    advance(ms) {
      const end = clock + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]); clock = Math.max(clock, due[1].at); due[1].fn();
      }
      clock = end;
    },
    /** Plays one complete turn and returns the clip that was heard, if any. */
    turn(key, { allowed = policy(), wait = 200 } = {}) {
      coordinator.arm(key, { token: 1 });
      coordinator.allow(key, allowed);
      this.advance(wait);
      const src = audio.src;
      if (src) { audio.dispatch('playing'); audio.finishNaturally(); }
      return src;
    },
  };
}

test('the request is not waited on: the timer arms immediately and a slow reply gets exactly one clip at the deadline', () => {
  const h = fixture();
  assert.equal(h.coordinator.arm('slow', { token: 1 }), true);
  h.coordinator.allow('slow', policy());
  h.advance(199);
  assert.equal(h.audio.plays.length, 0);
  h.advance(1);
  assert.equal(h.audio.plays.length, 1);
  h.audio.dispatch('playing');
  // Duplicate transcript, progress and playing events change nothing.
  assert.equal(h.coordinator.arm('slow', { token: 1 }), false);
  h.coordinator.allow('slow', policy());
  h.audio.dispatch('playing');
  h.advance(2000);
  assert.equal(h.audio.plays.length, 1);
  assert.equal(h.reports.filter(report => report.audible).length, 1);
});

test('the page waits about a second by default, matching the server setting', () => {
  assert.equal(new AcknowledgmentCoordinator({ player: {} }).graceMs, ACKNOWLEDGMENT_TIMING.grace_ms);
  assert.equal(ACKNOWLEDGMENT_TIMING.grace_ms, 1000);
});

test('a fast reply suppresses a clip that has not started', () => {
  const h = fixture();
  h.coordinator.arm('fast', { token: 1 });
  h.coordinator.allow('fast', policy());
  h.advance(150);
  h.coordinator.settled('fast');
  h.advance(5000);
  assert.equal(h.audio.plays.length, 0);
  assert.deepEqual(h.reports, []);
});

test('a terminal error before the deadline, or a settled event for another request, behaves correctly', () => {
  const h = fixture();
  h.coordinator.arm('current', { token: 1 });
  h.coordinator.allow('current', policy());
  h.coordinator.settled('some-older-request');
  h.advance(200);
  assert.equal(h.audio.plays.length, 1, 'another request cannot cancel this one');
  const other = fixture();
  other.coordinator.arm('failing', { token: 1 });
  other.coordinator.settled();
  other.coordinator.allow('failing', policy());
  other.advance(1000);
  assert.equal(other.audio.plays.length, 0);
});

test('nothing plays until the server has accepted the request, and only clips it allowed', () => {
  const h = fixture();
  h.coordinator.arm('accepting', { token: 1 });
  h.advance(5000);
  assert.equal(h.audio.plays.length, 0, 'a request never accepted never gets a clip');
  h.coordinator.allow('accepting', policy(['ack_03']));
  assert.deepEqual(h.audio.plays, ['blob:ack_03'], 'late acceptance plays at once, because the deadline has passed');
  const silent = fixture();
  silent.coordinator.arm('none', { token: 1 });
  silent.coordinator.allow('none', policy([]));
  silent.advance(1000);
  assert.equal(silent.audio.plays.length, 0, 'zero eligible clips means silence');
  const stale = fixture();
  stale.coordinator.arm('old-page', { token: 1 });
  stale.coordinator.allow('old-page', policy(undefined, 'v0'));
  stale.advance(1000);
  assert.equal(stale.audio.plays.length, 0, 'a policy for different recordings does not apply');
});

test('an answer ready mid-clip waits for the whole recorded sentence, then starts without overlap', async () => {
  const h = fixture();
  h.coordinator.arm('slow', { token: 1 });
  h.coordinator.allow('slow', policy());
  h.advance(200);
  h.audio.dispatch('playing');
  const src = h.audio.src;
  h.advance(1000);
  // Everything a normal answer does while the clip is still speaking.
  h.coordinator.settled('slow');
  let answerMayPlay = false;
  const queued = h.coordinator.beforeAnswer().then(outcome => { answerMayPlay = true; return outcome; });
  h.advance(1500);
  await flush();
  assert.equal(answerMayPlay, false, 'the answer waits');
  assert.equal(h.audio.src, src, 'the clip keeps playing');
  assert.equal(h.audio.paused, false);
  assert.equal(h.audio.pauses, 0, 'answer readiness never pauses or fades the clip');
  h.audio.finishNaturally();
  assert.equal(await queued, 'ended');
  assert.equal(answerMayPlay, true);
  assert.deepEqual(h.reports.at(-1), { audible: false, outcome: 'ended', resume: false }, 'no thinking flicker before the answer');
  assert.equal(h.audio.plays.length, 1, 'no second opening line');
});

test('final audio that wins the race skips the filler entirely', async () => {
  const h = fixture();
  h.coordinator.arm('race', { token: 1 });
  h.coordinator.allow('race', policy());
  assert.equal(await h.coordinator.beforeAnswer(), 'none');
  h.advance(5000);
  assert.equal(h.audio.plays.length, 0);
});

test('a clip finishing with work still pending only returns to thinking', () => {
  const h = fixture();
  assert.equal(h.turn('pending').length > 0, true);
  assert.deepEqual(h.reports, [{ audible: true, clipId: h.reports[0].clipId }, { audible: false, outcome: 'ended', resume: true }]);
});

test('Stop and interruption end audio at once, and late callbacks cannot speak or animate', async () => {
  const h = fixture();
  h.coordinator.arm('one', { token: 1 });
  h.coordinator.allow('one', policy());
  h.advance(200);
  h.audio.dispatch('playing');
  const queued = h.coordinator.beforeAnswer();
  h.coordinator.cancel();
  assert.equal(h.audio.src, '');
  assert.equal(h.audio.paused, true);
  assert.equal(await queued, 'stopped');
  assert.deepEqual(h.reports.at(-1), { audible: false, outcome: 'stopped', resume: false });
  const reports = h.reports.length;
  // Everything that can still arrive from the old clip.
  h.audio.dispatch('playing'); h.audio.dispatch('ended'); h.audio.dispatch('error'); h.audio.dispatch('pause');
  h.advance(60_000);
  assert.equal(h.reports.length, reports);
  assert.equal(h.pending.size, 0, 'no timer survives');
});

test('an old request cannot disturb a newer one', () => {
  const h = fixture({ cooldownMs: 0 });
  h.coordinator.arm('old', { token: 1 });
  h.coordinator.allow('old', policy());
  h.advance(100);
  h.coordinator.cancel();
  h.coordinator.arm('new', { token: 2 });
  h.coordinator.allow('old', policy(['ack_01']));
  h.coordinator.settled('old');
  h.coordinator.allow('new', policy(['ack_02']));
  h.advance(200);
  assert.deepEqual(h.audio.plays, ['blob:ack_02']);
  h.audio.dispatch('playing');
  h.coordinator.arm('newer', { token: 3 });
  assert.equal(h.audio.src, '', 'starting a newer turn stops the older filler');
  h.coordinator.allow('new', policy(['ack_01']));
  h.advance(1000);
  assert.deepEqual(h.audio.plays, ['blob:ack_02']);
});

test('a retry of the same request in a new generation is a new turn', () => {
  const h = fixture();
  h.coordinator.arm('retry', { token: 1 });
  assert.equal(h.coordinator.arm('retry', { token: 2 }), true);
});

test('one line per turn, a cooldown between turns, and no immediate repeat', () => {
  const h = fixture();
  assert.ok(h.turn('a'));
  assert.equal(h.turn('b', { wait: 1000 }), '', 'still cooling down');
  const heard = [];
  h.advance(3000);
  for (let index = 0; index < 25; index++) { heard.push(h.turn(`turn-${index}`)); h.advance(3000); }
  assert.ok(heard.every(Boolean));
  assert.ok(heard.every((clip, index) => clip !== heard[index - 1]), 'no line twice in a row');
  assert.deepEqual([...new Set(heard.slice(0, 5))].sort(), CLIPS.map(clip => clip.url), 'the bag uses every line before repeating');
});

test('a single eligible line repeats after the cooldown, and rules still decide the set', () => {
  const h = fixture();
  const only = policy(['ack_04']);
  assert.equal(h.turn('a', { allowed: only }), 'blob:ack_04');
  h.advance(3000);
  assert.equal(h.turn('b', { allowed: only }), 'blob:ack_04');
  h.advance(3000);
  assert.equal(h.turn('c', { allowed: policy(['ack_01', 'ack_05']) }).match(/ack_0[15]/) !== null, true);
});

test('muted or disabled output is decided when the clip would start', () => {
  const h = fixture();
  let enabled = true;
  h.coordinator.arm('toggle', { token: 1, isEnabled: () => enabled });
  h.coordinator.allow('toggle', policy());
  enabled = false;
  h.advance(200);
  assert.equal(h.audio.plays.length, 0);
});

test('autoplay rejection skips the filler silently and cannot deadlock the answer', async () => {
  const h = fixture({ cooldownMs: 0, play: () => Promise.reject(new Error('NotAllowedError')) });
  h.coordinator.arm('blocked', { token: 1 });
  h.coordinator.allow('blocked', policy());
  h.advance(200);
  const queued = h.coordinator.beforeAnswer();
  assert.equal(await queued, 'blocked');
  assert.deepEqual(h.reports, [], 'nothing was audible, so nothing animates');
  assert.equal(h.audio.src, '');
  assert.equal(h.coordinator.clips.size, 5, 'a browser policy is not a broken file');
});

test('a throwing player and a corrupt file are skips, and the corrupt line is not retried', async () => {
  const h = fixture({ cooldownMs: 0, play: () => { throw new Error('No audio device'); } });
  h.coordinator.arm('throws', { token: 1 });
  h.coordinator.allow('throws', policy());
  h.advance(200);
  assert.equal(await h.coordinator.beforeAnswer(), 'blocked');
  const corrupt = fixture({ cooldownMs: 0 });
  corrupt.coordinator.arm('bad', { token: 1 });
  corrupt.coordinator.allow('bad', policy(['ack_02']));
  corrupt.advance(200);
  const queued = corrupt.coordinator.beforeAnswer();
  corrupt.audio.dispatch('error');
  assert.equal(await queued, 'failed');
  assert.equal(corrupt.coordinator.clips.has('ack_02'), false);
  corrupt.coordinator.arm('next', { token: 2 });
  corrupt.coordinator.allow('next', policy(['ack_02']));
  corrupt.advance(200);
  assert.equal(corrupt.audio.plays.length, 1);
});

test('the watchdog releases only a stuck player and never chops a sentence that is advancing', async () => {
  const stuck = fixture();
  stuck.coordinator.arm('stuck', { token: 1 });
  stuck.coordinator.allow('stuck', policy());
  stuck.advance(200);
  stuck.audio.dispatch('playing');
  const queued = stuck.coordinator.beforeAnswer();
  stuck.advance(6999);
  assert.ok(stuck.audio.src, 'duration plus padding has not passed');
  stuck.advance(1);
  assert.equal(await queued, 'stalled');
  assert.equal(stuck.audio.src, '');
  const slow = fixture();
  slow.coordinator.arm('late', { token: 1 });
  slow.coordinator.allow('late', policy());
  slow.advance(200);
  slow.audio.dispatch('playing');
  slow.audio.currentTime = 1.5;
  slow.advance(7000);
  assert.ok(slow.audio.src, 'a late but advancing clip keeps playing');
  slow.audio.finishNaturally();
  assert.deepEqual(slow.reports.at(-1), { audible: false, outcome: 'ended', resume: true });
});

test('an outside pause counts as over, while the pause before a natural end does not', async () => {
  const h = fixture();
  h.coordinator.arm('paused', { token: 1 });
  h.coordinator.allow('paused', policy());
  h.advance(200);
  h.audio.dispatch('playing');
  const queued = h.coordinator.beforeAnswer();
  h.audio.pause();
  assert.equal(await queued, 'paused');
});

test('clip loading verifies files, drops what is missing or corrupt, and never plays anything', async () => {
  const bytes = Buffer.from('RIFF-synthetic-audio'), good = createHash('sha256').update(bytes).digest('hex');
  const clip = (id, extra = {}) => ({ id, path: `${id}.wav`, bytes: bytes.length, sha256: good, duration_ms: 2500, ...extra });
  const manifest = { version: 'v9', clips: [clip('good'), clip('missing'), clip('short', { bytes: 3 }), clip('tampered', { sha256: 'f'.repeat(64) })] };
  const requested = [];
  const fetchImpl = async path => {
    requested.push(path);
    if (path.endsWith('manifest.json')) return { json: async () => manifest };
    if (path.includes('missing')) return { ok: false };
    return { ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) };
  };
  const result = await loadAcknowledgmentClips({ fetchImpl, createObjectURL: () => 'blob:verified', subtle: crypto.subtle });
  assert.equal(result.version, 'v9');
  assert.deepEqual(result.clips, [{ id: 'good', url: 'blob:verified', durationMs: 2500 }]);
  assert.ok(requested.includes('/companion/acknowledgments/good.wav'));
  assert.deepEqual(await loadAcknowledgmentClips({ fetchImpl: async () => ({ json: async () => ({ error: 'Not found.' }) }) }), { version: null, clips: [] });
});
