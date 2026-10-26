# MERLIN

A voice-first, Jarvis-inspired home assistant that learns about its household, manages connected devices and services, and stays accessible through a companion app.

Built for the **2026 Meta Global AI Developer Hackathon**, hosted by Meta and Cerebral Valley. MERLIN aims to make everyday home tasks useful, simple, and natural through Meta models and a polished companion interface.

**Status:** Initial Blender character and animation assets are available in [assets/merlin-character](assets/merlin-character/README.md). The first text-only application prototype now implements Meta-driven web search and local timers. Other features below remain product goals, not working integrations.

## Product vision

- **Home device and companion app:** remain available on a home device/display, with a companion app for communication, configuration, and remote access. Reach as many users and devices as practical; specific platforms remain TBD.
- **Voice and interface:** activate through a wake word and respond conversationally, with a clean Jarvis-inspired interface requiring little or no touch. The owner has requested a simple, cute robot modeled in Blender, refined to a lighter blue with rounded head and body forms, matte/satin surfaces, minimal reflections, and premium refinement comparable to Meta or Apple products. Its screen sits flush within the head, with luminous cyan/blue face details grading toward pale white and a few subtle head and torso panel seams. Include bottom lighting for a dark room and waving/jumping animations. The wake phrase, voice API roles, and character integration remain TBD.
- **Memory and personalization:** learn useful preferences and context from conversations directed at MERLIN, using one shared household identity initially. Keep memory visible, editable, and removable; do not learn by monitoring ambient conversations.
- **Standing instructions:** keep explicit do/don't instructions separate from learned preferences and check every outgoing response against them in context. A prohibited word and a prohibited topic are different instructions.
- **Everyday assistance:** play music through connected speakers and services, connect with a calendar, search and summarize information, and run multiple labeled timers with optional generated images.
- **Home cameras and doorbell:** show authorized camera feeds and doorbell alerts, including access through the companion app while away.
- **MERLIN's own camera:** answer questions about what the user chooses to show, such as objects, food calories, math homework, or clothing combinations. These are incidental assistant features, not separate coaching products.
- **Schedules and automation:** create device schedules by voice or app, including lights, supported oven controls, and AC. Established schedules run through ordinary scheduling logic without a new AI call for every execution; authorization follows the user's one-time or recurring intent.
- **Custom commands and routines:** let users define phrases and their actions. “Goodnight” is only an example, with no preset behavior. A workout routine can follow an uploaded plan and coordinate lights, music, and AC; look up workout advice when asked.
- **Information sharing and remote control:** accept documents, text, plans, and schedules through the app, support remote device actions, and use permitted location access for requests such as preheating when five minutes from home.

MERLIN is a home assistant, not an open-ended chat or autonomous coaching product. Privacy matters: wake-word availability does not authorize ambient conversation learning. The detailed requirements and unresolved decisions live in [project context](docs/PROJECT_CONTEXT.md).

Meta models are a core product requirement. Kokoro is the tentative speech synthesis choice. The application stack, hardware, integrations, and final model routing remain open; iPad, Spotify, and Ring are examples or candidates, not selected dependencies.

## Start here

**Every coding agent and contributor should read [AGENTS.md](AGENTS.md) before making changes.** It includes the owner's standing instruction to commit and push project changes to GitHub unless explicitly told otherwise.

| Document | Purpose |
| --- | --- |
| [Project context](docs/PROJECT_CONTEXT.md) | Owner's requirements, ten feature areas, clarified decisions, and open questions |
| [Hackathon brief](docs/HACKATHON.md) | Rules from the supplied materials, schedule, judging, and submission checklist |
| [Model reference](docs/MODELS.md) | Meta catalog, tentative model roles, pricing snapshot, and Kokoro reference |
| [Project status](docs/STATUS.md) | Current implementation state, decisions, and next steps |
| [Original event overview](docs/sources/event-overview.txt) and [participant guide](docs/sources/participant-guide.txt) | User-supplied source snapshots |

Submission target: **November 4, 2026 at 9:00 PM America/New_York (EST)**. A public repository and a three-minute video demonstrating work built during the hackathon are required by the supplied participant guide.

Run the text prototype with Node.js 22.16+: copy `.env.example` to `.env` if it does not exist, set `META_API_KEY` locally, then run `npm run check:meta` and `npm start`. Open [localhost:3000](http://127.0.0.1:3000). Run `npm test` for the offline test suite. See [prototype setup, architecture, and privacy](docs/PROTOTYPE.md). An open-source license has not yet been selected.

The character's [Blender workflow](assets/merlin-character/README.md) includes rebuilding, rendering, animation playback, and asset validation instructions.
