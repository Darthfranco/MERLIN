# MERLIN project context

Updated **October 26, 2026** from the owner's initial brief, detailed ten-area outline, and follow-up clarifications. This is the shared product brief for every contributor. It describes intended features and confirmed product decisions; the first text-only assistant prototype has now been implemented.

## The objective

**MERLIN is a voice-first home assistant that learns about its household, manages connected devices and services, and stays accessible through a companion app.** The owner's shorthand is “a Google Home on steroids”: everyday household assistance, natural interactions, and useful actions are the product focus. Meta models power the experience; model chat itself is not the central interface.

MERLIN is being built in a public GitHub repository for the **2026 Meta Global AI Developer Hackathon**, hosted by Meta and Cerebral Valley. See [hackathon requirements](HACKATHON.md) and the [model reference](MODELS.md). The proposed primary theme is **Build for Your World**; physical-device coordination may also support **Push the Frontier**. Track and final submission theme remain undecided.

The owner wants MERLIN to be accessible to as many people as possible. Exact home hardware, companion-app platforms, service providers, and device integrations are **TBD**. An iPad, Spotify, and Ring are examples or candidate integrations, not finalized platform commitments or claims of working support.

## First application slice confirmed October 26, 2026

The owner requested typed input → Meta understanding and tool selection → execution → text response, with **web search and timers only for this first build**. No voice input or voice output yet. The owner confirmed a **simple local browser UI with a small Node.js server** for testing; it need not be polished and does not choose MERLIN's final app platform or reduce the full feature scope. The owner confirmed Meta Model API access. The prototype uses standard `muse-spark-1.3`, Meta's built-in web search, and local timer functions; final model routing remains open. See [prototype implementation](PROTOTYPE.md) and [verification status](STATUS.md).

## Ten feature areas

**Compound requests confirmed October 26, 2026:** the owner requested multiple tool operations in one message: multiple searches, multiple simultaneous timers, and especially timer creation plus web search in the same ask. The assistant should complete the requested parts together rather than requiring separate messages. Search content remains data, not permission to perform actions the user did not request.

### 1. Home device and companion app

MERLIN runs continuously on a home device with a display, such as an iPad or similar device. The companion app lets users communicate with MERLIN, configure it, share information, create schedules, and access their home remotely. The specific device, app platforms, and local/cloud architecture remain open; choose them with broad accessibility in mind.

Continuous availability does not authorize learning from ambient household conversations. The voice and privacy decisions below apply even while MERLIN is idle.

### 2. Voice and interface

**Wake-word activation is confirmed.** The exact wake phrase, detection implementation, and conversation-session behavior remain TBD. MERLIN should accept conversational voice commands, respond aloud, and require little or no touch for common tasks.

Use Meta APIs in the voice/assistant experience; the exact role and model routing are still to be defined. Speech recognition and speech synthesis are separate responsibilities. **Kokoro remains the tentative speech-output choice.**

Provide a clean, Jarvis-inspired interface that displays relevant information when useful and makes listening, processing, speaking, and action outcomes understandable.

**Conversational behavior confirmed October 26, 2026:** MERLIN should speak as the household's personal home assistant, helping with everyday tasks and useful recall. Ordinary replies should be warm, calm, concise, and practical: “Your timer is set for five minutes,” or the one clarification needed to proceed. Apply saved preferences quietly. Memory categories, implementation choices, tool names, model calls, and validation details belong in the testing inspector unless the user explicitly asks how the system works. Be truthful about an unavailable action or failed save without turning normal household conversation into developer troubleshooting.

**Character direction confirmed October 26, 2026:** the owner requested a robot character modeled in Blender using supplied robot images as visual references. Keep it **clean, cute, and simple**, with **a lighter shade of blue and rounded head and body forms**, a premium, AAA level of refinement comparable to Meta or Apple products, visible bottom lighting in a dark room, and **waving and jumping animations**. The head and body should avoid a square appearance. The owner's **latest material direction supersedes the original glossy request**: use **matte/satin surfaces with very little reflection**, gently brightening where light falls through ordinary diffuse shading. Retain the luminous eyes and sole lighting.

The screen must sit **flush within the head**, without a protruding face panel. **Cyan/blue face lighting should grade toward pale white**, retaining its color instead of washing out to pure white. Include **a small number of subtle panel seams on the head and torso**, following the references while keeping the design uncluttered. The owner's **latest proportion instruction restores the original design**, superseding the temporary request to widen and deepen the character after the result looked stretched. Keep the original width, depth, and height proportions in the room variant. The resulting model still needs the owner's visual review.

**Room and casual animation direction confirmed October 26, 2026:** frame **the whole scene in a landscape iPad-style composition**. The owner's **latest brightness instruction restores the original lighting**, superseding the intervening brighter-room experiments. Use the original portrait scene's lights, world illumination, exposure, and midnight floor tone in the new room. This is a composition choice, not approval of an iPad application or deployment platform; the initial scene uses a 4:3 landscape frame. Preserve the original character proportions and add casual, bored behavior: **walk from left to right while whistling; lean against the left wall and toss a ball against the right wall so it bounces off the floor and returns to the hand; lie in the middle with hands behind the head and nap**. These are requested visual character activities. Their timing or selection as live assistant behavior remains undecided. The original portrait assets remain available separately.

**Two-way activity transitions confirmed October 26, 2026:** the owner requested a shared ready pose **standing in the middle of the frame, facing ahead and ready to interact**, with a wave after returning. Return from the nap by springing up to stand; return from wall tossing and walking/whistling by running to the middle. Also animate departures from the central idle pose into each of those activities. Preserve the original character proportions and restored brightness. These animations establish visual entry and return behavior; live assistant triggers and interruption handling still need runtime integration.

**Expressive interactions confirmed October 26, 2026:** make the getting-up transition feel more natural while retaining the earlier request to spring up from the nap and return to the central ready pose. Use more purposeful face movement: glances, blinking, sleepy eyes, effort, relief, and a warm welcome. Add a right-edge interaction where MERLIN reaches, grips, and pulls a large white panel into approximately the right half of the frame with visible effort, then idles beside it. A separate tap breaks the panel into restrained pieces that disappear cleanly before MERLIN returns to the central ready pose. Also add fast, coherent transitions between the central robot and a full-frame dark face with a blue head-like outline and a seven-bar cyan mouth following the supplied reference, plus the reverse transition. The full-frame mode must read as the same character. Preserve the accepted proportions, matte finish, cyan gradient, and original room lighting. These are authored animation and presentation requests; panel content, speech-driven mouth motion, and live application triggers remain separate work.

The character and room work does not select an application framework, establish a complete assistant interface, or define an MVP. Character integration and its listening, processing, speaking, and automatic idle-state behavior remain TBD.

### 3. Background memory and personalization

**Memory design requested October 26, 2026:** the owner outlined four categories: conversation memory with access to all conversational details; automatically learned overall household facts/preferences/context; explicit general and domain-specific do/don't instructions; and named documents with brief catalog context whose contents are loaded when relevant. The goals are personal, accurate recall with focused token use. The local prototype now implements these categories; retaining the archive does not guarantee perfect model recall. See [memory research](MEMORY_RESEARCH.md) and [implementation](MEMORY.md).

**Responsiveness and rule interpretation confirmed during the research:** MERLIN must feel very fast and responsive. Interpret the meaning of standing instructions when saving them and record that interpretation clearly, rather than repeatedly resolving the same prose on every request. The owner also accepts agent-generated code as an option if useful, suggesting a Muse coding interface. The local implementation uses typed rule data handled by trusted JavaScript, normally interpreted by standard Meta Spark at save time. A narrow parser handles complete simple timer-default declarations and bare timer starts with a saved whole-duration default locally, with zero foreground model calls, only when the normal context selection finds no household facts, preferences, or guidance to interpret. Selected household context, broader phrasing, and compound requests continue through Meta; uncertain or unsupported wording is not guessed by the parser. The local route preserves evidence, conflict, action, persistence, and output checks. Background household learning can still run after its reply. No arbitrary generated code is evaluated. Production latency targets and broader rule types remain open. Clear saved meaning does not eliminate the need to apply it correctly to future outputs and actions.

Use **one shared household identity/profile initially**. Separate household-member profiles and speaker-specific identity are not part of the confirmed initial design.

Learn useful facts, preferences, communication style, and context in the background from **conversations directed at MERLIN**. Incorporate that information into an evolving household profile and use it in later interactions. Automatic learning is intended; requiring manual approval for every learned preference is not the requested experience.

The owner's privacy boundary is explicit: MERLIN learns through conversation and must not act as a spy. Do not turn this into passive surveillance or learning from unrelated room conversations. Wake-word detection must be distinguished from recording, retaining, uploading, or analyzing unrelated audio. For this local testing build, the owner chose local retention until deletion, with a clear-all button. Memory is inspectable, editable, and removable. Production retention and storage architecture remain open.

### 4. Explicit do and don't lists

Keep explicit standing instructions **separate from learned preferences**. Illustrative examples are “Always call me sir” in the do list and “Never say ‘cat’” in the don't list; these are product examples, not instructions already enabled for this household.

Every outgoing assistant response should pass a quick check against applicable standing instructions before delivery. Interpret instructions in context: **“Never mention cats” is a topic restriction; “Never say ‘cat’” is a restriction on wording.** Do not collapse both into a universal substring filter or assume identical intent.

Apply each instruction according to its wording, context, and intended output channel. The owner has not specified a universal spoken-only or all-screen-text rule. Clarify a materially ambiguous instruction instead of silently broadening it. The owner subsequently chose deterministic compiled rules where meaning can be represented precisely; irreducibly semantic guidance belongs in general information and is visibly marked as model guidance in the inspector, not guaranteed enforcement. Save conflicts without silently choosing a winner. The next request that needs a conflicting setting asks for clarification before the affected action; unrelated actions can proceed. Ask the concrete everyday choice instead of explaining internal conflict machinery.

**Timer defaults clarified October 26, 2026:** a request such as “My default timer is five minutes” is an enforceable whole-duration default, not general guidance. Store it as `timer_default_seconds: 300`, separate from `timer_default_unit` for requests such as “Use seconds unless I say otherwise.” The whole-duration default applies to “set me a timer”; the unit default applies to a number such as “set a timer for five.” A whole-duration default does not infer the unit of a different stated number. Supported whole-duration defaults are integers from 1 to 604800 seconds. Conflicting whole durations require a choice only when a request omits its duration; conflicting units require a choice only when a stated number omits its unit. An explicit duration and unit bypass those defaults for that request, without resolving saved conflicts or overriding other restrictions. If there is no usable default, ask for the missing duration or unit instead of inventing one.

### 5. Everyday assistant tools

- Play music through connected speakers and services, with Spotify as an example. Speaker brands and connection protocols remain TBD.
- Connect to a calendar; provider and the supported calendar operations remain TBD.
- Search the internet and summarize useful findings in response to requests.
- Support multiple simultaneous timers with descriptive labels.
- Generate quick images to help identify timers, such as a coffee image for a coffee timer.

The user should be able to request these tasks naturally through voice or the app. Providers and account access have not been selected or tested.

### 6. Home cameras and doorbell

Access authorized connected camera feeds through requests such as “Show me the living room.” Display a doorbell popup and let users check who is at the door, including remotely through the companion app. Ring is a candidate/example doorbell integration; hardware, provider support, and access methods are TBD.

### 7. The home device's own camera

Use the home device's camera to answer questions about what the user deliberately shows MERLIN. The requested examples include object identification, estimating food calories, helping with math homework, and assessing whether clothes match.

These remain incidental assistant features within the broader home product. The owner clarified that the hackathon's anti-project examples concern the overall project category and wants these examples retained in scope. Record that as the owner's interpretation, not a claim of organizer review. See the distinction in [HACKATHON.md](HACKATHON.md).

Camera hardware and the use of general Meta vision versus optional SAM segmentation remain undecided. An image model's capabilities do not establish access to a physical camera.

### 8. Schedules and home automation

Users create schedules through conversation or the app. Examples include turning off lights at a specified time, preheating the oven, or switching on the AC at 2 a.m. MERLIN uses tools to establish the schedule.

**Once established, automations execute through ordinary scheduling/event logic without another AI call for each run.** The saved schedule must preserve the requested actions, conditions, timing, and frequency. Persistent execution, time zones, cancellation, and duplicate-execution protection belong in implementation planning.

**Authorization follows the user's actual request.** A one-time request authorizes that occurrence; it must not become a recurring rule. An explicit recurring request authorizes the specified future executions, without asking for the same permission every time. Do not infer blanket ongoing permission from a one-time command. Clarify genuinely ambiguous targets, frequency, or conditions.

This applies to remote and location-triggered actions too. Device capabilities, physical limits, and supported safety controls still apply; the owner's recurrence decision does not authorize bypassing appliance controls. Do not impose a universal extra confirmation on every scheduled oven run solely because an earlier agent proposed one.

### 9. Custom commands and routines

**Conversational setup clarified October 26, 2026:** the owner reported repeated failures to save a routine already described in conversation. MERLIN should understand an informal definition, resolve “what we already said” from the user's earlier instructions, and treat a quoted answer during setup as the requested routine body. Save as soon as the name and actions are clear; do not require verbatim repetition or an extra confirmation. Ask only for genuinely missing or ambiguous details. Defining or looking up a routine does not run its actions. An explicitly separate request to save and run now can do both, in that order. Looking up a saved name should explain its actual steps, not search for a dictionary definition.

**Keyword behavior confirmed October 26, 2026:** save a user-defined name/aliases and a replacement request. Starting a routine acts as that saved request, with normal capability and standing-rule checks. Context matters: “I'm going to workout” can activate a saved workout routine, but “What should I eat before I workout?” must not. “Merlin goodnight” can activate a saved goodnight routine; a question about a good night of sleep must not. A close paraphrase such as going to exercise at the gym asks whether the user meant to start the saved routine. The prototype combines model interpretation with conservative full-utterance activation guards and a confirmation valid only for the next user reply. There are no preset routine actions.

Users define phrases that trigger multiple actions. **“Goodnight” is only an example phrase, with no fixed actions or required preset.** Do not assume it turns off lights, changes music, or adjusts appliances.

The user's workout example is “I'm going to the gym”: retrieve today's instructions from an uploaded training schedule, turn on gym lights, start a workout playlist, and set the AC cold. Preserve this as an illustrative user-configured routine, not an installed default or a specified temperature.

MERLIN should follow uploaded plans and schedules. If the user asks for workout advice, look up relevant information and respond to that request. Do not expand this into autonomous coaching, ongoing fitness-program generation, or personality analysis. Its focus remains practical household assistance.

### 10. Information sharing and remote control

Users can send documents, text, workout plans, and schedules through the companion app. MERLIN should use supplied information for relevant requests and routines.

Away from home, users should be able to switch off forgotten lights, request oven preheating, and view authorized cameras. With location access, support requests such as **“Preheat my oven when I'm five minutes from home.”** This is an arrival-time condition, not a timer started five minutes after the request. Location permission, ETA calculation, and provider choice remain TBD.

Preserve one-time versus recurring intent for arrival triggers as for other automations. A request for the current journey must not silently become a permanent rule for every return home. Remote authentication and device permissions are implementation decisions still to be made.

## Product boundaries and engineering expectations

The ten areas are **hackathon feature goals**, not a claim that all will ship or a finalized priority order. The owner has approved the text/search/timer test slice and local browser/Node.js harness above. A final MVP, demonstration sequence, production technology stack, and delivery commitment remain undecided. Ask before converting undecided choices or examples into requirements. Do not repeatedly reopen decisions the owner has already answered.

Keep memory, explicit standing instructions, and executable routines distinct. Preferences do not grant device permissions. Explicit instructions should not be silently overwritten by inferred preferences. Clear tool results should tell the user whether an action succeeded, failed, or remains uncertain.

Validate device targets and parameters and respect actual device capabilities. Keep microphone/camera activity visible and user-controlled. Keep private household data, audio, imagery, credentials, and location information out of the public repository; use synthetic public fixtures. Do not automatically choose Contributor model variants for private household data. These engineering expectations support the owner's stated privacy and control goals.

## Decisions still needed

- Home display/hardware, companion-app platforms, actual device inventory, and service providers, including calendar, music, cameras, and doorbell.
- App framework, device protocols/home hub, hosting, storage, authentication, and local/cloud split.
- Exact wake phrase, detection implementation, conversation-session behavior, and voice pipeline/model selection.
- Household permission management, production memory retention/storage, and audio/image policies beyond the confirmed local retention and privacy decisions.
- Additional rule handlers and ambiguous wording/channel handling; deterministic compilation, semantic guidance, and deferred conflict clarification are confirmed.
- Location access, ETA source, remote-access implementation, and specific device-supported controls.
- Initial demo priorities, real hardware versus labeled simulations, visual review of the first Blender character, and its integration and assistant-state behavior.
- Team, Representative, competition track, final theme, complete Official Rules/acceptance, license, and attribution.

**TBD means undecided.** Broad accessibility is the direction; it is not approval to choose a specific platform, claim universal integration support, or promise an untested device capability.

## Owner's development workflow

**Commit and push code and other project changes to GitHub by default, unless the owner explicitly says not to.** Ask clarifying questions before making unresolved product assumptions; record confirmed answers here so future agents do not need the original conversation. [AGENTS.md](../AGENTS.md) defines the workflow; [STATUS.md](STATUS.md) tracks actual progress.
