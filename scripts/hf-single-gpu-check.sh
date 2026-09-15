#!/usr/bin/env bash
# ============================================================================
# HF-Single-GPU-Check – Harte Kostenregel: maximal 1 A100 für AudioMONASTRY
# ----------------------------------------------------------------------------
# Prüft, dass nur der Endpoint `audiomonastry-ai` konfiguriert ist und keine
# alten Einzel-GPU-Endpoints (pilot/clap) mehr aktiv sind.
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0

echo "==> 1/4 Env-Check (nur HF_ENDPOINT_URL, keine pilot/clap)"
if [[ -n "${HF_PILOT_ENDPOINT_URL:-}" ]]; then
  echo "FEHLER: HF_PILOT_ENDPOINT_URL ist gesetzt – bitte entfernen (deaktiviert)." >&2
  fail=1
fi
if [[ -n "${HF_CLAP_ENDPOINT_URL:-}" ]]; then
  echo "FEHLER: HF_CLAP_ENDPOINT_URL ist gesetzt – bitte entfernen (deaktiviert)." >&2
  fail=1
fi
if [[ -z "${HF_ENDPOINT_URL:-}" ]]; then
  echo "FEHLER: HF_ENDPOINT_URL fehlt – der einzige GPU-Endpoint muss gesetzt sein." >&2
  fail=1
fi
if [[ "${AI_MAX_GPU_ENDPOINTS:-1}" != "1" ]]; then
  echo "FEHLER: AI_MAX_GPU_ENDPOINTS muss 1 sein (aktuell: ${AI_MAX_GPU_ENDPOINTS:-unset})." >&2
  fail=1
fi

echo "==> 2/4 ProviderRouter-Check (HfStandardEndpointProvider deaktiviert)"
if grep -q "new HfStandardEndpointProvider()" src/core/ai/orchestrator/providerRouter.ts; then
  echo "FEHLER: HfStandardEndpointProvider ist noch im ProviderRouter registriert." >&2
  fail=1
fi

echo "==> 3/4 hf_manage_endpoint.py-Guard"
if ! grep -q "SINGLE_GPU_ENDPOINT_NAME = \"audiomonastry-ai\"" services/audiomonastry-ai-runtime/hf_manage_endpoint.py; then
  echo "FEHLER: Single-GPU-Guard fehlt in hf_manage_endpoint.py." >&2
  fail=1
fi

echo "==> 4/4 Modell-Manifest (alle Modelle auf einer Runtime)"
if ! python3 -c "import json;json.load(open('services/audiomonastry-ai-runtime/model_manifest.json'))"; then
  echo "FEHLER: model_manifest.json ist ungültig." >&2
  fail=1
fi

if [[ "$fail" -ne 0 ]]; then
  echo "STATUS: FAIL"
  exit 1
fi

echo "STATUS: PASS"
echo "GPU INSTANCES: 1 (audiomonastry-ai, A100)"
echo "ACTIVE A100: audiomonastry-ai"
echo "MIGRATED SERVICES: whisper-large-v3 (Pilot), clap-music (CLAP), ast-audioset, musicgen-small/medium, mms-tts-deu, bark, pyannote-diarization, qwen-omni"
echo "DISABLED/REMOVED GPU ENDPOINTS: audiomonastry-ai-pilot, audiomonastry-ai-clap"
