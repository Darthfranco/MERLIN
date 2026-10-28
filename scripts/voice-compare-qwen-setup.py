#!/usr/bin/env python3
"""Install the exact Qwen 0.6B ANE comparison backend into ignored local storage."""

from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "local/voice-compare/qwen-runtime"
MODELS = ROOT / "local/voice-compare/qwen-model"
SOURCE_REVISION = "60e0ddaf8797e4c33043427a6c7712833f4d82d3"
MODEL_REPO = "tinytrashlabs/Qwen3-TTS-0.6B-Base-ANE"
MODEL_REVISION = "551e82a5618b4804a51559bc508fece40d63b6a7"
TARGETS = ("GVoiceKit", "GVoiceProductionKit", "QwenANE")
RUNTIME_NAME = "Swift Core ML; talker CPU/GPU, code predictor CPU/ANE"


def run(*args, cwd=None):
    subprocess.run(args, cwd=cwd, check=True, stdout=sys.stderr)


def fingerprint(path, entry):
    size = path.stat().st_size if path.is_file() else -1
    if size != entry["size"]:
        return False
    lfs = entry.get("lfs")
    digest = hashlib.sha256() if lfs else hashlib.sha1()
    if not lfs:
        digest.update(f"blob {size}\0".encode())
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest() == (lfs["sha256"] if lfs else entry["blobId"])


def download(entry):
    relative = Path(entry["rfilename"])
    if relative.is_absolute() or ".." in relative.parts:
        raise RuntimeError("Unsafe model path")
    target = MODELS / relative
    if fingerprint(target, entry):
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + ".partial")
    url = f"https://huggingface.co/{MODEL_REPO}/resolve/{MODEL_REVISION}/{relative.as_posix()}"
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=180) as response, temporary.open("wb") as output:
                shutil.copyfileobj(response, output, length=1024 * 1024)
            if not fingerprint(temporary, entry):
                raise RuntimeError(f"Checksum mismatch: {relative}")
            temporary.replace(target)
            print(f"Downloaded {relative}", file=sys.stderr)
            return
        except Exception:
            temporary.unlink(missing_ok=True)
            if attempt == 3:
                raise
            time.sleep(attempt + 1)


def main():
    if platform.system() != "Darwin" or platform.machine() != "arm64" or int(platform.mac_ver()[0].split(".")[0]) < 15:
        raise SystemExit("Qwen ANE comparison requires an Apple Silicon Mac with macOS 15 or later.")
    for command in ("git", "swift"):
        if not shutil.which(command):
            raise SystemExit(f"Missing {command}; install Apple Command Line Tools first.")
    RUNTIME.mkdir(parents=True, exist_ok=True)
    source = RUNTIME / "source"
    if not (source / ".git").is_dir():
        run("git", "clone", "--depth", "1", "--filter=blob:none", "--sparse",
            "https://github.com/TinyTrashLabs/gloam-voice-studio.git", str(source))
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source, text=True).strip()
    if revision != SOURCE_REVISION:
        run("git", "fetch", "--depth", "1", "origin", SOURCE_REVISION, cwd=source)
        run("git", "checkout", "--detach", SOURCE_REVISION, cwd=source)
    run("git", "sparse-checkout", "set", *(f"Sources/{target}" for target in TARGETS), cwd=source)

    # Reuse upstream targets, without its unrelated app/MLX dependency graph.
    package = RUNTIME / "package"
    for target in TARGETS:
        destination = package / "Sources" / target
        if destination.exists():
            shutil.rmtree(destination)
        shutil.copytree(source / "Sources" / target, destination)
    # The exact export's stateful multifunction talker cannot load with CPU/ANE on
    # this M1/macOS 26.3.1. CPU/GPU loads both decode and prefill. Keep both on the
    # same fixed backend so their shared MLState is compatible, and do not include
    # failed ANE attempts in every cold benchmark. The model bytes stay unchanged.
    talker = package / "Sources/QwenANE/ANETalker.swift"
    original = "            c.computeUnits = .cpuAndNeuralEngine\n"
    contents = talker.read_text()
    if contents.count(original) != 1:
        raise RuntimeError("Pinned Qwen loader changed; refusing an unchecked compatibility patch")
    talker.write_text(contents.replace(original,
        "            c.computeUnits = name.hasPrefix(\"talker\") ? .cpuAndGPU : .cpuAndNeuralEngine\n"))
    shutil.copy2(source / "LICENSE", package / "UPSTREAM-LICENSE")
    worker = package / "Sources/VoiceCompareQwen"
    worker.mkdir(parents=True, exist_ok=True)
    shutil.copy2(ROOT / "scripts/voice-compare-qwen/main.swift", worker / "main.swift")
    shutil.copy2(ROOT / "scripts/voice-compare-qwen/Package.swift", package / "Package.swift")
    run("swift", "build", "-c", "release", "-j", "2", "--product", "voice-compare-qwen", cwd=package)
    binary_dir = subprocess.check_output(["swift", "build", "-c", "release", "--show-bin-path"], cwd=package, text=True).strip()
    shutil.copy2(Path(binary_dir) / "voice-compare-qwen", RUNTIME / "voice-compare-qwen")

    with urllib.request.urlopen(f"https://huggingface.co/api/models/{MODEL_REPO}/revision/{MODEL_REVISION}?blobs=true", timeout=60) as response:
        manifest = json.load(response)
    if manifest["sha"] != MODEL_REVISION:
        raise RuntimeError("Model revision mismatch")
    entries = [entry for entry in manifest["siblings"] if entry["rfilename"] != ".gitattributes"]
    MODELS.mkdir(parents=True, exist_ok=True)
    print(f"Verifying/downloading {sum(entry['size'] for entry in entries):,} model bytes", file=sys.stderr)
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(download, entries))
    (MODELS / "download-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (RUNTIME / "installation.json").write_text(json.dumps({"sourceRevision": SOURCE_REVISION, "modelRevision": MODEL_REVISION,
                                                          "modelRepo": MODEL_REPO, "zipFoundation": "0.9.19", "adapterRevision": 3,
                                                          "talkerComputeUnits": "cpuAndGPU", "codePredictorComputeUnits": "cpuAndNeuralEngine"}, indent=2) + "\n")
    print(json.dumps({"available": True, "runtime": RUNTIME_NAME, "requiresReference": True}))


if __name__ == "__main__":
    main()
