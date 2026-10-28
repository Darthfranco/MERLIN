# Chatterbox Nano comparison worker

This local adapter runs the **exact Nano variant** from the community
[ChatterboxCoreML runtime](https://github.com/iliasaz/chatterbox-coreml), pinned to
`b8288834e783f3a6210757fbaf62f9014220bff9`. The lockfile pins its Swift dependencies.
It requires Apple Silicon, macOS 15+, and Swift 6 command-line tools. This does
not verify iPad performance or select a production voice.

From the repository root:

```sh
python3 scripts/voice-compare-chatterbox.py --setup
python3 scripts/voice-compare-chatterbox.py --probe
python3 scripts/voice-compare-chatterbox.py
```

Setup builds a release executable in ignored
`local/voice-compare/chatterbox-build/`, then downloads
[`iliasaz/chatterbox-nano-coreml`](https://huggingface.co/iliasaz/chatterbox-nano-coreml)
and the Perth watermark encoder into ignored
`local/voice-compare/chatterbox-cache/`. Setup needs network access. SwiftPM also
uses its ordinary system repository cache. Core ML stores compiled models in
`~/Library/Application Support/com.chatterbox.coreml/CompiledModels/`; the first
compile can take substantially longer than later loads. Neither model weights
nor runtime dependencies are redistributed in this project.

Model artifacts are revision-pinned too: Nano
`3fb8f1a29cf456d82268b81c71b9b0fd54658542` and Perth
`f17228757ad4876c8e13f0cd606758ce1ea5e4de`. The standard-library downloader checks
each file's byte count and SHA-256 (LFS) or Git blob SHA-1 before installation,
with four bounded download workers. Its receipt stays beside the ignored cache.
Synthesis loads the local watermark encoder directly and does not use the
upstream automatic download fallback.

The persistent worker consumes one JSON object per line, for example:

```json
{"id":"sample","text":"Hello there, your tea timer is ready.","outputPath":"/absolute/local/output.wav"}
```

Successful responses include PCM16 mono WAV path, 24 kHz sample rate, audio
duration, model load time, voice preparation time, synthesis time, and first
generated-chunk time (from the beginning of synthesis). The WAV write is outside
`synthesisMs`; the caller can also measure end-to-end wall time. Loading is lazy,
and subsequent requests in the same process report `loadMs: 0`. Logs go to
stderr; stdout contains JSON responses only. Output is generated sequentially.
Nano's actual loaded variant is checked; another Chatterbox variant is rejected.

Without `referencePath`, the upstream built-in default voice is used. With a
reference, the upstream `VoiceCloner` extracts conditioning; **no weights are
trained or fine-tuned**. Use a clean 10–120-second recording, ideally 25–30
seconds. Nano does not need `referenceText`. Short clips can produce unstable
speech in this model, as documented in the upstream
[cloning guide](https://github.com/iliasaz/chatterbox-coreml/blob/main/docs/voice-cloning.md).
The test does not include any film recording or character voice reference.

Reference conditioning is cached in process memory. A temporary conditioning
file is deleted after each completed request, including errors. Killing the
worker releases memory; a crash or forced termination can leave temporary files
beside the requested output WAV, where the comparison clear operation removes
them with its other local test data. Never commit private audio or its
conditioning files. Generated audio retains the upstream Perth watermark path;
there is no opt-out flag in this adapter.

The community runtime is MIT, copyright Ilia Sazonov. Chatterbox Nano and Perth
weights are from Resemble AI under MIT. Their conversions remain third-party
assets. Swift dependencies and attribution are described in the upstream
[NOTICE](https://github.com/iliasaz/chatterbox-coreml/blob/main/NOTICE), including
Apache-2.0 Swift Transformers/Hugging Face and MIT Swift Safetensors. The package
also depends on the RUAccent runtime, though English Nano does not download or
run Russian stress models.

Local verification on October 27, 2026 used an Apple M1 / macOS 26.3.1, the
sentence “Hello there, your tea timer is ready,” and a synthetic Fenrir reference.
Built-in cold generation produced 2.16 seconds of audio with 18.459 seconds of
model loading and 7.437 seconds of synthesis; the next synthesis took 1.201
seconds with no model reload. Reference conditioning first took 11.795 seconds,
then 0.761 milliseconds from the process cache; its two synthesis runs took
1.428 and 1.201 seconds, producing 2.12 seconds of audio. These are individual
Mac observations, not iPad measurements or a voice-quality rating. All four WAVs
passed mono/PCM16/24 kHz, duration/frame-count, and non-silence checks. Native
probe, malformed-input recovery, rejection of non-Nano model directories, and
temporary-conditioning cleanup also passed. No Tails recording was used.
