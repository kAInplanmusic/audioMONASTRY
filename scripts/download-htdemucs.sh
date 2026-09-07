#!/bin/bash
# audioMONASTRY · htdemucs.onnx Download
# ======================================
# Stand: 2026-09-07
# HtmDemucs ist ein ONNX-Export von Meta's htdemucs (split vocals/bass/drums/guitar)
# Quelle: https://github.com/facebookresearch/htdemucs
# Modell-Größe: ~824 MB (htdemucs.onnx)
# Ziel: public/models/htdemucs/

set -euo pipefail

MODEL_URL="https://github.com/facebookresearch/htdemucs/raw/main/htdemucs.onnx"
OUTPUT_DIR="public/models/htdemucs"
MODEL_FILE="$OUTPUT_DIR/htdemucs.onnx"

echo "Downloading htdemucs.onnx ($MODEL_URL)..."
mkdir -p "$OUTPUT_DIR"

if command -v curl &> /dev/null; then
    curl -L -o "$MODEL_FILE" "$MODEL_URL"
elif command -v wget &> /dev/null; then
    wget -O "$MODEL_FILE" "$MODEL_URL"
else
    echo "ERROR: curl or wget required" >&2
    exit 1
fi

if [ ! -f "$MODEL_FILE" ]; then
    echo "ERROR: Download failed, $MODEL_FILE not found" >&2
    exit 1
fi

MODEL_SIZE=$(du -h "$MODEL_FILE" | cut -f1)
echo "✅ Download complete: $MODEL_FILE ($MODEL_SIZE)"

# Hinweis: ONNX-Modell kann 5–10 Minuten laden (erstes Mal: Kompilierung)
