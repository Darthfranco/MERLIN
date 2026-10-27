# MERLIN screen panels

Seven simple 2D designs for the white panels MERLIN pulls into the scene. They share the character's white, pale blue, cyan, and navy palette, large readable status text, and a small number of controls. The timer is a **countdown only**; there is no clock or time-of-day screen.

Every design uses a **5:6 portrait** canvas, authored at **900 × 1080**. This matches both existing robot panels. The camera viewfinder has a different shape and is not a target for this collection. The same renderer supplies the gallery, PNG textures, and the left and right 3D panels, including their dismissal fragments.

## Open the designs

From the repository root:

```sh
node assets/merlin-character/viewer/serve.mjs
```

Open [the panel gallery](http://127.0.0.1:3310/viewer/panels/) or [the character studio](http://127.0.0.1:3310/viewer/). A gallery tile opens an interactive preview with state variants, a name field, and **Export PNG**. **See example on MERLIN** opens the corresponding panel in the studio. Direct links use `?panel=timer` in the gallery or `?panel=timer&side=right` in the studio; `side` may also be `left`.

The gallery's transparent HTML buttons align with the canvas controls and support pointer and keyboard input. **The buttons drawn on the 3D texture are not clickable.** The studio displays the design and plays the authored panel animation; it does not route clicks into the texture.

## Designs and states

| Panel ID | Content | Main states | Available actions |
| --- | --- | --- | --- |
| `timer` | Remaining time, progress ring, original duration | `running`, `paused`, `done`, `cancelled` | Pause/resume, cancel, start again |
| `lights` | Room/device name and clear on/off state | `on`, `off` | Turn off/on |
| `oven` | Oven name, on/off state, supplied heating detail | `on`, `off` | Turn off/on |
| `music` | Track, artist, playback position, output device | `playing`, `paused`, `empty` | Previous, play/pause, next; none when empty |
| `schedule` | Saved action, target, time, recurrence, time zone | `saved`, `removed` | Remove while saved |
| `routine-saved` | Routine name, illustration, saved acknowledgment, actions | `saved` | View routine |
| `routine` | Routine name, illustration, activation phrase, actions | `ready`, `running`, `done` | Run/run again; disabled while running |

All designs also render `pending`, `offline`, and `error` as a clear unavailable state with no action targets. The gallery exposes the relevant subset for each design. These are display states, not validators for provider or device responses; integrations must validate the supplied state before painting it.

Routine panels show up to two actions and a count of any remaining actions. Saving and viewing a routine remain separate from running it. “Tea time” and its five-minute timer are synthetic examples, not installed household routines or defaults.

## Reuse the renderer

[render.js](render.js) exports:

- `PANEL_TYPES`, `PANEL_WIDTH`, `PANEL_HEIGHT`, and `COLORS` for the collection and shared styling.
- `createDemoState(type)` for independent synthetic fixtures, marked `source: 'demo'`. This is a preview helper, not a source of live defaults.
- `loadPanelArt()` to load the bundled artwork once. It returns an art map, currently containing `tea`; an unavailable image resolves to `null`.
- `paintPanel(context, width, height, state, {art})` to draw the complete screen. It makes no model, device, scheduling, or music calls. Preserve the 5:6 aspect ratio when selecting the output dimensions.
- `panelActions(state)` to return action IDs, accessible labels, and hit rectangles in logical 900 × 1080 coordinates. The caller owns event handling and execution.
- `panelDescription(state)` for a textual description and `formatDuration(seconds)` for countdown/playback formatting.

```js
import {
  createDemoState, loadPanelArt, paintPanel, panelActions,
} from './render.js';

const art = await loadPanelArt();
const state = createDemoState('timer');
canvas.width = 900;
canvas.height = 1080;
paintPanel(canvas.getContext('2d'), canvas.width, canvas.height, state, {art});
const targets = panelActions(state); // Drawn controls; execution is the caller's job.
```

Scale action rectangles by `displayWidth / 900` and `displayHeight / 1080` when placing HTML controls over a differently sized canvas. The gallery implements this mapping in [panels.js](panels.js). The renderer does not install event handlers or advance timers itself.

After the studio dispatches `merlinready`, its convenience API can show a design:

```js
merlin.showPanel('timer', {label: 'Pasta timer', seconds: 180, durationSeconds: 180}, 'right');
merlin.showPanel('routine', {}, 'left');
```

`showPanel()` merges the supplied fields over the selected synthetic fixture, paints the texture, and requests the corresponding animation. It returns the painted state. Treat it as a preview API: those fixture defaults must not fill missing live device or schedule information. These studio states are static until repainted. See the [studio integration notes](../README.md) for direct canvas sources, animated drawing, and replacing screen textures.

## Artwork for any routine

Routine artwork is selected by `state.artKey` from the `art` map passed to `paintPanel()`. The bundled Tea time fixture uses `artKey: 'tea'`. A caller may supply a different decoded image or canvas under a different key; the renderer does not derive an image from the routine name or contact a model.

```js
const state = {
  type: 'routine', status: 'ready', label: 'Reading time',
  trigger: 'Reading time', steps: ['Your saved action'], artKey: 'reading',
};
paintPanel(context, 900, 1080, state, {art: {reading: readingImage}});
```

Here `readingImage` is an image or canvas already loaded by the caller. Missing artwork uses a simple local fallback icon. Keep each image associated with the correct saved routine; changing a label does not generate a new picture. Generic routine artwork slots are available, but automatic image generation during actual routine saving is not connected.

The bundled [Tea time illustration](art/tea-time.png) was generated with standard **Meta `muse-image-1.0`** from an original synthetic description: a simple pale-blue cup, cyan steam, a tiny leaf, and an off-white background. It is 1600 × 1600 and contains no text, logos, or external reference assets. Its exact prompt is embedded in PNG `Description` metadata and recorded with dimensions and SHA-256 in [the provenance manifest](art/tea-time.json).

Generate a new synthetic illustration from the repository root:

```sh
node --env-file-if-exists=.env scripts/generate-routine-art.mjs \
  --title 'Reading time' \
  --description 'One simple open book, with rounded pale blue covers and a tiny warm amber bookmark.' \
  --out assets/merlin-character/viewer/panels/art/reading-time.png \
  --public-demo
```

The script uses the existing ignored `META_API_KEY` or `MODEL_API_KEY`, fixes the standard Muse model, sets `store:false`, and disables web search, image search, and shell tools. It makes one generation request without automatic retries, refuses to overwrite existing output, and writes a PNG plus its JSON provenance. Provider retention policies still apply; `store:false` is not a zero-retention claim. See [Meta's image API](https://dev.meta.ai/docs/image-generation) and [data commitments](https://dev.meta.ai/legal/commitments).

Without `--out`, output goes under ignored `local/routine-art/`. Output outside `local/` requires `--public-demo`, which is only for explicitly synthetic public examples. The script never reads saved routines, conversation memory, household preferences, or Spotify metadata. Supply only the visual subject appropriate to send to Meta. Keep private prompts and artwork out of this public repository.

## Preview and live behavior

The gallery and studio are design previews. They do not connect to the assistant's stored timers/routines, Spotify, a scheduler, or physical devices.

- The gallery countdown runs in page memory after an explicit start/resume. It is not persisted, raises no system alarm, and ends when the page is closed. The studio shows a static timer fixture.
- Lights and oven controls change only the preview. They send no appliance command. The oven's heating text is example data; an on state is not evidence of a reached temperature.
- Music controls change synthetic playback fields. No audio plays, and no account data is fetched or sent to Meta.
- Schedule removal changes only the preview. No schedule is created or removed from storage.
- Routine save/view states do not execute their contents. The gallery's run action briefly simulates progress and completion without starting the depicted timer.

A live integration must supply verified outcomes and route action IDs through the application's existing permission, rule, capability, and argument checks. Show `pending` until a device result is known, and `offline`/`error` when appropriate. Do not interpret a rendered “On,” “Schedule set,” or “All done” as evidence that an action occurred.

Schedules need an explicit IANA `timezone` and an accurate `repeat` description. `zoneLabel` is an optional readable display label; it does not replace the stored time zone. A one-time schedule must include its date and stay one-time. Recurring schedules must preserve the actual authorized frequency, action, and target. The renderer does not calculate dates, handle daylight-saving transitions, infer recurrence, persist schedules, cancel backend work, or prevent duplicate execution. Those responsibilities belong to the scheduler, which should execute established schedules without another model call per occurrence.

## PNG textures and checks

The gallery's **Export PNG** downloads the currently displayed design at 900 × 1080 for use in Blender or another runtime. Textures are exported on demand; there is no bundled `exports/` collection. PNG controls are visual only, and exports do not contain executable routines or schedules. Keep names, device information, music metadata, and other household data out of committed exports.

The artwork generator's focused checks run with:

```sh
node --test test/routine-art.test.js
```

They cover the standard model and privacy switches, local/public output boundary, missing credentials, exact prompt metadata with unchanged image pixels, safe provider errors, and incomplete/invalid image responses. These checks do not establish live device, scheduling, music, or household-routine behavior.
