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
- No application code, installed application dependencies, device integrations, API credentials, or working assistant application exist yet. This character is an art asset, not an implemented assistant interface.
- No application build or test commands exist yet. Blender reproduction and validation commands are documented with the asset. Edited text passes Git whitespace checks and Python syntax checks; all 24 local links in the four changed documentation files resolve. Original hackathon source snapshots remain unchanged.

## Confirmed decisions

| Decision | Status |
| --- | --- |
| Product name | MERLIN |
| Product direction | Voice-first, Jarvis-inspired home assistant with the full ten-area feature scope in `PROJECT_CONTEXT.md`; an everyday home assistant, not an open-ended chat or autonomous coaching product |
| Home presence and access | Continuously available home device/display plus a companion app for communication, configuration, uploads, scheduling, and remote access |
| Platform and integration strategy | Aim to reach as many users as practical; platforms, hardware, and providers remain TBD. iPad, Spotify, and Ring are examples or candidates, not commitments |
| Voice activation | Wake word; exact phrase, detection implementation, and voice API roles remain TBD |
| Character design | Blender model guided by the owner's supplied robot reference views; clean, cute, simple, with lighter blue, rounded head and body forms, and premium refinement comparable to Meta or Apple products. The latest material direction replaces the original gloss with matte/satin surfaces, minimal reflections, and gentle diffuse shading. The screen must sit flush within the head; luminous cyan/blue face details should grade toward pale white while retaining visible color. Include a few subtle head and torso panel seams without clutter, visible bottom lighting in a dark room, and waving/jumping animations. Direction and refinements are confirmed; the resulting model remains subject to visual review |
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
| AI foundation | Meta models; exact routing still open |
| Speech output | Kokoro is the owner's tentative preference |

## Next useful work

Review the delivered character visually with the owner. Mapping it to listening, processing, speaking, and other assistant states remains future work after runtime/interface decisions; application integration was not part of this asset-only design task. Real-time device performance has not been benchmarked. GLB viewers must supply their own lighting, floor, and bloom to reproduce the studio presentation.

The following are proposed next steps, not an approved implementation sequence or reduced feature commitment:

1. Inventory available devices, cameras, and the intended demonstration environment.
2. Agree on a focused first demonstration and select the application stack and device integration approach.
3. Verify Meta account/API access and evaluate voice recognition plus Kokoro response latency.
4. Implement an end-to-end assistant interaction with truthful tool results, then add memory, routines, schedules, and visual features.
5. Maintain contribution history and prepare the three-minute demo and public submission before November 4 at 9 PM ET.

Full Official Rules and participant acceptance have not been verified. The supplied materials differ on the building-period start; consult `HACKATHON.md` before relying on an eligibility interpretation. Team/track, stack, hardware, service/device integrations, hosting, license, wake phrase, exact voice API roles, retention policy, detailed permissions, and final demo scope remain undecided. Do not turn the confirmed goal of broad accessibility into a specific platform choice.

## Contribution record

- **October 26, 2026 — initial character asset:** new Blender geometry, matte materials, an authored packed display gradient, rigging, waving/jumping/idle animation, studio lighting, renders, and reproducible build/validation scripts. Blender 4.0.2 and its bundled glTF exporter are the production tools. No models, textures, HDRIs, or animations were downloaded. This date records actual work, not a determination of hackathon eligibility; the October 26/27 building-period ambiguity remains unresolved. Owner-supplied screenshots guided the design and are not redistributed in the repository.

## Handoff discipline

Update this file after meaningful work. Record implemented behavior, verification results, limitations, and the next step. Keep roadmap proposals separate from owner decisions. Never paste credentials or private household data here.
