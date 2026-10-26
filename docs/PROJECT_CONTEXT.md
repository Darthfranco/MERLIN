# MERLIN project context

Established from the owner's brief on **October 26, 2026**. This file preserves product intent for future contributors. The owner asked to document and understand the project first; application development follows in subsequent tasks.

## The objective

Build **MERLIN**, an exceptionally useful and approachable AI home assistant inspired by Jarvis. It should combine conversation, memory, visual understanding, device control, and a compelling interface into one experience that saves effort around the home.

The project is an entry in the **Meta Global AI Developer Hackathon**, hosted by Meta and Cerebral Valley. It will live in a **public GitHub repository**. Meta models must provide meaningful product functionality. [Hackathon requirements](HACKATHON.md) and [model options](MODELS.md) are documented separately.

Proposed theme fit: **Build for Your World**, centered on reducing everyday household effort. Coordinated physical-device control could also demonstrate **Push the Frontier**. A final submission theme and competition track have not been selected.

## Confirmed owner requirements

| Capability | Intended behavior |
| --- | --- |
| Memory and personalization | Remember preferences across interactions and build on them over time, instead of repeatedly asking for the same information. |
| Voice | Accept spoken requests and provide spoken responses. Kokoro is the probable TTS choice; speech recognition and TTS are separate components. |
| Jarvis-inspired UI | A polished, engaging, clear interface that shows what MERLIN heard, is doing, and has accomplished. |
| Connected home devices | Connect to lights, an oven, speakers, and cameras around the home. Exact brands, access methods, and permitted controls remain unspecified. |
| Everyday assistance | Play music, create/manage timers, look up information, and handle other useful household requests. |
| Home cameras | Give the user authorized access to home-camera views and useful visual context. |
| MERLIN's own camera | Use a dedicated or attached camera for requests such as “What is this?” Camera hardware is not selected. |
| Image generation | Generate quick useful images, such as labels or illustrations for timers. |
| Timers and schedules | Automate timing and schedules for lights, the oven, and other supported devices, with clear controls. |
| Custom commands/routines | Support “Goodnight” and other user-defined commands that coordinate multiple actions. |
| Companion app | Let the user send MERLIN information, manage preferences and routines, and set up schedules. App platform remains open. |

These are scope commitments, not claims that functionality already exists. Prioritization for the hackathon should preserve the larger vision while choosing a credible working demonstration.

## Proposed first demonstration

The following sequence is an agent proposal for discussion, not an approved MVP or final architecture:

1. The user gives a voice request; MERLIN displays the transcript and responds aloud.
2. MERLIN remembers a preference, such as the user's preferred evening light brightness, and applies it in a later request.
3. A custom “Goodnight” routine coordinates supported lights and music and shows actual outcomes.
4. A timer or schedule appears in the app with a clear label, optionally generated artwork, and edit/cancel controls.
5. A user-initiated camera request uses Meta visual understanding to answer a practical question in the same assistant session.

Build a reliable interaction from voice to reasoning to device action and visible feedback before expanding the number of integrations. A working device integration is more convincing than a large list of simulated controls. Keep simulations available for development and clearly label them in the demo. Oven integration remains in the product scope; live heating should wait for the device's supported API and appropriate controls.

## Proposed system responsibilities

This is a conceptual outline, not a selected technology stack:

- **Interface:** conversation, voice status, rooms/devices, camera views, timers, routines, schedules, and memory management.
- **Voice:** capture and speech recognition, turn handling, and speech synthesis; assess latency and interruption behavior during implementation.
- **Agent:** Meta-powered intent handling, tool selection, multi-step coordination, and explanation of outcomes.
- **Memory:** durable, user-controlled preferences, separated from temporary conversation context.
- **Device adapters:** explicit capabilities and observed state for each supported device or home hub.
- **Scheduling:** persistent timers and routines with explicit time zones, cancellation, and recovery after restarts.
- **Vision and images:** authorized camera input and generated UI imagery, using appropriate Meta models.
- **Activity and permissions:** understandable action history, access control, and deliberate handling of physical-device risks.

The owner has not chosen Home Assistant, Matter, MQTT, a vendor API, a frontend framework, a database, or deployment infrastructure. These may be evaluated as options when the actual hardware and demo environment are known.

## Product quality and privacy defaults

MERLIN should be easy to understand and control. Show listening/thinking/speaking/action states, acknowledge requests promptly, expose failures, and keep common actions simple. A futuristic visual style should support everyday use.

The home is private. Keep credentials and raw household data out of the public repository. Use synthetic public demos, visible camera/microphone controls, and editable/deletable memory. Explain which data goes to hosted models. Contributor variants that use data for training should not be silently selected for household audio, imagery, or preferences.

Device execution should validate targets and parameters, enforce permissions, and verify results where possible. Oven heating requires deliberate handling of appliance limits and user confirmation; routines and schedules must preserve those controls. These are engineering defaults proposed for this physical-world product, not requirements attributed to the event organizers.

## Decisions still needed

- Actual device inventory, brands, connection methods, and access to a home hub, if any.
- Companion app target: browser, desktop, mobile, shared wall display, or a combination.
- Local/cloud split, deployment location, and available compute for Kokoro or open-weight models.
- Initial Meta model selection, account access, budget, and measured response latency.
- Push-to-talk versus wake-word behavior; wake-word or always-on capture is not an existing requirement.
- Household profiles, permissions, memory retention, and recording policies.
- First demo scenarios and what will use real hardware versus clearly marked simulation.
- Team members, representative, competition track, final theme, and accepted Official Rules.
- Repository license and third-party attribution requirements.

Decide these as they become relevant. Do not block documentation or unrelated work on answers that are not yet needed.

## Owner's development workflow

**Commit and push code and other project changes to GitHub by default, unless the owner explicitly says not to.** This includes project documentation. Keep shared context current so a new agent can continue without the original conversation. [AGENTS.md](../AGENTS.md) defines the repository workflow; [STATUS.md](STATUS.md) records progress.
