# MERLIN character — first design study

An original Blender model built from the owner's visual brief: a clean, cute robot with matte cornflower-blue surfaces, rounded head and body forms, a flush dark display, restrained cyan lighting, and a visible pool of light beneath its feet. Its matte/satin finish uses gentle diffuse shading and minimal reflections. The eyes grade from cyan-blue above to pale ice below. Two fine, muted-blue panel joins mark the rear head cap and curve around the chest. The proportions and simplified mitten hands are deliberately softer than the mechanical detail in the supplied references. This is a character asset; live assistant-state selection and application integration have not been implemented.

## Latest: expressive acting, panel interaction, and full-frame face

The new [merlin-interactions.blend](merlin-interactions.blend) and [merlin-interactions.glb](merlin-interactions.glb) extend the previous animation set with a more natural supported wake-up, purposeful eye glances and eyelid acting, a physical panel pull, clean tap dismissal, and coherent expansion into the same character's full-frame face. Original proportions, matte blue surfaces, cyan gradient, and room lighting are preserved. Earlier `.blend`, `.glb`, and preview files remain available as prior versions; this file is the latest animation study.

The wake-up brings the hands down for support, leads with the head and torso, gathers the feet, and makes a small hop followed by a cushioned landing and the existing welcome wave. Expressions follow the action: groggy eyes wake before the body, glances anticipate travel, the panel pull shows focus and effort, and returns soften into a friendly smile. Every facial channel is baked; a tiny corrective morph keeps combined eye shapes on the curved display.

| New clip | Frames at 24 fps | Behavior |
| --- | --- | --- |
| `ReadyToPanel` | 1–180 | Approach the right edge, grip, tug with effort, backstep while pulling the white panel into the right half of the scene, and settle beside it |
| `PanelIdle` | 1–96 | Breathe quietly beside the panel and glance toward it; loops |
| `PanelToReady` | 1–144 | Reach and tap at frame 30; small fragments recede and disappear during frames 31–53, then return to the central ready stance |
| `ReadyToFace` | 1–40 | Expand the robot's face into the full-frame display |
| `FullFaceIdle` | 1–96 | Expressive full-frame face, blue head-like border, and seven rounded cyan mouth bars; loops |
| `FaceToReady` | 1–36 | Retract the display to the original robot and central ready stance |

The GLB has **19 clips**: the prior 13 plus these six. [interactions.json](interactions.json) records their routes, exact connected endpoints, and presentation timeline. `ExperienceShowcase` is **748 frames at 24 fps** (31⅙ seconds): waking up, presenting the panel, tapping it away, expanding the face, and returning to the robot. Play it with **Space** over Blender's timeline. The four 1600 × 1200 Cycles stills are complete and visually reviewed: [supported wake-up](previews/merlin-natural-wakeup.png), [panel beside MERLIN](previews/merlin-panel.png), [tap dismissal](previews/merlin-panel-dismiss.png), and [full-frame face](previews/merlin-fullscreen-face.png).

Watch the completed [31.17-second interaction movie](previews/merlin-interactions.mp4): **748 H.264 frames at 800 × 600 and 24 fps**, with no audio track. [Encoded-media validation](previews/interaction-video-validation.json) independently confirms frame count, dimensions, frame timing, duration, and absence of audio. Twelve decoded frames were visually reviewed, covering supported wake-up and landing, panel effort and pulling, idle beside the panel, tap dismissal and return, face expansion, full-frame expression, and retraction to the robot.

All **63 scene/export checks** pass in [interactions-validation.json](previews/interactions-validation.json), covering fixed route continuity, the new loops, floor/wall/framing bounds, supported wake-up, panel/display visibility, and the preserved character/room setup. The 19 exported clips each retain 187 synchronized channels with correct durations and embedded resources. Five tested GLB route boundaries differ by at most 2.39 × 10⁻⁷ scene/channel units. Head/torso geometry and all 15 rest skeleton bind matrices match the prior asset exactly; original matte materials and room brightness are preserved. The [independent Blender re-import comparison](previews/interaction-roundtrip-validation.json) passes all 57 sampled poses across the 19 clips with no missing objects or tracks. All 15 bone positions differ by at most 1.34 × 10⁻⁶ scene units; face/display morph weights and display bounds match exactly, while prop matrix differences are below 3 × 10⁻⁷. A further mid-expansion vertex comparison is within 9.54 × 10⁻⁷ scene units. The robot and full-frame face share the same embedded gradient, whose imported pixels match exactly.

The saved scene passes all **11 facial checks** in [expression-validation.json](previews/expression-validation.json). Across all 19 clips, 6,564 robot-face object/frame samples and 1,702,264 vertex/frame samples retain positive screen clearance (minimum approximately 0.001 scene units), finite bounded weights, and explicit morph channels. Panel effort, glances, and relief are active. The eye/mouth shader graphs and packed texture pixels match the prior asset exactly. These checks cover authored integer frames; they do not prove every possible runtime blend.

Use the new helper to keep the body, face, ball, panel, fragments, and full-frame display synchronized:

```python
import bpy, sys
from pathlib import Path
sys.path.insert(0, str(Path(bpy.data.filepath).parent / 'scripts'))
from interaction_support import apply_activity

apply_activity(bpy.context.scene, 'ReadyToPanel')
# Also: PanelIdle, PanelToReady, ReadyToFace, FullFaceIdle, FaceToReady.
```

Rebuild with Blender 4.0.2 from the repository root:

```sh
blender --background --factory-startup --python-exit-code 1 \
  --python assets/merlin-character/scripts/build_interactions.py

blender --background --factory-startup assets/merlin-character/merlin-interactions.blend \
  --python-exit-code 1 --python assets/merlin-character/scripts/verify_interactions.py

blender --background --factory-startup --python-exit-code 1 \
  --python assets/merlin-character/scripts/verify_interaction_roundtrip.py

blender --background --factory-startup assets/merlin-character/merlin-interactions.blend \
  --python-exit-code 1 --python assets/merlin-character/scripts/render_interactions.py -- stills

blender --background --factory-startup assets/merlin-character/merlin-interactions.blend \
  --python-exit-code 1 --python assets/merlin-character/scripts/render_interactions.py -- motion

blender --background --factory-startup --python-exit-code 1 \
  --python assets/merlin-character/scripts/verify_interaction_video.py
```

The full-resolution stills use Cycles with compositor bloom. The motion preview uses Eevee's native bloom with the same scene lighting and exposure. It bypasses the otherwise pass-through compositor, retaining a soft cyan halo; a matching full-frame-face comparison produced identical pixels with the bypass enabled. The presentation preview is silent; the original walking whistle remains a separate asset for `WalkWhistle`.

The panel and full-frame modes use their fixed entry/exit routes at the documented endpoints. The earlier `transition_support.build_return_from_activity` helper below is scoped to the prior casual/transition assets: it synchronizes the body, face, and ball only and does not author panel or full-frame returns.

The full-frame presentation is authored for the saved landscape camera's transform and **4:3 orthographic composition**. The GLB contains animation assets, not a configured application camera or renderer; a runtime must reproduce that framing, lighting, and bloom. The white panel has no live content, and its dismissal is authored geometry animation. The mouth movement is authored animation, not audio analysis or speech synchronization. Application state selection and device performance remain unimplemented and unbenchmarked.

## Central ready pose and two-way transitions

The separate [merlin-transitions.blend](merlin-transitions.blend) adds connected departures and returns while retaining the original character proportions, materials, room, and brightness. Open it and press **Space** over the timeline for `InteractionShowcase`: lie down and nap, spring up and wave; go to the wall and toss the ball, run back and wave; go to the left side and walk while whistling, then run back and wave. The continuous presentation has no scene cuts or exposure fades. Every return finishes standing in the middle, facing ahead with open eyes, ready to interact.

| Clip | Frames at 24 fps | Behavior |
| --- | --- | --- |
| `ReadyIdle` | 1–96 | Central forward-facing idle, gentle breathing and blinking; loops |
| `ReadyToNap` | 1–96 | Kneel and lower into the relaxed hands-behind-head nap |
| `NapToReady` | 1–108 | Wake, tuck in, spring up, land, and wave |
| `ReadyToWallToss` | 1–96 | Travel to the left wall and settle into the ball-toss pose |
| `WallTossToReady` | 1–108 | Put away the ball, run to the middle, and wave |
| `ReadyToWalkWhistle` | 1–96 | Travel to the left starting position and prepare to whistle |
| `WalkWhistleToReady` | 1–108 | Run from the right side to the middle and wave |

Entrances begin at `ReadyIdle` frame 1 and end at the corresponding activity's frame 1. The three fixed return clips begin at their activity's final frame (`Nap` 192, `WallToss` 240, `WalkWhistle` 192), wave during frames 60–108, and end at `ReadyIdle` frame 1. [transitions.json](transitions.json) records those endpoints, clip durations, routes, audio alignment, and showcase segments. The [transition GLB](merlin-transitions.glb) contains **13 clips**: these seven plus the six original and casual clips. Its room, lights, camera, audio, and presentation timeline stay in Blender.

For an interruption at another playhead position, use `build_return_from_activity(activity, source_frame, name='ReturnToReady')` from `scripts/transition_support.py`. It samples the current body pose, face expressions, and ball state, then bakes a matching return. If the ball is already in flight, the current wall/floor/catch sequence finishes before MERLIN leaves the wall. The helper also handles the original `Idle`, `Wave`, `Jump`, and `Showcase`, the three casual activities, and their presentation timelines. `apply_activity(scene, name, frame=1)` selects the rig, face, prop, and audio together; selecting only an action on the rig does not synchronize the whole character.

For example, in Blender's Python Console with `merlin-transitions.blend` open:

```python
import bpy, sys
from pathlib import Path
sys.path.insert(0, str(Path(bpy.data.filepath).parent / 'scripts'))
from transition_support import apply_activity, build_return_from_activity

# Choose a fixed departure; press Space over the timeline to play it.
apply_activity(bpy.context.scene, 'ReadyToNap')

# Or author a return starting in the middle of an airborne throw.
clip = build_return_from_activity('WallToss', 52)
apply_activity(bpy.context.scene, clip)
```

The helper creates Blender actions without saving or re-exporting the file. The exported GLB provides fixed clips; a future live application needs to select those clips at their documented boundaries or implement equivalent pose-aware transitions. Assistant triggers, application playback, and device performance remain unimplemented and unbenchmarked.

`InteractionShowcase` spans **1,002 frames at 24 fps** (41.75 seconds). It demonstrates a return during the nap at source frame 48, a return after a catch at wall-toss frame 90, and the full left-to-right walk. Its packed whistle is aligned with walking at presentation frames 679–870. The movie renderer aligns the same WAV there; GLB playback requires the separate audio file.

All **119 numerical checks** pass in [transition-validation.json](previews/transition-validation.json). The checks cover every frame of the seven new fixed clips for floor/wall clearance, framing, and rig scale; exact source/target continuity; a central forward-facing ready stance; the wake-up hop and center waves; all 15 bones' exported transform channels; and seven sampled interruption cases. An interruption during the ball's flight preserves its trajectory through the catch, and interrupting a generated return preserves a partly stowed ball. Interruption sampling is not an exhaustive check of every possible source time.

The [GLB re-import check](previews/transition-roundtrip-validation.json) passes for 39 sampled poses across all 13 clips. Root, head, hand, and foot position errors are at most 1.34 × 10⁻⁶ scene units; face weights and ball positions match exactly, and ball-scale error is below 6 × 10⁻⁸. The three **1600 × 1200 Cycles stills** are complete and visually reviewed: [central ready pose](previews/merlin-ready.png), [wake-up jump](previews/merlin-wake-jump.png), and [wave at center](previews/merlin-ready-wave.png).

The [continuous transition movie](previews/merlin-transitions.mp4) is complete: **1,002 H.264 frames at 800 × 600 and 24 fps**, lasting **41.75 seconds**, with the original whistle muxed as stereo AAC. [Encoded-video/audio validation](previews/transition-video-validation.json) confirms the dimensions, frame count, duration, whistle during walking at frames 679–870, and silence outside that section. Nine decoded frames were visually reviewed, covering the ready stance, lowering into the nap, wake-up hop, center wave, departures, and both running returns.

Rebuild from the reviewed room asset, then validate and render:

```sh
blender --background --factory-startup --python-exit-code 1 \
  --python assets/merlin-character/scripts/build_transitions.py

blender --background --factory-startup assets/merlin-character/merlin-transitions.blend \
  --python-exit-code 1 --python assets/merlin-character/scripts/verify_transitions.py

blender --background --factory-startup assets/merlin-character/merlin-transitions.blend \
  --python-exit-code 1 --python assets/merlin-character/scripts/render_transitions.py -- all

blender --background --factory-startup --python-exit-code 1 \
  --python assets/merlin-character/scripts/verify_transition_video.py
```

Use `stills` or `motion` instead of `all` for one output type. These scripts write separate transition artifacts and preserve the original portrait and casual-room files.

## Landscape room and casual actions

The owner requested the whole scene in a landscape iPad-style composition. The latest brightness instruction restores the original portrait lighting and midnight room tones, replacing the intervening brighter-room experiments. The room retains the original lights, world illumination, exposure, and floor material tone. The new scene uses a 4:3 frame; no iPad application or runtime is selected. The original character, portrait scene, and wave/jump assets below remain available.

The room character retains the **original width, depth, and height proportions**, following the owner's latest instruction to restore the original design. The temporary widening/deepening was reversed; the room rig uses unit scale.

The casual actions are:

| Action | Frames at 24 fps | Requested behavior | Playback |
| --- | --- | --- | --- |
| `WalkWhistle` | 1–192 | Walk from left to right while whistling | One traversal |
| `WallToss` | 1–240 | Lean on the left wall; throw a ball to the right wall, then floor, then catch it | Loop |
| `Nap` | 1–192 | Lie in the middle with hands behind the head and nap | Loop |
| `CasualShowcase` | 1–624 | Present the three casual activities | Three sections separated by short fades |

Watch the [26-second casual animation movie](previews/merlin-casual.mp4), or open [merlin-room.blend](merlin-room.blend) and play its 624-frame `CasualShowcase` timeline. Short fades separate walking, the wall toss, and napping; the individual actions retain uninterrupted lighting. The Blender scene contains the midnight room with the original lighting, a landscape camera, the character, face expression keys, and a play ball. [merlin-room.glb](merlin-room.glb) contains the character and ball with six clips: the original `Idle`, `Wave`, and `Jump`, plus the three individual casual actions. The room geometry, camera, lighting, and `CasualShowcase` presentation stay in Blender.

The room passes all **57 numerical checks** in [room-validation.json](previews/room-validation.json): framing, original proportions/lighting, retained geometry/rig, six exported clips, floor clearance, ball contact/catch order, active expression weights, effective ball visibility per clip, constant sleeping expressions, and embedded assets. Every frame of the three individual activities is checked; the showcase is sampled at intervals, section boundaries, and ball-contact events. The walking character crosses from −3.1 to +3.1 scene units. Both ball throws contact the right wall and floor and return to the hand, with a measured catch-center error of zero. A separate GLB re-import compared 18 pose samples: ball positions/scales and face weights matched, with root/hand position error no greater than 1.1 × 10⁻⁶ scene units. These are authored character animations; automatic selection by a live assistant has not been implemented.

The room workflow uses `scripts/build_room.py`, `scripts/room_support.py`, `scripts/render_room.py`, and `scripts/verify_room.py`. `apply_activity(scene, name, frame)` in `room_support.py` selects the rig, face, and ball actions together; changing only the rig's Action Editor selection will not synchronize the full performance. The completed, visually reviewed **1600 × 1200** Cycles stills are [walking/whistling](previews/merlin-walk.png), [wall toss](previews/merlin-wall-toss.png), and [napping](previews/merlin-nap.png). The H.264 movie contains **624 frames at 800 × 600 and 24 fps**, with the original whistle muxed as stereo AAC. [Video validation](previews/video-validation.json) confirms the 26-second duration and whistle audio confined to the walking section. Five decoded movie frames were visually reviewed, covering the walk, wall contact, floor bounce, catch, and nap.

An original eight-second procedural whistle is generated by `scripts/make_whistle.py` as [audio/merlin-whistle.wav](audio/merlin-whistle.wav), using the Python standard library with no recorded samples or third-party music. The saved Blender scene includes the packed whistle in an unmuted timeline audio strip starting at frame 1, aligned with the opening walking section. The video rendering command also includes it. The GLB does not carry audio; a future runtime must play the separate WAV alongside `WalkWhistle`.

After the original character has been built, the room workflow is:

```sh
python3 assets/merlin-character/scripts/make_whistle.py

blender --background --factory-startup --python-exit-code 1 \
  --python assets/merlin-character/scripts/build_room.py

blender --background --factory-startup assets/merlin-character/merlin-room.blend \
  --python-exit-code 1 --python assets/merlin-character/scripts/verify_room.py

blender --background --factory-startup assets/merlin-character/merlin-room.blend \
  --python-exit-code 1 --python assets/merlin-character/scripts/render_room.py -- all
```

Use `stills` or `motion` instead of `all` to render only that output. The room verifier writes `previews/room-validation.json`; its results must be read alongside the rendered views. Rebuilding the room replaces its generated `.blend` and `.glb` files while preserving the original portrait assets.

## Open and play

- Open **[merlin.blend](merlin.blend)** in Blender. The file contains the editable geometry, materials, a 15-bone rig, named actions, a camera, and the dark studio lighting.
- Press **Space** over the timeline to play the eight-second `Showcase`: a quiet idle, a hello wave, and a springy jump.
- Use the Dope Sheet's **Action Editor** with `MERLIN_Rig` selected to choose `Idle`, `Wave`, or `Jump`. Set the timeline end to the corresponding frame below when looping an individual action.
- Press **F12** for the portrait render. The saved scene uses Cycles and denoising. Metal GPU rendering is selected when available; choose CPU in Render Properties on other machines if needed.
- **[merlin.glb](merlin.glb)** includes the character, materials, skeleton, and three separate animation clips. The studio, camera, and lights are excluded.

| Action | Frames at 24 fps | Motion |
| --- | --- | --- |
| `Idle` | 1–96 | Gentle breath and head drift |
| `Wave` | 1–96 | Raised side wave, wrist swings, head tilt |
| `Jump` | 1–72 | Crouch, takeoff, airborne arc, soft landing |
| `Showcase` | 1–192 | Complete presentation, stored in Blender |

The original `Idle`, `Wave`, `Jump`, and `Showcase` actions return to the same resting pose. The rigidly weighted shell pieces remain smooth during animation. Jump anticipation and landing compensate for the leg rotations to keep the feet at the ground plane.

## Rebuild and verify

Tested with Blender **4.0.2**. The scripts use Blender's Python runtime, the standard library, and Blender's bundled NumPy for casual animation calculations. No additional package installation, add-ons, downloaded assets, or network access are required. The build script generates the display gradient texture. Run from the repository root:

```sh
blender --background --factory-startup --python-exit-code 1 \
  --python assets/merlin-character/scripts/build_character.py

blender --background assets/merlin-character/merlin.blend --python-exit-code 1 \
  --python assets/merlin-character/scripts/verify_character.py
```

On macOS, Blender may be located at `/Applications/Blender.app/Contents/MacOS/Blender`. Append `-- --render` to the build command to render the hero PNG. Append `-- --preview` to render the 192-frame Eevee preview video. Rendered outputs are written to `assets/merlin-character/previews/`. Rebuilding replaces the generated `.blend` and `.glb`; save artistic edits separately before rebuilding.

To render the saved scene without rebuilding it:

```sh
blender --background --factory-startup assets/merlin-character/merlin.blend \
  --python assets/merlin-character/scripts/render_previews.py -- hero
```

Replace `hero` with `poses` for two stills of the wave and jump, `motion` for the eight-second video, or `all` to render every preview in one Blender session. Rendered previews are [hero](previews/merlin-hero.png), [wave](previews/merlin-wave.png), [jump](previews/merlin-jump.png), and [motion](previews/merlin-wave-jump.mp4).

The validation script checks geometry, rig bones, required actions, actual arm motion, jump height and return pose, embedded resources, glTF animation timestamps, and exclusion of the studio from the GLB. It writes [previews/validation.json](previews/validation.json).

## Materials and lighting

The eight character materials are matte cornflower-blue ceramic, a matte obsidian display, soft graphite joints, satin midnight trim, a luminous cyan smile, cyan sole lighting, the cyan-to-pale-ice eye gradient, and muted-blue panel joins. The blue shell and dark display are nonmetallic with no clear coat; broad, soft shading keeps their rounded shapes readable. A fine rear-cap join and a curved U-shaped chest join add restrained detail. The studio has a separate matte floor material.

The head is one continuous surface whose display, fine border, and ceramic regions share edges, keeping the screen flush. The eyes and smile are thin surface graphics that follow the display's curvature. The eye material uses one authored **64 × 256** gradient image, generated from linear color values encoded as sRGB, packed into the Blender file, and embedded in the GLB. The gradient feeds emission only to preserve its blue/cyan color. No textures are downloaded.

Large softboxes provide gentle lighting across the matte surfaces; the floor receives light from the emissive sole geometry and supplemental lights that follow the feet. The Cycles portrait is the reference for surface quality; the Eevee animation is a motion preview.

GLB preserves physically based material parameters and emission. Bloom, environment lighting, floor shading, and emitted-light spill require configuration in the eventual renderer. An unlit GLB viewer will not reproduce the studio render by itself. No application renderer or device performance target has been selected.

## Provenance

Created October 26, 2026 for MERLIN. Modeling, materials, the display gradient image, rigging, animation, room/studio setup, and procedural whistle are authored in the accompanying scripts. No meshes, HDRIs, textures, fonts, animations, or audio samples were downloaded. Blender, its bundled NumPy, and its bundled glTF exporter are the production dependencies; they are not redistributed here.

The owner-supplied images were used as visual references and are not included in the repository. Their original sources and redistribution rights have not been established. The project's licensing decision remains open. This contribution date is factual and does not resolve the hackathon's October 26/27 building-period ambiguity documented in [HACKATHON.md](../../docs/HACKATHON.md).
