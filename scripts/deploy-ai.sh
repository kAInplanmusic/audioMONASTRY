#!/usr/bin/env bash
# audioMONASTRY – AI-Runtime Deployment (Hetzner-Smoke / HF-Endpoint-Vorbereitung)
# ===============================================================================
# bauen → testen → deployen → health-checken. Produktions-GPU-Deployment läuft
# über den HF-Inference-Endpoint (hf_endpoint.example.json); dieses Skript ist
# der reproduzierbare lokale/Hetzner-Pfad.
set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSE="docker compose -f docker-compose.ai.yml"

echo "==> 1/4 Build"
$COMPOSE build

echo "==> 2/4 Start"
$COMPOSE up -d

echo "==> 3/4 Health-Check (max 90s)"
healthy=0
for _ in $(seq 1 30); do
  if curl -fsS http://localhost:8000/health >/dev/null 2>&1; then healthy=1; break; fi
  sleep 3
done
if [ "$healthy" -ne 1 ]; then
  echo "FEHLER: AI-Runtime nicht gesund." >&2
  $COMPOSE logs --tail=100
  exit 1
fi

echo "==> 4/4 Status"
curl -fsS http://localhost:8000/status || true

echo
echo "==> AI-Runtime bereit. Rollback: $COMPOSE down && docker compose -f docker-compose.ai.yml build --no-cache"
