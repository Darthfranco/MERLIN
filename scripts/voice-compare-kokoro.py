#!/usr/bin/env python3
"""Benchmark the existing official Fenrir pipeline without changing the voice lab."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import time
import wave

ROOT = Path(__file__).resolve().parents[1]
MODEL = ROOT / "local/voice-model"
RUNTIME = "Official Kokoro Python · CPU · am_fenrir"

def emit(value):
    print(json.dumps(value), flush=True)

if "--probe" in sys.argv:
    available = all((MODEL / p).is_file() for p in ["config.json", "kokoro-v1_0.pth", "voices/am_fenrir.pt"])
    emit({"available": available, "runtime": RUNTIME, "reason": "" if available else "Run npm run setup:voice."})
    sys.exit(0)

pipeline = None
for line in sys.stdin:
    request = {}
    try:
        request = json.loads(line)
        text = request["text"]
        if not isinstance(text, str) or not 1 <= len(text.strip()) <= 600:
            raise ValueError("Enter 1–600 characters.")
        loaded = 0
        with contextlib.redirect_stdout(sys.stderr):
            if pipeline is None:
                start = time.perf_counter()
                spec = importlib.util.spec_from_file_location("merlin_voice_worker", ROOT / "scripts/voice-worker.py")
                worker = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(worker)
                pipeline = worker.pipeline_for(MODEL)
                loaded = (time.perf_counter() - start) * 1000
            start = time.perf_counter()
            audio = worker.synthesize(pipeline, text, 1)
            synthesis = (time.perf_counter() - start) * 1000
        with wave.open(io.BytesIO(audio)) as wav:
            rate = wav.getframerate()
            duration = wav.getnframes() / rate
        Path(request["outputPath"]).write_bytes(audio)
        emit({"id": request["id"], "ok": True, "outputPath": request["outputPath"],
              "sampleRate": rate, "durationSeconds": duration, "loadMs": loaded,
              "preparationMs": 0, "synthesisMs": synthesis, "runtime": RUNTIME,
              "voiceMode": "Fenrir baseline (no voice cloning)"})
    except Exception as error:
        emit({"id": request.get("id"), "ok": False, "error": str(error)[:300]})
