#!/usr/bin/env bash
# SampleMONK AI Runtime – Startup
# - liest runtime_config.yaml (env hat Vorrang)
# - startet Uvicorn mit graceful shutdown
# - klare Startup-Fehler über strukturierte Logs
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

export HF_HOME="${HF_HOME:-/data/hf-cache}"
# AD-H9: Gerät validieren (cpu|cuda|mps|auto), Default auto statt blind cuda.
AI_RUNTIME_DEVICE="${AI_RUNTIME_DEVICE:-auto}"
case "$AI_RUNTIME_DEVICE" in
  cpu|cuda|mps|auto) ;;
  *) echo "Ungültiges AI_RUNTIME_DEVICE: $AI_RUNTIME_DEVICE -> auto" >&2; AI_RUNTIME_DEVICE=auto ;;
esac
export AI_RUNTIME_DEVICE
# AD-I1: Manifest-Default an das Script-Verzeichnis binden (nicht an pwd).
export AI_MODEL_MANIFEST="${AI_MODEL_MANIFEST:-$SCRIPT_DIR/model_manifest.json}"

echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"level\":\"INFO\",\"service\":\"samplemonk-ai-runtime\",\"msg\":\"starting\",\"device\":\"${AI_RUNTIME_DEVICE}\",\"manifest\":\"${AI_MODEL_MANIFEST}\"}"

# Modelle werden NICHT manuell installiert – Gewichte kommen aus dem HF-Hub
# in den persistenten HF_HOME-Cache (Revision-Pinning im Manifest).
exec uvicorn app:app \
  --host 0.0.0.0 \
  --port "${PORT:-8000}" \
  --workers 1 \
  --timeout-keep-alive 30
