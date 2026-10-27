# MERLIN character studio

A local preview of the actual Blender/glTF character, with 37 animation clips and three editable screen surfaces. The preview is separate from the assistant and voice applications.

From the repository root:

```sh
node assets/merlin-character/viewer/serve.mjs
```

Open **http://127.0.0.1:3310/viewer/**. Select an animation and choose **Play animation**. Use **Return to ready** to route back to the centered robot. The screen editor supports text, local PNG/JPEG/WebP images, and a live canvas example. Images remain in browser memory and are not uploaded or saved. Reloading restores the bundled synthetic content.

## Use the screens from JavaScript

The page exposes `window.merlin` after loading and dispatches `merlinready`. Each surface has a stable ID: `right`, `left`, or `camera`. Code can draw text, charts, buttons, or other canvas content, or supply an image/video element. Textures update on the physical panel and on its fragments when dismissed.

```js
window.addEventListener('merlinready', () => {
  merlin.screens.right.draw((ctx, width, height) => {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#172a3b';
    ctx.font = '56px sans-serif';
    ctx.fillText('Hello, MERLIN.', 60, 110);
  });
  merlin.go('right');
});
```

For ongoing drawing, add `{animate: true}`; the fourth callback argument is elapsed animation time in seconds. A regular externally supplied canvas is refreshed each frame. Video uses Three.js `VideoTexture`; the caller controls its source and playback. No camera permission is requested by this preview.

```js
merlin.screens.left.draw((ctx, w, h, seconds) => {
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#185c9e';
  ctx.beginPath();
  ctx.arc(w / 2, h / 2, 80 + 20 * Math.sin(seconds), 0, Math.PI * 2);
  ctx.fill();
}, {animate: true});

merlin.screens.camera.setSource(myCanvasOrImageOrVideo);
merlin.screens.camera.reset(); // restore the bundled synthetic viewfinder
merlin.go('camera');
merlin.pause();
merlin.resume();
merlin.ready();
```

Content is a texture, not an embedded browser: HTML/React layouts must be drawn into a canvas or implemented by the consuming application. No click routing into textured controls is provided. `draw()` starts with a saved canvas context, restores it after each frame, and uses a top-left origin. Use `reset()` to restore the original packed image. These setters do not persist edits into the Blender file.

## States and transitions

Available destinations:

| Destination | Behavior |
| --- | --- |
| `ready` | Centered, forward-facing ready idle |
| `right`, `left` | Approach, pull a content screen, idle beside it; tap/shatter on exit |
| `dance` | Gentle bounce, head nod, arm swing, floating cyan music notes |
| `bodyThink` | Chin-resting hand, gaze shifts, head tilt and shifting weight |
| `face` | Full-frame original face with seven cyan mouth bars |
| `camera` | Lens eyes and a lower programmable viewfinder; mouth hidden |
| `faceThink` | Focused eyelids, glances, sequenced mouth bars |
| `search` | Moving magnifying-glass eyes and searching mouth motion |
| `nap`, `toss`, `walk` | Earlier casual animations with ready entry/return routes |

Transitions route through `ready` and the `face` hub. Requests made during a transition retain the latest destination and finish the active transition before rerouting. Walking and ball tossing finish the current cycle before their authored return, keeping travel and the wall/floor/catch intact; the status shows this wait. Other loop interruptions use a short 180ms blend into the authored exit. This is a preview controller, not a physically simulated animation system or the Blender pose-aware interruption helper. The old whistle audio is not played by this viewer. Dance, search, and camera states are visual animations; they do not start music, a web search, or a camera feed.

Reduced-motion preference starts the character paused. An explicit Play action resumes it. Pause also freezes animated canvas content. The 4:3 scene remains fixed while the surrounding controls adapt to a narrow screen.

## Edit the Blender screens

Open `merlin-states.blend`, switch to the Python Console, and run:

```python
import bpy, sys
from pathlib import Path
sys.path.insert(0, str(Path(bpy.data.filepath).parent / 'scripts'))
from screen_state_support import apply_activity
from screen_content import set_screen_image, set_screen_pixels

set_screen_image('left', '/absolute/path/to/your-image.png')
apply_activity(bpy.context.scene, 'LeftPanelIdle', 1)
# set_screen_pixels('right', width, height, flat_rgba_buffer)
```

The image is packed by default; save your scene to retain it. `set_screen_pixels()` takes finite RGBA values in 0–1 with rows ordered **bottom to top**. Dimensions must be integers from 1–8192. Each screen is isolated; changing the left texture does not change the right or camera screen. Do not publish private images in the public repository.

For your own runtime, `merlin_screen_id` is exported on screen objects and materials. Panel edges retain a separate porcelain material, and shards have UVs corresponding to their position in the full card. Blender uses bottom-left UV coordinates; glTF exports top-left UV coordinates. In Three.js use `texture.flipY = false` and `texture.colorSpace = THREE.SRGBColorSpace`. Replace `emissiveMap` (and `map` when present), preserving the material's colors and emission strength. See the official [texture documentation](https://threejs.org/docs/pages/Texture.html) and [color-management guide](https://threejs.org/manual/pages/color-management.html).

## Rendering and checks

The browser uses the authored camera transform, a local matte floor, approximation lights, and restrained bloom. Blender is the lighting reference; the realtime renderer is not a pixel-identical Cycles renderer. Device performance and production iPad deployment have not been benchmarked.

```sh
node --test assets/merlin-character/viewer/motion.test.mjs
```

The route tests exercise every ordered pair of the twelve destinations, request replacement during transitions, pause/resume, invalid-state handling, walking/tossing cycle completion, and cancellation of pending returns with the real Three.js animation mixer. Blender validation and re-import reports are in the parent `previews` directory.

## Dependencies and provenance

Three.js **0.180.0** is vendored under `vendor/three` with its MIT license, exact package source and hash. No runtime CDN, installation, or third-party request is needed. The server uses Node built-ins and binds to loopback only. Character geometry, motions, screen graphics, gradient textures, and six state stills are authored in Blender/Python in this repository; no third-party character or animation asset was downloaded. User reference screenshots are not redistributed.
