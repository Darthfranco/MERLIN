# MERLIN voice lab

The owner requested this separate local development page on October 27, 2026: type words or speak, then hear those words in **Kokoro Fenrir**. It is an echo lab. It does not answer questions, run tools, read household preferences, save conversation memory, or control Spotify. The main assistant remains at port 3000.

## Start

Requirements: Node.js 22.16+, and `uv` or Python 3.12. The initial setup needs internet access and downloads the Python runtime dependencies, official Kokoro weights, Fenrir voice, and English pronunciation data. Keep enough space for PyTorch and the model. The setup is isolated inside ignored `local/` directories.

```sh
npm run setup:voice
npm run voice
```

Open [http://127.0.0.1:3001](http://127.0.0.1:3001). For microphone transcription, add the existing Meta key as `META_API_KEY` (or `MODEL_API_KEY`) in ignored `.env`. Do not put a key in browser code. Typed speech works without Meta access. `VOICE_PORT` changes the voice server port; `VOICE_PYTHON` can point to a compatible Python environment. `npm run dev:voice` enables the Node file watcher.

Type into the text box and choose **Speak with Fenrir**, or select **Start recording** and then **Stop & speak**. Recorded speech is transcribed, placed in the editable text box, and spoken automatically. Replay uses the audio player; Cancel/Stop releases capture or interrupts pending work and playback. If the browser blocks automatic playback, use the player’s Play control. Microphone access requires the browser's permission and a secure context such as this loopback URL.

The lab caps each recording at 60 seconds and speech input at 2,000 characters. Fenrir is an English voice. The first synthesis after server start loads the local model; subsequent requests reuse it. Cancellation during synthesis terminates the worker, so the next request loads it again. This development server accepts only loopback access and is not a public deployment.

## Data flow and boundaries

1. **Typed input:** browser → local Node server → local Kokoro worker → WAV → browser playback. Text is not sent to Meta or Hugging Face.
2. **Recorded input:** explicit microphone button → browser AudioWorklet → mono PCM16 WAV at 24 kHz → local server validation → standard Meta `muse-voice-transcribe-1.0` → transcript → the same local synthesis path.
3. **Retention:** the lab writes no recordings, generated speech, or transcripts to disk and uses no browser storage. The current text and audio remain available in the page until cleared/replaced or the page is closed. HTTP responses are marked `no-store`; workers do not print input-derived diagnostics. Deleting local page content does not delete Meta’s provider-side records.
4. **Provider terms:** Meta receives the intentional recording for transcription. [Standard Services do not train Meta models on submitted content](https://dev.meta.ai/legal/commitments), but standard usage is not zero retention. No Contributor variant or provider fallback is used. Cancellation aborts the local request; it cannot retract bytes already uploaded to Meta.
5. **Isolation:** the separate server does not import assistant, memory, routine, timer, or Spotify services. An utterance containing a command is spoken as text; it cannot execute an action. The lab is not wired into the household’s standing-instruction system. Full assistant voice integration and output-rule scope remain future work.

Wake-word detection, continuous listening, voice activity endpointing, character mouth animation, and assistant reasoning are not implemented by this slice. The microphone is only active during a user-started recording, with a visible recording state and time limit; stop/cancel, page exit, and interruption release its tracks.

## Implementation and verification

- `src/voice-server.js`: independent loopback HTTP server, same-origin checks, bounded request bodies, one transcription and one synthesis at a time, disconnect cancellation, safe errors.
- `src/voice/meta.js`: documented multipart `request` and `audio` contract at `/v1/asr/transcribe`, fixed standard voice model, 60-second provider timeout.
- `src/voice/audio.js`: validates WAV format, duration, channel count, byte rate, chunk bounds, and size; removes ancillary metadata before upload.
- `src/voice/kokoro.js` and `scripts/voice-worker.py`: persistent local worker with fixed Fenrir selection, offline runtime, bounded synthesis and audio size, interruption/recovery.
- `public/voice/`: plain development UI, browser capture, transcript editing, audio playback, cancellation, and error states.

```sh
# Offline regression suite, with scripted providers and worker fixtures
npm test
# Real synthetic phrase: local Fenrir -> Meta transcription (uses API credits)
npm run check:voice
```

The live check uses an authored test phrase without microphone access or household data. It verifies synthesis and the actual transcription endpoint; physical microphone quality and audibility on the owner’s speakers still require trying the page. See [STATUS.md](STATUS.md) for completed results and limitations, and [the interface handoff](VOICE_DESIGN.md) for layout and interaction details.

## Sources and dependencies

- [Official Kokoro Space](https://huggingface.co/spaces/hexgrad/Kokoro-TTS) and [Space code](https://huggingface.co/spaces/hexgrad/Kokoro-TTS/blob/main/app.py): reference implementation and Fenrir voice identifier `am_fenrir`.
- [Kokoro-82M model](https://huggingface.co/hexgrad/Kokoro-82M), [Kokoro Python runtime](https://github.com/hexgrad/kokoro), and [Misaki pronunciation library](https://github.com/hexgrad/misaki): Apache-2.0 upstream projects. The setup pins the official model revision `f3ff3571791e39611d31c381e3a41a3af07b4987` and keeps downloaded model assets outside Git.
- [PyTorch](https://github.com/pytorch/pytorch), [Transformers](https://github.com/huggingface/transformers), [Hugging Face Hub](https://github.com/huggingface/huggingface_hub), and [spaCy English pipeline](https://huggingface.co/spacy/en_core_web_sm): local inference/loading and English pronunciation dependencies. Exact direct versions are recorded in `scripts/voice-requirements.txt`; upstream licenses remain in the installed distributions. No Node runtime package was added.
- Transitive phonemizer/eSpeak components include GPLv3 code; PyTorch bundles additional BSD/MIT/Apache/BSL components. These are installed locally, not copied into this repository. Preserve their license notices and evaluate obligations before packaging/distributing a runtime; do not assume every dependency uses Kokoro’s Apache-2.0 license.
- [Meta speech-to-text guide](https://dev.meta.ai/docs/speech-to-text) and [transcription endpoint](https://dev.meta.ai/docs/api-reference/voice/transcribe), checked October 27, 2026: WAV format, request fields, and transcript response. Account access to the voice model was verified independently of the catalog.

This is a new October 27 hackathon contribution using the third-party components above, not a newly trained voice model or a claim that the final MERLIN deployment platform is selected.
