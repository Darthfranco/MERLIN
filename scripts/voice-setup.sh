#!/usr/bin/env bash
set -euo pipefail

voice_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
voice_venv="$voice_root/local/voice-venv"
voice_models="$voice_root/local/voice-model"

if command -v uv >/dev/null 2>&1; then
  if [ ! -x "$voice_venv/bin/python" ]; then
    uv venv --python 3.12 "$voice_venv"
  fi
  uv pip install --python "$voice_venv/bin/python" -r "$voice_root/scripts/voice-requirements.txt" -r "$voice_root/scripts/voice-listener-requirements.txt"
else
  if ! command -v python3.12 >/dev/null 2>&1; then
    echo 'Install uv or Python 3.12, then run npm run setup:voice again.' >&2
    exit 1
  fi
  if [ ! -x "$voice_venv/bin/python" ]; then
    python3.12 -m venv "$voice_venv"
  fi
  "$voice_venv/bin/python" -m pip install -r "$voice_root/scripts/voice-requirements.txt" -r "$voice_root/scripts/voice-listener-requirements.txt"
fi

echo 'Preparing official Kokoro-82M and Fenrir locally (first setup downloads the model).'
HF_HUB_DISABLE_TELEMETRY=1 DO_NOT_TRACK=1 "$voice_venv/bin/python" "$voice_root/scripts/voice-worker.py" --model-dir "$voice_models" --setup
echo 'Preparing local MERLIN keyword spotting and speech detection.'
"$voice_venv/bin/python" "$voice_root/scripts/voice-listener-setup.py" --model-dir "$voice_root/local/voice-listener-model"
