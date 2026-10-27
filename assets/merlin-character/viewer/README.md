# MERLIN character studio

A local preview of the actual Blender/glTF character, with 113 animation clips, 30 connected states, and three editable screen surfaces. The preview is separate from the assistant and voice applications.

From the repository root:

```sh
node assets/merlin-character/viewer/serve.mjs
```

Open **http://127.0.0.1:3310/viewer/**. Select an animation and choose **Play animation**. Use **Return to body** after a full-face animation to restore the same body activity and open panels. **Return to ready** explicitly exits the activity and routes back to the centered robot. The screen editor supports text, local PNG/JPEG/WebP images, and a live canvas example. Images remain in browser memory and are not uploaded or saved. Reloading restores the bundled synthetic content.

Choose **Pull both screens & sit between them** to bring in both panels and settle between them. **Dismiss left** or **Dismiss right** removes only that screen and keeps MERLIN seated beside the remaining one. **Dismiss both** clears the pair and returns to the central ready pose. The controls remain available during a transition; successive dismissal requests combine against the latest requested arrangement. An absent screen's dismissal is a no-op. Editing either visible screen preserves the two-panel or seated arrangement. Editing one of those panels while in full-face mode zooms back to the remembered arrangement without dismissing the other screen.

Choose **Jump & pull down a large screen** for the ceiling pull. **Move screen left/right** carries that screen into the corresponding portrait layout while MERLIN stays visible. Its content follows it, including when the left mesh takes over from the right. The large screen is a presentation of the existing right surface, exposed as `merlin.screens.ceiling`; it is not a fourth independently stored texture.

## MERLIN panel designs

The **MERLIN panels** controls place the reusable 2D designs onto either physical panel or the large ceiling presentation. The [2D panel gallery](panels/) offers countdown timer, lights, oven, music, schedule confirmation, routine confirmation, and routine detail designs. These use synthetic demonstration data: selecting a panel does not start a timer, control a device, play music, or save a schedule or routine. They do not install routine defaults. The existing assistant's persisted timers and routines remain separate.

Both physical panels are **5:6 portrait** (4.75 × 5.70 scene units in the original standing layout); the studio draws them at **900 × 1080**. The paired seated layout scales them together to fit the frame without changing the content ratio. The same canvas renderer supplies the gallery and each panel, including the dismissal fragments. The camera viewfinder has a different aspect ratio and is not a target for these designs.

Open a design directly with a link such as [`?panel=timer&side=right`](./?panel=timer&side=right). Supported IDs are `timer`, `lights`, `oven`, `music`, `schedule`, `routine-saved`, and `routine`; sides are `right`, `left`, and `ceiling`. An invalid ID or side reports an error and leaves the original screen content intact. The initial design is selected before `merlinready` fires. With reduced motion enabled, use **Resume** to play the panel entry.

After `merlinready`, the synchronous preview API merges supplied fields over the selected synthetic fixture and returns the painted state:

```js
const state = merlin.showPanel('timer', {}, 'right');
merlin.showPanel('routine', {}, 'left');
```

`showPanel(type, data = {}, target = 'right')` validates the design, requires an object for `data`, and accepts the two portrait panels or `ceiling`. Portrait designs retain their 5:6 layout inside the wide presentation, with margins instead of stretched typography. It changes the texture and requests the corresponding authored animation, or preserves the current paired/seated layout when that screen is already visible. It does not execute the represented action. The routine illustration is loaded once before editing becomes available, so a late image load cannot replace subsequent edits. If art is unavailable, the renderer's simple fallback remains usable. A later text edit, image upload, or panel selection replaces that surface's content. These preview states are static; production state updates must come from verified assistant/tool results and a real timer clock.

## Use the screens from JavaScript

The page exposes `window.merlin` after loading and dispatches `merlinready`. Each physical surface has a stable ID: `right`, `left`, or `camera`. `screens.ceiling` aliases `screens.right` for the large presentation. Code can draw text, charts, buttons, or other canvas content, or supply an image/video element. Textures update on the physical panel and on its fragments when dismissed.

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

For ongoing drawing, add `{animate: true}`; the fourth callback argument is elapsed animation time in seconds. A regular externally supplied canvas is refreshed each frame. Video is sampled into the surface canvas while visible; the caller controls its source and playback. No camera permission is requested by this preview.

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
merlin.go('camera'); // expand from the current body context
merlin.body(); // zoom back out to that activity and its open panels
merlin.pause();
merlin.resume();
merlin.ready();

merlin.go('both'); // pull both panels, then sit between them
merlin.dismissScreen('left'); // keep the right panel and remain seated
merlin.dismissScreen('right'); // dismiss the remaining panel and stand ready
// merlin.dismissScreen('both') clears either the pair or a remaining panel.

merlin.go('ceiling');
merlin.screens.ceiling.draw((ctx, width, height) => {
  // Width and height reflect the current physical screen aspect.
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#172a3b'; ctx.font = '64px sans-serif';
  ctx.fillText('Room to think.', 80, 150);
});
merlin.dockScreen('left'); // content follows the screen into the left layout
```

Text and code painters reflow to the screen's live physical aspect using the callback width/height. Images, external canvases, videos, and built-in portrait designs are contained with preserved proportions. Use `draw(painter, {reflow: false})` to keep a fixed 900×1080 painter layout. The internal output canvas keeps a fixed resolution while the screen changes shape. Immutable images are copied into owned pixels immediately, so closing an uploaded ImageBitmap does not break later resizing or handoff. Live painters, canvases, and videos retain their source through `copyFrom(otherScreen)` and the automatic ceiling-to-left transfer. Subsequent edits to the original screen do not replace the transferred content.

When editing the left destination from the ceiling presentation, new text, images, and designs first appear on the carried screen and follow it into place. Pending image decodes are discarded if a newer edit, public API update, or content handoff has already changed either participating surface. Decode an `HTMLImageElement` before calling `setSource(image)` (for example, `await image.decode()`). Direct drawing on `surface.context` followed by `surface.update()` preserves the painted pixels; `setSource(surface.canvas)` is also supported. Those manual pixels keep their captured proportions through later resizing and copying. Use a painter callback when content should reflow or animate.

Content is a texture, not an embedded browser: HTML/React layouts must be drawn into a canvas or implemented by the consuming application. No click routing into textured controls is provided. `draw()` starts with a saved canvas context, restores it after each frame, and uses a top-left origin. Use `reset()` to restore the original packed image. These setters do not persist edits into the Blender file.

## States and transitions

Available destinations:

| Destination | Behavior |
| --- | --- |
| `ready` | Centered, forward-facing ready idle |
| `right`, `left` | Approach, pull a content screen, idle beside it; tap/shatter on exit |
| `both` | Pull both screens and sit between them |
| `ceiling` | Jump, pull down a large screen, then move it directly to the left or right panel |
| `seatedLeft`, `seatedRight` | Keep one screen after a selective dismissal, remaining seated at center |
| `dance` | Gentle bounce, head nod, arm swing, floating cyan music notes |
| `bodyThink` | Think within the current activity or panel arrangement; in full-face mode, use the thinking face |
| `face` | Full-frame original face with seven cyan mouth bars |
| `camera` | Lens eyes and a lower programmable viewfinder; mouth hidden |
| `faceThink` | Focused eyelids, glances, sequenced mouth bars |
| `search` | Moving magnifying-glass eyes and searching mouth motion |
| `nap`, `toss`, `walk`, `walkReverse` | Casual activities; each selected walking direction makes one pass, then rests at its endpoint |

Transitions use the authored graph in `states.json`, retaining the `ready` and `face` hubs. The direct `both` → `seatedLeft` and `both` → `seatedRight` edges dismiss only the opposite screen. Each seated single-panel state exits directly to `ready`. Selecting a seated single-panel state from elsewhere first enters the paired layout, then dismisses the unwanted screen. A manifest route is `{from, to, clip}`; state `exitTo` overrides the semantic parent for an exit. Context-specific face routes also identify their `context`. Requests made during a transition retain the latest destination and finish the active transition before rerouting. Walking in either direction and ball tossing finish the current cycle before their authored return, keeping travel and the wall/floor/catch intact; the status shows this wait. Other loop interruptions use a short 180ms blend into the authored exit. This is a preview controller, not a physically simulated animation system or the Blender pose-aware interruption helper. The old whistle audio is not played by this viewer. Dance, search, and camera states are visual animations; they do not start music, a web search, or a camera feed.

Full-face transitions remember their originating body context. A panel arrangement expands directly without playing its dismissal; the same left/right texture content and panel layout return on `merlin.body()`. The other face modes share this remembered body context. `merlin.go('bodyThink')` resolves to the current activity's contextual thought or to `faceThink` if already expanded. A thought may return briefly through its base body pose before expanding, without closing its panels. Walking in either direction plays once and settles into its matching relaxed endpoint pose. It does not loop back to the starting edge or automatically reverse direction. Interrupted walking also restores that endpoint on zoom-out; select another direction or a new walk explicitly to resume travel. `merlin.bodyContext` exposes the remembered state.

`merlin.ready()` explicitly clears the current presentation through authored exits. For a softer zoom-out, use `merlin.body()`; `go('ready')` from a face with an open-panel context also restores that context. Other body destinations retain their normal exit/entry behavior. `dismissScreen()` from a full face first restores its panel context, then dismisses the requested side.

Reduced-motion preference starts the character paused. An explicit Play action resumes it. Pause also freezes animated canvas content. Both visible panel canvases continue updating together in the paired layout; a dismissed screen stops updating after its exit. The 4:3 scene remains fixed while the surrounding controls adapt to a narrow screen.

## Scene clock

The stage displays the browser's current local time and date in large pale numerals. It follows the browser's locale and time zone, including 12/24-hour formatting and daylight saving; pausing the character does not pause wall time. It updates at minute boundaries, checks for clock changes within 15 seconds, and refreshes when returning to the tab. This clock is a browser overlay, not baked into the Blender export.

Its five resting positions are **upper left, upper middle, upper right, lower left, and lower right**. `clock-layout.js` chooses a clear position using projected swept bounds from the actual GLB meshes, including skinning, props and panel fragments. It reserves the entire active loop and upcoming entry/exit, so walking back in the opposite direction cannot invalidate the chosen corner. It holds a clear position instead of chasing each frame. When switching opposite standing panels it reserves the current panel through dismissal, then replans at the ready hub before the next panel pulls in. The large ceiling presentation and its docking routes use the same actual-geometry prediction. The paired layout reserves both simultaneous panels, the actual selective-dismissal route, and the remaining seated idle together. Prediction uses the same transition graph as playback.

Moves use a 320 ms ease-out. Stage or font-size changes recompute placement without sliding from stale coordinates; reduced motion uses instant relocation. Full-face entry, every full-face variant, and the complete return hide the overlay visually and from assistive technology. The ceiling pull, large-screen idle/thought, and conversion to a side panel also hide time because the screen covers almost the entire frame. The complete paired pull and simultaneous dismissal briefly hide time because their swept paths cover all five anchors; it returns in the clear seated or ready pose. Selective dismissals keep time visible and replan at the remaining seated pose before any later exit. The clock never takes pointer focus or makes repeated live-region announcements. `merlin.clock` exposes its current `spot` and `hidden` status for inspection.

`motion-footprints.json` caches normalized geometry bounds so the expensive sampling runs at build time, not on page load. After changing `merlin-states.glb` or the authored camera, regenerate with:

```sh
node assets/merlin-character/scripts/build_motion_footprints.mjs
```

The tests verify asset/camera hashes and off-grid posed vertices against the cache. The planner is specific to the authored orthographic scene; future camera controls, additional objects, or interactive HTML panels need updated footprints/obstacles. If every resting spot is obstructed, it chooses the least obstructed spot and keeps the time visible; full-face and ceiling presentations, the paired pull, and simultaneous dismissal are intentional hiding cases.

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
node --test assets/merlin-character/viewer/motion.test.mjs assets/merlin-character/viewer/clock-layout.test.mjs assets/merlin-character/viewer/screens.test.mjs
```

The 45 motion, clock, and screen tests exercise all 900 ordered pairs of authored destinations, request replacement during transitions, pause/resume, invalid-state handling, walking/tossing cycle completion, natural one-pass walking and held-endpoint requests, cancellation of pending returns, selective dismissal, rapid combined dismissal requests, visible-screen editing, contextual thought, and full-face restoration with the real Three.js animation mixer. They also check ceiling-to-side routing, intentional clock hiding, aspect-preserving content, retained images, live sources, direct canvas compatibility, and stale-upload rejection through screen handoffs. Seven additional footprint tests verify the actual asset, off-grid visible vertices, and clear clock anchors across visible routes. The shared character driver also applies ceiling aspect and handoff behavior, including live panel data, face return, and reduced motion; the companion's navigation and controls remain unchanged. Blender validation and re-import reports are in the parent `previews` directory.

## Dependencies and provenance

Three.js **0.180.0** is vendored under `vendor/three` with its MIT license, exact package source and hash. No runtime CDN, installation, or third-party request is needed. The server uses Node built-ins and binds to loopback only. Character geometry, motions, screen graphics, gradient textures, and six state stills are authored in Blender/Python in this repository; no third-party character or animation asset was downloaded. User reference screenshots are not redistributed.
