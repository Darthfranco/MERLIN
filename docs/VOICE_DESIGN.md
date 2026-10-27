# Voice lab interface handoff

Updated **October 27, 2026**. Scope: [the separate voice lab](../public/voice/index.html), with [its stylesheet](../public/voice/voice.css) and [browser controller](../public/voice/voice.js).

## Purpose and boundary

The owner requested a simple local development interface: type words or record speech, have Meta transcribe recorded speech, and hear those words in Kokoro’s Fenrir voice. This is an **Operate** surface for testing that flow. It is an echo test, with no assistant commands, memory, Spotify controls, wake word, character animation, or production-platform decision. The existing assistant interface is a separate surface.

## Built layout and visual language

One column centers a maximum 760-pixel workspace. The heading identifies the lab; the editable text field and its two input actions occupy the first viewport. Service status sits above the field, activity and errors follow the actions, and a native audio player appears once speech is available. The footer explains the development scope and audio destination.

The lab inherits the typed prototype’s practical visual language: system sans-serif, pale gray page (`#f4f6f8`), white workspace, dark blue text (`#172a3b`), blue actions (`#185c9e`), muted supporting text, and restrained borders. It has no decorative images, animation, shadows, or extra navigation. The workspace has a 12-pixel radius; fields and buttons use 6-pixel corners.

At widths up to 520 pixels, outer padding decreases, the primary action spans the available width, and recording and stop controls share the following row. Buttons have a minimum 44-pixel height. The text field can resize vertically; long status and error text can wrap.

## Interaction contract

- **Typed input:** “Speak with Fenrir” reads the current text. Empty input disables the action. Command/Ctrl + Enter submits from the field.
- **Recorded input:** microphone access begins only after “Start recording.” A visible recording label, colored indicator, and elapsed-time counter accompany capture. “Stop & speak” releases the microphone, sends the recording to Meta, replaces the field with the transcript, then requests Fenrir speech.
- **Busy states:** microphone permission, recording, finishing, transcription, and speech preparation each have explicit status text. The field is read-only during active work; Cancel remains available.
- **Playback:** the browser’s audio controls provide replay and pause. A blocked autoplay attempt leaves the player visible with a Play instruction. Stop halts playback.
- **Recovery:** errors preserve the text for correction or retry. Clear cancels work, releases capture, removes playback and its object URL, empties the field, and restores focus to it.
- **Bounds:** the current service contract permits 2,000 text characters and 60 seconds of recorded audio. The browser reads limits from service status. A longer transcript stays visible for editing rather than being silently truncated.

Labels, visible keyboard-focus outlines, a polite live status region, and an alert region support keyboard and assistive-technology use. Recording state also has words, so its meaning does not depend on color. The changing elapsed-time value is hidden from screen readers to avoid constant announcements.

## Verification and limits

The browser session verified actual typed speech playback through completion, cancellation restoring controls, and Clear removing playback. The observed clip duration and completed playback position were both 2.625 seconds. No browser errors appeared in that session. The desktop capture was clear and reviewable.

At a measured 390-pixel viewport, document scroll width was 390 pixels, the main column was 358 pixels, and the primary action was 324 pixels wide. These measurements confirm no horizontal overflow in that state. The mobile screenshot backend rendered the content at an inconsistent scale despite the correct DOM dimensions, so full mobile screenshot fidelity could not be verified. This is not a full accessibility audit or a claim of comprehensive cross-browser microphone testing.

JavaScript syntax and whitespace checks passed. Audio contract checks covered 16/24/44.1/48 kHz input conversion to mono PCM16 WAV at 24 kHz, expected sample duration and levels, stereo mixing, exact capture limits, flush acknowledgment, and silent speaker output during capture. These checks do not establish a live human-microphone transcription result.

The design detector ran with its regex fallback because optional parser modules were unavailable. Its palette and type-ramp advisories include values inherited from the existing prototype and the lab’s recording-state colors; computed contrast and full selector checks were unavailable. Keep future changes within this plain development interface unless the owner requests a broader design.
