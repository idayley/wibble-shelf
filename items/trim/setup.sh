#!/bin/sh
# Sets up Trim's judge: a Python runtime with mlx-lm, and a 4-bit copy of
# Qwen3.5-4B, both kept in $WIBBLE_HELPER_HOME (Wibble gives it). Wibble
# runs this once, when you press Set up on Trim's page. Safe to run again:
# every step it already finished is skipped.
set -eu
H="${WIBBLE_HELPER_HOME:?Wibble sets WIBBLE_HELPER_HOME}"
mkdir -p "$H"

if [ "$(uname -m)" != "arm64" ]; then
  echo "The judge needs an Apple silicon Mac (M1 or later). Trim still works without it."
  exit 1
fi

# A judge set up by hand before Trim could (README, older versions) is reused.
OLD_VENV="$HOME/.venvs/openjev"
OLD_MODEL="$HOME/.cache/openjev/qwen35-4b-q4"

ok_python() { "$1" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; }

if [ ! -x "$H/venv/bin/python" ]; then
  if [ -x "$OLD_VENV/bin/python" ] && "$OLD_VENV/bin/python" -c 'import mlx_lm' 2>/dev/null; then
    echo "Using the judge runtime already in $OLD_VENV."
    ln -s "$OLD_VENV" "$H/venv"
  else
    PY=""
    for c in python3.14 python3.13 python3.12 python3.11 python3.10 python3; do
      p="$(command -v "$c" 2>/dev/null || true)"
      if [ -n "$p" ] && ok_python "$p"; then PY="$p"; break; fi
    done
    if [ -z "$PY" ]; then
      echo "Python 3.10 or newer is needed. Install it (brew install python), then press Set up again."
      exit 1
    fi
    echo "Making a Python runtime with $PY."
    "$PY" -m venv "$H/venv"
  fi
fi

if ! "$H/venv/bin/python" -c 'import mlx_lm' 2>/dev/null; then
  echo "Installing mlx-lm (the model runtime)."
  "$H/venv/bin/pip" install --disable-pip-version-check -q mlx-lm
fi

if [ ! -f "$H/model/config.json" ]; then
  if [ -f "$OLD_MODEL/config.json" ]; then
    echo "Using the judge model already in $OLD_MODEL."
    rm -rf "$H/model"
    ln -s "$OLD_MODEL" "$H/model"
  else
    echo "Downloading Qwen3.5-4B (about 9 GB, once)."
    HF_HUB_OFFLINE=0 "$H/venv/bin/python" -c 'from huggingface_hub import snapshot_download; snapshot_download("Qwen/Qwen3.5-4B")'
    echo "Making the 4-bit copy the judge runs (about 2.5 GB)."
    rm -rf "$H/model.partial"
    "$H/venv/bin/python" -m mlx_lm convert --hf-path Qwen/Qwen3.5-4B --mlx-path "$H/model.partial" \
      --quantize --q-bits 4 --q-group-size 64 --dtype bfloat16
    mv "$H/model.partial" "$H/model"
    echo "You can delete the full download from ~/.cache/huggingface to get the 9 GB back."
  fi
fi

echo "The judge is ready."
