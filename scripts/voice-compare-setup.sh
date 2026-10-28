#!/usr/bin/env bash
set -euo pipefail
compare_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$compare_root"
if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  echo 'These exact community Core ML ports require an Apple Silicon Mac.' >&2
  exit 1
fi
command -v swift >/dev/null || { echo 'Install Apple Command Line Tools first: xcode-select --install' >&2; exit 1; }
if [ ! -x local/voice-venv/bin/python ] || [ ! -f local/voice-model/voices/am_fenrir.pt ]; then
  bash scripts/voice-setup.sh
fi
bash scripts/voice-compare-pocket-setup.sh
python3 scripts/voice-compare-chatterbox.py --setup
python3 scripts/voice-compare-qwen-setup.py
echo 'Four-model setup complete. Run npm run voice:compare. Add a permitted reference and transcript in the browser for Qwen.'
