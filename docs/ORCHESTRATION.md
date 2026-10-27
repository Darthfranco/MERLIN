# MERLIN companion orchestration

Planned October 27, 2026, before implementation. This combines the existing local assistant, voice session, and authored 3D character; it does not select production hardware or a new device provider.

## Owner decisions

The character is the primary home interface. Full-face mode listens and replies; body mode starts actions and carries their panels. The owner clarified that action panels remain visible when MERLIN returns to the face; a timer finishing can bring the body back and speak there. The owner is adding two-screen and direct left/right-to-face animations, so left panel, right panel, and conversation presence must remain independent. Waiting uses casual activities including sweeping, walking/whistling, and ball tossing. Appliance and Spotify connection setup belongs to a separate application. This surface shows connected and disconnected states and controls only for capabilities actually available.

## Interaction sequence

| Trigger | Presentation | Completion / interruption |
| --- | --- | --- |
| Initial load or sustained quiet | Centered body, local scene clock; alternate casual idles after a quiet interval | New directed conversation takes priority immediately |
| Explicitly enable microphone | Visible microphone state; local MERLIN keyword detection in standby | Off, hidden page, closed page, or transport failure stops capture |
| Wake / speaking / typed composition | Full face, attentive listening | Endpoint starts the existing memory/rule/assistant path; idle audio never enters it |
| Foreground reasoning and memory retrieval | Thinking face; simple “Thinking…” status | No memory categories, evidence, or model counts in ordinary UI |
| Actual permitted web-search work | Searching face | Return to thought or the next action; citations remain available with the answer |
| Validated timer / music / routine action | Body with the corresponding panel; pending until an actual result | Show confirmed result, failure, or unavailable state; animation never executes the action |
| Reply ready | Finish a brief action presentation, then full face beside retained live action panels and checked reply | Voice playback waits for face readiness; text remains available if synthesis/playback fails |
| Person interrupts | Stop stale speech; full face immediately; cancel remaining foreground work | Completed actions remain real. Do not replay prior utterance after execution has started |
| Follow-up silence | Keep face attentive for the existing 10-second quiet window, 15 seconds after interruption/late continuation | Then body standby; goodbye/thanks are ordinary words |
| Timer expires | Show actual finished timer in body when conversation is idle; speak its checked local announcement when voice is enabled; defer during conversation | Do not interrupt the person's speech or re-execute the timer |
| Background learning | No foreground animation change | Existing extraction, evidence, persistence and deletion remain authoritative |

## Motion and interface contract

Extend the established rounded matte-blue character, midnight scene, cyan face, white 5:6 action panels, and native control typography. The character occupies the main landscape stage; a compact caption and input area supports voice and typing. A secondary expandable activity area contains real timers, service status, and controls. No OAuth, account fields, appliance pairing, or setup wizard appears here. Keep the old testing interface and character studio available separately.

Transitions normally use authored routes. Conversation urgency overrides long casual cycles and panel choreography so the person is never made to wait for a ball catch or a seven-second screen pull before being heard. Reduced motion uses the correct static face/body state and suppresses casual movement. Clock visibility follows actual full-face presentation. The new sweep is a browser-authored movement and prop because the existing GLB has no sweep clip; do not claim it exists in Blender.

Implementation timing choices (tunable, not new owner requirements): normal foreground transitions play at up to 4× their authored pace, while loops keep their original speed; start casual idle after 20 seconds, rotate activities without repeating the last one, and show an action result briefly before replying. Speech capture and backend execution never wait for animation. The latest active conversation owns the foreground; stale progress/audio cannot take it back. Retain independent left/right panel records. Two results can use the authored `both` destination when available. Entering face mode keeps both live panels in matching DOM canvases alongside the face; these are the same painters as the physical textures. Closing one panel cannot close the other or end a conversation. More than two results remain in Activity; the foreground retains the two latest. Exact authored destinations and direct routes come from `states.json`, including its body-context return paths, rather than hard-coded inverse clips. When a new clip is not yet available, retained DOM panels provide an honest presentation fallback. No animation is described as baked into the GLB until it actually exists.

## Service truth and execution

Use one assistant server and one set of memory, routine, timer, and request-ledger stores. Both typed and voice requests enter the same checked turn runner. A small allowlisted progress projection drives presentation; raw memory traces and provider metadata do not. Every action stays behind the existing capability/rule/argument checks. A request ID protects retries; canceling presentation does not undo completed work.

Timers and routine memory use their existing real stores. Spotify uses the existing connected-account adapter, through typing and direct controls only; retrieved metadata is local UI data and never goes to Meta, transcripts, learning, speech, or traces. No dance or playing state is inferred from an accepted command: playback state must confirm it. Lights, ovens, schedules, and cameras have no live adapter in this checkout. Their panels must say unavailable/not connected, never treat the separate Connection Center's simulated selections as evidence of live support. Future adapters must supply validated capabilities and observed outcomes before enabling controls; provider and hardware choices remain TBD.

## Verification contract

Exercise state priorities, idle rotation, rapid local timer receipts, compound actions, interruption and stale events, unavailable connections, timer completion, reduced motion, and actual face-before-playback ordering. Preserve existing assistant/voice tests. Use isolated synthetic stores for backend/browser tests; do not alter household memory or control real devices during verification. Inspect the combined surface at desktop and mobile sizes, including keyboard controls and loading/error states. Record completed checks and remaining limitations in STATUS.md.

## Run the combined surface

Run `npm ci`, configure the existing local `.env`, then `npm start` and open [MERLIN at home](http://127.0.0.1:3000/companion/). The old test and memory surface remains at `/`. For voice, run `npm run setup:voice` once; the assistant server now hosts the same-origin local wake transport and Fenrir worker. The separate `npm run voice` echo lab remains unchanged.

Microphone access is off until **Enable microphone**. **Read typed replies aloud** is optional and also enables microphone-off timer announcements. Mic-off, page hiding/exit, and failed transport release audio capture. A finished timer may speak without a model call only from its actual completed server record after current output checks. Voice alerts are deduplicated within the active connection and defer while busy; this is an open-page notification, not an operating-system alarm or delivery guarantee while asleep/offline.

Direct voice transcripts and assistant replies now enter the existing local conversation archive and background learning, unlike the separate echo lab. Raw audio remains transient. Clearing this conversation removes its transcript; full household memory deletion remains in the existing memory controls and invalidates cached speech. The same checked assistant text is displayed/spoken; no new spoken-only rule language is claimed. Replies over the voice limit remain on screen. Browser autoplay restrictions expose a manual audio player.

## Runtime contract for future animation and device work

`public/companion/orchestrator.js` decides foreground priority and stores two panel records; it executes no tools. `character.js` accepts `go(destination, {urgent, pace})`, independent `showPanel(type, dataOrCallback, side, {navigate:false})`, `updatePanel(data, side)`, `clearPanel(side)`, `capabilities`, and cancellation-aware `whenSettled`. The animation controller consumes the exported state graph. Add new states/routes to the authored manifest rather than making the model select arbitrary clip names. The companion's layout carries retained panels during face presentation; future retained-panel geometry can replace that rendering choice without changing action identity or execution.

The shared turn runner emits allowlisted foreground stages. Timer/routine presentation records are projected from actual results, independently of private diagnostic traces. Search anticipation starts only after the checked search gate; the current nonstreaming Meta adapter reports actual native-search completion when the response arrives. Spotify status/metadata is read directly by the local player UI. Lights/ovens remain disconnected until a real scoped adapter is added; the UI must never call mock Connection Center state an authorization.

Current limitations: visual walk/whistle is silent; sweep is procedural browser animation; speech expressions react to playback activity rather than phoneme alignment. No actual microphone-room test, connected Spotify playback, physical appliance, camera, or operating-system notification has been verified by this task. The local 4:3 browser composition is not a production hardware commitment.
