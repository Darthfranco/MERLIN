# MERLIN status and handoff

Last updated: **October 26, 2026**.

## Current state

- The owner's ten-area product outline and follow-up clarifications are documented in `PROJECT_CONTEXT.md` and summarized in the README and shared agent instructions.
- Shared instructions are available in root `AGENTS.md`, with entry points for common coding assistants.
- Hackathon overview and participant guide are preserved as user-supplied source snapshots.
- Meta model reference and tentative Kokoro TTS choice are documented.
- The public [Darthfranco/MERLIN repository](https://github.com/Darthfranco/MERLIN) is initialized on `main`; the initial documentation commit was pushed and verified against the remote.
- No application code, installed application dependencies, device integrations, API credentials, or working demo exist yet.
- No application build or test commands exist yet. Verification for this scope update passed: 28 local documentation links resolve, both original source snapshots remain byte-for-byte intact, and edited files pass Git whitespace checks. The updated documents were also reviewed against the owner's feature outline and clarifications. Source snapshots intentionally preserve whitespace from the supplied originals.

## Confirmed decisions

| Decision | Status |
| --- | --- |
| Product name | MERLIN |
| Product direction | Voice-first, Jarvis-inspired home assistant with the full ten-area feature scope in `PROJECT_CONTEXT.md`; an everyday home assistant, not an open-ended chat or autonomous coaching product |
| Home presence and access | Continuously available home device/display plus a companion app for communication, configuration, uploads, scheduling, and remote access |
| Platform and integration strategy | Aim to reach as many users as practical; platforms, hardware, and providers remain TBD. iPad, Spotify, and Ring are examples or candidates, not commitments |
| Voice activation | Wake word; exact phrase, detection implementation, and voice API roles remain TBD |
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

The following are proposed next steps, not an approved implementation sequence or reduced feature commitment:

1. Inventory available devices, cameras, and the intended demonstration environment.
2. Agree on a focused first demonstration and select the application stack and device integration approach.
3. Verify Meta account/API access and evaluate voice recognition plus Kokoro response latency.
4. Implement an end-to-end assistant interaction with truthful tool results, then add memory, routines, schedules, and visual features.
5. Maintain contribution history and prepare the three-minute demo and public submission before November 4 at 9 PM ET.

Full Official Rules and participant acceptance have not been verified. The supplied materials differ on the building-period start; consult `HACKATHON.md` before relying on an eligibility interpretation. Team/track, stack, hardware, service/device integrations, hosting, license, wake phrase, exact voice API roles, retention policy, detailed permissions, and final demo scope remain undecided. Do not turn the confirmed goal of broad accessibility into a specific platform choice.

## Handoff discipline

Update this file after meaningful work. Record implemented behavior, verification results, limitations, and the next step. Keep roadmap proposals separate from owner decisions. Never paste credentials or private household data here.
