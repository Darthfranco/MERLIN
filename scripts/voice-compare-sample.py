#!/usr/bin/env python3
"""Create an original synthetic reference for comparison; not a character clone."""
import argparse
import importlib.util
import json
from pathlib import Path
import wave

ROOT = Path(__file__).resolve().parents[1]
LOCAL = ROOT / "local/voice-compare"
REVISION = "f3ff3571791e39611d31c381e3a41a3af07b4987"
TEXT = "Hello there! I'm ready to help, and there's plenty we can do together. Just tell me what you need, and we'll take it one step at a time. I can keep track of the little things while you get on with your day. Your tea is almost ready, the kitchen timer is ticking, and everything is coming along nicely. Let's get started!"

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--download", action="store_true", help="Download the pinned official Sky voice asset before local synthesis.")
    args = parser.parse_args()
    voice_path = LOCAL / "reference-assets/voices/af_sky.pt"
    if args.download:
        from huggingface_hub import hf_hub_download
        hf_hub_download("hexgrad/Kokoro-82M", "voices/af_sky.pt", revision=REVISION, local_dir=LOCAL / "reference-assets")
    if not voice_path.is_file():
        raise SystemExit("Run this script with --download once to prepare the official Sky asset.")
    import numpy as np
    import torch
    spec = importlib.util.spec_from_file_location("merlin_voice_worker", ROOT / "scripts/voice-worker.py")
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)
    pipeline = worker.pipeline_for(ROOT / "local/voice-model")
    pipeline.voices["af_sky"] = torch.load(voice_path, map_location="cpu", weights_only=True)
    chunks = [audio.detach().cpu().numpy().reshape(-1) for _, _, audio in pipeline(TEXT, voice="af_sky", speed=1.08) if audio is not None]
    if not chunks:
        raise RuntimeError("The sample did not produce speech.")
    audio = np.concatenate(chunks)
    if not np.isfinite(audio).all() or not 10 <= len(audio) / 24000 <= 30:
        raise RuntimeError("The synthetic reference is outside the comparison limits.")
    output = LOCAL / "bright-reference.wav"
    with wave.open(str(output), "wb") as wav:
        wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(24000)
        wav.writeframes((np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes())
    output.chmod(0o600)
    metadata = {"label": "Bright synthetic voice · Kokoro Sky", "transcript": TEXT, "voice": "af_sky", "durationSeconds": len(audio) / 24000, "model": "hexgrad/Kokoro-82M", "modelRevision": REVISION, "speed": 1.08, "purpose": "Original synthetic comparison reference. Not Tails or a movie performance."}
    metadata_path = LOCAL / "bright-reference.json"
    metadata_path.write_text(json.dumps(metadata, indent=2)); metadata_path.chmod(0o600)
    print(f"Created {output}\nTranscript and provenance: {metadata_path}")

if __name__ == "__main__":
    main()
