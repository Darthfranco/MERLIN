# Local four-model voice comparison

The owner requested a separate browser test for **Pocket TTS 100M**, **Chatterbox Nano**, **Qwen3-TTS 0.6B Base ANE**, and the existing **Kokoro Fenrir** voice, with actual audio and measured generation time. It is available with:

```sh
npm run voice:compare
```

Open [the local comparison](http://127.0.0.1:3004). Enter one passage, select models, and choose a first request plus a warm repeat. Each successful result contains a native audio player, WAV download, total wait, generation time, audio duration, load/reference preparation times, and generation-to-audio ratio. Timing records can be downloaded as JSON. Models run sequentially and release their worker before the next model. Stop terminates inference; failures remain visible while other selected models continue.

This surface does not change the voice in the main assistant, the original echo lab, or the phone demo. It does not use Meta, microphones, household memory, Spotify, or devices. It is a Mac development test, **not an iPad performance measurement or production voice decision**.

## Reference conditioning, not fine-tuning

The three new runtimes accept a voice recording as conditioning at inference time. Their weights are not updated by this test. Kokoro remains the selected **`am_fenrir`** baseline and ignores custom reference audio. Qwen Base has no built-in voice and requires both a reference and its exact transcript. Chatterbox and Pocket can also run their supplied default voices.

The original request named Tails’ performance in the Sonic films. That target has **not** been trained or cloned. [Kyutai’s published access conditions](https://huggingface.co/kyutai/pocket-tts) prohibit cloning without explicit lawful consent; an official public movie clip does not itself supply that permission. The owner had no reference recording available. A clearly labelled synthetic reference is used for pipeline verification, with an original bright voice proposed as an alternative. Neither the synthetic sample nor model similarity has been approved as MERLIN’s final voice. No film audio, voice embedding, or model weights are committed.

Use **Voice reference** to import an authorized audio file. Browser decoding converts it locally to mono 24 kHz PCM16 WAV; it does not access the microphone or upload to a provider. The harness accepts 3–30 seconds; for all three models together use at least 10 seconds, with 25–30 seconds recommended by the Nano author. Prefer one clear speaker, no music, no overlap. Qwen requires the exact words; a transcript is not automatically inferred. Replacing the reference is blocked during a run, and each result records the reference label used. Synthetic Kokoro references test the machinery; they do not establish a film-voice match or human listening quality.

## Setup on a new Mac

Use Apple Silicon, macOS 15 or newer, Node.js 22.16+, Python 3.12 or `uv`, Git, and Apple Command Line Tools with Swift 6.2+. Have several gigabytes free for model weights, package caches, and native release builds. The current machine’s exact ports are used; no Python/MLX substitute is silently selected.

```sh
npm ci
npm run setup:voice-compare
npm run voice:compare
```

The first command for model setup uses the network and can take several minutes. Inference loads local assets. Setup scripts are resumable and pin source/model revisions. Existing Kokoro setup is reused if present; the other runtimes are isolated under ignored `local/voice-compare/`.

Individual setup commands:

```sh
bash scripts/voice-compare-pocket-setup.sh
python3 scripts/voice-compare-chatterbox.py --setup
python3 scripts/voice-compare-qwen-setup.py
```

For a reproducible synthetic reference, run `local/voice-venv/bin/python scripts/voice-compare-sample.py --download`. Import `local/voice-compare/bright-reference.wav` in the page and copy its exact transcript from the adjacent JSON. This uses the pinned official Kokoro `af_sky` preset at speed 1.08 with original text. It is labelled **Bright synthetic voice · Kokoro Sky**, not Tails, and does not change the assistant’s Fenrir preset. The sample files remain local and are not included in Git.

| Row | Actual runtime and model | Reference behavior |
| --- | --- | --- |
| Kokoro · Fenrir | Official Kokoro-82M Python `KPipeline`, CPU; existing local pinned model | Fixed `am_fenrir`, speed 1, unmodified words |
| Pocket TTS | Exact English 100M conversion through pinned FluidAudio Swift/Core ML | Mimi reference encoding; supplied Alba otherwise |
| Chatterbox Nano | Pinned community Nano Core ML conversion; actual loaded variant is checked | Reference encoders, built-in default otherwise; Perth watermark preserved |
| Qwen3-TTS Base | Exact `tinytrashlabs/Qwen3-TTS-0.6B-Base-ANE`; upstream QwenANE/Core ML/Accelerate | Audio and transcript mandatory; reference encoders use CPU; talker requests CPU/GPU on this Mac, code predictor CPU/Neural Engine |

The optional `bash scripts/voice-compare-pocket-setup.sh --pytorch` path prepares an explicitly separate official Python CPU baseline. The browser defaults to the Core ML runtime and does not fall back automatically. Official Python cloning weights have a separate Hugging Face access gate; the public FluidInference conversion and its cloning support are documented by its publisher.

The Qwen talker’s original CPU/Neural Engine configuration failed to load on this M1/macOS 26.3.1 machine. A guarded loader patch requests CPU/GPU for all talker decode/prefill instances, with the exact functions, state and weights preserved. The code predictor still requests CPU/Neural Engine. Result labels expose this configuration; it is not a benchmark of the author’s complete ANE path. The precise operating-system/backend cause is unconfirmed.

Qwen reference preparation applies its upstream `ReferenceStandard` tail cleanup and loudness normalization in RAM before encoding, while preserving the uploaded recording and exact transcript. This work is included in reference preparation time. The initial adapter omitted that required preprocessing and failed on the longer Sky-reference test; the corrected adapter completed that same passage. It still needed three internal takes in the verification run, and its output was quiet. Listen before judging voice quality.

The final shared-reference Qwen outputs were valid playable WAVs, but local speech recognition recovered no words even after diagnostic amplification. Its speech quality is therefore unresolved. The actual audio and slow timings remain in the comparison; a completed WAV is not a claim of intelligible or faithful speech. See the measured results and limitations in [STATUS.md](STATUS.md).

The Pocket build includes an equivalent explicit `TaskLocal` expansion in the ignored pinned dependency checkout because this Command Line Tools installation could not locate the macro plugin. It does not change model inference. Pocket model conversion assets are about 414 MB for the selected files; Nano’s artifact repository is about 751 MB; Qwen’s selected download is about 2.07 GB. These sizes exclude runtime/build caches.

## Timing interpretation

- **Total wait:** server monotonic elapsed time from the worker request to its completed WAV response. It includes process startup, model load, reference preparation, synthesis, writing, and IPC; browser fetch/playback startup is not included.
- **Generation:** runtime-measured synthesis, including any automatic retries inside that runtime. Qwen's upstream renderer can redraw a take that fails its completion checks; that time is included. **Load** and **Reference** are separately reported; a reused in-memory reference may take zero time.
- **Audio length:** derived from validated PCM WAV headers, not estimated from text.
- **Generation ratio:** synthesis time divided by audio duration. Below 1× means synthesis was faster than playback.
- **First request:** a fresh worker, not necessarily cold filesystem or Core ML compiler caches. First-ever native compilation can take much longer. **Warm repeat** immediately reuses that worker before it is released.
- Optional **firstAudioMs** in the JSON is the runtime’s first generated chunk measured from synthesis start. The browser waits for the complete WAV; this is not a measured streaming playback latency. Qwen’s batch renderer does not report it.

The comparison passes identical text without adding model-specific expressive tags or semantic rewrites. Models have different architectures, default sampling and prosody, and may generate different audio lengths or mistakes. A low latency number is not a voice-quality score. Individual M1 Mac observations must not be generalized to iPads or other hardware.

## Local data and cleanup

The server binds `127.0.0.1`, validates Host/Origin, serves only known assets and generated audio filenames, and sets no-store/CSP headers. Worker subprocesses receive a minimal environment without Meta/Spotify credentials. Model failures are shown as failures, not audio substitutions.

Text, timing records, uploaded references and generated WAVs persist under ignored **`local/voice-compare/data/`** until **Delete local tests & reference** is used. State writes use atomic replacement. A restart marks unfinished work interrupted and keeps complete results available. Clear stops running workers before deleting data, including temporary reference conditioning. It leaves installed models/builds intact. The result download contains test text/reference labels; treat it accordingly if sharing.

Reference conditioning is held in worker memory. Nano briefly writes an intermediate file beside the output, deletes it normally, and clear removes any residue after cancellation. Native model compiler caches contain model assets, not reference recordings; Nano uses `~/Library/Application Support/com.chatterbox.coreml/CompiledModels/`. Explicit command-line smoke/reference-generation files outside the browser’s `data/` folder are developer artifacts and are not deleted by the page.

## Sources and contribution

Original MERLIN work: the loopback comparison server/UI, validated JSON-lines worker boundaries, sequential first/warm measurement, WAV validation, local reference upload/deletion, setup orchestration, and regression checks. Models and native engines are third-party work:

- [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M), Apache 2.0; existing setup/pins in [VOICE.md](VOICE.md).
- [Kyutai Pocket TTS](https://github.com/kyutai-labs/pocket-tts), [FluidAudio](https://github.com/FluidInference/FluidAudio), and [Pocket Core ML conversion](https://huggingface.co/FluidInference/pocket-tts-coreml). Model CC-BY-4.0 requires Kyutai attribution; FluidAudio code is Apache 2.0. Setup pins FluidAudio to `4c65ad493a397410b2f8c354dd977c700fb55192` and the conversion to `b51c4854305532b182026259092cc53e4b600f49`. The model’s consent conditions remain relevant.
- [Chatterbox Nano Core ML](https://github.com/iliasaz/chatterbox-coreml), MIT runtime and Resemble model/Perth assets. Exact pins, transitive attribution, cache and watermark details: [adapter notes](../scripts/voice-compare-chatterbox/README.md).
- [Qwen ANE conversion](https://huggingface.co/tinytrashlabs/Qwen3-TTS-0.6B-Base-ANE), Apache 2.0; TinyTrashLabs Swift engine and ZIPFoundation are MIT. Exact pins, CPU/ANE split and attribution: [adapter notes](../scripts/voice-compare-qwen/README.md).

Actual verification and remaining limitations are recorded in [STATUS.md](STATUS.md). No provider or device support is implied beyond the measured local runs.
