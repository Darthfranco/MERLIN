#!/usr/bin/env python3
"""Local Pocket TTS 100M comparison worker; one JSON request/result per line.

Default: pinned public FluidAudio CoreML port with a native persistent worker.
Optional --pytorch: official CPU baseline; its custom references require gated
Kyutai weights. Both condition on references at inference, without fine-tuning.
Runtime is offline; only explicit setup commands download model assets.
"""

import argparse
import contextlib
import hashlib
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import wave

ROOT = Path(__file__).resolve().parent.parent
LOCAL = ROOT / "local" / "voice-compare"
CACHE = LOCAL / "pocket-models"
VERSION = "4.0.0"
RUNTIME = "Pocket TTS 4.0.0 / English 100M / PyTorch CPU"
COREML_RUNTIME = "Pocket TTS 100M / FluidAudio CoreML fp16 / automatic placement"
COREML_REVISION = "b51c4854305532b182026259092cc53e4b600f49"
COREML_BINARY = LOCAL / "pocket-native" / ".build" / "release" / "merlin-pocket-worker"
COREML_ROOT = LOCAL / "pocket-coreml-models" / "Models" / "pocket-tts"
COREML_MANIFEST = LOCAL / "pocket-coreml-models" / "manifest.json"
CLONING = ("kyutai/pocket-tts", "languages/english/model.safetensors", "7f364c05d1be3faf2b234cdbe4cbb68a026d4218")
BUILTIN = ("kyutai/pocket-tts-without-voice-cloning", "languages/english/model.safetensors", "575d14372df89a4534bcb989870a34e77544b09f")
TOKENIZER = ("kyutai/pocket-tts-without-voice-cloning", "languages/english/tokenizer.json", "00eac05ed3d16bdc3f6b5d598874019c34a89214")
VOICE = ("kyutai/pocket-tts-without-voice-cloning", "languages/english/embeddings/alba.safetensors", "a3055dcb533cf2ec90458008a01e7cef550bae2a")
MAX_TEXT = 2000
MAX_SECONDS = 240


def emit(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":"), allow_nan=False) + "\n")
    sys.stdout.flush()


def cached(asset):
    from huggingface_hub import try_to_load_from_cache

    repo, filename, revision = asset
    value = try_to_load_from_cache(repo, filename, revision=revision, cache_dir=str(CACHE))
    return isinstance(value, str) and Path(value).is_file()


def probe():
    if importlib.util.find_spec("pocket_tts") is None:
        return {"available": False, "reason": "Run scripts/voice-compare-pocket-setup.sh first.", "runtime": RUNTIME}
    if importlib.metadata.version("pocket-tts") != VERSION:
        return {"available": False, "reason": "Pocket TTS package version differs from the pinned setup.", "runtime": RUNTIME}
    clone_available = cached(CLONING)
    available = cached(TOKENIZER) and cached(VOICE) and (clone_available or cached(BUILTIN))
    result = {"available": available, "runtime": RUNTIME, "cloneAvailable": clone_available}
    if not available:
        result["reason"] = "Pocket model files are missing. Run scripts/voice-compare-pocket-setup.sh."
    elif not clone_available:
        result["cloneReason"] = "Custom voice needs access to kyutai/pocket-tts on Hugging Face, local authentication, and setup again. Built-in Alba is ready."
    return result


def setup():
    from huggingface_hub import hf_hub_download
    from huggingface_hub.errors import GatedRepoError

    def download(asset):
        repo, filename, revision = asset
        hf_hub_download(repo, filename, revision=revision, cache_dir=str(CACHE))

    for asset in (TOKENIZER, VOICE):
        download(asset)
    try:
        download(CLONING)
    except GatedRepoError:
        print("Pocket custom-voice weights need Hugging Face access. Installing the official built-in-voice checkpoint; custom references will remain unavailable.", file=sys.stderr)
        download(BUILTIN)
    return probe()


def coreml_probe():
    available = False
    try:
        manifest = json.loads(COREML_MANIFEST.read_text())
        available = COREML_BINARY.is_file() and manifest["revision"] == COREML_REVISION and manifest["encoder"] == "mimi_encoderv2.mlmodelc" and bool(manifest["files"]) and all(
            (COREML_ROOT / item["path"]).stat().st_size == item["size"] for item in manifest["files"]
        )
    except (OSError, ValueError, KeyError):
        pass
    result = {"available": available, "runtime": COREML_RUNTIME, "cloneAvailable": available}
    if not available:
        result["reason"] = "Pocket CoreML files are missing. Run scripts/voice-compare-pocket-setup.sh."
    return result


def setup_coreml():
    from huggingface_hub import HfApi, snapshot_download

    info = HfApi().model_info("FluidInference/pocket-tts-coreml", revision=COREML_REVISION, files_metadata=True)
    bundles = {"cond_prefill.mlmodelc", "flowlm_step.mlmodelc", "flow_decoder_fused.mlmodelc", "mimi_decoder.mlmodelc"}
    constants = {"bos_emb.bin", "bos_before_voice.bin", "text_embed_table.bin", "tokenizer.model", "alba.safetensors"}
    selected = []
    for item in info.siblings:
        path = item.rfilename
        parts = path.split("/")
        if path.startswith("mimi_encoderv2.mlmodelc/") or (
            path.startswith("v2.1/english/") and len(parts) >= 4 and (
                parts[2] in bundles or (parts[2] == "constants_bin" and parts[-1] in constants)
            )
        ):
            if not path.endswith(".DS_Store"):
                selected.append({"path": path, "size": item.size})
    snapshot_download(
        "FluidInference/pocket-tts-coreml", revision=COREML_REVISION,
        allow_patterns=[item["path"] for item in selected], local_dir=str(COREML_ROOT), max_workers=3,
    )
    COREML_MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    COREML_MANIFEST.write_text(json.dumps({"revision": COREML_REVISION, "encoder": "mimi_encoderv2.mlmodelc", "files": selected}, indent=2))
    return coreml_probe()


def validate(request):
    if not isinstance(request, dict) or not isinstance(request.get("id"), str):
        raise ValueError("Request must contain a string id.")
    text = request.get("text")
    if not isinstance(text, str) or not 1 <= len(text.strip()) <= MAX_TEXT:
        raise ValueError("Text must contain between 1 and 2000 characters.")
    raw_output = request.get("outputPath")
    if not isinstance(raw_output, str):
        raise ValueError("An outputPath is required.")
    output = Path(raw_output).expanduser().resolve()
    if not output.is_relative_to(LOCAL.resolve()) or output.suffix.lower() != ".wav":
        raise ValueError("Output must be a WAV inside local/voice-compare.")
    reference = request.get("referencePath")
    if reference is not None:
        if not isinstance(reference, str) or not reference:
            raise ValueError("Reference path must identify a local audio file.")
        reference = Path(reference).expanduser().resolve()
        if not reference.is_file() or reference == output:
            raise ValueError("Reference audio is missing or matches the output path.")
        if reference.stat().st_size > 20 * 1024 * 1024:
            raise ValueError("Reference audio must be at most 20 MB.")
    return text.strip(), output, reference


class Worker:
    def __init__(self):
        self.model = None
        self.reference_digest = None
        self.reference_state = None
        self.builtin_state = None

    def run(self, request):
        text, output, reference = validate(request)
        status = probe()
        if not status["available"]:
            raise RuntimeError(status["reason"])
        if reference and not status["cloneAvailable"]:
            raise RuntimeError(status["cloneReason"])
        load_ms = 0
        if self.model is None:
            started = time.perf_counter()
            from pocket_tts import TTSModel

            # 4.0.0's English config pins the exact revisions declared above.
            # HF_HUB_OFFLINE prevents any request text/reference from leaving here.
            self.model = TTSModel.load_model(language="english")
            load_ms = (time.perf_counter() - started) * 1000

        started = time.perf_counter()
        if reference:
            import soundfile as sf

            info = sf.info(str(reference))
            if not 1 <= info.duration <= 30:
                raise ValueError("Pocket reference audio must last between 1 and 30 seconds.")
            with reference.open("rb") as handle:
                digest = hashlib.file_digest(handle, "sha256").digest()
            if self.reference_digest != digest:
                self.reference_state = self.model.get_state_for_audio_prompt(reference)
                self.reference_digest = digest
            state = self.reference_state
            mode = "reference-clone"
        else:
            if self.builtin_state is None:
                self.builtin_state = self.model.get_state_for_audio_prompt("alba")
            state = self.builtin_state
            mode = "builtin-alba"
        preparation_ms = (time.perf_counter() - started) * 1000

        import numpy as np

        started = time.perf_counter()
        first_audio_ms = None
        chunks = []
        sample_count = 0
        stop = threading.Event()
        stream = self.model.generate_audio_stream(state, text, copy_state=True, stop=stop)
        try:
            for chunk in stream:
                samples = chunk.detach().cpu().numpy().reshape(-1)
                if not samples.size:
                    continue
                if not np.isfinite(samples).all():
                    raise RuntimeError("Pocket generated invalid audio.")
                if first_audio_ms is None:
                    first_audio_ms = (time.perf_counter() - started) * 1000
                sample_count += samples.size
                if sample_count > self.model.sample_rate * MAX_SECONDS:
                    raise RuntimeError("Generated audio exceeded the four-minute limit.")
                chunks.append(samples)
        finally:
            stop.set()
            stream.close()
        synthesis_ms = (time.perf_counter() - started) * 1000
        if not sample_count:
            raise RuntimeError("Pocket generated no audio.")
        pcm = (np.clip(np.concatenate(chunks), -1, 1) * 32767).astype("<i2")
        output.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=output.parent, suffix=".wav", delete=False) as handle:
                temporary = Path(handle.name)
            with wave.open(str(temporary), "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(self.model.sample_rate)
                wav.writeframes(pcm.tobytes())
            os.replace(temporary, output)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
        return {
            "id": request["id"], "ok": True, "outputPath": str(output),
            "sampleRate": self.model.sample_rate, "durationSeconds": sample_count / self.model.sample_rate,
            "loadMs": round(load_ms, 3), "preparationMs": round(preparation_ms, 3),
            "synthesisMs": round(synthesis_ms, 3), "firstAudioMs": round(first_audio_ms, 3),
            "runtime": RUNTIME, "voiceMode": mode,
        }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--setup", action="store_true")
    parser.add_argument("--setup-coreml", action="store_true")
    parser.add_argument("--pytorch", action="store_true", help="Explicitly use the official Python CPU baseline.")
    args = parser.parse_args()
    os.environ["HF_HUB_CACHE"] = str(CACHE)
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    os.environ["DO_NOT_TRACK"] = "1"
    os.environ["DEBUG_MIMI"] = "0"
    if not args.setup and not args.setup_coreml:
        os.environ["HF_HUB_OFFLINE"] = "1"
    else:
        os.environ.pop("HF_HUB_OFFLINE", None)
    if args.setup_coreml:
        try:
            with contextlib.redirect_stdout(sys.stderr):
                result = setup_coreml()
        except Exception as error:
            result = {"available": False, "reason": str(error), "runtime": COREML_RUNTIME}
        emit(result)
        if not result["available"]:
            sys.exit(1)
        return
    if not args.pytorch and not args.setup:
        status = coreml_probe()
        if args.probe:
            emit(status)
            return
        if not status["available"]:
            for line in sys.stdin:
                try:
                    request = json.loads(line)
                    request_id = request.get("id") if isinstance(request, dict) else None
                except ValueError:
                    request_id = None
                emit({"id": request_id, "ok": False, "error": status["reason"]})
            return
        os.environ["MERLIN_POCKET_ROOT"] = str(ROOT)
        os.execv(str(COREML_BINARY), [str(COREML_BINARY)])
    if args.probe or args.setup:
        try:
            with contextlib.redirect_stdout(sys.stderr):
                result = setup() if args.setup else probe()
        except Exception as error:
            result = {"available": False, "reason": str(error), "runtime": RUNTIME}
        emit(result)
        if args.setup and not result["available"]:
            sys.exit(1)
        return
    worker = Worker()
    for line in sys.stdin:
        request_id = None
        try:
            if len(line) > 32000:
                raise ValueError("Request is too large.")
            request = json.loads(line)
            request_id = request.get("id") if isinstance(request, dict) else None
            with contextlib.redirect_stdout(sys.stderr):
                result = worker.run(request)
            emit(result)
        except Exception as error:
            emit({"id": request_id, "ok": False, "error": str(error)})


if __name__ == "__main__":
    main()
