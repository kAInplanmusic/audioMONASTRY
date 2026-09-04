#!/usr/bin/env bash
# SampleMONK AI Runtime – Startup
# - liest runtime_config.yaml (env hat Vorrang)
# - startet Uvicorn mit graceful shutdown
# - klare Startup-Fehler über strukturierte Logs
set -euo pipefail
cd "$(dirname "$0")"

export HF_HOME="${HF_HOME:-/data/hf-cache}"
export AI_RUNTIME_DEVICE="${AI_RUNTIME_DEVICE:-cuda}"
export AI_MODEL_MANIFEST="${AI_MODEL_MANIFEST:-$(pwd)/model_manifest.json}"

echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"level\":\"INFO\",\"service\":\"samplemonk-ai-runtime\",\"msg\":\"starting\",\"device\":\"${AI_RUNTIME_DEVICE}\",\"manifest\":\"${AI_MODEL_MANIFEST}\"}"

# Modelle werden NICHT manuell installiert – Gewichte kommen aus dem HF-Hub
# in den persistenten HF_HOME-Cache (Revision-Pinning im Manifest).
exec uvicorn app:app \
  --host 0.0.0.0 \
  --port "${PORT:-8000}" \
  --workers 1 \
  --timeout-keep-alive 30
