import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const PHASES = new Set(['idle', 'listening', 'thinking', 'speaking']);
const CLIPS = ['FullFaceIdle', 'FaceToThink', 'FaceThink', 'ThinkToFace'];

/** A presentation-only view of MERLIN's existing full-face asset. */
export async function createFace({ canvas, onReady = () => {}, onError = () => {} } = {}) {
  if (!canvas) throw new TypeError('MERLIN needs a face canvas.');
  const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
  let model, renderer, mixer, observer, scene, camera, currentAction;
  let destroyed = false, visible = true, phase = 'idle', mode = 'idle';
  let elapsed = 0, previousTime = 0, frame = 0;
  const mouth = [], restoredScales = [];
  const actions = new Map();

  function restoreMouth() {
    for (const [bar, scale] of restoredScales) bar.scale.copy(scale);
    restoredScales.length = 0;
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    cancelAnimationFrame(frame);
    observer?.disconnect();
    document.removeEventListener('visibilitychange', syncVisibility);
    preference.removeEventListener('change', changedPreference);
    canvas.removeEventListener('webglcontextlost', contextLost);
    restoreMouth();
    mixer?.removeEventListener('finished', finished);
    mixer?.stopAllAction();
    if (model) mixer?.uncacheRoot(model);
    const materials = new Set(), geometries = new Set(), textures = new Set();
    model?.traverse(object => {
      if (object.geometry) geometries.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        if (!material) continue;
        materials.add(material);
        for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
      }
    });
    for (const texture of textures) { texture.image?.close?.(); texture.dispose(); }
    for (const resource of [...materials, ...geometries]) resource.dispose();
    renderer?.dispose();
    renderer?.forceContextLoss();
  }

  function contextLost(event) {
    event.preventDefault();
    destroy();
    onError(new Error('The animated face is unavailable.'));
  }

  function play(name, nextMode, loop = false) {
    restoreMouth();
    currentAction?.stop();
    currentAction = actions.get(name);
    currentAction.reset();
    currentAction.enabled = true;
    currentAction.clampWhenFinished = !loop;
    currentAction.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    currentAction.setEffectiveTimeScale(loop ? 1 : 1.5);
    currentAction.setEffectiveWeight(1).play();
    mode = nextMode;
    mixer.update(0);
  }

  function reconcile() {
    if (preference.matches) {
      play(phase === 'thinking' ? 'FaceThink' : 'FullFaceIdle', phase === 'thinking' ? 'thinking' : 'idle', true);
    } else if (phase === 'thinking' && mode === 'idle') {
      play('FaceToThink', 'enter');
    } else if (phase !== 'thinking' && mode === 'thinking') {
      play('ThinkToFace', 'exit');
    }
  }

  function finished(event) {
    if (destroyed || event.action !== currentAction) return;
    if (mode === 'enter') play('FaceThink', 'thinking', true);
    else if (mode === 'exit') play('FullFaceIdle', 'idle', true);
    reconcile();
  }

  function draw(delta = 0) {
    if (destroyed || !renderer) return;
    restoreMouth();
    if (!preference.matches) {
      elapsed += delta;
      mixer.update(delta);
      if (phase === 'speaking') {
        mouth.forEach((bar, index) => {
          if (bar.scale.y <= 0) return;
          restoredScales.push([bar, bar.scale.clone()]);
          bar.scale.y *= 1.12 + .75 * Math.abs(Math.sin(elapsed * 10.5 + index * 1.7))
            * (.4 + .6 * Math.abs(Math.sin(elapsed * 3.4)));
        });
      }
    }
    renderer.render(scene, camera);
  }

  function tick(time) {
    frame = 0;
    if (destroyed || !visible || document.hidden || preference.matches) return;
    const delta = previousTime ? Math.min((time - previousTime) / 1000, .05) : 0;
    previousTime = time;
    draw(delta);
    frame = requestAnimationFrame(tick);
  }

  function syncVisibility() {
    cancelAnimationFrame(frame);
    frame = 0;
    previousTime = 0;
    if (destroyed || !visible || document.hidden) return;
    draw();
    if (!preference.matches) frame = requestAnimationFrame(tick);
  }

  function changedPreference() {
    if (destroyed) return;
    play(phase === 'thinking' ? 'FaceThink' : 'FullFaceIdle', phase === 'thinking' ? 'thinking' : 'idle', true);
    syncVisibility();
  }

  try {
    const manifest = await fetch('/character/states.json').then(response => {
      if (!response.ok) throw new Error('The character camera is unavailable.');
      return response.json();
    });
    const gltf = await new GLTFLoader().loadAsync('/character/merlin-states.glb');
    model = gltf.scene;
    const clips = new Map(gltf.animations.map(clip => [clip.name, clip]));
    if (CLIPS.some(name => !clips.has(name))) throw new Error('The face animations are unavailable.');

    // GLTFLoader replaces whitespace in authored names with underscores. Keep
    // only the display family, even if a future GLB adds a body visibility track.
    model.traverse(object => {
      if (/^Display_mode_.*mouth_bar_\d+$/.test(object.name)) mouth.push(object);
      if (!object.isMesh) return;
      let isDisplay = false;
      for (let parent = object; parent && parent !== model; parent = parent.parent) {
        if (/^Display_mode_/.test(parent.name)) { isDisplay = true; break; }
      }
      if (/full_frame_backing/.test(object.name)) isDisplay = false;
      object.visible = isDisplay;
      object.frustumCulled = false;
      if (!isDisplay) object.layers.disableAll();
    });
    if (mouth.length !== 7) throw new Error('The character face is incomplete.');

    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'low-power' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.AgXToneMapping;
    scene = new THREE.Scene();
    scene.background = new THREE.Color('#080f1c');
    scene.add(model, new THREE.AmbientLight(0xb8dbff, .6));
    const light = new THREE.DirectionalLight(0xdbeeff, .7);
    light.position.set(-3, 8, 6);
    scene.add(light);
    const width = manifest.camera.orthographic_width;
    const height = width / manifest.camera.aspect_ratio;
    camera = new THREE.OrthographicCamera(-width / 2, width / 2, height / 2, -height / 2, .1, 100);
    new THREE.Matrix4().set(...manifest.camera.matrix_world.flat())
      .premultiply(new THREE.Matrix4().makeRotationX(-Math.PI / 2))
      .decompose(camera.position, camera.quaternion, camera.scale);

    mixer = new THREE.AnimationMixer(model);
    for (const name of CLIPS) actions.set(name, mixer.clipAction(clips.get(name)));
    mixer.addEventListener('finished', finished);
    play('FullFaceIdle', 'idle', true);

    const resize = () => {
      if (destroyed) return;
      const bounds = canvas.getBoundingClientRect();
      const width = Math.max(1, bounds.width || (canvas.parentElement?.clientWidth || 376) * .85);
      renderer.setSize(width, width * 3 / 4, false);
      if (visible && !document.hidden) draw();
    };
    observer = new ResizeObserver(resize);
    observer.observe(canvas.parentElement || canvas);
    canvas.addEventListener('webglcontextlost', contextLost);
    document.addEventListener('visibilitychange', syncVisibility);
    preference.addEventListener('change', changedPreference);
    resize();
    syncVisibility();
    onReady();
    return {
      setPhase(next) {
        if (destroyed) return;
        if (!PHASES.has(next)) throw new RangeError('Choose an available face phase.');
        if (phase === next) return;
        phase = next;
        reconcile();
        syncVisibility();
      },
      setVisible(value) { visible = Boolean(value); syncVisibility(); },
      destroy,
    };
  } catch (error) {
    destroy();
    onError(error);
    throw error;
  }
}
