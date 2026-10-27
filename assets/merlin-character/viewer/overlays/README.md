# Optional floating timer and music cards

Short, white-backed versions of the existing MERLIN panels, scaled with the scene clock. These are reusable DOM/CSS/vector assets, not new timer or music services. Nothing appears on startup, nothing is saved, and the companion's normal physical-panel behavior is unchanged.

In the [character studio](../), expand **Floating timer & music previews** and choose a sample. Only these explicit buttons create synthetic data. Pause/resume changes the sample's appearance; there is no countdown execution or audio. Clear overlays removes both samples; reloading also starts empty.

## Studio API

Wait for `merlinready`, then supply actual presentation data yourself:

```js
merlin.overlays.show('timer', {
  title: 'Tea timer',
  status: 'running',
  remainingSeconds: 242,
  durationSeconds: 300,
}, {id: 'tea'});

merlin.overlays.show('music', {
  title: 'Slow mornings',
  artist: 'MERLIN sessions',
  status: 'paused',
  positionSeconds: 84,
  durationSeconds: 218,
});

merlin.overlays.update('tea', {remainingSeconds: 241});
merlin.overlays.hide('tea');
merlin.overlays.clear();
```

The values above are synthetic examples. `show(type, data, {id = type, onAction})` returns the id. Reusing the same id updates that card; changing its type requires a different id. `update(id, patch)` and `hide(id)` return false for absent ids. `status` returns `{id, type, visible, spot, reason}` records; `reason` is `presentation`, `space`, or null. `hide` removes the record, including while it is temporarily concealed.

Without `onAction`, cards are display-only and have no transport button. To enable a pause/resume button, supply a callback receiving `{id, type, action: 'pause' | 'resume'}`. The caller must validate and execute the action, then call `update` with the confirmed state. The component never changes playback/countdown state optimistically, runs an API request, or writes metadata to memory/logs. Preserve the existing Spotify privacy and typed/manual-control restrictions when wiring a future adapter.

Supported timer statuses: `running`, `paused`, `finished`, `unknown`. Music: `playing`, `paused`, `stopped`, `loading`, `error`, `unknown`. Missing/invalid timing displays **—** and omits progress. Unsupported statuses display **Status unavailable** with disabled controls. Timer duration supports up to 604800 seconds (168 hours). Existing panel field aliases (`label`/`seconds`, `elapsed`/`duration`) are accepted; use one field convention consistently when patching a record. Canonical fields take precedence, including explicit null.

## Reuse in another scene

Include `overlays.css`, then mount beside an existing `SceneClock`:

```js
import {SceneOverlays} from './overlays/scene-overlays.js';
const overlays = new SceneOverlays(stage, {clock: sceneClock});
// Nothing has been added. Call overlays.show(...) only after explicit selection.
// On unmount, destroy overlays before destroying its clock:
overlays.destroy();
```

The stage needs `position: relative`, `overflow: hidden`, and `container-type: inline-size`, as in the studio. No package dependency, raster artwork, frame loop, network call, or polling timer is added. The caller supplies countdown/progress updates from its own authoritative state and refreshes after sleep. This module is deliberately not mounted or wired to live timers/music in `/companion/`.

The clock publishes its layout through `subscribeLayout(listener)`, returning an unsubscribe function. Cards reserve the clock first, then earlier cards, among upper-left, upper-middle, upper-right, lower-left and lower-right. They use the same full-route animation footprints, including return walks. A card retains its anchor while safe, moves in 320 ms, and uses immediate placement for resize/reduced motion. No clear anchor means temporary concealment with retained data; tight viewports and single-side panels can hide all cards. Full-face, ceiling, and busy paired-screen transitions share the clock's concealment policy. Hidden cards are inert and removed from the accessibility tree. Long titles visually truncate but retain their full accessible text and title tooltip; countdowns are not live-announced every second.

Original contributions: compact card composition, authored record/transport vector geometry derived from the panel family, collision-aware coordinator, data normalization and explicit preview controls. No third-party asset or new runtime dependency.
