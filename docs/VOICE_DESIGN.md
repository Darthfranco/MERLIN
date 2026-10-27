# Voice lab interface handoff

Updated **October 27, 2026**. Scope: [the separate voice lab](../public/voice/index.html), with [its stylesheet](../public/voice/voice.css) and [browser controller](../public/voice/voice.js).

## Purpose and boundary

The owner requested a simple local interface to type or speak, have Meta transcribe speech, and hear the same words in Kokoro Fenrir. The follow-up adds expressive delivery, local MERLIN activation, automatic speech boundaries, interruption, and short follow-up conversations. This remains an echo test with no assistant commands, memory, Spotify controls, character animation, or production-platform decision. The assistant UI stays separate.

## Built layout and visual language

One column centers a maximum 760-pixel workspace. Service status comes first, followed by hands-free controls and an explicit microphone status. The text field, Delivery/Pace selectors, collapsible emphasis help, manual input actions, activity/errors, and native player share the workspace. The footer explains echo scope, local wake processing, and how to turn the microphone off.

The lab inherits the typed prototype’s practical visual language: system sans-serif, pale gray page (`#f4f6f8`), white workspace, dark blue text (`#172a3b`), blue actions (`#185c9e`), muted supporting text, and restrained borders. It has no decorative images, animation, shadows, or extra navigation. The workspace has a 12-pixel radius; fields and buttons use 6-pixel corners.

At widths up to 520 pixels, outer padding decreases, wake controls stack vertically, and the wake/typed-speech buttons span the available width. Recording and Stop share a row; delivery controls wrap when needed. Buttons and selects have a minimum 44-pixel height. The text field can resize vertically; long status/error text wraps.

## Interaction contract

- **Typed input:** “Speak with Fenrir” reads the current text. Empty input disables the action. Command/Ctrl + Enter submits from the field.
- **Recorded input:** microphone access begins only after “Start recording.” A visible recording label, colored indicator, and elapsed-time counter accompany capture. “Stop & speak” releases the microphone, sends the recording to Meta, replaces the field with the transcript, then requests Fenrir speech.
- **Enable local wake:** explicitly requests microphone access and starts local detection. The initial page state is microphone off. While armed, the toggle reads “Turn microphone off” and Stop reads “Mic off”; typed/manual submission is disabled. Delivery/Pace can change for later speech.
- **Standby:** “Local wake only — say MERLIN” means the microphone remains active locally. Unrelated standby speech makes no Meta calls. A detected wake utterance can use one short Meta clip, even when it contains only MERLIN; stripping that transcript leaves the page waiting without speaking. The UI must not promise wake-only activation is free.
- **Conversation:** approximately 1.1 seconds of silence ends a turn. Speaking during STT/TTS cancels the stale reply and preserves unfinished speech; speaking during playback starts a fresh turn. Follow-up speech within 12 seconds needs no wake word. Silence, an exact end phrase, or End conversation returns to standby, retaining local microphone access. Development bounds are three minutes, 12 transcription attempts, and 60 seconds per accumulated utterance.
- **Delivery:** Natural is initially selected; Neutral, Lively, and Gentle change pacing. Pace offers Slower/Normal/Faster. The hint demonstrates `That is [so](+2) good!` and explains punctuation/native stress without claiming a trained emotion control.
- **Busy states:** microphone permission, recording, finishing, transcription, and speech preparation each have explicit status text. The field is read-only during active work; Cancel remains available.
- **Playback:** the browser’s audio controls provide replay and pause. A blocked autoplay attempt leaves the player visible with a Play instruction. Stop halts playback.
- **Recovery:** errors preserve text for correction/retry. Connection or processing failures turn the microphone off. Clear cancels work, releases capture, removes playback/object URLs, empties the field, and restores focus. Hiding/leaving the page stops capture; returning never rearms it automatically. Late media promises/socket events cannot revive stopped playback.
- **Bounds:** the current service contract permits 2,000 text characters and 60 seconds of recorded audio. The browser reads limits from service status. A longer transcript stays visible for editing rather than being silently truncated.

Labels, visible focus outlines, polite live status regions, an alert region, and the wake toggle’s `aria-pressed` state support keyboard/assistive technology use. Listening/recording states have explicit words, so color is supplementary. The changing timer is hidden from screen readers to avoid constant announcements.

## Verification and limits

The initial push-to-talk version was checked in a real browser for typed playback, cancellation, Clear, and desktop layout. Its observed clip duration/playback position were both 2.625 seconds, without browser errors. Those earlier observations do not establish visual approval of the expanded wake controls.

At a measured 390-pixel viewport, document scroll width was 390 pixels, the main column was 358 pixels, and the primary action was 324 pixels wide. These measurements confirm no horizontal overflow in that state. The mobile screenshot backend rendered the content at an inconsistent scale despite the correct DOM dimensions, so full mobile screenshot fidelity could not be verified. This is not a full accessibility audit or a claim of comprehensive cross-browser microphone testing.

JavaScript syntax and whitespace checks passed. Audio contract checks covered 16/24/44.1/48 kHz input conversion to mono PCM16 WAV at 24 kHz, expected sample duration and levels, stereo mixing, exact capture limits, flush acknowledgment, and silent speaker output during capture. These checks do not establish a live human-microphone transcription result.

Session/listener/prosody tests cover local-only standby, active uploads, interruption and stale-result rejection, time/call/capture bounds, cancellation, and exact text/native markup preservation. Real offline synthesis produced audio for all four delivery presets. The updated browser check played Lively delivery with native stress through completion at 3.555 seconds, without warnings/errors. The real synthetic session check passed with zero idle uploads and three active uploads (wake-only, full phrase, follow-up). See [STATUS.md](STATUS.md) for the final integrated suite and remaining browser coverage.

Physical wake sensitivity, false activations, audibility, and browser echo cancellation in the owner’s room still need human testing. Requesting browser echo cancellation does not guarantee clean interruption or protection from a speaker waking the detector. The initial design detector used a regex fallback with incomplete contrast/selector analysis. This is not a full accessibility or cross-browser microphone certification; retain the plain development interface unless broader design is requested.
