#!/usr/bin/env python3
"""Launch the exact local Qwen ANE Swift JSON-lines worker; never downloads implicitly."""

import argparse
import json
import os
from pathlib import Path
import platform
import sys

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "local/voice-compare/qwen-runtime"
MODELS = ROOT / "local/voice-compare/qwen-model"
BINARY = RUNTIME / "voice-compare-qwen"
RUNTIME_NAME = "Swift Core ML; talker CPU/GPU, code predictor CPU/ANE"


def probe():
    reason = None
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        reason = "Requires an Apple Silicon Mac."
    elif int(platform.mac_ver()[0].split(".")[0]) < 15:
        reason = "Requires macOS 15 or later."
    elif not BINARY.is_file() or not os.access(BINARY, os.X_OK):
        reason = "Run python3 scripts/voice-compare-qwen-setup.py to build the Swift runtime."
    elif not (MODELS / "download-manifest.json").is_file() or not (RUNTIME / "installation.json").is_file():
        reason = "Run python3 scripts/voice-compare-qwen-setup.py to finish the model download."
    else:
        try:
            manifest = json.loads((MODELS / "download-manifest.json").read_text())
            installation = json.loads((RUNTIME / "installation.json").read_text())
            if installation.get("adapterRevision") != 3 or manifest["sha"] != installation["modelRevision"] or any(
                not (MODELS / entry["rfilename"]).is_file()
                or (MODELS / entry["rfilename"]).stat().st_size != entry["size"]
                for entry in manifest["siblings"] if entry["rfilename"] != ".gitattributes"
            ):
                reason = "The Qwen model installation is incomplete. Rerun its setup script."
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            reason = "The Qwen installation record is unreadable. Rerun its setup script."
    return {"available": reason is None, "reason": reason, "runtime": RUNTIME_NAME, "requiresReference": True,
            "model": "tinytrashlabs/Qwen3-TTS-0.6B-Base-ANE"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--probe", action="store_true")
    args = parser.parse_args()
    result = probe()
    if args.probe:
        print(json.dumps(result), flush=True)
        return
    if result["available"]:
        os.execv(str(BINARY), [str(BINARY), str(MODELS)])
    for line in sys.stdin:
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id") if isinstance(request, dict) else None
        except (ValueError, TypeError):
            pass
        print(json.dumps({"id": request_id, "ok": False, "error": result["reason"]}), flush=True)


if __name__ == "__main__":
    main()
