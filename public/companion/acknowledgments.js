/**
 * Prerecorded "working on it" lines. Presentation only: a clip never starts, delays,
 * finishes, or reaches a request, and it is not part of any assistant turn.
 */
const DEFAULTS = Object.freeze({ graceMs: 200, cooldownMs: 3000, watchdogPaddingMs: 4000 });
const MANIFEST_URL = '/companion/acknowledgments/manifest.json';

/** Fetch and verify the files once. Whatever is missing or corrupt is simply not available. */
export async function loadAcknowledgmentClips({ fetchImpl, createObjectURL, subtle, signal } = {}) {
  const hex = buffer => Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, '0')).join('');
  const manifest = await (await fetchImpl(MANIFEST_URL, { signal })).json();
  if (typeof manifest?.version !== 'string' || !Array.isArray(manifest.clips)) return { version: null, clips: [] };
  const clips = await Promise.all(manifest.clips.map(async clip => {
    try {
      const response = await fetchImpl(new URL(clip.path, 'http://localhost' + MANIFEST_URL).pathname, { signal });
      if (!response.ok) return null;
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength !== clip.bytes || (subtle && hex(await subtle.digest('SHA-256', bytes)) !== clip.sha256)) return null;
      return { id: clip.id, url: createObjectURL(new Blob([bytes], { type: 'audio/wav' })), durationMs: clip.duration_ms };
    } catch { return null; }
  }));
  return { version: manifest.version, clips: clips.filter(Boolean) };
}

/** One dedicated element, so a filler can never be mistaken for the real reply's audio. */
export class AcknowledgmentPlayer {
  constructor(audio) {
    this.audio = audio;
    this.run = null;
    audio.addEventListener('playing', () => {
      const run = this.run;
      if (run && !run.audible) { run.audible = true; run.onAudible(); }
    });
    audio.addEventListener('ended', () => this.#done('ended'));
    audio.addEventListener('error', () => this.#done('failed'));
    // The browser pauses just before a normal end. Only an outside pause of audible playback counts.
    audio.addEventListener('pause', () => { if (this.run?.audible && !audio.ended) this.#done('paused'); });
  }
  #done(outcome) {
    const run = this.run;
    if (!run) return;
    this.#release();
    run.onDone(outcome);
  }
  #release() {
    this.run = null;
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
  }
  play(clip, { onAudible, onDone }) {
    const run = { onAudible, onDone, audible: false };
    this.run = run;
    this.audio.src = clip.url;
    let started;
    try { started = this.audio.play(); } catch { started = Promise.reject(); }
    // Blocked or rejected playback is a skip: no extra button, prompt, or retry.
    Promise.resolve(started).catch(() => { if (this.run === run) this.#done('blocked'); });
  }
  stop() { if (this.run) this.#release(); }
  position() { return this.audio.currentTime || 0; }
}

/**
 * The single owner of the race between "start the filler" and "the answer is ready":
 * - unstarted when the answer is known: skipped;
 * - started: always finishes its sentence, and the answer's audio queues behind it;
 * - only people stop one early: interruption, Stop, a new turn, hiding the page, or disabling it.
 */
export class AcknowledgmentCoordinator {
  constructor({ player, onAudible = () => {}, graceMs = DEFAULTS.graceMs, cooldownMs = DEFAULTS.cooldownMs, watchdogPaddingMs = DEFAULTS.watchdogPaddingMs,
    now = () => performance.now(), random = Math.random, setTimer = (...args) => setTimeout(...args), clearTimer = id => clearTimeout(id) } = {}) {
    Object.assign(this, { player, onAudible, graceMs, cooldownMs, watchdogPaddingMs, now, random, setTimer, clearTimer });
    this.version = null; this.clips = new Map(); this.bag = [];
    this.turn = null; this.active = null; this.lastArmed = null;
    this.lastClipId = null; this.lastFinishedAt = -Infinity;
  }
  configure({ grace_ms: graceMs = this.graceMs, cooldown_ms: cooldownMs = this.cooldownMs } = {}) { this.graceMs = graceMs; this.cooldownMs = cooldownMs; }
  setClips(version, clips) { this.version = version; this.clips = new Map(clips.map(clip => [clip.id, clip])); this.bag = []; }

  /** Runs alongside the request: nothing here is awaited by it. Duplicate events cannot arm twice. */
  arm(key, { token = null, isEnabled = () => true } = {}) {
    const armed = `${key}|${token}`;
    if (armed === this.lastArmed) return false;
    this.cancel();
    this.lastArmed = armed;
    const turn = { key, isEnabled, allowed: null, due: false, timer: null };
    turn.timer = this.setTimer(() => { turn.due = true; this.#fire(turn); }, this.graceMs);
    this.turn = turn;
    return true;
  }
  /** The server's clip IDs for this accepted request, checked against its current rules. */
  allow(key, policy) {
    const turn = this.turn;
    if (!turn || turn.key !== key || turn.allowed || !policy) return;
    turn.allowed = policy.version === this.version && Array.isArray(policy.clips) ? policy.clips : [];
    this.#fire(turn);
  }
  #fire(turn) {
    if (turn !== this.turn || !turn.due || !turn.allowed) return;
    this.turn = null;
    if (!turn.isEnabled() || this.now() - this.lastFinishedAt < this.cooldownMs) return;
    const clip = this.#pick(turn.allowed);
    if (clip) this.#start(clip);
  }
  #pick(allowed) {
    const ready = allowed.filter(id => this.clips.has(id));
    if (!ready.length) return null;
    let bag = this.bag.filter(id => ready.includes(id));
    if (!bag.length) {
      bag = [...ready];
      for (let index = bag.length - 1; index > 0; index--) {
        const other = Math.floor(this.random() * (index + 1));
        [bag[index], bag[other]] = [bag[other], bag[index]];
      }
      // A refilled bag must not lead with the line just heard. Variety never widens eligibility.
      if (bag[0] === this.lastClipId && bag.length > 1) [bag[0], bag[1]] = [bag[1], bag[0]];
    }
    this.bag = bag.slice(1);
    return this.clips.get(bag[0]);
  }
  #start(clip) {
    const playback = { clip, answerQueued: false, audible: false, position: 0, watchdog: null, resolve: null, finished: null };
    playback.finished = new Promise(resolve => { playback.resolve = resolve; });
    this.active = playback;
    this.lastClipId = clip.id;
    this.#watch(playback);
    this.player.play(clip, {
      onAudible: () => {
        if (this.active !== playback) return;
        playback.audible = true;
        this.#report(true, { clipId: clip.id });
      },
      onDone: outcome => { if (this.active === playback) this.#finish(playback, outcome); },
    });
  }
  /** Only for a genuinely stuck player. A sentence that is still advancing is never cut. */
  #watch(playback) {
    playback.watchdog = this.setTimer(() => {
      if (this.active !== playback) return;
      const position = this.player.position();
      if (position > playback.position) { playback.position = position; this.#watch(playback); return; }
      this.player.stop();
      this.#finish(playback, 'stalled');
    }, playback.clip.durationMs + this.watchdogPaddingMs);
  }
  #report(audible, detail) { try { this.onAudible(audible, detail); } catch {} }
  #finish(playback, outcome, { resume = true } = {}) {
    this.active = null;
    this.clearTimer(playback.watchdog);
    if (outcome === 'failed') this.clips.delete(playback.clip.id);
    if (playback.audible) {
      this.lastFinishedAt = this.now();
      this.#report(false, { outcome, resume: resume && !playback.answerQueued });
    }
    playback.resolve(outcome);
  }
  /** The answer or a terminal error is known: an unstarted filler is skipped, a started one is left alone. */
  settled(key) {
    const turn = this.turn;
    if (!turn || (key !== undefined && turn.key !== key)) return;
    this.clearTimer(turn.timer);
    this.turn = null;
  }
  /** Await before playing real speech. Never stops a started filler; resolves when it is over. */
  beforeAnswer() {
    this.settled();
    const playback = this.active;
    if (!playback) return Promise.resolve('none');
    playback.answerQueued = true;
    return playback.finished;
  }
  /** User-controlled stop. `resume: false` means the caller is about to choose the next pose itself. */
  cancel({ resume = false } = {}) {
    this.settled();
    const playback = this.active;
    if (!playback) return;
    this.player.stop();
    this.#finish(playback, 'stopped', { resume });
  }
}
