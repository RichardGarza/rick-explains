#!/usr/bin/env bash
# Prepare vendor/ for electron-builder extraResources (not committed to git).
# Requires: Homebrew ollama (arm64), local qwen2.5:7b in ~/.ollama, network once for Kokoro, Node 22+ for `npm run dist`.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

OLLAMA_SRC="${OLLAMA_LIBEXEC:-/opt/homebrew/Cellar/ollama}"
if [[ ! -x "${OLLAMA_SRC}"/*/libexec/ollama ]]; then
  # Resolve latest cellar
  OLLAMA_BIN="$(readlink -f /opt/homebrew/bin/ollama 2>/dev/null || readlink /opt/homebrew/bin/ollama)"
  OLLAMA_LIBEXEC="$(cd "$(dirname "$OLLAMA_BIN")" && pwd)"
else
  OLLAMA_LIBEXEC="$(echo "${OLLAMA_SRC}"/*/libexec | awk '{print $NF}')"
fi
# Prefer real path next to brew binary
if [[ -x /opt/homebrew/Cellar/ollama/*/libexec/ollama ]]; then
  OLLAMA_LIBEXEC=$(ls -d /opt/homebrew/Cellar/ollama/*/libexec | tail -1)
fi

MODELS_SRC="${OLLAMA_MODELS_SRC:-$HOME/.ollama/models}"
echo "==> Ollama libexec: $OLLAMA_LIBEXEC"
echo "==> Models source:  $MODELS_SRC"

mkdir -p vendor/ollama vendor/ollama-models vendor/kokoro-model/onnx
cp "$OLLAMA_LIBEXEC/ollama" vendor/ollama/ollama
rsync -a "$OLLAMA_LIBEXEC/lib/" vendor/ollama/lib/
chmod +x vendor/ollama/ollama vendor/ollama/lib/ollama/* 2>/dev/null || true

if [[ ! -d "$MODELS_SRC/blobs" ]]; then
  echo "ERROR: no models at $MODELS_SRC — run: ollama pull qwen2.5:7b" >&2
  exit 1
fi
rsync -a "$MODELS_SRC/" vendor/ollama-models/

# Kokoro q8 ONNX (~90MB) — uses `hf` CLI (follows redirects; fixes Hub 307 issues)
if [[ ! -f vendor/kokoro-model/onnx/model_quantized.onnx || ! -f vendor/kokoro-model/config.json ]]; then
  if ! command -v hf >/dev/null 2>&1; then
    echo "ERROR: install Hugging Face CLI: pip install -U huggingface_hub" >&2
    exit 1
  fi
  echo "==> Downloading Kokoro-82M q8 ONNX..."
  hf download onnx-community/Kokoro-82M-v1.0-ONNX \
    config.json tokenizer.json tokenizer_config.json onnx/model_quantized.onnx \
    --local-dir vendor/kokoro-model
fi

du -sh vendor/ollama vendor/ollama-models vendor/kokoro-model
echo "==> vendor ready. Build with Node 22+: CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist"
