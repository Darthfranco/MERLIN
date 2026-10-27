import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {AnimationMixer, AnimationClip, Object3D, NumberKeyframeTrack, Group, Box3, Vector3, Mesh, PlaneGeometry} from './vendor/three/build/three.module.min.js';
import {MotionController} from './motion.js';
import {surfaceBasis} from './screens.js';
import {createCharacterDriver, createSpeechOverlay, createSweep, runtimeManifest, createRenderLoop, createHiddenMeshCuller, renderPixelRatio, RENDER_BUDGET} from './character.js';
import {loadFootprintSource} from '../scripts/build_motion_footprints.mjs';
import {chooseClockSpot} from './clock-layout.js';

const manifest = JSON.parse(readFileSync(new URL('../states.json', import.meta.url)));
function fixture({reducedMotion = false, dualPanels = false} = {}) {
  const fixtureManifest = structuredClone(manifest);
  if (dualPanels && !fixtureManifest.states.both) {
    fixtureManifest.states.both = {parent: 'ready', enter: 'TestBothEnter', idle: 'TestBothIdle', exit: 'TestBothExit'};
    for (const clip of ['TestBothEnter', 'TestBothIdle', 'TestBothExit']) fixtureManifest.clips[clip] = {frames: 48};
  }
  const model = new Object3D();
  const clips = Object.entries(fixtureManifest.clips).map(([name, meta], index) => new AnimationClip(name, (meta.frames - 1) / 24,
    [new NumberKeyframeTrack('.position[x]', [0, (meta.frames - 1) / 24], [index, index])]));
  let driver;
  const controller = new MotionController(new AnimationMixer(model), clips, fixtureManifest, () => driver?.motionChanged());
  const screens = Object.fromEntries(['left', 'right'].map(side => [side, {paints: 0, version: 0,
    draw(painter, options) {this.painter = painter; this.options = options; this.version++;}, tick() {this.paints++;},
    copyFrom(other) {this.painter = other.painter; this.options = other.options; this.version++;},
    setAspect(aspect) {this.aspect = aspect;}, reset() {this.painter = null; this.version++;}}]));
  driver = createCharacterDriver({controller, screens, reducedMotion});
  return {controller, driver, model, screens};
}
function advance(controller, seconds) {for (let i = 0; i < seconds * 60; i++) controller.update(1 / 60);}

function renderFixture(options = {}) {
  let clock = 0, id = 0; const frames = new Map(), timers = new Map(), renders = [];
  const loop = createRenderLoop({render: delta => renders.push(delta), now: () => clock,
    requestFrame: callback => {frames.set(++id, callback); return id;}, cancelFrame: id => frames.delete(id),
    scheduleTimer: (callback, delay) => {timers.set(++id, {callback, at: clock + delay}); return id;}, cancelTimer: id => timers.delete(id), ...options});
  function step(milliseconds) {
    clock += milliseconds;
    for (const [id, timer] of [...timers]) if (timer.at <= clock) {timers.delete(id); timer.callback();}
    const scheduled = [...frames]; frames.clear(); for (const [, callback] of scheduled) callback(clock);
  }
  return {loop, frames, timers, renders, step};
}

test('render loop caps GPU frames, preserves elapsed motion, and cancels all work when hidden', () => {
  const {loop, frames, timers, renders, step} = renderFixture();
  loop.invalidate(); for (let i = 0; i < 1200; i++) step(1000 / 120);
  assert.ok(renders.length >= 295 && renders.length <= 301, `${renders.length} frames across ten seconds`);
  step(100); assert.ok(renders.at(-1) >= .099, 'dropped frames do not slow motion to a fixed .05 step');
  loop.setVisible(false); assert.equal(frames.size + timers.size, 0);
  const count = renders.length; for (let i = 0; i < 120; i++) step(1000 / 120); assert.equal(renders.length, count);
  loop.invalidate(); assert.equal(frames.size + timers.size, 0);
  loop.setVisible(true); step(16); assert.equal(renders.length, count + 1); assert.ok(renders.at(-1) < .04);
  loop.destroy(); assert.equal(frames.size + timers.size, 0);
});

test('a static reduced-motion scene renders only changes while dynamic panels can wake it', () => {
  let changed = false, live = false, polls = 0;
  const {loop, frames, timers, renders, step} = renderFixture({animated: () => false, dynamic: () => live,
    poll: () => {polls++; const result = changed; changed = false; return result;}});
  loop.invalidate(); step(16); assert.equal(renders.length, 1); assert.equal(frames.size + timers.size, 0);
  for (let i = 0; i < 100; i++) step(100); assert.equal(renders.length, 1);
  live = true; loop.invalidate(); step(40); assert.equal(renders.length, 2);
  for (let i = 0; i < 4; i++) step(250); assert.equal(renders.length, 2);
  changed = true; step(250); assert.equal(renders.length, 3); assert.ok(polls >= 6);
  loop.destroy(); assert.equal(frames.size + timers.size, 0);
});

test('render resolution stays bounded on retina desktop and narrow mobile surfaces', () => {
  for (const [width, height, dpr] of [[1360, 1020, 2], [2000, 1500, 3], [390, 292.5, 3], [800, 600, 1]]) {
    const ratio = renderPixelRatio(width, height, dpr);
    assert.ok(ratio <= RENDER_BUDGET.maxPixelRatio && ratio <= dpr);
    assert.ok(width * height * ratio * ratio <= RENDER_BUDGET.maxPixels + 1);
  }
  const ratio = renderPixelRatio(1360, 1020, 2);
  assert.ok((1360 * 1020 * ratio ** 2 * 30) / (1360 * 1020 * 4 * 60) < .08);
});

test('runtime manifest excludes unexported states, descendants, unavailable routes and stranded destinations', () => {
  const source = {initial: 'both', states: {
    ready: {idle: 'Ready', parent: null},
    face: {idle: 'Face', parent: 'ready', enter: 'InFace', exit: 'OutFace'},
    left: {idle: 'Left', parent: 'ready', enter: 'InLeft', exit: 'OutLeft'},
    both: {idle: 'Both', parent: 'ready', enter: 'MissingBoth', exit: 'OutBoth'},
    seated: {idle: 'Seat', parent: 'both', exit: 'OutSeat'},
    unreachable: {idle: 'Stranded', parent: 'ready', exit: 'OutStranded'},
    trapped: {idle: 'Trap', parent: 'ready', enter: 'InTrap'},
  }, routes: [
    {from: 'left', to: 'face', clip: 'LeftFace'},
    {from: 'both', to: 'face', clip: 'BothFace'},
    {from: 'ready', to: 'unreachable', clip: 'MissingRoute'},
  ]};
  const original = structuredClone(source);
  const available = ['Ready', 'Face', 'InFace', 'OutFace', 'Left', 'InLeft', 'OutLeft', 'LeftFace', 'Both', 'OutBoth',
    'Seat', 'OutSeat', 'BothFace', 'Stranded', 'OutStranded', 'Trap', 'InTrap'];
  const filtered = runtimeManifest(source, available);
  assert.deepEqual(Object.keys(filtered.states), ['ready', 'face', 'left']);
  assert.deepEqual(filtered.routes, [{from: 'left', to: 'face', clip: 'LeftFace'}]);
  assert.equal(filtered.initial, 'ready');
  assert.deepEqual(filtered.unavailableStates, ['both', 'seated', 'unreachable', 'trapped']);
  assert.deepEqual(source, original, 'filtering never rewrites authored states');
  assert.throws(() => runtimeManifest(source, []), /ready pose/);
});

test('actual export supports every advertised runtime state and route even during an asset update', async () => {
  const {gltf, manifest} = await loadFootprintSource();
  const clips = new Set(gltf.animations.map(clip => clip.name));
  const filtered = runtimeManifest(manifest, clips);
  assert.ok(filtered.states.ready); assert.ok(filtered.states.face);
  for (const state of Object.values(filtered.states)) for (const key of ['idle', 'enter', 'exit']) if (state[key]) assert.ok(clips.has(state[key]));
  for (const route of filtered.routes) assert.ok(clips.has(route.clip) && filtered.states[route.from] && filtered.states[route.to]);
  let driver;
  const controller = new MotionController(new AnimationMixer(gltf.scene), gltf.animations, filtered, () => driver?.motionChanged());
  driver = createCharacterDriver({controller, screens: {}});
  assert.deepEqual(driver.capabilities.states, Object.keys(filtered.states));
  driver.go('face', {pace: 4}); advance(controller, 1); assert.equal(driver.state, 'face');
  driver.go('ready', {pace: 4}); advance(controller, 1); assert.equal(driver.state, 'ready');
});

test('urgent face interrupts every ambient and panel entry without waiting for a clip', () => {
  for (const start of ['walk', 'toss', 'left', 'right', 'nap']) {
    for (const time of [.5, 5, 12]) {
      const {controller, driver} = fixture(); driver.go(start); advance(controller, time);
      driver.go('face', {urgent: true});
      assert.equal(driver.state, 'face', `${start} at ${time}`); assert.equal(driver.phase, 'idle');
      assert.equal(controller.clip, 'FullFaceIdle'); assert.equal(controller.retiring.length, 0);
      advance(controller, 20); assert.equal(controller.current, 'face', 'old completion events cannot resume an interrupted action');
    }
  }
});

test('invalid urgent state preserves the current action', () => {
  const {controller, driver} = fixture(); driver.go('face', {urgent: true}); const active = controller.active;
  assert.throws(() => driver.go('missing', {urgent: true}), RangeError);
  assert.equal(controller.active, active); assert.equal(driver.desired, 'face');
});

test('reduced motion changes to correct static face/panel states and suppresses ambience', async () => {
  const {controller, driver, model} = fixture({reducedMotion: true});
  driver.go('face'); const facePosition = model.position.x;
  assert.equal(controller.paused, true); advance(controller, 3); assert.equal(controller.active.time, 0);
  driver.showPanel('timer', {status: 'running', seconds: 20, durationSeconds: 60});
  assert.equal(driver.state, 'right'); assert.notEqual(model.position.x, facePosition); assert.equal(controller.active.time, 0);
  for (const ambient of ['walk', 'toss', 'sweep', 'nap', 'dance']) {driver.go(ambient); assert.equal(driver.state, 'ready');}
  driver.go('faceThink'); assert.equal(await driver.whenSettled('faceThink'), true);
});

test('live panels never acquire demo values and callbacks keep wall-clock countdown data', () => {
  const {driver, screens} = fixture({reducedMotion: true});
  const unknown = driver.showPanel('oven'); assert.deepEqual(unknown, {type: 'oven'});
  let remaining = 40;
  driver.showPanel('timer', () => ({status: 'running', seconds: remaining, durationSeconds: 60}), 'left');
  assert.equal(screens.left.options.animate, true); assert.equal(driver.panel.seconds, 40);
  remaining = 12; assert.equal(driver.panel.seconds, 12);
  driver.updatePanel({status: 'cancelled'}, 'left'); assert.equal(driver.panel.status, 'cancelled'); assert.equal(driver.panel.seconds, 12);
  assert.equal(screens.left.paints, 1);
  assert.throws(() => driver.showPanel('invented'), TypeError);
  assert.throws(() => driver.showPanel('timer', {}, 'camera'), TypeError);
});

test('transition pace shortens authored routes but restores normal idle playback', async () => {
  const {driver, controller} = fixture();
  driver.go('right', {pace: 4});
  assert.notEqual(controller.phase, 'idle'); assert.equal(controller.active.getEffectiveTimeScale(), 4);
  const arrival = driver.whenSettled('right'); advance(controller, 2);
  assert.equal(await arrival, true); assert.equal(controller.active.getEffectiveTimeScale(), 1);
  const at = controller.active.time; advance(controller, .25); assert.ok(Math.abs(controller.active.time - at - .25) < .001);
  assert.throws(() => driver.go('face', {pace: 0}), RangeError); assert.equal(driver.desired, 'right');
  driver.go('face', {urgent: true, pace: 4}); assert.equal(controller.active.getEffectiveTimeScale(), 1);
});

test('independent panel installation, updates and clear do not navigate or overwrite the other side', () => {
  const {driver, screens} = fixture({dualPanels: true});
  let seconds = 45;
  driver.showPanel('timer', () => ({status: 'running', label: 'First timer', seconds, durationSeconds: 60}), 'left', {navigate: false});
  driver.showPanel('lights', {status: 'off', label: 'Second panel'}, 'right', {navigate: false});
  assert.equal(driver.desired, 'ready'); assert.equal(driver.phase, 'idle');
  seconds = 23; driver.updatePanel({status: 'on'}, 'right'); driver.refreshPanels(['left']);
  assert.equal(driver.panels.left.seconds, 23); assert.equal(driver.panels.right.status, 'on');
  function paint(surface) {
    const texts = [], context = new Proxy({measureText: value => ({width: String(value).length * 12}), fillText: value => texts.push(String(value))},
      {get: (target, name) => name in target ? target[name] : () => {}});
    surface.painter(context, 900, 1080); return texts;
  }
  const leftTexts = paint(screens.left), rightTexts = paint(screens.right);
  assert.ok(leftTexts.includes('First timer')); assert.ok(leftTexts.includes('00:23')); assert.ok(!leftTexts.includes('Second panel'));
  assert.ok(rightTexts.includes('Second panel')); assert.ok(!rightTexts.includes('First timer'));
  assert.ok(!leftTexts.includes('Pause')); assert.ok(!rightTexts.includes('Turn off'));
  driver.clearPanel('left'); assert.equal(driver.panels.left, null); assert.equal(screens.left.painter, null);
  assert.equal(driver.panels.right.status, 'on'); assert.equal(driver.desired, 'ready');
  assert.equal(driver.updatePanel({seconds: 1}, 'left'), false);
});

test('unchanged panels reuse textures and do no repeated painting while countdowns update at display precision', () => {
  const {driver, screens} = fixture();
  driver.showPanel('lights', {status: 'off'}, 'right', {navigate: false});
  const firstPainter = screens.right.painter;
  for (let i = 0; i < 600; i++) {driver.refreshPanels(); driver.showPanel('lights', {status: 'off'}, 'right', {navigate: false});}
  assert.equal(driver.panelPaints, 1); assert.equal(screens.right.painter, firstPainter);
  let seconds = 60;
  driver.showPanel('timer', () => ({status: 'running', seconds, durationSeconds: 60}), 'left', {navigate: false});
  for (let i = 0; i < 40; i++) {seconds = 60 - i / 4; driver.refreshPanels(['left']);}
  assert.equal(driver.panelPaints, 11, 'one static paint plus ten countdown values across ten seconds');
  assert.equal(screens.left.paints, 9);
});

test('zero-scale meshes and concealed body meshes skip GPU submission and restore on body return', async () => {
  const {gltf} = await loadFootprintSource(), mixer = new AnimationMixer(gltf.scene), cull = createHiddenMeshCuller(gltf.scene);
  function pose(name, face) {mixer.stopAllAction(); mixer.clipAction(gltf.animations.find(clip => clip.name === name)).play(); mixer.update(0); gltf.scene.updateMatrixWorld(true); return cull(face);}
  const ready = pose('ReadyIdle', false), face = pose('FullFaceIdle', true), returned = pose('ReadyIdle', false);
  assert.ok(ready > 0 && ready < 70); assert.ok(face > 0 && face < ready / 2); assert.equal(returned, ready);
  gltf.scene.traverse(object => {if (object.isSkinnedMesh) assert.equal(object.visible, true);});
});

test('culled right panel restores during its authored entry and after a full-face excursion', async () => {
  const {gltf, manifest: authored} = await loadFootprintSource();
  const manifest = runtimeManifest(authored, gltf.animations.map(clip => clip.name)), cull = createHiddenMeshCuller(gltf.scene);
  let driver;
  const controller = new MotionController(new AnimationMixer(gltf.scene), gltf.animations, manifest, () => driver?.motionChanged());
  driver = createCharacterDriver({controller, screens: {}});
  const panelMeshes = [];
  gltf.scene.traverse(object => {if (object.isMesh && object.parent.name === 'Panel_•_white_card') panelMeshes.push(object);});
  assert.equal(panelMeshes.length, 2);
  function run(seconds) {
    for (let i = 0; i < seconds * 30; i++) {
      controller.update(1 / 30); gltf.scene.updateMatrixWorld(true);
      cull(controller.current === 'face' && controller.phase === 'idle');
    }
  }
  driver.go('right', {pace: 4}); run(33);
  assert.equal(driver.state, 'right'); assert.equal(driver.phase, 'idle');
  assert.ok(panelMeshes.every(mesh => mesh.visible && mesh.parent.visible && mesh.getWorldScale(new Vector3()).lengthSq() > 2.9));
  driver.go('face', {pace: 4}); run(6); assert.ok(panelMeshes.every(mesh => !mesh.visible));
  driver.go('right', {pace: 4}); run(6);
  assert.equal(driver.state, 'right'); assert.equal(driver.phase, 'idle');
  assert.ok(panelMeshes.every(mesh => mesh.visible && mesh.parent.visible && mesh.getWorldScale(new Vector3()).lengthSq() > 2.9));
});

test('available dual-panel state is selected from the manifest and panel records survive face mode', () => {
  const {driver, controller} = fixture({dualPanels: true, reducedMotion: true});
  driver.showPanel('timer', {status: 'running', seconds: 20, durationSeconds: 60}, 'left');
  driver.showPanel('lights', {status: 'off'}, 'right');
  assert.equal(driver.state, 'both'); assert.ok(driver.capabilities.states.includes('both'));
  assert.deepEqual(driver.capabilities.routes, controller.routes || []);
  driver.go('face'); assert.equal(driver.state, 'face');
  assert.equal(driver.panels.left.type, 'timer'); assert.equal(driver.panels.right.status, 'off');
  assert.equal(controller.bodyContext, 'both');
  driver.clearPanel('both'); assert.deepEqual(driver.panels, {left: null, right: null});
});

test('ceiling content keeps its aspect and live data through face return and left docking', () => {
  for (const reducedMotion of [false, true]) {
    const {driver, controller, screens} = fixture({reducedMotion}); let seconds = 40;
    for (const side of ['right', 'left']) screens[side].basis = surfaceBasis(new Mesh(new PlaneGeometry(4.75, 5.7)));
    screens.right.basis.mesh.scale.set(9.65 / 4.75, 6.8 / 5.7, 1);
    driver.showPanel('timer', () => ({status:'running', label:'Carried timer', seconds, durationSeconds:60}), 'right', {navigate:false});
    driver.go('ceiling', {pace:8}); advance(controller, 2); driver.syncScreens();
    assert.equal(driver.state, 'ceiling'); assert.ok(Math.abs(screens.right.aspect - 9.65 / 6.8) < 1e-6);
    assert.equal(screens.right.options.reflow, false, 'Portrait designs are contained rather than stretched into the wide card');
    driver.go('face', {pace:8}); advance(controller, 2); assert.equal(controller.bodyContext, 'ceiling');
    assert.equal(driver.panels.right.label, 'Carried timer');
    driver.go('ceiling', {pace:8}); advance(controller, 2);
    driver.go('left', {pace:8});
    if (!reducedMotion) driver.updatePanel(() => ({status:'running',label:'Updated while carried',seconds,durationSeconds:60}), 'right');
    advance(controller, 2); driver.syncScreens(); assert.equal(driver.state, 'left');
    assert.ok(Math.abs(screens.left.aspect - 5 / 6) < 1e-6);
    const carriedLabel = reducedMotion ? 'Carried timer' : 'Updated while carried';
    seconds = 12; driver.refreshPanels(['left']); assert.equal(driver.panels.left.seconds, 12);
    driver.updatePanel({label:'Independent right edit',seconds:99}, 'right');
    assert.equal(driver.panels.left.label, carriedLabel); assert.equal(driver.panels.left.seconds, 12);
    const texts = [], context = new Proxy({measureText: value => ({width: String(value).length * 12}), fillText: value => texts.push(String(value))},
      {get: (target, name) => name in target ? target[name] : () => {}});
    screens.left.painter(context, 900, 1080);
    assert.ok(texts.includes(carriedLabel)); assert.ok(texts.includes('00:12')); assert.ok(!texts.includes('Independent right edit'));
  }
});

test('settlement wakes on arrival, replacement, abort and destruction without stale continuations', async () => {
  const {driver, controller} = fixture();
  driver.go('right'); const replaced = driver.whenSettled('right');
  driver.go('face', {urgent: true}); assert.equal(await replaced, false);
  assert.equal(await driver.whenSettled('face'), true);
  driver.go('left'); const abort = new AbortController(), interrupted = driver.whenSettled('left', abort.signal);
  abort.abort(); assert.equal(await interrupted, false);
  const arrived = driver.whenSettled('left'); advance(controller, 30); assert.equal(await arrived, true);
  driver.go('right'); const destroyed = driver.whenSettled('right'); driver.destroy();
  assert.equal(await destroyed, false); assert.equal(driver.go('face'), false);
});

test('procedural sweep is interruptible and reports a separate state without changing the studio manifest', () => {
  const {driver, controller} = fixture(); driver.go('sweep');
  assert.equal(driver.state, 'sweep'); assert.equal(controller.current, 'ready'); assert.equal(manifest.states.sweep, undefined);
  driver.go('face', {urgent: true}); assert.equal(driver.state, 'face');
  driver.setSpeaking(2); assert.equal(driver.speaking, 1); driver.setSpeaking(NaN); assert.equal(driver.speaking, 0);
});

test('speech overlay restores exact authored scale, never compounds, and never reveals hidden bars', () => {
  const root = new Group(), bar = new Object3D(), hidden = new Object3D();
  bar.name = 'Display_mode_•_mouth_bar_01'; bar.scale.set(1, 2, 1);
  hidden.name = 'Display_mode_•_mouth_bar_02'; hidden.scale.set(0, 0, 0); root.add(bar, hidden);
  const speech = createSpeechOverlay(root);
  for (let i = 0; i < 1000; i++) {speech.restore(); speech.update(i / 60, .8, true); assert.ok(bar.scale.y <= 6);}
  assert.deepEqual(hidden.scale.toArray(), [0, 0, 0]); speech.restore(); assert.deepEqual(bar.scale.toArray(), [1, 2, 1]);
  speech.update(1, 1, false); assert.deepEqual(bar.scale.toArray(), [1, 2, 1]);
});

test('actual exported geometry can snap to full face and hide every carried prop immediately', async () => {
  const {gltf, manifest} = await loadFootprintSource();
  const controller = new MotionController(new AnimationMixer(gltf.scene), gltf.animations, manifest);
  controller.snap('toss'); advance(controller, 2.5); controller.snap('face');
  const bars = []; gltf.scene.traverse(object => {if (/mouth_bar/.test(object.name)) bars.push(object);});
  assert.equal(bars.length, 7); assert.ok(bars.every(bar => bar.scale.y > .9));
  const props = []; gltf.scene.traverse(object => {if (/ball|fragment/i.test(object.name)) props.push(object);});
  gltf.scene.updateMatrixWorld(true);
  assert.ok(props.length > 30); assert.ok(props.every(prop => prop.getWorldScale(new Vector3()).lengthSq() < 1e-8));
  controller.snap('right', {paused: true}); assert.ok(bars.every(bar => bar.scale.lengthSq() === 0));
  const speech = createSpeechOverlay(gltf.scene); speech.update(0, 1, true);
  assert.ok(bars.every(bar => bar.scale.lengthSq() === 0));
  speech.restore();
  const smile = gltf.scene.getObjectByName('Face_•_luminous_smile'), original = smile.morphTargetInfluences.slice();
  speech.update(0, .8, false, true);
  assert.equal(smile.morphTargetInfluences[smile.morphTargetDictionary.Whistle], .52);
  speech.restore(); assert.deepEqual(smile.morphTargetInfluences, original);
});

test('original sweep stays above the floor and inside its reserved clock envelope', async () => {
  const {gltf, camera, manifest} = await loadFootprintSource();
  const scene = new Group(); scene.add(gltf.scene);
  const controller = new MotionController(new AnimationMixer(gltf.scene), gltf.animations, manifest);
  const sweep = createSweep(gltf.scene, scene), box = new Box3(), point = new Vector3();
  const envelope = {left: .30, right: .70, top: .43, bottom: .91};
  for (let i = 0; i < 50; i++) {
    sweep.restore(); controller.update(.16); sweep.update(i * .16, true); scene.updateMatrixWorld(true); box.setFromObject(sweep.group);
    assert.ok(box.min.y >= .024, 'broom remains above the floor');
    for (let corner = 0; corner < 8; corner++) {
      point.set(corner & 1 ? box.max.x : box.min.x, corner & 2 ? box.max.y : box.min.y, corner & 4 ? box.max.z : box.min.z).project(camera);
      const x = (point.x + 1) / 2, y = (1 - point.y) / 2;
      assert.ok(x >= envelope.left && x <= envelope.right && y >= envelope.top && y <= envelope.bottom, `${x}, ${y} escaped sweep envelope`);
    }
  }
  const footprints = JSON.parse(readFileSync(new URL('./motion-footprints.json', import.meta.url)));
  for (const width of [358, 896]) {
    const spot = chooseClockSpot({width, height: width * .75, clockWidth: width * .27, clockHeight: width * .14,
      obstacles: [...footprints.clips.ReadyIdle, envelope]});
    assert.equal(spot.overlap, 0);
  }
  sweep.restore(); assert.equal(sweep.group.visible, false);
});
