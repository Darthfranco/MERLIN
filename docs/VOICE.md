# MERLIN voice lab

Updated **October 27, 2026**. The owner requested a separate local page to type or speak and hear those words in **Kokoro Fenrir**, then requested more expressive delivery and private wake-word conversations. It remains an echo lab: it does not answer questions, run tools, read household preferences, save conversation memory, or control Spotify. The main assistant remains at port 3000.

## Combined assistant surface

The separate echo lab described below remains isolated. The later [combined MERLIN surface](ORCHESTRATION.md) runs at `/companion/` on the assistant server (`npm start`): directed speech now goes through the existing assistant, memory and checked tools, then Fenrir speaks the response. Its transcripts/replies follow household memory retention, unlike this echo lab; raw audio is still transient. Interruption after assistant execution begins starts a new turn, so previously completed actions cannot replay. Spotify remains unavailable to voice. Both modes retain explicit microphone activation, local idle detection, quiet follow-ups and cleanup.

## Start

Requirements: Node.js 22.16+, and `uv` or Python 3.12. Initial setup downloads the Python dependencies, official Kokoro weights, Fenrir voice, English pronunciation data, and local keyword/speech-detection models into ignored `local/` directories. Keep enough space for PyTorch and the models. Node dependencies are pinned in `package-lock.json`.

```sh
npm ci
npm run setup:voice
npm run voice
```

Open [http://127.0.0.1:3001](http://127.0.0.1:3001). For microphone transcription, add the existing Meta key as `META_API_KEY` (or `MODEL_API_KEY`) in ignored `.env`. Do not put a key in browser code. Typed speech works without Meta access. `VOICE_PORT` changes the voice server port; `VOICE_PYTHON` can point to a compatible Python environment. `npm run dev:voice` enables the Node file watcher.

Type into the text box and choose **Speak with Fenrir**, or select **Start recording** and then **Stop & speak**. Recorded speech is transcribed, placed in the editable text box, and spoken automatically. Replay uses the audio player; Cancel/Stop releases capture or interrupts pending work and playback. If the browser blocks automatic playback, use the player’s Play control. Microphone access requires the browser's permission and a secure context such as this loopback URL.

The lab caps each recording at 60 seconds and speech input at 2,000 characters. Fenrir is an English voice. The first synthesis loads the local model; subsequent requests reuse it. Cancellation during synthesis terminates the worker, so the next request reloads it. This development server accepts loopback access only.

## Hands-free conversation

Select **Enable local wake**, grant microphone permission, say **“MERLIN”**, then speak. The status distinguishes local wake standby, listening to a turn, transcription, generation, and playback.

- **Standby:** a local keyword spotter checks only for MERLIN. Unrelated speech and silence make no Meta or TTS calls. A four-second rolling raw-audio buffer stays in RAM to recover activation audio.
- **Turn completion:** local Silero voice activity detection waits for approximately **1.1 seconds of silence**, then submits the active clip to Meta. This is an acoustic pause rule, not semantic understanding of sentence completion. The first clip can include MERLIN; its leading transcription is removed before the echo. **A detected wake-only utterance can use one short Meta transcription request**; an empty result after removing MERLIN waits for the request without speaking. Keyword timestamps are not reliable enough to discard short postwake words safely.
- **Interruption:** speaking during transcription or voice generation cancels that reply and combines unfinished audio with the continuation. Speaking during playback stops playback and begins a new turn. Revision checks discard late results. Continuation can require another transcription; cancellation cannot retract bytes already sent to Meta.
- **Follow-up:** a longer quiet pause ends the conversation. Normally the window is **10 seconds after playback**; it becomes **15 seconds** after an interruption or when the last turn resumed after at least eight seconds of quiet. An ordinary prompt resets the next window to 10 seconds. This small amount of context comes from local timing, without an extra Meta call. Goodbye, thanks, and other words do not automatically end the session. The manual **End conversation** button still returns to standby immediately.
- **Pause handling:** the 1.1-second turn pause is separate from the longer conversation pause. Thinking time during transcription/generation/playback does not consume the follow-up window. A 400 ms local onset grace, included within the 10/15-second windows, protects speech beginning near timeout. Duplicate playback-finished events and rejected tiny speech/noise bursts do not restart the quiet countdown. Normal long speech still uses the existing capture/session limits.
- **Development limits:** an active conversation lasts at most **three minutes**, starts at most **12 transcription requests**, including interrupted attempts, and retains at most **60 seconds per utterance**, including continuations. A limit returns to local wake standby; another MERLIN activation starts a fresh conversation.

**Wake standby keeps the microphone on.** Detecting MERLIN requires local audio processing; standby does not mean physically muted. **Turn microphone off**, **Mic off**, **Clear**, hiding the page, or leaving it stops microphone tracks, closes the local listener, and cancels work/playback. **End conversation** keeps local wake detection enabled. Returning to the page never enables capture automatically.

The browser requests echo cancellation, noise suppression, and automatic gain control. False/missed wakes, accents, room noise, and speaker feedback have not been validated with the owner’s physical microphone and speakers. A false activation followed by speech can submit an unintended active clip. The visible mic-off control stops all listening; this is not a claim of Alexa/Google Home recognition quality.

## Fenrir delivery

**Natural** is the default. **Neutral** keeps original single-pass timing; **Lively** uses faster phrase pacing and shorter gaps; **Gentle** uses slower pacing and longer gaps. Pace offers slower, normal, and faster. All choices retain `am_fenrir`, preserve source text, and use local computation. Plans are bounded to 32 segments and synthesis rates from 0.75 to 1.25.

The [official Kokoro Space code](https://huggingface.co/spaces/hexgrad/Kokoro-TTS/blob/main/app.py) documents punctuation and native stress/pronunciation controls, not a trained emotion parameter. Try `That is [so](+2) good!`. `(-1)` and `(-2)` reduce stress; increasing stress mainly affects less-stressed short words. Punctuation shapes intonation. Pronunciation links such as `[Kokoro](/kˈOkəɹO/)` remain supported. Invented `[happy]` or `[sad]` tags are not emotion controls and can become spoken text. Delivery presets do not guarantee emotional acting or low latency.

## Speech-friendly assistant replies

The assistant prompt asks Meta to write natural spoken language for ordinary replies, including typed replies that may be read aloud. A shared browser-safe formatter in `public/shared/spoken-text.js` expands common explicit temperature, unit, percentage, money, time, range, and fraction notation and removes ordinary prose markdown from the derived speech. It preserves numerical meaning, signs, exact protected literals, code, raw URLs/identifiers, and native Kokoro stress/pronunciation markup. Ambiguous numeric dates, bare unit/seat codes, media timestamps, unfamiliar abbreviations, and unsupported compound units are not guessed; the language model should express their meaning when context establishes it. There is no extra model call for speech formatting.

`src/spoken-replies.js` checks both the original text and its speech projection against current household output rules and enforces the existing two-thousand-character synthesis limit after expansion. Required literal address/prefix/suffix text is protected, so general speech styling cannot override it. The combined assistant injects this preparation into HTTP read-aloud, live wake replies, and timer/stored-reply notifications. The phone demo uses the same formatter before browser speech synthesis. Displayed/archived assistant text, timer labels, tool arguments, and Spotify metadata boundaries remain unchanged. The standalone echo lab and Kokoro prosody engine retain their exact-text behavior; this formatter belongs to assistant output, not arbitrary source transcription.

## Data flow and boundaries

1. **Typed input:** browser → local Node server → local Kokoro worker → WAV → browser playback. Text is not sent to Meta or Hugging Face.
2. **Recorded input:** explicit microphone button → browser AudioWorklet → mono PCM16 WAV at 24 kHz → local server validation → standard Meta `muse-voice-transcribe-1.0` → transcript → the same local synthesis path.
3. **Wake mode:** browser AudioWorklet → 80 ms PCM16 frames at 16 kHz over a same-origin loopback WebSocket → local MERLIN keyword spotter and Silero VAD. Completed activated speech clips become WAV uploads to Meta; standby audio is not sent for cloud transcription. This uses a keyword-constrained local model, not browser/cloud continuous speech recognition.
4. **Retention:** no recordings, generated speech, or transcripts are written to disk; no browser storage is used. The ring, active clips, and detector state are transient RAM. Current text/audio can remain in the page until cleared, replaced, or closed. Models/dependencies are persistent setup files. HTTP responses use `no-store`; input-derived worker diagnostics are discarded. Clear does not delete Meta’s provider-side records.
5. **Provider terms:** Meta receives active recordings for transcription. [Standard Services do not train Meta models on submitted content](https://dev.meta.ai/legal/commitments), but this is not zero retention. No Contributor variant, alternate provider, or invented ASR `store:false` parameter is used. Cancellation cannot retract uploaded bytes.
6. **Isolation:** the server does not import assistant, memory, routine, timer, or Spotify services. Commands are echoed and cannot execute actions. Full assistant reasoning, standing-instruction scope for voice, character animation, and production integration remain future work.

The transport permits one session, checks Host/Origin, rejects oversized/non-realtime frames, bounds queued PCM to two seconds, and stops on a stalled microphone or disconnected socket. Microphone frames do not enter logs or household traces.

## Implementation and verification

- `src/voice-server.js` and `src/voice/transport.js`: loopback HTTP/WebSocket server, origin checks, bounded input, disconnect cancellation, and safe errors.
- `src/voice/listener.js` and `scripts/voice-listener.py`: offline local keyword spotting/VAD, sample-aligned event receipts, and no emitted transcripts.
- `src/voice/session.js`: wake/conversation states, bounded RAM capture, endpointing, continuation/interruption, time/call limits, and stale-result rejection.
- `src/voice/meta.js`: documented multipart `request` and `audio` contract at `/v1/asr/transcribe`, fixed standard voice model, 60-second provider timeout.
- `src/voice/audio.js`: validates WAV format, duration, channel count, byte rate, chunk bounds, and size; removes ancillary metadata before upload.
- `src/voice/prosody.js`, `src/voice/kokoro.js`, and `scripts/voice-worker.py`: exact-text delivery plans and persistent local Fenrir synthesis.
- `public/voice/`: explicit microphone controls, manual/streaming capture, state labels, delivery controls, playback, and recovery.

```sh
# Offline regression suite, with scripted providers and worker fixtures
npm test
# Real synthetic phrase: local Fenrir -> Meta transcription (uses API credits)
npm run check:voice
# Real local wake/VAD -> Meta -> Fenrir, including a follow-up (uses API credits)
npm run check:voice-session
```

These checks use authored synthetic phrases without microphone access, household data, or audio files. The completed session check used **three Meta uploads**: wake-only activation, a full activated phrase, and a follow-up without another MERLIN. Unrelated standby speech made zero transcription calls. It exercised the real local detector and Meta/Fenrir path, but did not validate physical microphone/speaker echo cancellation.

Focused session/listener/prosody regressions cover privacy, bounds, interruption, and text preservation. Real offline synthesis produced valid, distinct WAVs for all four deliveries; installed Misaki consumes native stress markup as phoneme stress rather than spoken tag words. A browser Lively/native-stress check reached playback completion at 3.555 seconds with no warnings/errors. See [STATUS.md](STATUS.md) for the final suite and live-check results, and [VOICE_DESIGN.md](VOICE_DESIGN.md) for UI behavior.

## Sources and dependencies

- [Official Kokoro Space](https://huggingface.co/spaces/hexgrad/Kokoro-TTS) and [Space code](https://huggingface.co/spaces/hexgrad/Kokoro-TTS/blob/main/app.py): reference implementation and Fenrir voice identifier `am_fenrir`.
- [Kokoro-82M model](https://huggingface.co/hexgrad/Kokoro-82M), [Kokoro Python runtime](https://github.com/hexgrad/kokoro), and [Misaki pronunciation library](https://github.com/hexgrad/misaki): Apache-2.0 upstream projects. The setup pins the official model revision `f3ff3571791e39611d31c381e3a41a3af07b4987` and keeps downloaded model assets outside Git.
- [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) and [SentencePiece](https://github.com/google/sentencepiece): Apache-2.0 runtimes, pinned to `sherpa-onnx`/`sherpa-onnx-core` `1.12.35` and SentencePiece `0.2.1`. The [official keyword release](https://github.com/k2-fsa/sherpa-onnx/releases/tag/kws-models) supplies `sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01`; its bundled README declares Apache-2.0. Setup selects int8 ONNX files and verifies MERLIN’s BPE tokens.
- [Silero VAD](https://github.com/snakers4/silero-vad) is MIT licensed; its ONNX file comes from the [sherpa model release](https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models). Setup verifies SHA-256 before writing: keyword archive `f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a`, Silero `9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6`. `scripts/voice-listener-setup.py` pins the bytes, not just filenames.
- [ws 8.22.0](https://github.com/websockets/ws/tree/8.22.0), MIT licensed, supplies the Node WebSocket transport. Browser code uses native WebSocket/AudioWorklet APIs.
- [PyTorch](https://github.com/pytorch/pytorch), [Transformers](https://github.com/huggingface/transformers), [Hugging Face Hub](https://github.com/huggingface/huggingface_hub), and [spaCy English data](https://huggingface.co/spacy/en_core_web_sm) support local voice synthesis. Direct versions are pinned in `scripts/voice-requirements.txt` and `scripts/voice-listener-requirements.txt`; installed distributions retain upstream notices.
- Transitive phonemizer/eSpeak components include GPLv3 code; PyTorch bundles additional BSD/MIT/Apache/BSL components. These are installed locally, not copied into this repository. Preserve their license notices and evaluate obligations before packaging/distributing a runtime; do not assume every dependency uses Kokoro’s Apache-2.0 license.
- [Meta speech-to-text guide](https://dev.meta.ai/docs/speech-to-text) and [transcription endpoint](https://dev.meta.ai/docs/api-reference/voice/transcribe), checked October 27, 2026: WAV format, request fields, and transcript response. Account access to the voice model was verified independently of the catalog.

This is a new October 27 hackathon contribution using the third-party components above, not a newly trained voice model or a claim that the final MERLIN deployment platform is selected.
