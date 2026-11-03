// Browser check for the device camera: npm run check:camera, or npm run check:camera -- --live
// Real Chrome, real page, real getUserMedia and real clicks, with a synthetic picture of a blank-faced mannequin as
// the camera feed. Scripted by default, so no API credits. --live uses the real Meta APIs (a cent or two).
// No household data, no real camera, throwaway storage.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { createApp } from '../src/server.js';
import { MetaClient } from '../src/meta.js';
import { TimerStore } from '../src/timers.js';

const LIVE = process.argv.includes('--live');
const SCREENSHOT = process.argv.find(argument => argument.startsWith('--screenshots='))?.slice('--screenshots='.length);
const CHROME = process.env.CHROME_PATH || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);
if (!CHROME) { console.log('SKIPPED: no Chrome found. Set CHROME_PATH to run this check.'); process.exit(0); }
const apiKey = process.env.META_API_KEY || process.env.MODEL_API_KEY || '';
if (LIVE && !apiKey) { console.log('SKIPPED: --live needs META_API_KEY.'); process.exit(0); }

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const directory = await mkdtemp(join(tmpdir(), 'merlin-camera-check-'));
const answer = text => [{ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text, annotations: [] }] }];
const box = (x1, y1, x2, y2, c = 0.93) => ({ x1, y1, x2, y2, width: 682, height: 1024, confidence: c });
const SYNTHETIC_MATCHES = { shirt: [box(242, 338, 437, 586)], pants: [box(274, 569, 403, 865)], shoes: [box(278, 862, 325, 914), box(359, 864, 400, 916)], dress: [] };

// Everything the model is sent, so the check can prove the picture never reached it.
const sentToModel = [];
let scriptedViews = 0;
const real = LIVE ? new MetaClient({ apiKey, model: 'muse-spark-1.3' }) : null;
const meta = LIVE ? new Proxy(real, { get(target, name) {
  if (name === 'respond') return (input, tools, instructions, options) => { sentToModel.push(JSON.stringify({ input, instructions })); return target.respond(input, tools, instructions, options); };
  const value = target[name];
  return typeof value === 'function' ? value.bind(target) : value;
} }) : {
  configured: true, model: 'synthetic-meta',
  async segment(image, concept) { return SYNTHETIC_MATCHES[concept] ?? []; },
  async viewImage() { scriptedViews++; return { observation: 'A navy shirt, khaki trousers and brown shoes.', focus: [] }; },
  async respond(input, tools, instructions) {
    sentToModel.push(JSON.stringify({ input, instructions }));
    // History repeats earlier turns, so only the newest item decides.
    const latest = JSON.stringify(input.at(-1));
    if (/what color/iu.test(latest)) return answer(JSON.stringify(input).includes('navy shirt') ? 'Navy, as far as I could see.' : 'I do not know.');
    if (latest.includes('Camera observation')) return answer('Nice, that navy shirt and those khakis go well together!');
    return answer('Got it.');
  },
};
const app = await createApp({ dataDir: directory, memoryEngine: 'legacy', learningDelayMs: 60_000, meta,
  timers: await new TimerStore({ filePath: join(directory, 'timers.json') }).init(),
  voiceMeta: { configured: false, model: 'none', async transcribe() { throw new Error('No voice in this check.'); } },
  tts: { status: () => ({ configured: false, voice: 'am_fenrir' }), async synthesize() { throw new Error('No speech in this check.'); }, close() {} },
  listener: { status: () => ({ configured: false, wakeWord: 'MERLIN', localOnly: true }), async start() {}, async process() { return { sample: 0, speech: false, events: [] }; }, close() {} },
  spotify: { status: () => ({ connected: false, configured: false }), snapshot: async () => ({ connected: false }) },
});
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${app.server.address().port}`;

// Chrome treats a single JPEG with this extension as a video file for its fake camera.
const feed = join(directory, 'feed.mjpeg');
await copyFile(join(ROOT, 'test/fixtures/camera-outfit.jpg'), feed);
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${join(directory, 'chrome')}`, '--no-first-run', '--no-default-browser-check', '--mute-audio', '--window-size=1280,960',
  '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${feed}`, '--use-fake-ui-for-media-stream', '--enable-unsafe-swiftshader', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
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

// Plain observation from outside the app: every camera open, and whether its tracks really stopped.
const OBSERVER = `(() => {
  const opens = window.__opens = [];
  const media = navigator.mediaDevices, open = media.getUserMedia.bind(media);
  media.getUserMedia = async constraints => {
    const stream = await open(constraints);
    if (constraints.video) opens.push({ audio: Boolean(constraints.audio), tracks: stream.getTracks() });
    return stream;
  };
  window.__cameraLive = () => opens.flatMap(entry => entry.tracks).filter(track => track.readyState === 'live').length;
})()`;

async function openPage() {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId); await send('Runtime.enable', {}, sessionId);
  await send('Page.addScriptToEvaluateOnNewDocument', { source: OBSERVER }, sessionId);
  const evaluate = async expression => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || 'Page evaluation failed.');
    return result.value;
  };
  await send('Page.navigate', { url: `${origin}/companion/` }, sessionId);
  const page = {
    evaluate,
    until: async (expression, message, timeout = LIVE ? 90_000 : 15_000) => { const end = Date.now() + timeout; for (;;) { if (await evaluate(expression)) return; if (Date.now() > end) throw new Error(`Timed out: ${message}. Reply: ${await evaluate(`document.getElementById('reply').textContent`)}`); await sleep(50); } },
    click: async id => {
      const { x, y } = await evaluate(`(() => { const box = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; })()`);
      for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, sessionId);
    },
    ask: async text => {
      await evaluate(`document.getElementById('message').focus()`); await send('Input.insertText', { text }, sessionId); await page.click('send');
      // The earlier reply is still on screen until this request has really been accepted.
      await page.until(`document.getElementById('heard').textContent === ${JSON.stringify(text)} && document.getElementById('message').value === ''`, `accepting ${text}`);
    },
    replied: async (message = 'a reply') => { await page.until(`!document.getElementById('send').disabled && document.getElementById('reply').textContent.length > 0 && document.getElementById('stop').hidden`, message); return evaluate(`document.getElementById('reply').textContent`); },
    screenshot: async name => {
      if (!SCREENSHOT) return;
      const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
      await writeFile(join(SCREENSHOT, `${name}.png`), Buffer.from(data, 'base64'));
    },
    close: () => send('Target.closeTarget', { targetId }),
  };
  await page.until(`document.readyState === 'complete' && document.getElementById('send').disabled === false`, 'page ready', 15_000);
  // Replies are checked on screen here; speech has its own checks.
  await evaluate(`document.getElementById('read-aloud').checked = false; document.getElementById('acknowledgments').checked = false`);
  return page;
}

const results = [];
const check = (name, ok, detail = '') => { results.push(Boolean(ok)); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`); };
const opens = page => page.evaluate('window.__opens.length');
const FRAME_MARK = 'data:image/jpeg';

try {
  const page = await openPage();
  await page.until(`window.__opens !== undefined`, 'observer');
  await sleep(300);
  check('Loading the page checks for a camera without opening it', await opens(page) === 0);

  console.log('\nDoes my outfit match?');
  await page.ask('Does my outfit match?');
  const question = await page.replied('the camera question');
  check('MERLIN asks first', /turn on the camera/iu.test(question) && question.endsWith('?'), question);
  check('The camera is still closed while it asks', await opens(page) === 0);
  check('The buttons appear', await page.evaluate(`!document.getElementById('camera-consent').hidden`));
  check('The status line says the camera is off', await page.evaluate(`document.getElementById('camera-state').textContent === 'Camera off'`));
  await page.screenshot('1-asking');

  await page.click('camera-allow');
  await page.until(`/^Camera on/u.test(document.getElementById('camera-state').textContent)`, 'camera on');
  await page.until(`document.getElementById('camera-video').videoWidth > 0`, 'live video');
  await page.until(`document.getElementById('stage').dataset.characterState === 'camera'`, 'the camera face', 3000);
  check('Saying yes turns the camera on, visibly', await page.evaluate(`/^Camera on/u.test(document.getElementById('camera-state').textContent) && !document.getElementById('camera-close').hidden`));
  check('It opens video only, with no microphone', await page.evaluate(`window.__opens.length === 1 && window.__opens[0].audio === false && window.__opens[0].tracks.every(track => track.kind === 'video')`));
  check('MERLIN shows its camera face', await page.evaluate(`document.getElementById('stage').dataset.characterState === 'camera' && document.getElementById('phase').textContent === 'Get in frame…'`));
  await page.screenshot('2-camera-on');
  await page.until(`document.getElementById('camera-state').textContent === 'Camera off'`, 'camera off');
  const frameTaken = Date.now();
  check('The camera closes as soon as it has one frame', await page.evaluate('window.__cameraLive() === 0'));
  check('The camera face stays up while MERLIN reads the picture', await page.evaluate(`document.getElementById('stage').dataset.characterState === 'camera' && document.getElementById('camera-still').width > 0`));
  await page.screenshot('3-reading');

  await page.until(`document.getElementById('reply').textContent.length > 0`, 'the answer text');
  console.log(`      From the frame to the answer: ${((Date.now() - frameTaken) / 1000).toFixed(1)} seconds.`);
  await sleep(500);
  check('The camera face holds what SAM found for a moment', await page.evaluate(`document.getElementById('stage').dataset.characterState === 'camera'`));
  await page.screenshot('4-found');
  const verdict = await page.replied('the look');
  console.log(`      MERLIN said: ${verdict}`);
  check('MERLIN answers from what it saw', LIVE ? /navy|blue|khaki|tan|brown/iu.test(verdict) : /navy/iu.test(verdict));
  check('The look used exactly one camera open', await opens(page) === 1);
  check('MERLIN turns back to its speaking face', await page.evaluate(`document.getElementById('stage').dataset.characterState === 'face'`));
  check('The picture is wiped once the face has turned back', await page.evaluate(`document.getElementById('camera-still').width === 0`));
  await page.screenshot('5-answer');
  const activity = await page.evaluate(`document.getElementById('actions').textContent`);
  check('Activity says it looked and kept no picture', /did not keep the picture/iu.test(activity));
  if (!LIVE) check('Muse Spark read the frame once', scriptedViews === 1);

  console.log('\nRemembering');
  const looksBefore = await opens(page);
  await page.ask('What color was my shirt?');
  const recalled = await page.replied('the follow-up');
  console.log(`      MERLIN said: ${recalled}`);
  check('A follow-up is answered from memory of the look', /navy|blue/iu.test(recalled));
  check('Remembering does not turn the camera back on', await opens(page) === looksBefore);
  check('The picture never reached a reply round, memory or the store', !sentToModel.some(body => body.includes(FRAME_MARK)) && !JSON.stringify(app.store.snapshot()).includes(FRAME_MARK));
  check('What it saw is in the stored conversation', /navy|blue/iu.test(JSON.stringify(app.store.snapshot().conversations)));

  console.log('\nEvery look gets its own yes');
  await page.ask('how do I look?');
  check('A second look asks again', /turn on the camera/iu.test(await page.replied('second question')));
  await page.click('camera-decline');
  await page.until(`/stays off/u.test(document.getElementById('reply').textContent)`, 'decline reply');
  await page.replied('decline finished');
  check('Not now leaves the camera off', await opens(page) === looksBefore);
  await page.ask('yes');
  await page.replied('yes with nothing to answer');
  check('A later yes with no question pending opens nothing', await opens(page) === looksBefore);

  console.log('\nTurning it off during the countdown');
  await page.ask('what am I holding?');
  await page.replied('third question');
  await page.click('camera-allow');
  await page.until(`/^Camera on/u.test(document.getElementById('camera-state').textContent)`, 'camera on again');
  await page.click('camera-close');
  await page.until(`/camera.s off/iu.test(document.getElementById('reply').textContent)`, 'cancel reply');
  await page.replied('cancel finished');
  check('The person can stop it, and no frame is taken', await page.evaluate('window.__cameraLive() === 0') && await page.evaluate(`document.getElementById('camera-close').hidden && document.getElementById('camera-still').width === 0`));

  console.log('\nHome cameras are something else');
  const before = await opens(page);
  await page.ask("Who's at the door?");
  const door = await page.replied('door reply');
  console.log(`      MERLIN said: ${door}`);
  check('Who is at the door never touches the device camera, and no question is asked', await opens(page) === before && await page.evaluate(`document.getElementById('camera-consent').hidden`));
  await page.ask('Check my outfit with the Ring doorbell');
  const ring = await page.replied('ring reply');
  console.log(`      MERLIN said: ${ring}`);
  check('Asking to use the doorbell for an outfit is refused, offering its own camera instead', /don.t use the doorbell/iu.test(ring) && /my own camera/iu.test(ring));
  check('The doorbell request opened nothing', await opens(page) === before);
} catch (error) {
  check('The check ran to the end', false, error.message);
} finally {
  browser.close(); chrome.kill('SIGKILL');
  app.closeVoice?.();
  await new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections?.(); });
  await app.learning?.close?.().catch(() => {});
  await rm(directory, { recursive: true, force: true }).catch(() => {});
}
const failed = results.filter(ok => !ok).length;
console.log(`\n${results.length - failed} of ${results.length} passed${LIVE ? ' against the real Meta APIs' : ' with a scripted model'}.`);
process.exit(failed ? 1 : 0);
