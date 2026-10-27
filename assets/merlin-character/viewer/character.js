import * as THREE from './vendor/three/build/three.module.min.js';
import { GLTFLoader } from './vendor/three/examples/jsm/loaders/GLTFLoader.js';
import { EffectComposer } from './vendor/three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from './vendor/three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from './vendor/three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from './vendor/three/examples/jsm/postprocessing/OutputPass.js';
import { collectScreens } from './screens.js';
import { MotionController } from './motion.js';
import { SceneClock } from './scene-clock.js';
import { PANEL_TYPES, paintPanel, loadPanelArt } from './panels/render.js';

const panelTypes = new Set(PANEL_TYPES.map(panel => panel.id));
const ambient = new Set(['walk', 'toss', 'nap', 'dance', 'sweep']);
const assetURL = path => new URL(path, import.meta.url).href;
const validData = value => value && typeof value === 'object' && !Array.isArray(value);

/** A manifest may arrive before its GLB export; only advertise routes we can play. */
export function runtimeManifest(manifest, clipNames) {
  const clips = new Set(clipNames);
  const states = Object.fromEntries(Object.entries(manifest.states || {}).filter(([, state]) =>
    state && clips.has(state.idle) && ['enter', 'exit'].every(key => !state[key] || clips.has(state[key])))
    .map(([name, state]) => [name, {...state}]));
  if (!states.ready) throw new Error('The character is missing its ready pose.');
  let routes = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, state] of Object.entries(states)) {
      if (['parent', 'rest', 'exitTo'].some(key => state[key] && !states[state[key]])) {delete states[name]; changed = true;}
    }
    routes = (manifest.routes || []).filter(route => clips.has(route.clip) && states[route.from] && states[route.to]).map(route => ({...route}));
    const edges = routes.map(route => [route.from, route.to]);
    for (const [name, state] of Object.entries(states)) {
      if (state.parent && state.enter) edges.push([state.parent, name]);
      if (state.parent && state.exit) edges.push([name, state.exitTo || state.parent]);
      if (state.rest) edges.push([name, state.rest]);
    }
    function reachable(reverse = false) {
      const found = new Set(['ready']), pending = ['ready'];
      for (let index = 0; index < pending.length; index++) for (const edge of edges) {
        const from = edge[reverse ? 1 : 0], to = edge[reverse ? 0 : 1];
        if (from === pending[index] && !found.has(to)) {found.add(to); pending.push(to);}
      }
      return found;
    }
    const outward = reachable(), homeward = reachable(true);
    for (const name of Object.keys(states)) if (!outward.has(name) || !homeward.has(name)) {delete states[name]; changed = true;}
  }
  return {...manifest, initial: states[manifest.initial] ? manifest.initial : 'ready', states, routes,
    clips: Object.fromEntries(Object.entries(manifest.clips || {}).filter(([name]) => clips.has(name))),
    unavailableStates: Object.keys(manifest.states || {}).filter(name => !states[name])};
}

function lineage(state, states) {
  const path = [];
  for (let current = state; current; current = states[current]?.parent) path.push(current);
  return path;
}
const isFaceState = (state, states) => lineage(state, states).includes('face');
function visiblePanels(controller) {
  const layouts = {left: ['left'], right: ['right'], both: ['left', 'right'], seatedLeft: ['left'], seatedRight: ['right']};
  const states = [controller.current, ...(controller.phase === 'idle' ? [] : [controller.arrival])];
  return new Set(states.flatMap(state => {
    if (isFaceState(state, controller.states)) return [];
    const source = lineage(state, controller.states).find(name => controller.states[name]?.screens || layouts[name]);
    return (controller.states[source]?.screens || layouts[source] || []).filter(side => ['left', 'right'].includes(side));
  }));
}

/** Presentation only: no microphone, model, service credentials or demo outcomes. */
export function createCharacterDriver({controller, screens, panelArt = {}, reducedMotion = false, onStatus = () => {}}) {
  let wanted = 'ready', destroyed = false, lastSide = 'right', speaking = 0, listening = false, transitionPace = 1;
  const panels = {left: null, right: null};
  const capabilities = Object.freeze({states: Object.freeze(Object.keys(controller.states)),
    routes: Object.freeze((controller.routes || []).map(route => Object.freeze({...route}))), procedural: Object.freeze(['sweep'])});
  const waiters = new Set();
  const state = () => wanted === 'sweep' && controller.current === 'ready' && controller.phase === 'idle' ? 'sweep' : controller.current;
  const complete = (waiter, result) => {
    waiters.delete(waiter);
    waiter.signal?.removeEventListener('abort', waiter.abort);
    waiter.resolve(result);
  };
  function motionChanged() {
    // The shared controller may resolve context-sensitive thought/face routes.
    if (!(wanted === 'sweep' && controller.desired === 'ready')) wanted = controller.desired;
    if (controller.active) controller.active.setEffectiveTimeScale(['idle', 'finishLoop'].includes(controller.phase) ? 1 : transitionPace);
    for (const waiter of waiters) {
      if (destroyed || waiter.signal?.aborted || waiter.state !== wanted) complete(waiter, false);
      else if (state() === waiter.state && controller.phase === 'idle') complete(waiter, true);
    }
    if (!destroyed) onStatus({state: state(), desired: wanted, phase: controller.phase, clip: controller.clip,
      paused: controller.paused, bodyContext: controller.bodyContext, procedural: state() === 'sweep'});
  }
  function go(next, {urgent = false, pace = 1} = {}) {
    if (destroyed) return false;
    if (next !== 'sweep' && !controller.states[next]) throw new RangeError('Unknown MERLIN state: ' + next);
    if (!Number.isFinite(pace) || pace <= 0 || pace > 8) throw new RangeError('Animation pace must be greater than zero and at most eight.');
    transitionPace = pace;
    wanted = reducedMotion && ambient.has(next) ? 'ready' : next;
    const destination = wanted === 'sweep' ? 'ready' : wanted;
    if (urgent || reducedMotion) {
      const pending = controller.phase === 'idle' ? controller.current : controller.arrival;
      if (isFaceState(destination, controller.states) && !isFaceState(pending, controller.states)) controller.bodyContext = controller.states[pending]?.rest || pending;
      controller.snap(destination, {paused: reducedMotion});
    } else if (destination === 'ready' && controller.ready) controller.ready();
    else controller.go(destination);
    motionChanged();
    return true;
  }
  function readPanel(record = panels[lastSide]) {
    if (!record) return null;
    const value = typeof record.data === 'function' ? record.data() : record.data;
    if (!validData(value)) throw new TypeError('Panel data must be an object.');
    // The caller supplies every real value; missing states stay visibly unknown.
    return {...value, type: record.type};
  }
  function showPanel(type, data = {}, side = 'right', options = {}) {
    if (destroyed) return false;
    if (!panelTypes.has(type)) throw new TypeError('Choose a supported MERLIN panel design.');
    if (!['right', 'left'].includes(side)) throw new TypeError('Use the left or right panel.');
    if (typeof data !== 'function' && !validData(data)) throw new TypeError('Panel data must be an object or function.');
    const record = {type, data, side};
    readPanel(record); panels[side] = record; lastSide = side;
    screens[side].draw((context, width, height) => paintPanel(context, width, height, readPanel(record), {art: panelArt, controls: false}), {animate: true});
    if (options.navigate !== false) go(panels.left && panels.right && controller.states.both ? 'both' : side, options);
    return readPanel(record);
  }
  function updatePanel(data, side = 'right') {
    if (!['right', 'left'].includes(side)) throw new TypeError('Use the left or right panel.');
    const panel = panels[side];
    if (destroyed || !panel) return false;
    if (typeof data !== 'function' && !validData(data)) throw new TypeError('Panel data must be an object or function.');
    panel.data = typeof data === 'function' ? data : {...readPanel(panel), ...data};
    lastSide = side;
    // Screen content keeps updating when character motion is reduced/paused.
    screens[panel.side].tick(0);
    return readPanel(panel);
  }
  function clearPanel(side) {
    if (!['right', 'left', 'both'].includes(side)) throw new TypeError('Clear the left, right, or both panels.');
    if (destroyed) return false;
    for (const target of side === 'both' ? ['left', 'right'] : [side]) {
      panels[target] = null; screens[target].reset?.();
      const surface = screens[target]; surface.context?.clearRect(0, 0, surface.canvas.width, surface.canvas.height);
    }
    return true;
  }
  return {
    go, showPanel, updatePanel, clearPanel, motionChanged, capabilities,
    setSpeaking(level) { speaking = Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : level === true ? .5 : 0; },
    setListening(value) { listening = Boolean(value); },
    get state() { return state(); }, get desired() { return wanted; }, get phase() { return controller.phase; },
    get clip() { return controller.clip; }, get speaking() { return speaking; }, get listening() { return listening; },
    get reducedMotion() { return reducedMotion; }, get panel() { return readPanel(); },
    get panels() { return {left: readPanel(panels.left), right: readPanel(panels.right)}; },
    setReducedMotion(value) { reducedMotion = Boolean(value); go(wanted, {urgent: true}); },
    whenSettled(next, signal) {
      if (destroyed || signal?.aborted || next !== wanted) return Promise.resolve(false);
      if (state() === next && controller.phase === 'idle') return Promise.resolve(true);
      return new Promise(resolve => {
        const waiter = {state: next, signal, resolve, abort: null};
        waiter.abort = () => complete(waiter, false);
        waiters.add(waiter); signal?.addEventListener('abort', waiter.abort, {once: true});
      });
    },
    destroy() { destroyed = true; speaking = 0; listening = false; panels.left = null; panels.right = null; for (const waiter of waiters) complete(waiter, false); },
  };
}

/** Original browser-only broom and restrained ready-pose animation, not a baked GLB clip. */
export function createSweep(root, scene) {
  const group = new THREE.Group(); group.name = 'MERLIN_CompanionBroom'; group.visible = false; scene.add(group);
  const handleMaterial = new THREE.MeshStandardMaterial({color: 0x739bb5, roughness: .8});
  const brushMaterial = new THREE.MeshStandardMaterial({color: 0xc3e4ee, roughness: 1});
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(.024, .024, 1, 8), handleMaterial);
  const brush = new THREE.Mesh(new THREE.BoxGeometry(.46, .1, .17), handleMaterial);
  group.add(handle, brush);
  const bristles = new THREE.Group(); group.add(bristles);
  for (let i = 0; i < 12; i++) {
    const strand = new THREE.Mesh(new THREE.BoxGeometry(.025, .13, .13), brushMaterial);
    strand.position.set((i - 5.5) * .036, 0, 0); bristles.add(strand);
  }
  group.traverse(object => { if (object.isMesh) object.castShadow = true; });
  const hand = root.getObjectByName('handR'), arm = root.getObjectByName('upper_armR');
  const grip = new THREE.Vector3(), base = new THREE.Vector3(), direction = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  let restoreArm = null;
  return {
    group,
    restore() { if (restoreArm) { arm.quaternion.copy(restoreArm); restoreArm = null; } group.visible = false; },
    update(time, active) {
      group.visible = active && Boolean(hand && arm);
      if (!group.visible) return;
      restoreArm = arm.quaternion.clone();
      arm.rotateX(-.2); arm.rotateZ(.12 * Math.sin(time * 1.7));
      root.updateMatrixWorld(true); hand.getWorldPosition(grip);
      base.set(-.65 + .28 * Math.sin(time * 1.7), .20, .48);
      direction.subVectors(grip, base);
      handle.position.copy(grip).add(base).multiplyScalar(.5);
      handle.scale.y = direction.length(); handle.quaternion.setFromUnitVectors(up, direction.normalize());
      brush.position.copy(base); bristles.position.copy(base); bristles.position.y -= .1;
    },
  };
}

/** Restore sampled clip transforms before each overlay so speech never compounds or reveals hidden bars. */
export function createSpeechOverlay(root) {
  const bars = []; root.traverse(object => { if (/Display_mode_.*mouth_bar_\d+$/.test(object.name)) bars.push(object); });
  const smile = root.getObjectByName('Face_•_luminous_smile');
  let originals = [], originalSmile = null;
  return {
    restore() {
      for (const [bar, scale] of originals) bar.scale.copy(scale); originals = [];
      if (originalSmile) {smile.morphTargetInfluences.splice(0, originalSmile.length, ...originalSmile); originalSmile = null;}
    },
    update(time, level, active, bodyActive = false) {
      if (!Number.isFinite(level) || level <= 0) return;
      if (active) bars.forEach((bar, i) => {
        if (bar.scale.y <= 0) return;
        originals.push([bar, bar.scale.clone()]);
        bar.scale.y *= 1 + Math.min(1, level) * (1.2 + .8 * Math.sin(time * 17 + i * 1.6));
      });
      // Body-mode alerts use the existing mouth shapes, driven by audio level.
      // This is expressive amplitude feedback rather than phoneme lip sync.
      if (bodyActive && smile?.morphTargetDictionary?.Whistle !== undefined) {
        originalSmile = smile.morphTargetInfluences.slice();
        const shapes = smile.morphTargetDictionary;
        smile.morphTargetInfluences[shapes.Whistle] = Math.min(.65, level * .65);
        if (shapes.SmileWide !== undefined) smile.morphTargetInfluences[shapes.SmileWide] = Math.max(0, (1 - level) * .3);
      }
    },
  };
}

export async function createCharacter({canvas, stage, onStatus = () => {}, onError = () => {}, reducedMotion} = {}) {
  if (!canvas || !stage) throw new TypeError('The character needs a canvas and stage.');
  let renderer, composer, observer, sceneClock, driver, destroyDriver, controller, model, scene, surfaces, disposed = false;
  const media = matchMedia('(prefers-reduced-motion: reduce)');
  const followsPreference = reducedMotion === undefined;
  const onReducedMotion = () => driver?.setReducedMotion(media.matches);
  const onContextLost = event => { event.preventDefault(); dispose(); onError(new Error('The character display stopped. Reload to restore it.')); };
  function dispose() {
    if (disposed) return; disposed = true;
    destroyDriver?.(); renderer?.setAnimationLoop(null); observer?.disconnect(); sceneClock?.destroy();
    media.removeEventListener('change', onReducedMotion); canvas.removeEventListener('webglcontextlost', onContextLost);
    controller?.mixer.stopAllAction(); if (model) controller?.mixer.uncacheRoot(model);
    for (const surface of Object.values(surfaces || {})) {
      surface.reset(); surface.context.clearRect(0, 0, surface.canvas.width, surface.canvas.height);
    }
    const geometries = new Set(), materials = new Set(), textures = new Set();
    (scene || model)?.traverse(object => {
      if (object.geometry) geometries.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        if (!material) continue; materials.add(material);
        for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
      }
    });
    for (const item of [...textures, ...materials, ...geometries]) item.dispose();
    for (const pass of composer?.passes || []) pass.dispose?.();
    composer?.dispose(); renderer?.dispose();
  }
  try {
    const [authoredManifest, footprintData] = await Promise.all([
      fetch(assetURL('../states.json')).then(response => { if (!response.ok) throw new Error('Character states are unavailable.'); return response.json(); }),
      fetch(assetURL('./motion-footprints.json')).then(response => { if (!response.ok) throw new Error('Character layout is unavailable.'); return response.json(); }),
    ]);
    const [gltf, panelArt] = await Promise.all([
      new GLTFLoader().loadAsync(assetURL('../merlin-states.glb'), progress => {
        if (progress.total) onStatus({loading: true, progress: progress.loaded / progress.total});
      }), loadPanelArt().catch(() => ({})),
    ]);
    const manifest = runtimeManifest(authoredManifest, gltf.animations.map(clip => clip.name));
    onStatus({loading: true, supportedStates: Object.keys(manifest.states), unavailableStates: manifest.unavailableStates});
    model = gltf.scene;
    renderer = new THREE.WebGLRenderer({canvas, antialias: true, alpha: false, powerPreference: 'high-performance'});
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.AgXToneMapping;
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.VSMShadowMap;
    scene = new THREE.Scene(); scene.background = new THREE.Color('#081326'); scene.fog = new THREE.Fog('#081326', 22, 50);
    const width = manifest.camera.orthographic_width, height = width / manifest.camera.aspect_ratio;
    const camera = new THREE.OrthographicCamera(-width / 2, width / 2, height / 2, -height / 2, .1, 100);
    new THREE.Matrix4().set(...manifest.camera.matrix_world.flat()).premultiply(new THREE.Matrix4().makeRotationX(-Math.PI / 2))
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
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(100, 100), new THREE.MeshStandardMaterial({color: 0x01030a, roughness: .86}));
    floor.rotation.x = -Math.PI / 2; floor.position.y = .024; floor.receiveShadow = true; scene.add(floor);
    model.traverse(object => { if (object.isMesh) { object.castShadow = true; object.receiveShadow = true; object.frustumCulled = false; } });
    scene.add(model);
    const screens = collectScreens(model); surfaces = screens;
    for (const side of ['right', 'left', 'camera']) if (!screens[side]) throw new Error('The character is missing its ' + side + ' display.');
    const feet = [];
    for (const name of ['footL', 'footR']) {
      const foot = model.getObjectByName(name); if (!foot) continue;
      const glow = new THREE.PointLight(0x26bcff, 2.8, 1.1, 2); scene.add(glow); feet.push({foot, glow});
    }
    const sweep = createSweep(model, scene), speech = createSpeechOverlay(model);
    const clockStates = {...manifest.states, sweep: {label: 'Sweeping', parent: 'ready', idle: 'CompanionSweep'}};
    const footprints = new Map(Object.entries(footprintData.clips));
    // Extra center-only envelope covers the broom and procedural arm reach.
    footprints.set('CompanionSweep', [...footprints.get('ReadyIdle'), {left: .30, right: .70, top: .43, bottom: .91, object: 'Companion broom'}]);
    sceneClock = new SceneClock(stage, clockStates, footprints, manifest.routes || []);
    controller = new MotionController(new THREE.AnimationMixer(model), gltf.animations, manifest, info => {
      sceneClock.sync({...info, current: info.state}); driver?.motionChanged();
    });
    driver = createCharacterDriver({controller, screens, panelArt, reducedMotion: reducedMotion ?? media.matches, onStatus: info => {
      if (info.state === 'sweep') sceneClock.sync({...info, current: 'sweep', desired: 'sweep', clip: 'CompanionSweep'});
      onStatus(info);
    }});
    destroyDriver = driver.destroy;
    composer = new EffectComposer(renderer); composer.addPass(new RenderPass(scene, camera));
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(800, 600), .32, .25, 1.1)); composer.addPass(new OutputPass());
    function resize() { const width = Math.max(1, stage.clientWidth), height = Math.max(1, stage.clientHeight); renderer.setSize(width, height, false); composer.setSize(width, height); }
    observer = new ResizeObserver(resize); observer.observe(stage); resize();
    const clock = new THREE.Clock(); let elapsed = 0, lastPanelPaint = -Infinity;
    renderer.setAnimationLoop(() => {
      if (disposed) return;
      const delta = Math.min(clock.getDelta(), .05); if (document.hidden) return;
      sweep.restore(); speech.restore(); controller.update(delta);
      if (!driver.reducedMotion) elapsed += delta;
      sweep.update(elapsed, driver.state === 'sweep' && !driver.reducedMotion);
      speech.update(elapsed, driver.speaking, driver.state === 'face' && !driver.reducedMotion,
        ['ready', 'right', 'left', 'both', 'seatedLeft', 'seatedRight'].includes(driver.state) && !driver.reducedMotion);
      // Live countdown uses wall-clock data, even when the animation is static.
      if (performance.now() - lastPanelPaint > 100) {
        for (const side of visiblePanels(controller)) screens[side]?.tick(elapsed);
        lastPanelPaint = performance.now();
      }
      for (const {foot, glow} of feet) { foot.getWorldPosition(glow.position); glow.position.y = .12; }
      composer.render();
    });
    canvas.addEventListener('webglcontextlost', onContextLost);
    if (followsPreference) media.addEventListener('change', onReducedMotion);
    driver.go('ready', {urgent: true});
    return Object.assign(driver, {destroy: dispose});
  } catch (error) { dispose(); onError(error); throw error; }
}
