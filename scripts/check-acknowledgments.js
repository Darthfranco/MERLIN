// Browser smoke check for prerecorded acknowledgments: npm run check:acknowledgments
// Real Chrome, real page, real WAV files and real timing, with a scripted model, transcriber,
// final voice and wake detector. No API credits, household data, or microphone are used.
// It reports what the page's audio elements did. It cannot tell whether a person heard sound.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createApp } from '../src/server.js';
import { wavOf } from '../src/acknowledgments.js';
import { TimerStore } from '../src/timers.js';

const CHROME = process.env.CHROME_PATH || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);
if (!CHROME) { console.log('SKIPPED: no Chrome found. Set CHROME_PATH to run this check.'); process.exit(0); }

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const answer = text => [{ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text, annotations: [] }] }];
const tone = new Int16Array(24000).map((_, index) => Math.round(6000 * Math.sin(index / 12)));

// Each request names its own synthetic delay, so the model script needs no state.
const REPLY_DELAYS = { fast: 0, slow: 2500, long: 6000, stopped: 30_000, search: 6500, quicksearch: 1800 };
// The spoken lookup line for a search (owner request, November 3, 2026), written by its own small model call.
const LOOKUP_LINE = 'Looking up the smoke test forecast for you now.', LINE_DELAY_MS = 1200;
const searchCall = { type: 'web_search_call', id: 'ws_smoke', status: 'completed', action: { type: 'search', query: 'smoke test forecast' }, results: [{ type: 'text_result', title: 'Smoke', url: 'https://example.com/forecast', snippet: '' }] };
const directory = await mkdtemp(join(tmpdir(), 'merlin-ack-smoke-'));
const modelCalls = [], ttsCalls = [], detector = [];
const delayFor = input => {
  const text = JSON.stringify(input);
  // History repeats earlier requests, so the most recent mention decides.
  const name = Object.keys(REPLY_DELAYS).sort((a, b) => text.lastIndexOf(`smoke-${b}`) - text.lastIndexOf(`smoke-${a}`))[0];
  return text.includes(`smoke-${name}`) ? REPLY_DELAYS[name] : 0;
};
const app = await createApp({
  dataDir: directory, memoryEngine: 'legacy', learningDelayMs: 60_000,
  timers: await new TimerStore({ filePath: join(directory, 'timers.json') }).init(),
  meta: { configured: true, model: 'synthetic-meta', lineCalls: 0, async respond(input, tools, _instructions, options) {
    modelCalls.push(Date.now());
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, delayFor(input));
      options?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('Interrupted.'), { name: 'AbortError' })); }, { once: true });
    });
    return [...(tools.some(tool => tool.type === 'web_search') ? [searchCall] : []), ...answer('Here is your synthetic answer.')];
  }, async lookupLine() { this.lineCalls++; await sleep(LINE_DELAY_MS); return LOOKUP_LINE; } },
  voiceMeta: { configured: true, model: 'synthetic-transcribe', async transcribe() { return { text: 'Merlin, smoke-long voice request.' }; } },
  tts: { status: () => ({ configured: true, voice: 'am_fenrir' }), async synthesize(text) { ttsCalls.push(text); return wavOf(tone); }, close() {} },
  listener: { sample: 0, status: () => ({ configured: true, wakeWord: 'MERLIN', localOnly: true }), async start() { this.sample = 0; },
    async process(pcm) { const from = this.sample; this.sample += pcm.length / 2; return { sample: this.sample, speech: false, events: (detector.shift() || (() => []))(from, this.sample) }; }, close() {} },
  spotify: { status: () => ({ connected: false, configured: false }), snapshot: async () => ({ connected: false }) },
});
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${app.server.address().port}`;

const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${join(directory, 'chrome')}`, '--no-first-run', '--no-default-browser-check', '--mute-audio',
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--enable-unsafe-swiftshader', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const debugUrl = await new Promise((resolve, reject) => {
  let log = '';
  chrome.stderr.on('data', chunk => { log += chunk; const match = log.match(/ws:\/\/\S+/u); if (match) resolve(match[0]); });
  chrome.once('exit', () => reject(new Error('Chrome exited before it could be used.')));
});
let nextId = 0;
const waiting = new Map(), browser = new WebSocket(debugUrl);
await new Promise(resolve => browser.once('open', resolve));
browser.on('message', data => { const message = JSON.parse(data); if (waiting.has(message.id)) { const { resolve, reject } = waiting.get(message.id); waiting.delete(message.id); message.error ? reject(new Error(message.error.message)) : resolve(message.result); } });
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++nextId; waiting.set(id, { resolve, reject }); browser.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });

// Plain observation from outside the app: timestamps of what each audio element actually did.
// Capturing on the document runs before the app's own listeners can clear the element.
const OBSERVER = `(() => {
  const log = window.__smoke = [];
  for (const name of ['play', 'playing', 'pause', 'ended', 'error']) document.addEventListener(name, ({ target: audio }) => {
    // The silent unlock clip is about 10 ms long, and it is not speech.
    if (!['ack-audio', 'typed-audio', 'voice-audio'].includes(audio.id) || audio.duration < 0.1) return;
    log.push({ id: audio.id, name, at: performance.now(), time: audio.currentTime, duration: audio.duration, ended: audio.ended });
  }, true);
})()`;

async function openPage(extra = '') {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId); await send('Runtime.enable', {}, sessionId);
  const evaluate = async expression => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: false }, sessionId);
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || 'Page evaluation failed.');
    return result.value;
  };
  await send('Page.navigate', { url: `${origin}/companion/${extra}` }, sessionId);
  const page = {
    evaluate,
    until: async (expression, message, timeout = 12_000) => { const end = Date.now() + timeout; for (;;) { if (await evaluate(expression)) return; if (Date.now() > end) throw new Error(`Timed out: ${message}`); await sleep(25); } },
    // A real pointer click, so playback runs under the browser's actual autoplay policy.
    click: async id => {
      const { x, y } = await evaluate(`(() => { const box = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; })()`);
      for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, sessionId);
    },
    ask: async text => { await evaluate(`document.getElementById('message').focus()`); await send('Input.insertText', { text }, sessionId); await page.click('send'); },
    log: async () => evaluate('window.__smoke'),
    clearLog: () => evaluate('window.__smoke.length = 0'),
    close: () => send('Target.closeTarget', { targetId }),
  };
  await page.until(`document.readyState === 'complete' && document.getElementById('send').disabled === false`, 'page ready');
  await evaluate(OBSERVER);
  return page;
}

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`); };
const events = (log, id, name) => log.filter(entry => entry.id === id && (!name || entry.name === name));
const ackAudio = 'document.getElementById("ack-audio")';

try {
  const page = await openPage();
  // Clip files load in the background without playing.
  await page.until(`performance.getEntriesByType('resource').filter(entry => entry.name.endsWith('.wav')).length === 5`, 'all five clips fetched');
  check('Five real clips load in the background and none plays', (await page.log()).length === 0);

  console.log('\nFast reply');
  await page.ask('smoke-fast request');
  await page.until(`document.getElementById('reply').textContent.includes('synthetic answer')`, 'fast reply');
  await page.until(`document.getElementById('typed-audio').ended`, 'fast reply audio');
  let log = await page.log();
  check('A fast reply plays no acknowledgment', events(log, 'ack-audio', 'playing').length === 0);
  await page.clearLog();
  await sleep(3200); // Past the default cooldown, and quiet in any case.

  console.log('\nDelayed reply, answer ready while the clip plays');
  const started = await page.evaluate('performance.now()');
  const callsBefore = modelCalls.length, ttsBefore = ttsCalls.length;
  await page.ask('smoke-slow request');
  await page.until(`${ackAudio}.currentTime > 0`, 'clip started');
  const firstPlaying = events(await page.log(), 'ack-audio', 'playing')[0];
  check('The model was already running when the clip started', modelCalls.length === callsBefore + 1);
  check('The clip waited about a second first', firstPlaying.at - started >= 1000, `started ${Math.round(firstPlaying.at - started)} ms after the click`);
  check('The clip made no speech request', ttsCalls.length === ttsBefore);
  await page.until(`document.getElementById('reply').textContent.includes('synthetic answer') && document.getElementById('reply').textContent.length > 0 && ${ackAudio}.currentTime > 1`, 'answer text during clip');
  const textDuringClip = await page.evaluate(`!${ackAudio}.ended && ${ackAudio}.currentTime > 0`);
  check('The answer text appeared while the clip was still playing', textDuringClip);
  await page.until(`document.getElementById('typed-audio').currentTime > 0`, 'final audio');
  log = await page.log();
  const ackEnded = events(log, 'ack-audio', 'ended')[0], finalPlaying = events(log, 'typed-audio', 'playing')[0];
  check('The clip played to its natural end', ackEnded && Math.abs(ackEnded.time - ackEnded.duration) < 0.1, ackEnded ? `${ackEnded.time.toFixed(2)} of ${ackEnded.duration.toFixed(2)} s` : 'never ended');
  check('The clip was not paused early', !events(log, 'ack-audio', 'pause').some(entry => !entry.ended));
  check('The final answer started only after the clip ended', finalPlaying.at >= ackEnded.at, `${Math.round(finalPlaying.at - ackEnded.at)} ms later`);
  check('Exactly one clip played', events(log, 'ack-audio', 'playing').length === 1);
  check('Final speech was generated exactly once', ttsCalls.length === ttsBefore + 1);
  await page.until(`document.getElementById('typed-audio').ended`, 'final audio end');
  await page.clearLog();
  await sleep(3200);

  console.log('\nInterrupted typed turn');
  await page.ask('smoke-stopped request');
  await page.until(`${ackAudio}.currentTime > 0.3`, 'clip started');
  await page.click('stop');
  await page.until(`${ackAudio}.paused && !${ackAudio}.src`, 'clip stopped');
  log = await page.log();
  check('Stop silenced the clip immediately', events(log, 'ack-audio', 'ended').length === 0);
  await sleep(600);
  log = await page.log();
  check('Nothing played after Stop', events(log, 'typed-audio', 'playing').length === 0 && events(log, 'ack-audio', 'playing').length === 1);
  await page.clearLog();
  await sleep(3200);

  console.log('\nDisabled preference');
  await page.click('acknowledgments');
  await page.ask('smoke-slow request');
  await page.until(`document.getElementById('typed-audio').currentTime > 0`, 'final audio with acknowledgments off');
  log = await page.log();
  check('Turning it off keeps replies and silences only the clip', events(log, 'ack-audio', 'playing').length === 0 && events(log, 'typed-audio', 'playing').length === 1);
  await page.until(`document.getElementById('typed-audio').ended`, 'final audio end');
  check('Only the preference is remembered', await page.evaluate(`localStorage.getItem('merlin-acknowledgments') === 'false' && Object.keys(localStorage).filter(key => key.includes('ack')).length === 1`));
  await page.click('acknowledgments');
  await page.clearLog();
  await sleep(3200);

  console.log('\nSearch: clip, then the lookup line, then the answer');
  const lineTtsBefore = ttsCalls.filter(text => text === LOOKUP_LINE).length;
  await page.ask('smoke-search please look up the forecast');
  await page.until(`document.getElementById('typed-audio').currentTime > 0`, 'search answer audio', 20_000);
  log = await page.log();
  const ackPlays = events(log, 'ack-audio', 'playing'), ackEnds = events(log, 'ack-audio', 'ended'), searchAnswer = events(log, 'typed-audio', 'playing')[0];
  check('The clip and then the lookup line both played, on the filler player', ackPlays.length === 2 && ackEnds.length >= 1, `${ackPlays.length} plays`);
  check('The lookup line started only after the clip ended', ackPlays[1]?.at >= ackEnds[0]?.at, ackPlays[1] && ackEnds[0] ? `${Math.round(ackPlays[1].at - ackEnds[0].at)} ms later` : 'missing');
  check('The answer started only after the lookup line ended', ackEnds.length === 2 && searchAnswer.at >= ackEnds[1].at, ackEnds[1] ? `${Math.round(searchAnswer.at - ackEnds[1].at)} ms later` : 'line never ended');
  check('The lookup line was spoken once, in Fenrir, and is not in the reply', ttsCalls.filter(text => text === LOOKUP_LINE).length === lineTtsBefore + 1 && !(await page.evaluate(`document.getElementById('reply').textContent`)).includes('smoke test forecast for you'));
  await page.until(`document.getElementById('typed-audio').ended`, 'search answer end');
  await page.clearLog();
  await sleep(3200);

  console.log('\nSearch whose answer is ready during the clip: no lookup line');
  await page.ask('smoke-quicksearch please look up the forecast');
  await page.until(`document.getElementById('typed-audio').currentTime > 0`, 'quick search answer audio', 20_000);
  await sleep(300);
  log = await page.log();
  check('Only the clip played; the line had nothing left to cover', events(log, 'ack-audio', 'playing').length <= 1, `${events(log, 'ack-audio', 'playing').length} plays`);
  check('The answer followed the clip directly', events(log, 'typed-audio', 'playing')[0].at >= (events(log, 'ack-audio', 'ended')[0]?.at ?? 0));
  await page.until(`document.getElementById('typed-audio').ended`, 'quick search answer end');
  await page.clearLog();
  await sleep(3200);

  console.log('\nVoice path: real socket and browser capture with a fake microphone, scripted detector');
  await page.click('microphone');
  await page.until(`document.getElementById('mic-state').textContent.includes('say MERLIN')`, 'wake standby', 30_000);
  const speakUntilEnd = wake => detector.push(
    from => [wake ? { type: 'wake', sample: from + 640, startSample: from, endSample: from + 640 } : { type: 'speech_start', sample: from + 640, startSample: from }],
    () => [], () => [], (_from, end) => [{ type: 'speech_end', sample: end, endSample: end }],
  );
  speakUntilEnd(true);
  await page.until(`${ackAudio}.currentTime > 0.3`, 'voice clip started');
  check('A voice request gets a clip while reasoning runs', (await page.evaluate(`document.getElementById('mic-state').textContent`)) === 'Thinking');
  check('The page shows work in progress, not a finished state', (await page.evaluate(`document.getElementById('phase').textContent`)) === 'Thinking…');
  await page.until(`${ackAudio}.ended || (!${ackAudio}.src && ${ackAudio}.paused)`, 'voice clip end');
  await sleep(150);
  check('The clip ending leaves the request processing, with no follow-up', (await page.evaluate(`document.getElementById('mic-state').textContent`)) === 'Thinking');
  const pose = await page.evaluate(`document.getElementById('stage').dataset.characterDesired`);
  check('The character returned to thinking', !pose || /Think$/u.test(pose), pose ? `pose ${pose}` : 'character did not load in this browser');
  await page.until(`document.getElementById('voice-audio').currentTime > 0`, 'voice final audio');
  log = await page.log();
  check('The voice answer followed the finished clip', events(log, 'voice-audio', 'playing')[0].at >= events(log, 'ack-audio', 'ended')[0].at);
  await page.until(`document.getElementById('voice-audio').ended`, 'voice final audio end');
  await page.clearLog();
  await sleep(3200);

  console.log('\nVoice path: person speaks over the clip');
  speakUntilEnd(false);
  await page.until(`${ackAudio}.currentTime > 0.3`, 'second voice clip');
  detector.push(from => [{ type: 'speech_start', sample: from + 640, startSample: from }]);
  await page.until(`!${ackAudio}.src`, 'clip stopped by speech');
  log = await page.log();
  check('Speech stops the clip at once', events(log, 'ack-audio', 'ended').length === 0);
  check('Capture restarted for the person', (await page.evaluate(`document.getElementById('mic-state').textContent`)).includes('listening'));
  await sleep(300);
  check('Nothing played after the person spoke', events(await page.log(), 'voice-audio', 'playing').length === 0);
  await page.click('microphone');
  await page.close();
} catch (error) {
  check('Smoke check finished', false, error.message);
} finally {
  browser.close(); chrome.kill('SIGKILL');
  app.closeVoice();
  await new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); });
  await rm(directory, { recursive: true, force: true }).catch(() => {});
}
console.log('\nThese are playback events in a headless browser with muted output. They show what played and when, not that a person heard it, and they are not a room or echo test.');
if (results.some(ok => !ok)) process.exitCode = 1;
process.exit();
