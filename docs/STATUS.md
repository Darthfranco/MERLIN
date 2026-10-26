# MERLIN status and handoff

Last updated: **October 26, 2026**.

## Current state

- The owner's ten-area product outline and follow-up clarifications are documented in `PROJECT_CONTEXT.md` and summarized in the README and shared agent instructions.
- Shared instructions are available in root `AGENTS.md`, with entry points for common coding assistants.
- Hackathon overview and participant guide are preserved as user-supplied source snapshots.
- Meta model reference and tentative Kokoro TTS choice are documented.
- The public [Darthfranco/MERLIN repository](https://github.com/Darthfranco/MERLIN) is initialized on `main`; the initial documentation commit was pushed and verified against the remote.
- The first Blender character is implemented in [assets/merlin-character](../assets/merlin-character/README.md): an editable `.blend`, a self-contained animated `.glb`, and scripts to reproduce the model, render previews, and validate the assets. It has a lighter blue matte shell, rounded head and tapered oval torso, a flush screen with cyan-to-ice eyes, two subtle panel joins, and cyan under-foot lighting. The latest matte direction supersedes the original gloss request.
- The 15-bone rig includes `Idle`, `Wave`, and `Jump` actions plus an eight-second Blender `Showcase`. The GLB exports the three individual clips and excludes the studio. Delivery includes three PNG renders and an H.264 preview video (192 frames, 24 fps, 640 × 752). The encoded video was decoded and its wave, crouch, airborne, and landing frames visually checked.
- Asset validation passes all 20 checks in `previews/validation.json`, including geometry, animation motion, jump return height, embedded resources, and normalized GLB animation times. Independent GLB re-import preserved the rig/clips, a 0.68-unit airborne foot rise, and the authored eye gradient within 8-bit PNG rounding. The head and torso seams, matte finish, flush display, and representative wave/jump poses were visually reviewed. The floor-light helpers follow the feet and sit outside the opaque outsole so they can illuminate the floor.
- The separate `merlin-room.blend` and `merlin-room.glb` are built. The whole room uses a 4:3 landscape iPad-style composition with `WalkWhistle`, `WallToss`, and `Nap` actions, plus a 624-frame Blender `CasualShowcase`. The GLB includes the character, ball, original three clips, and three new clips with synchronized face expressions. The room, camera, and lights stay in Blender. Original character proportions and the portrait's six lights, world illumination, and exposure are restored, following the owner's reversals of the stretched-proportion and brighter-room experiments. The framing does not select an app platform.
- The room passes all **57 numerical checks** in [room-validation.json](../assets/merlin-character/previews/room-validation.json), rerun after the backdrop was moved clear of the original rim light and the final GLB was exported. Tests sample every frame of the three casual actions and selected showcase frames, confirming camera coverage, original geometry/proportions/lighting, floor and side-wall clearance, reclining pose, hands behind the head, active face expressions, effective ball visibility per clip, and constant sleep-expression channels. Both throws hit the right wall and floor before returning exactly to the hand's ball-center target. A separate 18-pose GLB re-import check preserved ball positions/scales and morph weights exactly, with root/hand position error at most 1.1 × 10⁻⁶ scene units.
- The three 1600 × 1200 Cycles room stills are complete and visually reviewed: walking/whistling, the wall toss, and napping. The [26-second room movie](../assets/merlin-character/previews/merlin-casual.mp4) is complete: 624 H.264 frames, 24 fps, 800 × 600, with short fades separating the three activities and an original whistle muxed as stereo AAC. [Video validation](../assets/merlin-character/previews/video-validation.json) confirms the frame count/dimensions/duration, audible whistle during walking, and silence afterward. Five decoded frames were visually reviewed for walking, wall contact, floor bounce, catching, and napping. The authored eight-second WAV is included separately and packed into the saved Blender timeline as an unmuted audio strip; the GLB requires separate synchronized audio playback.
- A functional text-only prototype now runs at `http://127.0.0.1:3000`: plain browser UI → standard Meta Spark 1.3 → built-in web search or validated local timer functions → text response. The character remains separate from this test interface. Local credentials are ignored and never committed.
- Multiple labeled countdown timers persist locally, expire without model calls, and support cancellation/dismissal, time zones, and duplicate-request protection. Tool outcomes remain visible even if the final model reply fails. Search displays real execution status and safe returned citation links. See [PROTOTYPE.md](PROTOTYPE.md) for setup, limits, and data flow.
- `npm test` passes **55 tests** covering timers, HTTP boundaries, durable retries, tool orchestration, failures, and provider configuration. Live Meta account model listing, timer creation, expiry, cancellation, and web-search execution were verified separately. Browser verification includes typed timer creation/cancellation, search with a clickable NASA citation, direct timer controls, and desktop/mobile layouts. A separate screenshot/source review found no material UI blockers for the simple prototype scope; it was not a full accessibility audit. No performance benchmark is claimed.
- Application commands: `npm start`, `npm run dev`, `npm run check:meta`, and `npm test`; Node.js 22.16+, no third-party application packages. Blender commands remain documented with the assets. Original hackathon source snapshots are unchanged.

- Compound tool requests are implemented: one ask can contain several searches, several timers, and both together. Meta can emit batches; the loop permits up to 64 local calls, eight model rounds, and 12 search calls total, with the existing 50-running-timer capacity. A live isolated test created ten timers and answered two searches with NASA/NOAA source links. Regression tests cover a full 50-timer batch, search/timer ordering, individual failures, accumulated citations, shared search budgets, and duplicate HTTP retries.

## Confirmed decisions

| Decision | Status |
| --- | --- |
| Product name | MERLIN |
| Product direction | Voice-first, Jarvis-inspired home assistant with the full ten-area feature scope in `PROJECT_CONTEXT.md`; an everyday home assistant, not an open-ended chat or autonomous coaching product |
| Home presence and access | Continuously available home device/display plus a companion app for communication, configuration, uploads, scheduling, and remote access |
| Platform and integration strategy | Aim to reach as many users as practical; platforms, hardware, and providers remain TBD. iPad, Spotify, and Ring are examples or candidates, not commitments |
| Voice activation | Wake word; exact phrase, detection implementation, and voice API roles remain TBD |
| Character design | Blender model guided by the owner's supplied robot reference views; clean, cute, simple, with lighter blue, rounded head and body forms, and premium refinement comparable to Meta or Apple products. The latest material direction replaces the original gloss with matte/satin surfaces, minimal reflections, and gentle diffuse shading. The screen must sit flush within the head; luminous cyan/blue face details should grade toward pale white while retaining visible color. Include a few subtle head and torso panel seams without clutter, bottom lighting, and waving/jumping animations. The latest proportion instruction restores the original design and reverses the temporary widening/deepening. Direction and refinements are confirmed; the resulting model remains subject to visual review |
| Room and casual animations | The latest request restores the original portrait's brightness, lighting, and midnight room tones, replacing the brighter experiments. Frame the whole scene in landscape using an iPad-style 4:3 composition. Add left-to-right walking/whistling, a left-wall lean with a ball tossed to the right wall then floor then hand, and a central nap with hands behind the head. This chooses a visual composition, not an app platform or automatic assistant behavior |
| Learning boundary | Learn from conversations directed at MERLIN, not ambient household conversations; privacy is a product requirement |
| Initial identity | One shared household identity |
| Memory and standing instructions | Learn useful preferences/context in the background; keep explicit do/don't instructions separately and check each outgoing response against them in context |
| Instruction interpretation | Distinguish an exact-word restriction from a topic restriction; do not assume which output channels an ambiguous instruction covers |
| Scheduling | Established schedules execute through ordinary scheduling logic without a new AI call for each run |
| Authorization duration | Follow the user's intent: one-time permission does not imply recurrence; explicit recurring authorization covers the specified future actions without routine reconfirmation |
| Routines | User-defined phrases and action sets; “Goodnight” is only an example and has no defined default actions |
| Everyday tools | Music through connected speakers/services, calendar access, web search/summaries, and multiple labeled timers with optional generated images |
| Cameras | Authorized home feeds and doorbell alerts, plus user-requested visual questions through the home device's camera |
| Remote and location use | Companion-app device/camera access and permission-based location/ETA automations are in scope; providers and implementation remain TBD |
| Workout support | Follow uploaded plans; look up advice when asked. Do not expand this into autonomous coaching or personality analysis |
| Incidental camera examples | Object identification, calorie estimates, math help, and clothing coordination remain requested features. The owner interprets the guide's anti-project examples as whole-project categories; organizer approval has not been established |
| Event | 2026 Meta Global AI Developer Hackathon |
| Repository | Public `Darthfranco/MERLIN`, requested by the owner on October 26, 2026 |
| Default delivery workflow | Commit and push all intentional project changes unless explicitly told otherwise |
| AI foundation | Meta models; first text prototype uses standard Spark 1.3; final routing remains open |
| First application build | Owner-confirmed local browser/Node.js test UI; typed input, web search, and timers; no voice in/out yet |
| Compound requests | Owner confirmed multiple searches/timers and timer creation plus web search in one message; separate asks are not required |
| Speech output | Kokoro is the owner's tentative preference |

## Next useful work

Review the delivered character, room, and animations with the owner. Mapping the character to listening, processing, speaking, and other assistant states remains future work after runtime/interface decisions; application integration was not part of this asset-only design task. Real-time device performance has not been benchmarked. GLB viewers must configure lighting, a room/floor, bloom, and synchronized whistle playback to reproduce the Blender presentation.

The requested text/search/timer slice is implemented. The next useful application step is owner testing of natural-language requests and tool results, then selection of the next feature from the full scope. Remaining broader proposals:

1. Inventory available devices, cameras, and the intended demonstration environment.
2. Choose the next demonstration flow and final application/device integration approach; the current local harness is temporary.
3. Evaluate voice recognition and Kokoro response latency when voice work is authorized; text Meta access has been verified.
4. Extend the implemented text/tool loop with memory, routines, schedules, and visual features as the owner prioritizes them.
5. Maintain contribution history and prepare the three-minute demo and public submission before November 4 at 9 PM ET.

Full Official Rules and participant acceptance have not been verified. The supplied materials differ on the building-period start; consult `HACKATHON.md` before relying on an eligibility interpretation. Team/track, production stack, hardware, service/device integrations, hosting, license, wake phrase, exact voice API roles, retention policy, detailed permissions, and final demo scope remain undecided. Do not turn the confirmed goal of broad accessibility into a specific platform choice.

## Contribution record

- **October 26, 2026 — compound tool requests:** enabled batched Meta function generation and mixed search/timer execution, increased bounded per-request capacity, shared search budgets across model rounds, aligned browser timeouts, and added multi-tool regression coverage. Full suite: 55 tests passing; live ten-timer/two-search flow passed.

- **October 26, 2026 — text/tool prototype:** first application UI, Meta Responses adapter, search-event/citation display, validated timer tools, persistent local timer engine, request receipts, loopback HTTP server, and 46 automated tests. Node.js/browser standard APIs only; Meta Model API is the external inference/search service. No voice, memory manager, physical device integration, or public deployment is claimed. Actual work date is recorded without resolving the hackathon build-start ambiguity.

- **October 26, 2026 — initial character asset:** new Blender geometry, matte materials, an authored packed display gradient, rigging, waving/jumping/idle animation, studio lighting, renders, and reproducible build/validation scripts. Blender 4.0.2 and its bundled glTF exporter are the production tools. No models, textures, HDRIs, or animations were downloaded. This date records actual work, not a determination of hackathon eligibility; the October 26/27 building-period ambiguity remains unresolved. Owner-supplied screenshots guided the design and are not redistributed in the repository.
- **October 26, 2026 — room extension:** landscape composition with the original character proportions and portrait lighting restored, new room/ball geometry, casual walking/whistling, wall-toss and napping actions, face expression shapes, an original procedural whistle, synchronized six-clip GLB export, three reviewed Cycles stills, and a 26-second H.264/AAC movie. The animation calculations use Blender's bundled NumPy; the whistle generator uses the Python standard library. Original portrait assets remain available. The 57 room checks, a separate GLB re-import comparison, and encoded movie/audio validation pass.

## Handoff discipline

Update this file after meaningful work. Record implemented behavior, verification results, limitations, and the next step. Keep roadmap proposals separate from owner decisions. Never paste credentials or private household data here.
