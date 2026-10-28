# Qwen ANE comparison worker

This standalone local backend runs the exact [tinytrashlabs/Qwen3-TTS-0.6B-Base-ANE](https://huggingface.co/tinytrashlabs/Qwen3-TTS-0.6B-Base-ANE) conversion linked for the comparison. It uses the upstream Swift QwenANE engine, Core ML and Accelerate. It does not substitute a Python, MLX or CustomVoice model, and does not integrate into MERLIN's assistant or microphone pipeline.

On an Apple Silicon Mac with macOS 15+ and Apple's Swift Command Line Tools:

```sh
python3 scripts/voice-compare-qwen-setup.py
python3 scripts/voice-compare-qwen.py --probe
python3 scripts/voice-compare-qwen.py
```

Setup downloads approximately 2.07 GB of model files and builds a release executable under ignored `local/voice-compare/`. It pins the upstream runtime to `60e0ddaf8797e4c33043427a6c7712833f4d82d3`, the model to `551e82a5618b4804a51559bc508fece40d63b6a7`, and ZIPFoundation to 0.9.19. All downloaded model files are verified against that revision's LFS SHA-256 or Git blob hash. Only the three required upstream targets are copied into the isolated build, avoiding the full app's unrelated dependency graph. One guarded loader patch is described below; model files remain unchanged. Existing MERLIN environments are not changed. Setup requires network access; synthesis has no downloader or remote inference API.

The Python launcher replaces its process with the Swift worker, so canceling its process also cancels synthesis. Send one JSON object per stdin line:

```json
{"id":"sample","text":"Your timer is ready.","outputPath":"/absolute/local/output.wav","referencePath":"/absolute/local/reference.wav","referenceText":"The exact words spoken in the reference recording."}
```

One JSON line is returned per request. Success includes `loadMs`, `preparationMs`, `synthesisMs`, `durationSeconds`, `sampleRate`, `runtime`, `voiceMode`, and `outputPath`. Errors return `ok:false` with an explanation. WAV output is mono PCM16 at 24 kHz. `loadMs` measures engine initialization, `preparationMs` measures reference preprocessing and encoding, and `synthesisMs` measures the complete render, excluding writing the WAV. Warm requests reuse the loaded engine and one prepared reference in RAM; the corresponding times are zero. Reference bytes, exact transcript and preparation-recipe version form the cache key, so editing a clip cannot reuse stale conditioning. A fixed seed of 7 makes comparisons repeatable; upstream may redraw a derailed take, reflected in `takes`. First-audio latency is not measured by this batch harness.

Before Qwen voice encoding, the worker applies the upstream `GVoiceKit.ReferenceStandard` expected by `QwenVoicePrep`: tail cleanup, then reference loudness normalization (target −17 LUFS, −1 dBFS peak ceiling). This preparation happens in RAM, is counted in `preparationMs`, and preserves the supplied exact transcript. The original uploaded recording is not rewritten. The encoder's normal sample-rate/channel conversion still applies. This is model-specific reference preprocessing, not weight training.

Qwen Base has **no preset voice**. Reference audio and its exact transcript are required. This is reference conditioning/voice cloning; it neither fine-tunes nor updates model weights. Synthetic Kokoro speech is suitable for checking the pipeline but is not a Tails recording or evidence of a Tails match. No film audio or character voice is bundled. Reference conditioning is held only in RAM; the worker does not save a reusable voice profile.

The upstream [QwenANE runtime guide](https://github.com/TinyTrashLabs/gloam-voice-studio/blob/60e0ddaf8797e4c33043427a6c7712833f4d82d3/Sources/QwenANE/README.md) documents the platform, reference preparation and rendering. On this M1 Mac with macOS 26.3.1, the unchanged talker export failed to load with `.cpuAndNeuralEngine`: Core ML misleadingly rejected `functionName`, although metadata and the MIL file correctly define `decode` and `prefill`. Both functions loaded with `.cpuOnly` and `.cpuAndGPU`; the stateless upsampler's named functions loaded normally. The precise operating-system/ANE cause is unconfirmed.

This comparison therefore **requests `.cpuAndGPU` for every talker decode/prefill instance** with a single guarded loader-line patch. It preserves the shared state, function names, graph and exact weights. This fixed configuration avoids timing repeated failed ANE loads. The code predictor still requests `.cpuAndNeuralEngine`; the vocoder mixes CPU and CPU/ANE components. The two reference encoders explicitly use `.cpuOnly` for correctness, despite the shorter model card labeling them as Neural Engine components. Probe and result runtime labels expose the CPU/GPU talker configuration. These are requested compute units, not independently profiled hardware placement. This is not a measurement of the author's full ANE path or iPad performance.

Initial adapter smoke, before the reference-standard follow-up, on October 27, 2026 on the development M1 Mac: two sequential requests using the same synthetic Kokoro Fenrir reference generated valid 24 kHz mono PCM16 WAVs for “Your timer is ready, mister. I will have everything sorted in a jiffy.” Both outputs were 4.26 seconds and byte-identical with seed 7. The initial engine load, including first-use Core ML compilation, took 49.529 seconds; reference preparation took 5.161 seconds; synthesis took 15.979 seconds. The second request reused the engine/reference (`loadMs` and `preparationMs` zero) and synthesized in 12.141 seconds. These individual measurements establish functioning audio generation and warm caching, not listening quality or latency guarantees. A subsequent fresh process may benefit from system compilation caches. Malformed JSON and missing-reference requests also returned exactly one structured error each without output files. Local evidence is retained under ignored `local/voice-compare/qwen-smoke-verified.json` and `qwen-cold.wav` / `qwen-warm.wav`.

The initial browser run with a 16.325-second synthetic Kokoro Sky reference and the longer comparison passage failed the incomplete-output guard; its failure is preserved in the comparison history. That exposed the adapter's missing upstream `ReferenceStandard` preparation. After adding the required preparation, rebuilding, and advancing the installation/probe revision to 3, the unchanged reference, exact transcript, seed, passage, and completion guards produced two successful requests. The passage was “Right away, mister! Your tea timer is set for five minutes. I'll have everything ready in a jiffy.” Cold engine loading took 7.388 seconds, reference preparation 2.093 seconds, and synthesis 43.970 seconds. The same-worker warm request took 43.332 seconds with zero load/preparation time. Both used three upstream takes, whose full cost is included in synthesis time, and produced identical 5.13-second WAVs. These relatively quiet outputs (PCM RMS 0.0101, peak 0.0901) passed the WAV and model-completion checks; those checks do not establish listening quality or that every word was spoken correctly. Final adapter evidence is in ignored `local/voice-compare/qwen-sky-standard-results.json` and `qwen-sky-standard-original-cold.wav` / `qwen-sky-standard-original-warm.wav`.

Sources and licenses:

- [QwenANE runtime, GVoiceKit and GVoiceProductionKit](https://github.com/TinyTrashLabs/gloam-voice-studio/tree/60e0ddaf8797e4c33043427a6c7712833f4d82d3): MIT, copyright TinyTrashLabs; setup preserves its license beside the copied sources.
- [Converted model](https://huggingface.co/tinytrashlabs/Qwen3-TTS-0.6B-Base-ANE/tree/551e82a5618b4804a51559bc508fece40d63b6a7): Apache 2.0; model license is downloaded with the weights.
- [Original Qwen3-TTS 12Hz 0.6B Base](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-Base): Apache 2.0, Qwen/Alibaba Cloud.
- [ZIPFoundation 0.9.19](https://github.com/weichsel/ZIPFoundation/tree/0.9.19): MIT. Used by the upstream voice-pack target; this worker does not import/export packs.

The small package manifest, JSON-lines interface, setup/checksum logic and WAV writer are MERLIN comparison contributions. Model/runtime sources and weights stay in ignored local storage.
