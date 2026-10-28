#!/usr/bin/env python3
"""Build/probe/launch the exact Nano Core ML comparison worker (macOS arm64).

Run --setup once to build the pinned community runtime and download public model
artifacts. This is reference conditioning, not model-weight fine-tuning. All
weights, generated audio and reference conditioning stay out of Git under local/.
Upstream Core ML compilation also maintains its standard Application Support
cache at ~/Library/Application Support/com.chatterbox.coreml/CompiledModels.
"""
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "scripts" / "voice-compare-chatterbox"
BUILD = ROOT / "local" / "voice-compare" / "chatterbox-build"
BINARY = BUILD / "release" / "merlin-chatterbox-worker"
RUNTIME = "Chatterbox Nano · Swift/Core ML (community port)"


def unavailable_reason():
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        return "Chatterbox Nano Core ML requires Apple Silicon and macOS 15 or newer."
    if int(platform.mac_ver()[0].split(".")[0]) < 15:
        return "Chatterbox Nano Core ML requires macOS 15 or newer."
    if not BINARY.is_file():
        return "Nano is not installed. Run python3 scripts/voice-compare-chatterbox.py --setup."
    return None


def main():
    environment = os.environ.copy()
    environment["HF_HOME"] = str(ROOT / "local" / "voice-compare" / "chatterbox-cache")
    environment.pop("HF_HUB_CACHE", None)
    if "--setup" in sys.argv:
        if platform.system() != "Darwin" or platform.machine() != "arm64":
            raise SystemExit("This exact Core ML runtime needs Apple Silicon macOS 15+.")
        if not shutil.which("swift"):
            raise SystemExit("Install the Xcode command-line tools before building this Swift runtime.")
        BUILD.mkdir(parents=True, exist_ok=True)
        subprocess.run([
            "swift", "build", "--package-path", str(PACKAGE),
            "--scratch-path", str(BUILD), "--configuration", "release",
            "--jobs", "2", "--product", "merlin-chatterbox-worker",
        ], check=True, env=environment, stdout=sys.stderr)
        subprocess.run([sys.executable, str(ROOT / "scripts" / "voice-compare-chatterbox-download.py")],
                       check=True, env=environment, stdout=sys.stderr)
        os.execve(str(BINARY), [str(BINARY), "--probe"], environment)
    reason = unavailable_reason()
    if reason:
        if "--probe" in sys.argv:
            print(json.dumps({"available": False, "reason": reason, "runtime": RUNTIME}))
        else:
            for line in sys.stdin:
                try:
                    request = json.loads(line)
                    identifier = request.get("id")
                except (ValueError, AttributeError):
                    identifier = None
                print(json.dumps({"id": identifier, "ok": False, "error": reason}), flush=True)
        return
    os.execve(str(BINARY), [str(BINARY), *sys.argv[1:]], environment)


if __name__ == "__main__":
    main()
