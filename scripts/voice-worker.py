#!/usr/bin/env python3
"""Private, local Kokoro Fenrir worker. One JSON request/response per line."""

import argparse
import base64
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import wave

MODEL_REPO = "hexgrad/Kokoro-82M"
MODEL_REVISION = "f3ff3571791e39611d31c381e3a41a3af07b4987"
VOICE = "am_fenrir"
SAMPLE_RATE = 24000
MAX_SAMPLES = SAMPLE_RATE * 240


def emit(message):
    sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def pipeline_for(model_dir):
    # Avoid spaCy's implicit network installer when setup is incomplete.
    if importlib.util.find_spec("en_core_web_sm") is None:
        raise RuntimeError("Missing English pronunciation model")
    import torch
    from kokoro import KModel, KPipeline
    from loguru import logger

    logger.disable("kokoro")
    logger.disable("misaki")
    torch.set_num_threads(min(4, os.cpu_count() or 1))
    model = KModel(
        repo_id=MODEL_REPO,
        config=str(model_dir / "config.json"),
        model=str(model_dir / "kokoro-v1_0.pth"),
    ).to("cpu").eval()
    pipeline = KPipeline(lang_code="a", repo_id=MODEL_REPO, model=model)
    # Preload the exact official voice from a local path: no implicit HF lookup.
    pipeline.voices[VOICE] = torch.load(model_dir / "voices" / f"{VOICE}.pt", map_location="cpu", weights_only=True)
    return pipeline


def synthesize(pipeline, text, speed):
    import numpy as np

    chunks = []
    samples = 0
    # Retain every chunk (the Space's generate_first helper only returns one).
    for _, _, audio in pipeline(text, voice=VOICE, speed=speed):
        if audio is None:
            continue
        chunk = audio.detach().cpu().numpy().reshape(-1)
        if not np.isfinite(chunk).all():
            raise ValueError("invalid_audio")
        samples += len(chunk)
        if samples > MAX_SAMPLES:
            raise ValueError("too_long")
        chunks.append(chunk)
    if not samples:
        raise ValueError("no_speech")
    pcm = (np.clip(np.concatenate(chunks), -1, 1) * 32767).astype("<i2")
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(pcm.tobytes())
    return output.getvalue()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--setup", action="store_true")
    args = parser.parse_args()
    try:
        with contextlib.redirect_stdout(sys.stderr):
            if args.setup:
                from huggingface_hub import snapshot_download
                snapshot_download(
                    repo_id=MODEL_REPO,
                    revision=MODEL_REVISION,
                    allow_patterns=["config.json", "kokoro-v1_0.pth", "voices/am_fenrir.pt"],
                    local_dir=args.model_dir,
                )
            pipeline = pipeline_for(args.model_dir)
            if args.setup:
                # A synthetic smoke test checks the real model without saving audio.
                audio = synthesize(pipeline, "Hello. Fenrir is ready to speak.", 1)
        if args.setup:
            emit({"ready": True, "voice": VOICE, "sampleRate": SAMPLE_RATE, "testAudioBytes": len(audio)})
            return
    except Exception:
        emit({"type": "fatal", "error": "setup"})
        sys.exit(1)

    emit({"type": "ready"})
    for line in sys.stdin:
        request_id = None
        try:
            if len(line) > 20000:
                raise ValueError("invalid_request")
            request = json.loads(line)
            request_id = request.get("id")
            text, speed = request.get("text"), request.get("speed", 1)
            if not isinstance(request_id, str) or not isinstance(text, str) or not 1 <= len(text.strip()) <= 2000:
                raise ValueError("invalid_request")
            if isinstance(speed, bool) or not isinstance(speed, (int, float)) or not 0.75 <= speed <= 1.25:
                raise ValueError("invalid_request")
            with contextlib.redirect_stdout(sys.stderr):
                audio = synthesize(pipeline, text.strip(), speed)
            emit({"id": request_id, "audio": base64.b64encode(audio).decode("ascii")})
        except Exception as error:
            code = str(error) if str(error) in {"no_speech", "too_long"} else "generation"
            emit({"id": request_id, "error": code})


if __name__ == "__main__":
    main()
