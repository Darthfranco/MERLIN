import * as THREE from '../vendor/three/build/three.module.min.js';
import { GLTFLoader } from '../vendor/three/examples/jsm/loaders/GLTFLoader.js';
import { EffectComposer } from '../vendor/three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from '../vendor/three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from '../vendor/three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from '../vendor/three/examples/jsm/postprocessing/OutputPass.js';
import { collectScreens } from '../screens.js';
import { MotionController } from '../motion.js';
import { isFaceState, stateScreens, visibleScreens } from '../motion-routes.js';
import { SceneClock } from '../scene-clock.js';
import { createCharacterDriver, createSpeechOverlay, runtimeManifest } from '../character.js';
import { PANEL_TYPES, createDemoState, paintPanel, loadPanelArt } from '../panels/render.js';

// B-roll only: synthetic presentation, no assistant, microphone, camera or services.
const $ = id => document.getElementById(id);
const STAGE_ONLY = new URLSearchParams(location.search).get('view') === 'stage';
const windowId = Math.random().toString(36).slice(2);
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('merlin-broll') : null;
const canvas = $('scene'), stage = $('stage');
const FREE = {preservePanels: false};
// Body poses where the companion moves the mouth while it talks.
const BODY_TALK = new Set(['ready', 'right', 'left', 'both', 'seatedLeft', 'seatedRight', 'ceiling']);

// One list feeds the buttons, the keys and the recording window.
const ACTIONS = [
  {group: 'Body', id: 'ready', label: 'Ready', key: 'r', run: d => d.ready()},
  {group: 'Body', id: 'dance', label: 'Music & dance', key: 'd', state: 'dance'},
  {group: 'Body', id: 'think', label: 'Think in place', key: 't', run: d => d.go('bodyThink')},
  {group: 'Body', id: 'nap', label: 'Nap', key: 'n', state: 'nap'},
  {group: 'Body', id: 'toss', label: 'Ball toss', key: 'b', state: 'toss'},
  {group: 'Body', id: 'walk', label: 'Walk & whistle', key: 'w', state: 'walk'},
  {group: 'Body', id: 'walkReverse', label: 'Walk back', key: 'q', state: 'walkReverse'},
  {group: 'Body', id: 'patrol', label: 'Walk back & forth', key: 'p', run: d => d.go('walk', {...FREE, patrol: true})},
  {group: 'Screens', id: 'left', label: 'Left screen', key: '1', state: 'left'},
  {group: 'Screens', id: 'right', label: 'Right screen', key: '2', state: 'right'},
  {group: 'Screens', id: 'both', label: 'Both, seated', key: '3', state: 'both'},
  {group: 'Screens', id: 'ceiling', label: 'Jump for big screen', key: '4', state: 'ceiling'},
  {group: 'Screens', id: 'seatedLeft', label: 'Sit by left', key: '5', state: 'seatedLeft'},
  {group: 'Screens', id: 'seatedRight', label: 'Sit by right', key: '6', state: 'seatedRight'},
  {group: 'Move screens', id: 'dockLeft', label: 'Big screen to left', key: '7', run: d => d.go('left', FREE), when: s => s.ceiling},
  {group: 'Move screens', id: 'dockRight', label: 'Big screen to right', key: '8', run: d => d.go('right', FREE), when: s => s.ceiling},
  {group: 'Move screens', id: 'dismissLeft', label: 'Dismiss left', key: 'z', run: d => d.dismissScreen('left'), when: s => s.panels.includes('left')},
  {group: 'Move screens', id: 'dismissRight', label: 'Dismiss right', key: 'x', run: d => d.dismissScreen('right'), when: s => s.panels.includes('right')},
  {group: 'Move screens', id: 'dismissBoth', label: 'Dismiss all', key: 'v', run: d => d.dismissScreen('both'), when: s => s.panels.length > 0},
  {group: 'Full face', id: 'face', label: 'Friendly face', key: 'f', state: 'face'},
  {group: 'Full face', id: 'faceThink', label: 'Thinking face', key: 'g', state: 'faceThink'},
  {group: 'Full face', id: 'search', label: 'Searching', key: 's', state: 'search'},
  {group: 'Full face', id: 'idea', label: 'Lightbulb idea', key: 'i', state: 'idea'},
  {group: 'Full face', id: 'camera', label: 'Camera viewfinder', key: 'c', state: 'camera'},
  {group: 'Full face', id: 'body', label: 'Back to body', key: 'e', run: d => d.body(), when: s => s.face},
];
// Which button reads as current for each settled state.
const CURRENT = {walkRest: 'walk', walkReverseRest: 'walkReverse', bodyThink: 'think'};

const SLOTS = [
  {id: 'left', label: 'Left panel', shape: '5 / 6', designs: true, fill: '#ffffff'},
  {id: 'right', label: 'Right panel', shape: '5 / 6', designs: true, fill: '#ffffff'},
  {id: 'ceiling', label: 'Big screen', shape: '16 / 10', designs: true, fill: '#ffffff', empty: 'Uses the right panel’s picture'},
  {id: 'camera', label: 'Camera viewfinder', shape: '2.88 / 1', designs: false, fill: '#03070e'},
];
// A screen is out of view when these clips start, so its picture can change unseen.
const ENTRIES = {
  ReadyToPanel: [['right', 'right']],
  ReadyToLeftPanel: [['left', 'left']],
  ReadyToBothPanels: [['left', 'left'], ['right', 'right']],
  ReadyToCeiling: [['right', 'ceiling']],
  FaceToCeiling: [['right', 'ceiling']],
};

const DEFAULT_SETTINGS = {talk: false, clock: true, speed: 1, frame: '4:3'};
let settings = {...DEFAULT_SETTINGS};
try { settings = {...settings, ...JSON.parse(localStorage.getItem('merlin-broll-settings') || '{}')}; } catch {}

let driver, controller, manifest, screens, panelArt = {}, patrolling = false, pendingSync = null;
const slotRecords = {}, slotContent = {}, shown = {left: null, right: null, camera: null};
const stageWindows = new Set();

// ---------- Saved pictures (IndexedDB, this browser only) ----------
const database = new Promise((resolve, reject) => {
  const request = indexedDB.open('merlin-broll', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('slots');
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
async function store(mode, action) {
  const db = await database;
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('slots', mode), request = action(transaction.objectStore('slots'));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () => reject(transaction.error);
  });
}
const readSlot = id => store('readonly', slots => slots.get(id)).catch(() => undefined);

async function decodeImage(blob) {
  let source;
  try { source = await createImageBitmap(blob); }
  catch {
    // SVG and a few other formats only decode through an image element.
    const url = URL.createObjectURL(blob), image = new Image();
    image.src = url;
    try { await image.decode(); } finally { URL.revokeObjectURL(url); }
    source = image;
  }
  // Own the pixels at a texture-friendly size; the screens are about 1000 pixels across.
  const width = source.naturalWidth || source.width, height = source.naturalHeight || source.height;
  if (!width || !height) throw new Error('That picture has no size.');
  const scale = Math.min(1, 2048 / Math.max(width, height));
  const copy = document.createElement('canvas');
  copy.width = Math.round(width * scale); copy.height = Math.round(height * scale);
  copy.getContext('2d').drawImage(source, 0, 0, copy.width, copy.height);
  source.close?.();
  return copy;
}
async function decodeVideo(blob) {
  const video = document.createElement('video'), url = URL.createObjectURL(blob);
  Object.assign(video, {muted: true, loop: true, playsInline: true, src: url});
  await new Promise((resolve, reject) => {
    video.addEventListener('loadeddata', resolve, {once: true});
    video.addEventListener('error', () => reject(new Error('That video format can’t play here. Try MP4 or WebM.')), {once: true});
  });
  await video.play().catch(() => {});
  return {video, dispose: () => { video.pause(); video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); }};
}
function mediaPainter(source, fit, fill) {
  return (ctx, w, h) => {
    ctx.fillStyle = fill; ctx.fillRect(0, 0, w, h);
    const sw = source.videoWidth || source.width, sh = source.videoHeight || source.height;
    if (!sw || !sh || (source instanceof HTMLVideoElement && source.readyState < 2)) return;
    const scale = fit === 'contain' ? Math.min(w / sw, h / sh) : Math.max(w / sw, h / sh);
    ctx.drawImage(source, (w - sw * scale) / 2, (h - sh * scale) / 2, sw * scale, sh * scale);
  };
}
async function buildContent(slot, record) {
  if (!record) return null;
  if (record.kind === 'design') {
    const state = {...createDemoState(record.design), type: record.design};
    return {painter: (ctx, w, h, t) => paintPanel(ctx, w, h, state, {art: panelArt, time: t}), reflow: false, animate: false};
  }
  if (record.kind === 'video') {
    const {video, dispose} = await decodeVideo(record.blob);
    return {painter: mediaPainter(video, record.fit, slot.fill), reflow: true, animate: true, dispose, source: video};
  }
  const image = await decodeImage(record.blob);
  return {painter: mediaPainter(image, record.fit, slot.fill), reflow: true, animate: false};
}

/** Puts a slot's picture on a physical screen; an empty slot restores the authored picture. */
function paint(surfaceId, slotId) {
  const surface = screens[surfaceId], content = slotContent[slotId] || (slotId === 'ceiling' ? slotContent.right : null);
  shown[surfaceId] = slotId;
  if (!content) {
    surface.aspect = surface.width / surface.height;
    surface.reset();
    return;
  }
  surface.draw(content.painter, {reflow: content.reflow, animate: content.animate});
  // The viewfinder's texture is stretched for the authored picture; real pictures keep their shape.
  if (surfaceId === 'camera' && surface.shape) surface.setAspect(surface.shape);
}
async function loadSlot(id) {
  const slot = SLOTS.find(item => item.id === id), record = await readSlot(id);
  let content = null, error = null;
  try { content = await buildContent(slot, record); } catch (problem) { error = problem; }
  const previous = slotContent[id];
  slotRecords[id] = record; slotContent[id] = content;
  if (screens) for (const surfaceId of Object.keys(shown)) {
    const showing = shown[surfaceId];
    if (showing === id || (id === 'right' && showing === 'ceiling' && !slotContent.ceiling)) paint(surfaceId, showing);
  }
  previous?.dispose?.();
  if (!STAGE_ONLY) renderSlot(slot);
  if (error) throw error;
}

// ---------- Stage ----------
function fail(error) {
  $('loading').hidden = true; $('stage-error').hidden = false;
  $('error-detail').textContent = error.message || 'Reload the page to try again.';
  console.error(error);
}

async function start() {
  const artReady = loadPanelArt().catch(() => ({}));
  const response = await fetch('../../states.json');
  if (!response.ok) throw new Error('The character files are unavailable. Start this page with the included local server.');
  const footprints = await fetch('../motion-footprints.json').then(result => result.ok ? result.json() : {clips: {}});
  const authored = await response.json();
  const renderer = new THREE.WebGLRenderer({canvas, antialias: true, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false});
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.AgXToneMapping; renderer.toneMappingExposure = 1;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.VSMShadowMap;
  const scene = new THREE.Scene(); scene.background = new THREE.Color('#081326'); scene.fog = new THREE.Fog('#081326', 22, 50);
  const baseWidth = authored.camera.orthographic_width, baseAspect = authored.camera.aspect_ratio, baseHeight = baseWidth / baseAspect;
  const camera = new THREE.OrthographicCamera(-baseWidth / 2, baseWidth / 2, baseHeight / 2, -baseHeight / 2, .1, 100);
  new THREE.Matrix4().set(...authored.camera.matrix_world.flat()).premultiply(new THREE.Matrix4().makeRotationX(-Math.PI / 2))
    .decompose(camera.position, camera.quaternion, camera.scale);
  scene.add(new THREE.HemisphereLight(0xb3d4ff, 0x172b48, .65));
  function light(color, intensity, x, y, z, shadow = false) {
    const value = new THREE.DirectionalLight(color, intensity); value.position.set(x, y, z); value.target.position.set(0, 2.2, 0);
    if (shadow) {
      value.castShadow = true; value.shadow.mapSize.set(1024, 1024);
      Object.assign(value.shadow.camera, {left: -7, right: 7, top: 8, bottom: -5, near: .1, far: 35});
      value.shadow.normalBias = .025; value.shadow.bias = -.00015; value.shadow.radius = 4; value.shadow.blurSamples = 8; value.shadow.intensity = .5;
    }
    scene.add(value, value.target);
  }
  light(0xdbeeff, 1.8, -3, 8, 6, true); light(0x92bfff, .65, 5, 4, 3); light(0x5b9cff, 2, 0, 5, -4);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(100, 100), new THREE.MeshStandardMaterial({color: 0x01030a, roughness: .86, metalness: 0}));
  floor.rotation.x = -Math.PI / 2; floor.position.y = .024; floor.receiveShadow = true; scene.add(floor);
  const [gltf, art] = await Promise.all([new GLTFLoader().loadAsync('../../merlin-states.glb', progress => {
    if (progress.total) $('loading').textContent = 'Loading MERLIN… ' + Math.round(progress.loaded / progress.total * 100) + '%';
  }), artReady]);
  panelArt = art;
  manifest = runtimeManifest(authored, gltf.animations.map(clip => clip.name));
  const model = gltf.scene;
  model.traverse(object => { if (object.isMesh) { object.castShadow = true; object.receiveShadow = true; object.frustumCulled = false; } });
  scene.add(model);
  screens = collectScreens(model);
  for (const side of ['right', 'left', 'camera']) if (!screens[side]) throw new Error('The character is missing its ' + side + ' screen.');
  const feet = [];
  for (const name of ['footL', 'footR']) {
    const foot = model.getObjectByName(name); if (!foot) continue;
    const glow = new THREE.PointLight(0x26bcff, 2.8, 1.1, 2); scene.add(glow); feet.push({foot, glow});
  }
  const speech = createSpeechOverlay(model);
  const sceneClock = new SceneClock(stage, manifest.states, new Map(Object.entries(footprints.clips || {})), manifest.routes || []);
  controller = new MotionController(new THREE.AnimationMixer(model), gltf.animations, manifest, info => {
    sceneClock.sync({...info, current: info.state}); driver?.motionChanged();
  });
  driver = createCharacterDriver({controller, screens, panelArt, reducedMotion: false, onStatus});
  driver.go('ready', {urgent: true});

  const composer = new EffectComposer(renderer); composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(800, 600), .32, .25, 1.1)); composer.addPass(new OutputPass());
  function resize() {
    const width = Math.max(1, stage.clientWidth), height = Math.max(1, stage.clientHeight), aspect = width / height;
    // Wider than authored shows more of the room at the sides; never crop the authored frame.
    const halfWidth = (aspect >= baseAspect ? baseHeight * aspect : baseWidth) / 2, halfHeight = halfWidth / aspect;
    Object.assign(camera, {left: -halfWidth, right: halfWidth, top: halfHeight, bottom: -halfHeight});
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false); composer.setSize(width, height);
  }
  new ResizeObserver(resize).observe(stage); resize();

  const clock = new THREE.Clock(); let elapsed = 0;
  renderer.setAnimationLoop(() => {
    const delta = Math.min(clock.getDelta(), .05) * settings.speed;
    if (!controller.paused) elapsed += delta;
    speech.restore();
    controller.update(delta);
    if (settings.talk) speech.update(elapsed, talkLevel(elapsed), driver.state === 'face', BODY_TALK.has(driver.state));
    driver.syncScreens();
    for (const id of visibleScreens(controller)) if (!controller.paused) screens[id]?.tick(elapsed);
    for (const {foot, glow} of feet) { foot.getWorldPosition(glow.position); glow.position.y = .12; }
    composer.render();
  });
  canvas.addEventListener('webglcontextlost', event => {
    event.preventDefault(); renderer.setAnimationLoop(null);
    fail(new Error('The graphics context was interrupted. Reload to resume.'));
  });

  await Promise.all(SLOTS.map(slot => loadSlot(slot.id).catch(error => slotMessage(slot.label + ': ' + error.message))));
  paint('left', 'left'); paint('right', 'right'); paint('camera', 'camera');
  $('loading').hidden = true;
  if (!STAGE_ONLY) for (const id of ['pause', 'reset', 'clean', 'popout']) $(id).disabled = false;
  updateButtons();
  window.merlin = {driver, controller, screens, run, shown};
  if (pendingSync) applySync(pendingSync);
  send({type: STAGE_ONLY ? 'hello' : 'ping'});
}

/** Synthetic phrases of a few syllables with short breaths between; there is no audio. */
function talkLevel(t) {
  if (Math.sin(t * 1.3) + Math.sin(t * 2.9 + 1.7) < -.9) return 0;
  return .25 + .55 * Math.abs(Math.sin(t * 7.8 + Math.sin(t * 1.9) * 1.6));
}

function layout() {
  const face = isFaceState(driver.desired, manifest.states) || isFaceState(driver.state, manifest.states);
  const context = isFaceState(driver.desired, manifest.states) ? driver.bodyContext : driver.desired;
  return {face, ceiling: context?.replace(/Think$/, '') === 'ceiling', panels: stateScreens(context).filter(side => side !== 'camera')};
}

function onStatus(info) {
  if (info.clip !== onStatus.clip) {
    onStatus.clip = info.clip;
    for (const [surface, slot] of ENTRIES[info.clip] || []) paint(surface, slot);
    if (info.clip === 'CeilingToLeftPanel') shown.left = shown.right;
  }
  if (STAGE_ONLY) return;
  const states = manifest.states, target = info.phase === 'idle' ? info.state : info.desired;
  const label = states[target]?.label || target;
  let text = info.phase === 'finishLoop' ? 'Finishing ' + states[info.state].label.toLowerCase() + '…'
    : info.phase === 'idle' ? label : 'Moving to ' + label.toLowerCase() + '…';
  if (patrolling && ['walk', 'walkReverse', 'walkRest', 'walkReverseRest'].includes(info.desired)) text = 'Walking back and forth';
  $('motion-status').textContent = (info.paused ? 'Paused · ' : '') + text;
  $('pause').textContent = info.paused ? 'Resume' : 'Pause';
  updateButtons();
}

function updateButtons() {
  if (STAGE_ONLY || !driver) return;
  const now = layout(), desired = driver.desired;
  const current = patrolling && /^walk/.test(desired) ? 'patrol'
    : CURRENT[desired] || (manifest.states[desired]?.contextualThinking ? 'think' : desired);
  for (const action of ACTIONS) {
    const button = $('action-' + action.id); if (!button) continue;
    button.disabled = action.when ? !action.when(now) : false;
    button.classList.toggle('is-current', action.id === current);
  }
}

// ---------- Actions, shared with the recording window ----------
function send(message) { channel?.postMessage({...message, from: windowId}); }

function run(id, {remote = false} = {}) {
  if (!driver) return;
  if (id === 'pause') controller.pause();
  else if (id === 'resume') controller.resume();
  else if (id === 'reset') { patrolling = false; driver.go('ready', {urgent: true, preservePanels: false}); }
  else {
    const action = ACTIONS.find(item => item.id === id);
    if (!action || (action.when && !action.when(layout()))) return;
    patrolling = id === 'patrol';
    if (action.run) action.run(driver); else driver.go(action.state, FREE);
  }
  updateButtons();
  if (!remote) send({type: 'action', id});
}

function applySync({state, patrol, paused}) {
  if (!manifest.states[state]) return;
  // Snapping skips the entry clip, so put the right picture on first.
  if (state.replace(/Think$/, '') === 'ceiling') paint('right', 'ceiling');
  patrolling = Boolean(patrol);
  driver.go(state, {urgent: true, preservePanels: false, patrol: patrolling});
  if (paused) controller.pause();
}

function applySettings(next, {remote = false} = {}) {
  settings = {...settings, ...next};
  try { localStorage.setItem('merlin-broll-settings', JSON.stringify(settings)); } catch {}
  stage.classList.toggle('hide-clock', !settings.clock);
  const [w, h] = settings.frame === '16:9' ? [16, 9] : [4, 3];
  document.documentElement.style.setProperty('--frame', w + ' / ' + h);
  document.documentElement.style.setProperty('--frame-ratio', String(w / h));
  if (!STAGE_ONLY) {
    $('talk').checked = settings.talk; $('clock').checked = settings.clock;
    $('speed').value = String(settings.speed); $('frame').value = settings.frame;
  }
  if (!remote) send({type: 'settings', settings});
}

channel?.addEventListener('message', ({data}) => {
  if (!data || data.from === windowId) return;
  if (data.type === 'action') run(data.id, {remote: true});
  else if (data.type === 'settings') applySettings(data.settings, {remote: true});
  else if (data.type === 'slot') loadSlot(data.id).catch(() => {});
  else if (data.type === 'sync' && STAGE_ONLY && !applySync.done) {
    applySync.done = true;
    if (driver) applySync(data); else pendingSync = data;
  } else if (!STAGE_ONLY && (data.type === 'hello' || data.type === 'here')) {
    stageWindows.add(data.from); updateRemote();
    if (data.type === 'hello' && driver) send({type: 'sync', state: driver.desired, patrol: patrolling, paused: controller.paused});
  } else if (!STAGE_ONLY && data.type === 'bye') { stageWindows.delete(data.from); updateRemote(); }
  else if (STAGE_ONLY && data.type === 'ping') send({type: 'here'});
});
addEventListener('pagehide', () => { if (STAGE_ONLY) send({type: 'bye'}); });

function updateRemote() {
  const count = stageWindows.size;
  $('remote-status').textContent = count
    ? (count === 1 ? 'Recording window connected.' : count + ' recording windows connected.') + ' Everything you press here plays there too.'
    : 'Open the recording window, put it on any screen, and record it while you click here. Everything you press here plays there too.';
  $('remote-status').classList.toggle('connected', count > 0);
}

// ---------- Keyboard ----------
addEventListener('keydown', event => {
  if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
  const target = event.target;
  if (target.closest?.('select, textarea, input:not([type=checkbox])')) return;
  const key = event.key.toLowerCase();
  if (key === ' ') {
    if (target.closest?.('button, input')) return;
    event.preventDefault(); run(controller?.paused ? 'resume' : 'pause'); return;
  }
  if (key === '0') { run('reset'); return; }
  if (key === 'm') { applySettings({talk: !settings.talk}); hint(settings.talk ? 'Talking mouth on' : 'Talking mouth off'); return; }
  if (key === 'k') { applySettings({clock: !settings.clock}); return; }
  if (!STAGE_ONLY && (key === 'h' || (key === 'escape' && document.body.classList.contains('clean')))) { toggleClean(); return; }
  const action = ACTIONS.find(item => item.key === key);
  if (action) { event.preventDefault(); run(action.id); }
});

// ---------- Clean view, recording window, full screen ----------
let hintTimer;
function hint(text, duration = 1800) {
  const element = $('stage-hint');
  element.textContent = text; element.hidden = false; element.classList.remove('fade');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => { element.classList.add('fade'); hintTimer = setTimeout(() => { element.hidden = true; }, 400); }, duration);
}
function toggleClean(force) {
  const clean = document.body.classList.toggle('clean', force);
  if (clean) hint('Press H to show the controls');
  else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}
function toggleFullscreen() {
  if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return; }
  if (!STAGE_ONLY) toggleClean(true);
  document.documentElement.requestFullscreen?.().catch(() => {});
}
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && !STAGE_ONLY) toggleClean(false); });
stage.addEventListener('dblclick', toggleFullscreen);
let cursorTimer;
addEventListener('pointermove', () => {
  document.body.classList.remove('idle-cursor'); clearTimeout(cursorTimer);
  cursorTimer = setTimeout(() => document.body.classList.add('idle-cursor'), 1500);
});

// ---------- Dashboard ----------
function slotMessage(text) { if (!STAGE_ONLY) $('slot-status').textContent = text; }

function buildDashboard() {
  const groups = $('actions');
  for (const name of [...new Set(ACTIONS.map(action => action.group))]) {
    const group = document.createElement('div'); group.className = 'action-group';
    const title = document.createElement('h3'); title.textContent = name; group.append(title);
    const grid = document.createElement('div'); grid.className = 'action-grid';
    for (const action of ACTIONS.filter(item => item.group === name)) {
      const button = document.createElement('button');
      button.type = 'button'; button.id = 'action-' + action.id; button.disabled = true;
      button.innerHTML = '<span></span><kbd></kbd>';
      button.firstChild.textContent = action.label; button.lastChild.textContent = action.key.toUpperCase();
      button.setAttribute('aria-keyshortcuts', action.key.toUpperCase());
      button.addEventListener('click', () => run(action.id));
      grid.append(button);
    }
    group.append(grid); groups.append(group);
  }
  for (const slot of SLOTS) $('slots').append(slotCard(slot));
  $('pause').addEventListener('click', () => run(controller.paused ? 'resume' : 'pause'));
  $('reset').addEventListener('click', () => run('reset'));
  $('clean').addEventListener('click', () => toggleClean(true));
  $('popout').addEventListener('click', () => {
    const [w, h] = settings.frame === '16:9' ? [1600, 900] : [1280, 960];
    const opened = window.open('./?view=stage', 'merlin-broll-stage', `popup,width=${w},height=${h}`);
    if (!opened) slotMessage('The browser blocked the recording window. Allow pop-ups for this page, or open ./?view=stage yourself.');
  });
  $('talk').addEventListener('change', event => applySettings({talk: event.target.checked}));
  $('clock').addEventListener('change', event => applySettings({clock: event.target.checked}));
  $('speed').addEventListener('change', event => applySettings({speed: Number(event.target.value)}));
  $('frame').addEventListener('change', event => applySettings({frame: event.target.value}));
}

function slotCard(slot) {
  const card = document.createElement('div');
  card.className = 'slot'; card.id = 'slot-' + slot.id;
  card.innerHTML = `
    <h3></h3>
    <label class="drop">
      <span class="drop-empty"></span>
      <input type="file" accept="image/*,video/mp4,video/webm,video/quicktime">
    </label>
    ${slot.designs ? '<select class="design"><option value="">Or a MERLIN design…</option></select>' : ''}
    <div class="slot-actions">
      <div class="fit" role="group" aria-label="How the picture fits">
        <button type="button" data-fit="cover" aria-pressed="true">Fill</button>
        <button type="button" data-fit="contain" aria-pressed="false">Fit</button>
      </div>
      <button type="button" class="clear">Clear</button>
    </div>`;
  card.querySelector('h3').textContent = slot.label;
  const drop = card.querySelector('.drop'), input = card.querySelector('input');
  drop.style.setProperty('--shape', slot.shape);
  input.setAttribute('aria-label', 'Choose a picture for the ' + slot.label.toLowerCase());
  const design = card.querySelector('.design');
  if (design) {
    design.setAttribute('aria-label', 'MERLIN design for the ' + slot.label.toLowerCase());
    for (const {id, label} of PANEL_TYPES) design.add(new Option(label, id));
    design.addEventListener('change', () => design.value ? saveSlot(slot, {kind: 'design', design: design.value}) : clearSlot(slot));
  }
  input.addEventListener('change', () => { if (input.files[0]) saveFile(slot, input.files[0]); input.value = ''; });
  drop.addEventListener('dragover', event => { event.preventDefault(); drop.classList.add('dragging'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
  drop.addEventListener('drop', event => {
    event.preventDefault(); drop.classList.remove('dragging');
    const file = event.dataTransfer.files[0]; if (file) saveFile(slot, file);
  });
  for (const button of card.querySelectorAll('[data-fit]')) button.addEventListener('click', () => {
    const record = slotRecords[slot.id];
    if (record && record.kind !== 'design' && record.fit !== button.dataset.fit) saveSlot(slot, {...record, fit: button.dataset.fit});
  });
  card.querySelector('.clear').addEventListener('click', () => clearSlot(slot));
  return card;
}

function renderSlot(slot) {
  const card = $('slot-' + slot.id); if (!card) return;
  const record = slotRecords[slot.id], drop = card.querySelector('.drop');
  drop.querySelectorAll('img, video, canvas').forEach(element => {
    if (element.src?.startsWith('blob:')) URL.revokeObjectURL(element.src);
    element.remove();
  });
  drop.dataset.fit = record?.fit || 'cover';
  drop.classList.toggle('filled', Boolean(record));
  card.querySelector('.drop-empty').textContent = record ? '' : (slot.empty ? 'Drop a picture · ' + slot.empty.toLowerCase() : 'Drop a picture or click to choose');
  if (record?.kind === 'design') {
    const preview = document.createElement('canvas'); preview.width = 900; preview.height = 1080;
    paintPanel(preview.getContext('2d'), 900, 1080, {...createDemoState(record.design), type: record.design}, {art: panelArt});
    drop.prepend(preview);
  } else if (record) {
    const media = document.createElement(record.kind === 'video' ? 'video' : 'img');
    media.src = URL.createObjectURL(record.blob); media.alt = '';
    if (record.kind === 'video') Object.assign(media, {muted: true, loop: true, autoplay: true, playsInline: true});
    drop.prepend(media);
  }
  const design = card.querySelector('.design');
  if (design) design.value = record?.kind === 'design' ? record.design : '';
  for (const button of card.querySelectorAll('[data-fit]')) {
    button.setAttribute('aria-pressed', String((record?.fit || 'cover') === button.dataset.fit));
    button.disabled = !record || record.kind === 'design';
  }
  card.querySelector('.clear').disabled = !record;
}

async function saveSlot(slot, record) {
  try {
    await store('readwrite', slots => slots.put(record, slot.id));
    await loadSlot(slot.id);
    send({type: 'slot', id: slot.id});
    slotMessage('');
  } catch (error) { slotMessage(slot.label + ': ' + (error.message || 'that picture couldn’t be used.')); }
}
function saveFile(slot, file) {
  const video = file.type.startsWith('video/'), image = file.type.startsWith('image/');
  if (!video && !image) { slotMessage('Choose a picture (PNG, JPEG, WebP, GIF, SVG) or a video (MP4, WebM, MOV).'); return; }
  if (file.size > (video ? 300 : 40) * 1024 * 1024) { slotMessage(video ? 'Choose a video under 300 MB.' : 'Choose a picture under 40 MB.'); return; }
  slotMessage('Adding ' + file.name + '…');
  saveSlot(slot, {kind: video ? 'video' : 'image', blob: file, name: file.name, fit: slotRecords[slot.id]?.fit || 'cover'});
}
async function clearSlot(slot) {
  await store('readwrite', slots => slots.delete(slot.id)).catch(() => {});
  await loadSlot(slot.id).catch(() => {});
  send({type: 'slot', id: slot.id});
}

if (STAGE_ONLY) {
  document.body.classList.add('stage-only', 'clean');
  document.title = 'MERLIN b-roll · recording window';
} else buildDashboard();
applySettings(settings, {remote: true});
$('retry').addEventListener('click', () => location.reload());
start().then(() => { if (STAGE_ONLY) hint('Recording window · double-click for full screen', 2600); }).catch(fail);
