# MERLIN companion orchestration

Planned October 27, 2026, before implementation. This combines the existing local assistant, voice session, and authored 3D character; it does not select production hardware or a new device provider.

## Animation cleanup — November 3, 2026

The owner asked to slow the animations down a bit, to make walking continuous (walk to one side, then back to the other, until MERLIN is called), and for an obvious lightbulb thinking face that is made now but not used yet.

- **Back-and-forth walking.** Two new authored clips, `WalkTurnAtRight` and `WalkTurnAtLeft` (22 frames each), hop-pivot MERLIN at the wall through a forward-facing pose. They are routes from each walk's held endpoint straight into the opposite walk, so `walkRest → walkReverse` no longer runs to the middle, waves and walks back out. The companion asks the character for `go('walk', {patrol: true})`. The shared driver (`character.js`) then turns at each wall after every pass and keeps going until another destination is requested. The orchestrator keeps the walk running through its 30-second ambient ticks; idle activities now alternate a back-and-forth walk with tossing, and music still switches to dancing. The studio's one-pass walks are unchanged, and a plain `go('walk')` still holds its endpoint.
- **No jumping walls.** Each walk's exits (to the face, thinking, ready, or the other walk) are authored to start at the far wall. If MERLIN was called while still walking out to start a pass, or just after a turn, the controller used to play that exit from the near wall, jumping him across the room. The route planner (`motion-routes.js`) now leaves a one-way walk only through its finished pass, for both playback and the clock's look-ahead.
- **Slower conversation motion.** Conversation transitions play at 2.5× instead of 4×. A walk or toss finishing its cycle before a conversation also uses that pace, instead of up to eight seconds at normal speed, so the face arrives sooner and the 2.5-second safety snap to the speaking pose has more room. Idle loops keep their authored speed.
- **Lightbulb thinking face (asset only).** New face state `idea` (`FaceToIdea`, `FaceIdea`, `IdeaToFace`) under `face`, authored in Blender like the search face: the display eyes fold away and two lightbulbs appear. Each 4-second loop ponders (flickering filaments, a sway and a slow "hmm" in the mouth), then the bulbs light with rays and a bigger smile, then dim. It is in `merlin-states.glb` and the studio. **The companion does not use it yet:** thinking still shows `faceThink`, per the owner's decision. To use it later, return `'idea'` where `thinkingPose()`/`begin()` choose `faceThink` in `orchestrator.js`, add it to `faceStates`, and add it to the face checks in `app.js`.

Checks are listed in [STATUS.md](STATUS.md#animation-cleanup--november-3-2026).

## Home display: `/companionfull/` — November 3, 2026

The owner asked for `http://127.0.0.1:3000/companionfull/` to show only MERLIN, as the shipped iPad version of the demo. Their requirements:
- The screen shows only the robot's stage and whatever panels he brings out.
- Voice turns on automatically.
- There is no typing.
- Acknowledgments and the microphone are always on.
- There is no test-speaker button.
- Everything Activity & services offered moves onto panels. Closing a timer, for example, is a tap on its panel.
- Touch targets are as large as they can sensibly be, using Google Home as the reference.

**How it works.** The server serves the same companion page with `data-mode="full"` and iPad web-app meta tags (`fullDisplay` in `src/companion.js`). It is the same assistant, memory and orchestration, not a fork.
- **Layout.** CSS hides everything except the 4:3 stage, which fills the screen inside the safe areas. Text selection, the iOS callout, zoom and overscroll are off.
- **Speech settings.** Read-aloud and acknowledgments are forced on.
- **Voice.** It starts on load when the browser allows sound without a tap. Otherwise the whole screen becomes one "Tap to start MERLIN" button, because iPad Safari and Chrome need one tap before a page may play sound. The microphone permission itself is remembered by the browser. A real microphone problem shows a smaller notice beside the mic button that leaves the panels usable. Voice restarts when the page becomes visible again.
- **Panels.** Regular panels are painted in touch mode (`paintPanel(..., {touch: true})` and `panelActions(state, {touch: true})`): a large primary button and a close X on every panel. Only real actions are drawn:
  - Timer: Cancel, which cancels and clears in one tap; a finished timer gets Dismiss.
  - Lights, oven and speaker: Turn on / Turn off, through the new `POST /api/home/control` with the same rules, hub and code-written receipt as speech.
  - Music: previous, play/pause and next.
  - Routines and schedules: only the close X, since they run by voice.

  The page lays real buttons over each painted control on both sides, with a minimum of 48 CSS pixels. Both big screens (connections and the Play screen) get a large close X.
- **Floating cards.** On the home display, tapping a timer or music card brings out its full panel. The music card's own button pauses and resumes.
- **Camera.** The camera consent buttons and "Turn camera off" become large buttons over the stage. Saying "yes" also works.
- **Stopping a reply.** Tapping MERLIN while he is talking stops the reply.

**Agent decisions, not owner-confirmed:**
- A small microphone button stays in the bottom-left corner. The owner's privacy rules require microphone use to stay visible and under the household's control, so it shows the mic state and mutes or unmutes with one tap.
- The one-tap start appears only when the browser requires it.
- Cancelling a timer clears it without a second tap.
- Devices toggle only between on and off from a tap.
- Routines are never run from a panel button.
- Tap-to-stop on MERLIN.
- Floating cards open panels.

**Limits.**
- The server still listens only on this computer. An iPad cannot open it without hosting work, see [HOSTING.md](HOSTING.md). iPad Safari also gives the microphone only to secure pages (HTTPS or localhost), so a plain `http://` address on the home network will not hear. Until then, run the home display full screen on this Mac, or mirror it.
- Checked at iPad landscape size (1180 × 820) in the built-in browser, which blocks microphones. So voice start-up was seen only as the blocked-microphone notice, not as working listening.
- Not yet tried on a physical iPad, in Safari, or with real touch.

## Always answering and three-part search answers — November 3, 2026

**Why MERLIN went quiet.** Two causes were found on the owner's live server. In voice mode, any speech the local detector heard while a request was working cancelled that request on the spot, before anyone knew whether it was a real request. That covered a cough, the television, or MERLIN's own filler leaking from the speaker. If the speech then turned out to be nothing, nothing replaced the cancelled request. Separately, the three-minute conversation limit cancelled whatever was in progress. One of the owner's requests ("make sure the pizza places are all kosher") was cut off by one of these 17.6 seconds in.

**Always answer (`src/voice/session.js`).** Speech over a request that is working starts a capture without cancelling anything. MERLIN's answer waits, held before it is shown or spoken, until that capture is understood:
- A brief sound, an empty transcript, or MERLIN's own words (a clip or the lookup line, while one was audible) means MERLIN goes back to thinking and the original answer arrives as usual.
- A real new request replaces the old one, as speaking over MERLIN always has, but only once its words are known.
- Continuing to talk during that transcription is heard in full before deciding.
- At the conversation time limit, a request already heard still answers and is spoken in full; then the conversation ends, and no new speech is uploaded after the limit.
- Speaking over MERLIN's spoken reply still interrupts it at once.

**Three parts for a search.** When search is enabled for a request (a required lookup, `prepare_web_search`, or a recovered made-up search name), the assistant starts a second, small Meta call (`MetaClient.lookupLine`) alongside the main one. It writes one sentence saying what MERLIN is looking up, using the request, the selected memory and the last few things said in the conversation. `checkedLookupLine` keeps it only if it is short and says it is looking something up. It must also contain no question, no colon and no standalone number (a number inside a name, like PS5, is fine), pass the saved rules unchanged, and pass the personality check. Otherwise no line is said, and the inspector records `lookup_line_skipped`. Plain and calm style, and rules that fix a prefix, suffix or address, never get a line.

The page learns a line exists from a `lookup_line` progress event, which carries no words. It fetches the audio from `POST /api/companion/lookup-speech`, which answers 409 once the request is finished, then queues it in the clip coordinator on the filler player. The coordinator plays the clip, then the line, then lets the answer through. A line that has not started when the answer is known is dropped; a started one finishes. Stop, a new turn or hiding the page ends both. The server's echo check includes recent lines, so MERLIN never takes its own line for a request. Speech requests are queued (`src/voice/speech-queue.js`), because the local voice refuses a second request while busy and could otherwise fail the answer.

**Measured live (real Meta, throwaway storage, typed channel, synthetic text):** five search questions all got a line, 1.5–2.4 s after the request (5.2 s when the model chose to search on its own). Their answers took 7–12 s. Examples: "Checking the weather in Brooklyn for you now.", "Looking up kosher pizza places in Brooklyn for you.", "Checking Trader Joe's closing time in Brooklyn for you." The line costs one extra small Meta call per search request.

## Prerecorded acknowledgments — November 2, 2026

**Owner request:** when MERLIN accepts a request, it quickly says a short recorded line while the real work runs. This reduces the felt wait, not the model's actual processing time. **Owner requirement:** a clip that has started always finishes its whole sentence; it must never sound like “Let me work on tha—your answer is…”.

| Step | What happens |
| --- | --- |
| Request accepted | The assistant starts immediately. A voice turn arms the timer on its finalized transcript, a typed turn on submit. No wake word, partial, ambient, or empty speech is acknowledged. |
| Eligibility | The turn's existing `received` progress event carries the allowed clip IDs, checked at that moment against current rules and settings. Voice receives it over the socket, typed through its existing progress poll. There is no new request. |
| One-second wait (`MERLIN_ACK_GRACE_MS`, default 1000) | The assistant is already working throughout. If the deadline passes, the request is still pending, speech output is on, and a cached clip is allowed, one plays. Otherwise nothing does. |
| Answer known first | An unstarted clip is skipped, including on a terminal error. |
| Answer known during the clip | Its text shows immediately and final speech starts generating at once, on the server for voice and in parallel with the character's move for typed. That audio waits for the clip's `ended` event, then starts directly. |
| Clip ends with work pending | The character returns to thinking. The request, follow-up state, and timers are untouched. |
| Person acts | Speech, Stop, a new turn, hiding the page, turning the microphone off, or disabling the feature stops the clip at once and invalidates its callbacks. Apart from disabling the feature, these also cancel the request under the existing rules. |

**Where it lives.** `public/companion/acknowledgments.js` holds the one coordinator that owns the race between starting a clip and the answer being ready, plus a dedicated player on its own `<audio id="ack-audio">`, so a filler can never be mistaken for the reply. Every path that plays real speech (voice replies, typed replies on either path, timer alerts) awaits `beforeAnswer()` first. `src/acknowledgments.js` holds the exact lines, the eligibility check, and the asset format. `VoiceSession.announce()` is not used: it invalidates active work. The clip's state is separate from the turn: the orchestrator's `acknowledgment()` only borrows a speaking pose, because mouth motion runs only in the `face` and body states, and it leaves the phase, panels, and deadlines alone. With reduced motion there are no pose changes.

**Which clips are allowed.** All checks are local and fail closed, so the result is a smaller set or silence:

- `prepareSpokenReply` must return the recorded words unchanged. A required prefix, suffix, or `address_as` rule would change them, so the unchanged recording is not compliant, and these lines then all stay silent. Word bans, phrase bans, and conflicts remove what they apply to.
- `checkPersonalityDraft` removes repeats of a recent opening, and would remove any line with an unchosen address or a retired old-fashioned opener. Since November 3, 2026 no line says “mister,” so every address setting keeps all five.
- Plain style and calm turns get silence, because all five lines are optional ceremony (agent decision).
- **Any saved general guidance silences every clip**, as does a saved preference about wording. These cannot be checked without a model call (agent decision, following the owner's rule to skip rather than bypass). The wording test matches whole words only, so “gym speakers” or “responsible” does not count. It also ignores the person's own “I say” or “we say”, as in a routine trigger, but not “don't say” (fixed November 3, 2026, after one such preference silenced every clip).
- A v2 conversation note (a correction or “tonight” statement, or a fact saved in this conversation) silences the clips for that conversation only when it reads as being about speech, by the same local test. A note this code cannot read, guidance, or an unknown kind still silences them. Before November 3, every note did, so ordinary words like “today” or “don't” kept the full-screen display silent for the rest of a conversation.
- Greetings, thanks, and requests about how MERLIN talks get silence, since “I'll work on that right now” would be wrong for them (agent decision).

**Controls.** The **Acknowledge requests aloud** checkbox persists only that preference, in `localStorage`. Typed requests also need **Read typed replies aloud**, so muted text chat stays silent. A muted or zero-volume reply player counts as speech output off. Autoplay rejection or a missing or corrupt file is a silent skip, with no extra button or prompt.

**Variety and timing.** A shuffle bag over the allowed set never repeats a line back to back, and a single eligible line can repeat. The 3-second cooldown (`MERLIN_ACK_COOLDOWN_MS`) runs between clips. A watchdog at the clip's length plus four seconds releases only a player that has stopped advancing. These are tuning values, not measured promises.

**Echo.** The microphone stays on, and the clip uses the same browser echo cancellation as replies. As a backstop, the browser tells the session when a clip is audible, and a transcript that is essentially a recorded line, captured during that window plus one second, starts no turn. A false barge-in from speaker leakage still cancels the running request under the existing interruption rule, and this has not been tested in a real room.

**Clips.** `npm run prepare:acknowledgments` records all five once with the configured voice, trims edge silence, matches speech levels, and writes `public/companion/acknowledgments/` with a manifest of ID, exact text, path, generation settings, measured duration, and SHA-256. `--check` validates without generating and `--force` records again. The browser verifies each file's hash before using it. If the voice is not set up, the script says so and generates nothing. The files are generic generated speech from Apache-2.0 Kokoro with no household data, so they are committed.

## Connection touchscreen plan — October 31, 2026

> **Superseded in part, November 1, 2026.** The simulated "preview connections" described below no longer exist: `src/connections.js`, `data/connections.json`, `/api/connections*` and every Connect/Disconnect preview button were removed. The screen now shows **real** status from the shared connector hub ([CONNECTORS.md](CONNECTORS.md)): a service is Connected only after MERLIN contacted it and it accepted the credentials. Tiles say Connected, Setup unfinished, Needs attention, Set up, Through Home Assistant, or Not supported; setup views show the live status line, what you need, what MERLIN can do afterward and what is still missing. Credentials are never typed on the big screen: its **Set up** buttons open the Connection Center page (`/connections/#<id>`) in a normal tab, while **Check connection** and **Disconnect** work on the screen itself. A category already covered by a verified connector no longer reopens the screen; the device tools handle it. The paragraphs below are kept as the original plan and design history.

Written before implementation. **Owner request (October 31):** when a user asks how to connect something, or asks for something they never connected, MERLIN pulls down the big panel and shows the add-on connection options on it as a touchscreen the user can tap. This supersedes the earlier rule that the home surface has no connection or setup UI; the separate Connection Center stays as the full directory.

Owner decisions: trigger on connection questions and on requests for an unconnected capability; use the big (ceiling) panel; make it tappable. Agent interpretation, not owner-confirmed: “the mobile app API for home appliances” means the Connection Center catalog (45 researched routes, setup difficulty, guides); connections stay **simulated previews**, exactly as in the Connection Center, except Spotify, whose real status comes from the existing Spotify service.

- **Triggers (local, no model call):** `src/connection-intents.js` classifies a message as *how-to* (“how do I connect my Ring”), *browse* (“what can you connect to”), or an *unconnected request* (“turn on the lights”, “preheat the oven”, “show me the front door”, “play some music” with Spotify disconnected). A request whose category already has a preview connection does not reopen the panel; MERLIN answers truthfully that previews do not control devices. The model can also open the panel with a `show_connections` tool for phrasing the classifier misses. Routine setup, thanks, and declined mentions never trigger it.
- **Panel:** a new `connections` panel on the existing ceiling screen. The robot stands in front, so tiles sit in the free top band and the two side columns, never behind MERLIN (footprint measured from the authored ceiling clips). It reflows to the card's aspect. Views: category chips, paged tiles (name, setup difficulty, Connected/Not connected), and a setup view (requirements, step titles, limits, Connect / Disconnect / official guide). The texture is display-only, so real transparent `<button>` elements sit exactly over the painted targets (the technique the panel gallery already uses), giving pointer, keyboard, focus and screen-reader access. They appear only once the ceiling pose has settled, and are computed from the screen mesh's projected rectangle, which is exact under the authored orthographic camera.
- **State:** preview connections are catalog IDs in a new server-side `data/connections.json` (ignored, owner-only), so the assistant can tell what was never connected. Clear-all memory does not remove them, like timers. Spotify is not simulated: its tile shows the real connection and links to the existing Spotify setup.
- **Presentation:** the panel is a retained scene record. Face conversation hides it and restores it, “Close panel” dismisses it, and a displaced timer or music panel moves to the free side. Replies stay in the body next to the open panel. No device action is ever authorized by a preview connection.
- **Verification targets:** classifier table, store and API validation, panel layout (no target overlaps the robot zone or leaves the card), the assistant path with a scripted model, orchestrator behavior, and desktop/phone browser checks with real clicks.

**Implemented October 31, 2026** (checks in [STATUS.md](STATUS.md)). Where it lives: `src/connection-intents.js` (triggers), `src/connections.js` and `/api/connections*` (preview store), `public/companion/connections-panel.js` (data and tap reducer), `assets/merlin-character/viewer/panels/connections.js` (layout, painter, tap targets), `character.screenGeometry()` (where the card sits), and the tap layer in `public/companion/app.js`.

Known limits: the painted text is a texture, so on a phone-width screen it is small (tap targets are grown to at least 30 CSS pixels, but the artwork is not). A finishing timer or music change does not reopen over the big screen; it stays in Activity and the floating cards until the screen is closed. A displaced second physical panel is dropped from the screen slots (the timer or music stays in Activity). Docking left/right is disabled for this screen because its tap geometry is measured only for the ceiling card. Preview connections are separate from the standalone Connection Center, which keeps its own browser-local list.

## Floating activities and face-corner plan — October 27, 2026

Written before this integration. The owner now explicitly requests the new floating timer/music assets for multiple activities in body mode and visible corner panels during face conversation. This supersedes the earlier requirement to hide all action information in face mode.

- One timer can retain its physical body screen. Multiple timers, or timers plus current Spotify playback, use the compact floating cards with MERLIN in a clear body pose. Other service/detail panels retain their existing behavior.
- Face conversation keeps the same live timer/music identities in one small lower-right rail, outside the eyes and mouth. Compact rows, bounded height, and scrolling prevent a growing activity list from covering MERLIN. Body mode expands the cards in the lower-left or lower-right corner according to the clock and character geometry; narrow layouts keep them clear of the central robot.
- Data comes from real timer records and the existing local Spotify snapshot. Countdown rendering never invents completion; Spotify metadata stays in the local UI. A disconnected service produces no imaginary playback. No connection/setup UI or new execution path is introduced.
- Physical timer/music screens yield to floating presentation without a destructive dismissal transition; their logical identities remain available. A face excursion changes presentation only. Explicit timer cancellation/dismissal remains in Activity; compact face cards are read-only to avoid accidental actions while talking.
- Reuse the existing ticker and layout subscription. Update text only when data changes; no extra render loop, audio work, or provider calls. Preserve reduced motion, hidden-page sleep, and rendering caps. The standalone studio keeps its optional overlay behavior.

Verification targets multiple live timers, timer plus synthetic connected music, face/body continuity, countdown updates, overflow, cancellation/completion/removal, disconnected music, desktop/mobile placement, and reduced motion. Public screenshots use synthetic records only.

## Retained-scene redesign plan — October 27, 2026

Written before this follow-up implementation, now implemented. The owner explicitly removes sweeping and requests orchestration using the completed 113-clip asset, keeping timers and other content intact through conversation. At this stage, the full-face/no-side-popup requirement remained; the floating-activity decision above now supersedes it for timer/music summaries. Short action confirmations beside their panels and general conversation in full face are the implemented, tunable reply policy. This is an agent implementation choice, not an additional confirmed owner decision.

- **Focal sequence:** a real result introduces a physical screen; MERLIN can think and speak in that exact standing, seated, paired, or ceiling arrangement. A face excursion covers the screens and restores the same arrangement and identities afterward.
- **Continuity:** confirmed panels are persistent scene records, separate from transient progress and speech. Pending, failed, interrupted, repeated, or unrelated requests cannot overwrite a confirmed timer. Two open panels stay pinned; additional automatic results remain in Activity. Explicit selection can change a displayed item without canceling its underlying action. Initial live timer state restores up to two running timers. Clearing conversation does not clear timers or their panels.
- **Transitions:** preserve left/right/both/seatedLeft/seatedRight/ceiling context. Use contextual thought clips. Use direct face entry/return and selective paired dismissal. If changing a retained layout has no non-destructive authored route, cover it with the full face, change the remembered layout while covered, then reveal it using the target's authored return. Dismissal clips are reserved for explicit close controls. Body and face choices never trigger backend work.
- **Speech:** pin one destination for each accepted reply/alert across text completion, typed HTTP audio, wake-session audio, and manual playback. Capture never waits for animation. Keep existing interruption/revision guards and the bounded settling fallback. Completed timer alerts defer during conversation and keep their physical screen afterward.
- **Large presentation:** provide an explicit enlarge action for a single panel using the ceiling state, with left/right docking that moves the same logical content and control identity. Do not enlarge over a second open panel. General conversation temporarily hides it, then restores it. No automatic large-screen takeover for unrelated work.
- **Quiet:** return to retained panels after follow-up. No walking, tossing, or dance that dismisses open panels. With no panels, alternate a back-and-forth walk (it keeps going until MERLIN is called) and ball tossing; confirmed music can use dance. Remove the procedural sweep and broom entirely.
- **Budget and access:** preserve the 30 fps/pixel/shadow limits, hidden-page sleep, changed-data texture updates, and reduced-motion static poses. Face mode has no detached side panels. Keep visible microphone state and explicit Cancel timer versus Close panel controls.

Verification covers a running timer through conversation/quiet, two timers plus pending/interrupted work, repeated results for one timer, selective paired dismissal, exact contextual thought/face returns, ceiling ownership, all speech paths, reload restoration, hidden/reduced motion, and desktop/mobile inspection. Completed checks are recorded in STATUS.md. No physical device or microphone-room support is inferred from these checks.

## Owner decisions

The character is the primary home interface. Full-face mode listens and handles general conversation; body mode starts actions and carries their panels. The redesign uses body speech for short action confirmations as an implementation choice. The latest owner correction keeps live timer/music summaries in a compact face corner and uses floating cards for multiple activities in body mode. Large physical action panels stay hidden in face mode. Their independent content remains retained for body mode; a timer finishing can bring the body back and speak there. The completed two-screen, seated, ceiling, and direct face animations keep left panel, right panel, and conversation presence independent. Sweeping is removed. Walking in either direction and ball tossing are waiting activities only while no panels are open. The owner later (October 31) asked for connection options on the large screen, so this surface now also shows the [connection touchscreen](#connection-touchscreen-plan--october-31-2026) for browsing and previewing connections; account sign-in, credentials, and real appliance pairing still do not happen here. Otherwise it shows connected and disconnected states and controls only for capabilities actually available.

## Interaction sequence

| Trigger | Presentation | Completion / interruption |
| --- | --- | --- |
| Initial load or sustained quiet | Restore real timer activity; multiple activities use floating cards, a single retained timer uses its physical panel. With no activities or panels, centered body and casual idles | New directed conversation takes priority; quiet never dismisses a timer |
| Explicitly enable microphone | Visible microphone state; local MERLIN keyword detection in standby | Off, hidden page, closed page, or transport failure stops capture |
| Wake / speaking / typed composition | Full face, attentive listening, live timer/music summaries in the lower-right corner | Endpoint starts the existing memory/rule/assistant path; idle audio never enters it |
| Foreground reasoning and memory retrieval | Thinking face after listening; contextual body thought during an action beside retained panels | No memory categories, evidence, or model counts in ordinary UI |
| Actual permitted web-search work | Searching face | Return to thought or the next action; citations remain available with the answer |
| Validated timer / music / routine action | Contextual body thought while pending; install only confirmed result panels | Progress/errors never overwrite pinned content; animation never executes the action |
| Reply ready | Short action confirmation beside the accepted panel layout; general reply in full face | Pin the chosen pose for every audio path; text remains available if synthesis/playback fails |
| Person interrupts | Stop stale speech; start the direct face-cover route while capture begins immediately | Completed actions and panels remain. Do not replay prior utterance after execution has started |
| Follow-up silence | Keep the reply’s body/face pose attentive for the existing quiet window | Then restore the retained body layout; goodbye/thanks are ordinary words |
| Timer expires | Show actual finished timer in body when conversation is idle; speak its checked local announcement when voice is enabled; defer during conversation | Do not interrupt the person's speech or re-execute the timer |
| Background learning | No foreground animation change | Existing extraction, evidence, persistence and deletion remain authoritative |

## Motion and interface contract

Extend the established rounded matte-blue character, midnight scene, cyan face, white 5:6 action panels, and native control typography. The character occupies the full main landscape stage in face mode; a compact caption and input area supports voice and typing. A secondary expandable activity area contains real timers, service status, and controls. No OAuth, account fields, appliance pairing, or setup wizard appears here. Keep the old testing interface and character studio available separately.

Transitions normally use authored routes. Conversation urgency overrides long casual cycles and panel choreography so the person is never made to wait for a ball catch or a seven-second screen pull before being heard. Reduced motion uses the correct static face/body state and suppresses casual movement. Clock visibility follows actual full-face presentation. The earlier procedural sweep and broom are removed; no sweep is advertised or selected.

Implementation timing choices (tunable, not new owner requirements): normal foreground transitions play at up to 2.5× their authored pace (`TRANSITION_PACE` in `public/companion/app.js`; it was 4× until the owner asked for slower motion on November 3, 2026), and a walk or toss finishing its cycle before a conversation uses the same pace, while loops keep their original speed; start casual idle after 20 seconds, rotate activities without repeating the last one, and show an action result for 400 ms before replying; a stalled presentation yields to the correct static pose after 2.5 seconds. Speech capture and backend execution never wait for animation. The latest active conversation owns the foreground; stale progress/audio cannot take it back. Retain independent left/right panel records. Two results can use the authored `both` destination when available. Entering face mode hides large physical panels and their controls without clearing either record. Timer/music summaries remain in the compact corner rail. Closing one panel cannot close the other or cancel its underlying action. An explicit layout change can stop pending reply playback so stale speech cannot restore the prior layout. All current timer/music activities can appear in the scrolling floating rail. Other automatic results remain in Activity when both physical slots are occupied. Exact authored destinations and direct routes come from `states.json`, including its body-context return paths, rather than hard-coded inverse clips. When dual-screen clips are not yet available, body mode shows the most recently focused physical screen while retaining both records. No animation is described as baked into the GLB until it actually exists.

## Service truth and execution

Use one assistant server and one set of memory, routine, timer, and request-ledger stores. Both typed and voice requests enter the same checked turn runner. A small allowlisted progress projection drives presentation; raw memory traces and provider metadata do not. Every action stays behind the existing capability/rule/argument checks. A request ID protects retries; canceling presentation does not undo completed work.

Timers and routine memory use their existing real stores. Spotify uses the existing connected-account adapter, through typing and direct controls only; retrieved metadata is local UI data and never goes to Meta, transcripts, learning, speech, or traces. No dance or playing state is inferred from an accepted command: playback state must confirm it. Lights, ovens, schedules, and home cameras have no live adapter in this checkout. The device's own camera is a separate capability that does work, and uses the `camera` face state during a look; see [MERLIN's camera](CAMERA.md). Their panels must say unavailable/not connected, never treat the separate Connection Center's simulated selections as evidence of live support. Future adapters must supply validated capabilities and observed outcomes before enabling controls; provider and hardware choices remain TBD.

## Verification contract

Exercise state priorities, idle rotation, rapid local timer receipts, compound actions, interruption and stale events, unavailable connections, timer completion, reduced motion, and actual face-before-playback ordering. Preserve existing assistant/voice tests. Use isolated synthetic stores for backend/browser tests; do not alter household memory or control real devices during verification. Inspect the combined surface at desktop and mobile sizes, including keyboard controls and loading/error states. Record completed checks and remaining limitations in STATUS.md.

## Run the combined surface

Run `npm ci`, configure the existing local `.env`, then `npm start` and open [MERLIN at home](http://127.0.0.1:3000/companion/). The old test and memory surface remains at `/`. For voice, run `npm run setup:voice` once; the assistant server now hosts the same-origin local wake transport and Fenrir worker. The separate `npm run voice` echo lab remains unchanged.

Microphone access is off until **Enable microphone**. **Read typed replies aloud** starts enabled, remembers explicit changes in this browser, and also enables microphone-off timer announcements. Mic-off, page hiding/exit, and failed transport release audio capture. A finished timer may speak without a model call only from its actual completed server record after current output checks. Voice alerts are deduplicated within the active connection and defer while busy; this is an open-page notification, not an operating-system alarm or delivery guarantee while asleep/offline.

Direct voice transcripts and assistant replies now enter the existing local conversation archive and background learning, unlike the separate echo lab. Raw audio remains transient. Clearing this conversation removes its transcript; full household memory deletion remains in the existing memory controls and invalidates cached speech. The same checked assistant text is displayed/spoken; no new spoken-only rule language is claimed. Replies over the voice limit remain on screen. Browser autoplay restrictions expose a manual audio player.

## Runtime contract for future animation and device work

`public/companion/orchestrator.js` decides foreground priority and stores two physical panel records; it executes no tools. `floating-activities.js` projects real timers and local Spotify state into stable activity identities and chooses a physical or floating presentation. `character.js` accepts `go(destination, {urgent, pace, preservePanels, dismiss, restorePanels})`, independent `showPanel(type, dataOrCallback, side, {navigate:false})`, `updatePanel(data, side)`, `clearPanel(side)`, `capabilities`, and cancellation-aware `whenSettled`. The animation controller consumes the exported state graph. Add new states/routes to the authored manifest rather than making the model select arbitrary clip names. The companion hides physical panel geometry during face presentation without changing action identity or execution; `SceneOverlays` retains compact timer/music summaries. `restorePanels:false` selects an exact neutral body/thinking pose for floating work, using a face cover instead of destroying a carried screen.

The shared turn runner emits allowlisted foreground stages. Timer/routine presentation records are projected from actual results, independently of private diagnostic traces. Search anticipation starts only after the checked search gate; the current nonstreaming Meta adapter reports actual native-search completion when the response arrives. Spotify status/metadata is read directly by the local player UI. Lights/ovens remain disconnected until a real scoped adapter is added; the UI must never call mock Connection Center state an authorization.

Current limitations: visual walk/whistle is silent; speech expressions react to playback activity rather than phoneme alignment. No actual microphone-room test, connected Spotify playback, physical appliance, camera, or operating-system notification has been verified by this task. The local 4:3 browser composition is not a production hardware commitment.

## Audio and rendering follow-up

The owner reported absent listening/speech and excessive resource use. The embedded browser denied microphone access during reproduction; the application cannot grant itself browser/OS permission. It now distinguishes permission waiting from local detector startup, explains recovery, and provides a checked local Fenrir **Test speaker** with no microphone or model call. Typed speech works through the existing wake session when enabled; the server accepts only stored, currently checked replies. Audio is primed silently on the explicit user gesture, with manual playback fallback.

Rendering is budgeted at 30 fps, at most 1024 × 768 internal pixels and DPR 1.25, with smaller shadow/bloom buffers. Hidden pages stop rendering; reduced-motion scenes render only on changes. Hidden model meshes and unchanged panel textures no longer consume the same per-frame work. Background timer DOM updates are skipped when state is unchanged. These are implementation budgets, not a guaranteed frame rate or a hardware benchmark.
