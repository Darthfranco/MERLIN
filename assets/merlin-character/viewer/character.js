import * as THREE from './vendor/three/build/three.module.min.js';
import { GLTFLoader } from './vendor/three/examples/jsm/loaders/GLTFLoader.js';
import { EffectComposer } from './vendor/three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from './vendor/three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from './vendor/three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from './vendor/three/examples/jsm/postprocessing/OutputPass.js';
import { collectScreens, syncScreenAspect } from './screens.js';
import { ScreenHandoff } from './screen-layout.js';
import { MotionController } from './motion.js';
import { planRoute, stateScreens, contentDestination, dismissalDestination } from './motion-routes.js';
import { SceneClock } from './scene-clock.js';
import { PANEL_TYPES, paintPanel, loadPanelArt } from './panels/render.js';

const panelTypes = new Set(PANEL_TYPES.map(panel => panel.id));
const ambient = new Set(['walk', 'walkReverse', 'toss', 'nap', 'dance']);
const assetURL = path => new URL(path, import.meta.url).href;
const validData = value => value && typeof value === 'object' && !Array.isArray(value);

export const RENDER_BUDGET = Object.freeze({fps: 30, maxPixels: 1024 * 768, maxPixelRatio: 1.25, panelInterval: 250, shadowSize: 512});
export function renderPixelRatio(width, height, deviceRatio = 1) {
  return Math.min(Math.max(.1, deviceRatio), RENDER_BUDGET.maxPixelRatio,
    Math.sqrt(RENDER_BUDGET.maxPixels / Math.max(1, width * height)));
}

/** No frames while hidden; static scenes sleep until a change or live panel poll. */
export function createRenderLoop({render, poll = () => false, animated = () => true, dynamic = () => false,
  requestFrame = requestAnimationFrame, cancelFrame = cancelAnimationFrame, scheduleTimer = setTimeout, cancelTimer = clearTimeout,
  now = () => performance.now(), visible = true}) {
  let frame = null, timer = null, dirty = true, stopped = false, lastFrame = null, lastPoll = -Infinity;
  function schedule() {
    if (stopped || !visible || frame !== null || timer !== null) return;
    if (dirty || animated()) frame = requestFrame(tick);
    else if (dynamic()) timer = scheduleTimer(() => {timer = null; dirty = poll() || dirty; lastPoll = now(); schedule();}, RENDER_BUDGET.panelInterval);
  }
  function tick(timestamp) {
    frame = null;
    if (stopped || !visible) return;
    const elapsed = lastFrame === null ? 1 / RENDER_BUDGET.fps : (timestamp - lastFrame) / 1000;
    if (lastFrame !== null && elapsed < 1 / RENDER_BUDGET.fps - .001) {schedule(); return;}
    if (timestamp - lastPoll >= RENDER_BUDGET.panelInterval) {dirty = poll() || dirty; lastPoll = timestamp;}
    if (dirty || animated()) {
      dirty = false; lastFrame = timestamp;
      // Keep real-time motion through moderate dropped frames without a huge resume jump.
      render(Math.min(elapsed, .25));
    }
    schedule();
  }
  function cancel() {if (frame !== null) cancelFrame(frame); if (timer !== null) cancelTimer(timer); frame = null; timer = null;}
  return {
    invalidate() {if (stopped) return; dirty = true; if (timer !== null) {cancelTimer(timer); timer = null;} schedule();},
    setVisible(value) {visible = Boolean(value); cancel(); lastFrame = null; lastPoll = -Infinity; if (visible) {dirty = true; schedule();}},
    destroy() {stopped = true; cancel();},
    get scheduled() {return frame !== null || timer !== null;},
  };
}

/** Scale-zero export helpers still submit draw calls unless explicitly hidden. */
export function createHiddenMeshCuller(root) {
  const meshes = []; root.traverse(object => {if (object.isMesh) meshes.push({object, visible: object.visible});});
  return fullFace => {
    let visible = 0;
    for (const entry of meshes) {
      const object = entry.object, m = object.matrixWorld.elements;
      object.visible = entry.visible && !(fullFace && object.isSkinnedMesh) &&
        Math.abs(m[0]) + Math.abs(m[1]) + Math.abs(m[2]) + Math.abs(m[4]) + Math.abs(m[5]) + Math.abs(m[6]) + Math.abs(m[8]) + Math.abs(m[9]) + Math.abs(m[10]) > 1e-7;
      if (object.visible) visible++;
    }
    return visible;
  };
}

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
  const layouts = {left: ['left'], right: ['right'], both: ['left', 'right'], seatedLeft: ['left'], seatedRight: ['right'], ceiling: ['right']};
  const states = [controller.current, ...(controller.phase === 'idle' ? [] : [controller.arrival])];
  return new Set(states.flatMap(state => {
    if (isFaceState(state, controller.states)) return [];
    const source = lineage(state, controller.states).find(name => controller.states[name]?.screens || layouts[name]);
    return (controller.states[source]?.screens || layouts[source] || []).filter(side => ['left', 'right'].includes(side));
  }));
}

/** Presentation only: no microphone, model, service credentials or demo outcomes. */
export function createCharacterDriver({controller, screens, panelArt = {}, reducedMotion = false, onStatus = () => {}, invalidate = () => {}}) {
  let wanted = 'ready', destroyed = false, lastSide = 'right', speaking = 0, listening = false, transitionPace = 1;
  let bridge = null, requestedAlias = 'ready', moving = false, retainedBody = 'ready';
  const panels = {left: null, right: null}; let panelPaints = 0;
  const handoff = typeof screens.left?.copyFrom === 'function' && screens.right ? new ScreenHandoff(screens, () => {
    // The left texture needs its own record so live polling follows the card,
    // while later edits to the retained right record remain independent.
    const source = panels.right;
    panels.left = source ? {type: source.type, side: 'left', data: source.data} : null;
    lastSide = 'left'; refreshPanels(['left']); invalidate();
  }) : null;
  const capabilities = Object.freeze({states: Object.freeze(Object.keys(controller.states)),
    routes: Object.freeze((controller.routes || []).map(route => Object.freeze({...route})))});
  const waiters = new Set();
  const state = () => controller.current;
  const phase = () => bridge ? 'transition' : controller.phase;
  function baseContext(value) {
    const definition = controller.states[value];
    return definition?.contextualThinking || value === 'bodyThink' ? definition.bodyContext || definition.parent : definition?.rest || value;
  }
  function pendingState() { return controller.phase === 'idle' ? controller.current : controller.arrival; }
  function physicalContext() {
    const pending = pendingState();
    return baseContext(isFaceState(pending, controller.states) ? controller.bodyContext : pending) || 'ready';
  }
  // The intended layout can differ from the inbound face clip's source during a
  // covered layout change. An interruption keeps that intent without revealing it.
  function bodyContext() {return retainedBody;}
  function resolveDestination(next, {preservePanels = true, dismiss = false, restorePanels = true} = {}) {
    const context = bodyContext();
    if (next === 'bodyThink') {
      if (!restorePanels) return 'bodyThink';
      if (isFaceState(pendingState(), controller.states) || isFaceState(wanted, controller.states)) return 'faceThink';
      return Object.keys(controller.states).find(name => controller.states[name].contextualThinking &&
        (controller.states[name].bodyContext || controller.states[name].parent) === context) || 'bodyThink';
    }
    if (next === 'ready' && preservePanels && restorePanels && !dismiss && stateScreens(context).some(side => side !== 'camera')) return context;
    return reducedMotion && ambient.has(next) ? 'ready' : next;
  }
  const complete = (waiter, result) => {
    waiters.delete(waiter);
    waiter.signal?.removeEventListener('abort', waiter.abort);
    waiter.resolve(result);
  };
  function motionChanged() {
    handoff?.sync(controller.clip);
    invalidate();
    if (controller.active) controller.active.setEffectiveTimeScale(['idle', 'finishLoop'].includes(controller.phase) ? 1 : transitionPace);
    // A cover is presentation only. Keep the final requested destination visible
    // to callers, and change the underlying body context only under a full face.
    if (bridge && !moving && controller.current === 'face' && controller.phase === 'idle' && bridge.stage === 'cover') {
      bridge.stage = 'reveal'; controller.bodyContext = baseContext(wanted);
      move(wanted);
      return;
    }
    if (bridge?.stage === 'reveal' && controller.current === wanted && controller.phase === 'idle') bridge = null;
    if (!moving && !bridge && controller.phase === 'idle' && isFaceState(controller.current, controller.states) && isFaceState(wanted, controller.states)) {
      controller.bodyContext = retainedBody;
    }
    // An authored one-way walk settles into its matching endpoint naturally.
    if (!bridge && controller.states[wanted]?.rest === controller.current && controller.phase === 'idle') wanted = controller.current;
    for (const waiter of waiters) {
      if (destroyed || waiter.signal?.aborted || waiter.state !== wanted) complete(waiter, false);
      else if (state() === waiter.state && phase() === 'idle') complete(waiter, true);
    }
    if (!destroyed) onStatus({state: state(), desired: wanted, phase: phase(), clip: controller.clip,
      paused: controller.paused, bodyContext: retainedBody, bridge: bridge?.stage || null});
  }
  function move(destination, {snap = false} = {}) {
    const pending = pendingState(), source = physicalContext();
    if (isFaceState(destination, controller.states) && !isFaceState(pending, controller.states)) controller.bodyContext = source;
    moving = true;
    try {
      if (snap) {
        if (lineage(source, controller.states).includes('ceiling') && lineage(destination, controller.states).includes('left')) handoff?.sync('CeilingToLeftPanel');
        if (!isFaceState(destination, controller.states)) controller.bodyContext = baseContext(destination);
        controller.snap(destination, {paused: reducedMotion});
      } else if (controller.request) controller.request(destination);
      else controller.go(destination);
    } finally { moving = false; }
    motionChanged();
  }
  function go(next, {urgent = false, pace = 1, preservePanels = true, dismiss = false, restorePanels = true} = {}) {
    if (destroyed) return false;
    if (!controller.states[next]) throw new RangeError('Unknown MERLIN state: ' + next);
    if (!Number.isFinite(pace) || pace <= 0 || pace > 8) throw new RangeError('Animation pace must be greater than zero and at most eight.');
    const destination = resolveDestination(next, {preservePanels, dismiss, restorePanels});
    transitionPace = pace;
    requestedAlias = next;
    if (destination === wanted && !(urgent || reducedMotion)) {motionChanged(); return true;}
    wanted = destination;
    if (!isFaceState(destination, controller.states)) retainedBody = baseContext(destination);
    for (const waiter of waiters) if (waiter.state !== wanted) complete(waiter, false);
    bridge = null;
    if (urgent || reducedMotion) {
      move(destination, {snap: true});
    } else {
      const route = planRoute(pendingState(), destination, controller.states, controller.routes || [], controller.bodyContext);
      const dissolvesPanel = route.some(edge => edge.to === 'ready' && stateScreens(edge.from).some(side => side !== 'camera'));
      // A selective close may arrive before a paired layout finishes appearing.
      // Its surviving screen still cannot take a destructive detour through ready.
      const keepsScreen = stateScreens(physicalContext()).some(side => side !== 'camera' && stateScreens(destination).includes(side));
      if (preservePanels && (!dismiss || keepsScreen) && !isFaceState(destination, controller.states) && dissolvesPanel) {
        bridge = {stage: 'cover'};
        move('face');
      } else move(destination);
    }
    return true;
  }
  function body(options = {}) {return go(bodyContext(), {...options, preservePanels: true});}
  function ready(options = {}) {return go('ready', {...options, preservePanels: false, dismiss: true});}
  function dismissScreen(side, options = {}) {
    const context = bridge ? baseContext(wanted) : bodyContext();
    return go(dismissalDestination(context, side), {...options, preservePanels: true, dismiss: true});
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
    const record = panels[side]?.type === type ? panels[side] : {type, side};
    record.data = data; readPanel(record); panels[side] = record; lastSide = side;
    refreshPanels([side]);
    if (options.navigate !== false) {
      const context = bodyContext(), existing = stateScreens(context);
      const destination = existing.includes(side) ? context : panels.left && panels.right && controller.states.both ? 'both' :
        contentDestination({...controller, desired: wanted}, side);
      go(destination, {...options, preservePanels: true});
    }
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
    refreshPanels([side]);
    return readPanel(panel);
  }
  function refreshPanels(sides = ['left', 'right']) {
    let changed = false, sourceChanged = false;
    for (const side of sides) {
      const panel = panels[side]; if (!panel) continue;
      const snapshot = readPanel(panel);
      // Display precision is seconds; do not redraw/upload a 1MP texture for invisible fractions.
      if (Number.isFinite(snapshot.seconds)) snapshot.seconds = Math.ceil(snapshot.seconds);
      if (Number.isFinite(snapshot.elapsed)) snapshot.elapsed = Math.floor(snapshot.elapsed);
      const signature = JSON.stringify(snapshot);
      if (signature === panel.signature) continue;
      panel.snapshot = snapshot; panel.signature = signature;
      if (!panel.initialized) {
        screens[side].draw((context, width, height) => paintPanel(context, width, height, panel.snapshot, {art: panelArt, controls: false}), {animate: true, reflow: false});
        panel.initialized = true;
      } else screens[side].tick(0);
      panelPaints++; changed = true; if (side === 'right') sourceChanged = true;
    }
    handoff?.sync(controller.clip, sourceChanged);
    if (changed) invalidate(); return changed;
  }
  function clearPanel(side) {
    if (!['right', 'left', 'both'].includes(side)) throw new TypeError('Clear the left, right, or both panels.');
    if (destroyed) return false;
    for (const target of side === 'both' ? ['left', 'right'] : [side]) {
      panels[target] = null; screens[target].reset?.();
      const surface = screens[target]; surface.context?.clearRect(0, 0, surface.canvas.width, surface.canvas.height);
    }
    invalidate(); return true;
  }
  function syncScreens() {
    handoff?.sync(controller.clip);
    for (const side of visiblePanels(controller)) if (screens[side]) syncScreenAspect(screens[side]);
  }
  return {
    go, body, ready, dismissScreen, resolveDestination, showPanel, updatePanel, clearPanel, refreshPanels, syncScreens, motionChanged, capabilities,
    setSpeaking(level) { speaking = Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : level === true ? .5 : 0; },
    setListening(value) { listening = Boolean(value); },
    get state() { return state(); }, get desired() { return wanted; }, get phase() { return phase(); },
    get bodyContext() { return retainedBody; },
    get clip() { return controller.clip; }, get speaking() { return speaking; }, get listening() { return listening; },
    get reducedMotion() { return reducedMotion; }, get panel() { return readPanel(); },
    get panelPaints() { return panelPaints; },
    get hasDynamicPanels() { return Object.values(panels).some(panel => typeof panel?.data === 'function'); },
    get panels() { return {left: readPanel(panels.left), right: readPanel(panels.right)}; },
    setReducedMotion(value) { reducedMotion = Boolean(value); go(wanted, {urgent: true}); },
    whenSettled(next, signal) {
      if (next === requestedAlias) next = wanted;
      if (destroyed || signal?.aborted || next !== wanted) return Promise.resolve(false);
      if (state() === next && phase() === 'idle') return Promise.resolve(true);
      return new Promise(resolve => {
        const waiter = {state: next, signal, resolve, abort: null};
        waiter.abort = () => complete(waiter, false);
        waiters.add(waiter); signal?.addEventListener('abort', waiter.abort, {once: true});
      });
    },
    destroy() { destroyed = true; speaking = 0; listening = false; panels.left = null; panels.right = null; for (const waiter of waiters) complete(waiter, false); },
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
  let renderer, composer, observer, sceneClock, driver, destroyDriver, controller, model, scene, surfaces, renderLoop, disposed = false;
  const renderStats = {frames: 0, drawCalls: 0, triangles: 0, visibleMeshes: 0, width: 0, height: 0, fpsCap: RENDER_BUDGET.fps};
  const media = matchMedia('(prefers-reduced-motion: reduce)');
  const followsPreference = reducedMotion === undefined;
  const onReducedMotion = () => driver?.setReducedMotion(media.matches);
  const onVisibility = () => renderLoop?.setVisible(!document.hidden);
  const onContextLost = event => { event.preventDefault(); dispose(); onError(new Error('The character display stopped. Reload to restore it.')); };
  function dispose() {
    if (disposed) return; disposed = true;
    destroyDriver?.(); renderLoop?.destroy(); observer?.disconnect(); sceneClock?.destroy();
    document.removeEventListener('visibilitychange', onVisibility);
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
    renderer = new THREE.WebGLRenderer({canvas, antialias: false, alpha: false, powerPreference: 'low-power'});
    renderer.setPixelRatio(1); renderer.info.autoReset = false;
    renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.AgXToneMapping;
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap; renderer.shadowMap.autoUpdate = false;
    scene = new THREE.Scene(); scene.background = new THREE.Color('#081326'); scene.fog = new THREE.Fog('#081326', 22, 50);
    const width = manifest.camera.orthographic_width, height = width / manifest.camera.aspect_ratio;
    const camera = new THREE.OrthographicCamera(-width / 2, width / 2, height / 2, -height / 2, .1, 100);
    new THREE.Matrix4().set(...manifest.camera.matrix_world.flat()).premultiply(new THREE.Matrix4().makeRotationX(-Math.PI / 2))
      .decompose(camera.position, camera.quaternion, camera.scale);
    scene.add(new THREE.HemisphereLight(0xb3d4ff, 0x172b48, .65));
    function light(color, intensity, x, y, z, shadow = false) {
      const value = new THREE.DirectionalLight(color, intensity); value.position.set(x, y, z); value.target.position.set(0, 2.2, 0);
      if (shadow) {
        value.castShadow = true; value.shadow.mapSize.set(RENDER_BUDGET.shadowSize, RENDER_BUDGET.shadowSize);
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
    const speech = createSpeechOverlay(model), cullMeshes = createHiddenMeshCuller(model);
    const footprints = new Map(Object.entries(footprintData.clips));
    sceneClock = new SceneClock(stage, manifest.states, footprints, manifest.routes || []);
    controller = new MotionController(new THREE.AnimationMixer(model), gltf.animations, manifest, info => {
      sceneClock.sync({...info, current: info.state}); driver?.motionChanged();
    });
    driver = createCharacterDriver({controller, screens, panelArt, reducedMotion: reducedMotion ?? media.matches,
      invalidate: () => renderLoop?.invalidate(), onStatus});
    destroyDriver = driver.destroy;
    composer = new EffectComposer(renderer); composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(400, 300), .32, .25, 1.1), sizeBloom = bloom.setSize.bind(bloom);
    bloom.setSize = (width, height) => sizeBloom(Math.max(1, Math.round(width / 2)), Math.max(1, Math.round(height / 2)));
    composer.addPass(bloom); composer.addPass(new OutputPass());
    function resize() {
      const width = Math.max(1, stage.clientWidth), height = Math.max(1, stage.clientHeight);
      const ratio = renderPixelRatio(width, height, window.devicePixelRatio || 1);
      renderer.setPixelRatio(ratio); renderer.setSize(width, height, false); composer.setPixelRatio(ratio); composer.setSize(width, height);
      renderStats.width = canvas.width; renderStats.height = canvas.height; renderLoop?.invalidate();
    }
    observer = new ResizeObserver(resize); observer.observe(stage); resize();
    let elapsed = 0;
    renderLoop = createRenderLoop({visible: !document.hidden,
      animated: () => !driver.reducedMotion && !controller.paused,
      dynamic: () => driver.hasDynamicPanels && visiblePanels(controller).size > 0,
      poll: () => driver.refreshPanels(visiblePanels(controller)),
      render: delta => {
      if (disposed) return;
      speech.restore(); controller.update(delta);
      if (!driver.reducedMotion) elapsed += delta;
      speech.update(elapsed, driver.speaking, driver.state === 'face' && !driver.reducedMotion,
        ['ready', 'right', 'left', 'both', 'seatedLeft', 'seatedRight', 'ceiling'].includes(driver.state) && !driver.reducedMotion);
      model.updateMatrixWorld(true);
      driver.syncScreens();
      const fullFace = isFaceState(controller.current, controller.states) && controller.phase === 'idle';
      renderStats.visibleMeshes = cullMeshes(fullFace);
      for (const {foot, glow} of feet) { foot.getWorldPosition(glow.position); glow.position.y = .12; }
      renderer.shadowMap.needsUpdate = !fullFace;
      renderer.info.reset(); composer.render();
      renderStats.frames++; renderStats.drawCalls = renderer.info.render.calls; renderStats.triangles = renderer.info.render.triangles;
    }});
    Object.defineProperty(driver, 'renderStats', {get: () => ({...renderStats, panelPaints: driver.panelPaints, hidden: document.hidden})});
    document.addEventListener('visibilitychange', onVisibility);
    canvas.addEventListener('webglcontextlost', onContextLost);
    if (followsPreference) media.addEventListener('change', onReducedMotion);
    driver.go('ready', {urgent: true});
    return Object.assign(driver, {subscribeLayout: listener => sceneClock.subscribeLayout(listener), destroy: dispose});
  } catch (error) { dispose(); onError(error); throw error; }
}
