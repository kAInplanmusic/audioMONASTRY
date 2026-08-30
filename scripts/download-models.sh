#!/usr/bin/env bash
# audioMONASTRY – Demucs-ONNX-Modelle herunterladen (Hugging Face)
# Modell: smank/htdemucs-onnx (HTDemucs v4, 4 Stems: drums/bass/other/vocals)
set -euo pipefail
mkdir -p public/models
echo "Lade htdemucs.onnx (~291 MB) …"
curl -fL --proto '=https' -o public/models/htdemucs.onnx \
  "https://huggingface.co/smank/htdemucs-onnx/resolve/main/htdemucs.onnx"
ls -lh public/models/htdemucs.onnx
