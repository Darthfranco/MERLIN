# MERLIN status and handoff

Last updated: **October 26, 2026**.

## Current state

- Project scope and owner preferences are documented.
- Shared instructions are available in root `AGENTS.md`, with entry points for common coding assistants.
- Hackathon overview and participant guide are preserved as user-supplied source snapshots.
- Meta model reference and tentative Kokoro TTS choice are documented.
- The public [Darthfranco/MERLIN repository](https://github.com/Darthfranco/MERLIN) is initialized on `main`; the initial documentation commit was pushed and verified against the remote.
- No application code, installed application dependencies, device integrations, API credentials, or working demo exist yet.
- No build or test commands exist yet. Initial verification passed: 26 local documentation links resolve, both source snapshots match byte-for-byte, authored files pass Git whitespace checks, basic credential-pattern checks pass, and private runtime paths are ignored. Source snapshots intentionally preserve whitespace from the supplied originals.

## Confirmed decisions

| Decision | Status |
| --- | --- |
| Product name | MERLIN |
| Product direction | Jarvis-inspired home assistant with the full feature scope in `PROJECT_CONTEXT.md` |
| Event | 2026 Meta Global AI Developer Hackathon |
| Repository | Public `Darthfranco/MERLIN`, requested by the owner on October 26, 2026 |
| Default delivery workflow | Commit and push all intentional project changes unless explicitly told otherwise |
| AI foundation | Meta models; exact routing still open |
| Speech output | Kokoro is the owner's tentative preference |

## Next useful work

1. Inventory available devices, cameras, and the intended demonstration environment.
2. Agree on a focused first demonstration and select the application stack and device integration approach.
3. Verify Meta account/API access and evaluate voice recognition plus Kokoro response latency.
4. Implement an end-to-end assistant interaction with truthful tool results, then add memory, routines, schedules, and visual features.
5. Maintain contribution history and prepare the three-minute demo and public submission before November 4 at 9 PM ET.

Full Official Rules and participant acceptance have not been verified. The supplied materials differ on the building-period start; consult `HACKATHON.md` before relying on an eligibility interpretation. Team/track, stack, hardware, hosting, license, and final demo scope remain undecided.

## Handoff discipline

Update this file after meaningful work. Record implemented behavior, verification results, limitations, and the next step. Keep roadmap proposals separate from owner decisions. Never paste credentials or private household data here.
