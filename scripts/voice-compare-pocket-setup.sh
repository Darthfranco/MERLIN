#!/usr/bin/env bash
set -euo pipefail

pocket_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
pocket_venv="$pocket_root/local/voice-compare/pocket-env"

if command -v uv >/dev/null 2>&1; then
  if [ ! -x "$pocket_venv/bin/python" ]; then
    uv venv --python 3.12 "$pocket_venv"
  fi
  uv pip install --python "$pocket_venv/bin/python" -r "$pocket_root/scripts/voice-compare-pocket-requirements.txt"
else
  if ! command -v python3.12 >/dev/null 2>&1; then
    echo 'Install uv or Python 3.12, then run this setup again.' >&2
    exit 1
  fi
  if [ ! -x "$pocket_venv/bin/python" ]; then
    python3.12 -m venv "$pocket_venv"
  fi
  "$pocket_venv/bin/python" -m pip install -r "$pocket_root/scripts/voice-compare-pocket-requirements.txt"
fi

if [ "${1:-}" = "--pytorch" ]; then
  echo 'Preparing the optional official Pocket Python CPU baseline.' >&2
  "$pocket_venv/bin/python" "$pocket_root/scripts/voice-compare-pocket.py" --setup
  exit
fi

pocket_source="$pocket_root/local/voice-compare/FluidAudio"
pocket_package="$pocket_root/local/voice-compare/pocket-native"
pocket_commit=4c65ad493a397410b2f8c354dd977c700fb55192
if [ ! -d "$pocket_source/.git" ]; then
  git clone --no-checkout --filter=blob:none https://github.com/FluidInference/FluidAudio.git "$pocket_source"
fi
git -C "$pocket_source" fetch --depth 1 origin "$pocket_commit"
git -C "$pocket_source" checkout --detach "$pocket_commit"
# Equivalent @TaskLocal expansion for Command Line Tools builds whose bundled
# SwiftMacros plugin is unavailable. Changes only this ignored dependency copy.
"$pocket_venv/bin/python" - "$pocket_source" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1]) / "Sources/FluidAudio/TTS/PocketTTS/Pipeline/PocketTtsSynthesizer.swift"
source = path.read_text()
old = "@TaskLocal static var modelStore: PocketTtsModelStore?"
new = "static let modelStoreContext = TaskLocal<PocketTtsModelStore?>(wrappedValue: nil)\n        static var modelStore: PocketTtsModelStore? { modelStoreContext.wrappedValue }"
if old in source:
    source = source.replace(old, new).replace("Context.$modelStore.withValue(store)", "Context.modelStoreContext.withValue(store)")
    path.write_text(source)
elif new not in source:
    raise RuntimeError("Pinned Pocket TaskLocal source changed; inspect before patching.")
PY
mkdir -p "$pocket_package/Sources/PocketWorker"
cp "$pocket_root/scripts/voice-compare-pocket.swift" "$pocket_package/Sources/PocketWorker/main.swift"
cat > "$pocket_package/Package.swift" <<'EOF'
// swift-tools-version: 6.2
import PackageDescription
let package = Package(name: "MerlinPocket", platforms: [.macOS(.v15)], products: [.executable(name: "merlin-pocket-worker", targets: ["PocketWorker"])], dependencies: [.package(path: "../FluidAudio", traits: ["TTS"])], targets: [.executableTarget(name: "PocketWorker", dependencies: [.product(name: "FluidAudio", package: "FluidAudio")])])
EOF
# The SDK owns libc++ headers on current Command Line Tools installations.
pocket_sdk="$(xcrun --show-sdk-path)"
swift build --package-path "$pocket_package" --configuration release --jobs 2 \
  --product merlin-pocket-worker -Xcxx -isystem -Xcxx "$pocket_sdk/usr/include/c++/v1"
echo 'Preparing the pinned public FluidInference Pocket 100M CoreML conversion and voice encoder.' >&2
"$pocket_venv/bin/python" "$pocket_root/scripts/voice-compare-pocket.py" --setup-coreml
