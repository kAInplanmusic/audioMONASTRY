#!/usr/bin/env bash
# =============================================================================
# audioMONASTRY – Docker-Gate (Release-Gate: Container-Build + Startup + Health)
# -----------------------------------------------------------------------------
# Baut die Container, startet sie, prüft /api/health und räumt wieder auf.
# Voraussetzung: Docker + docker compose auf dem Zielhost.
#   bash scripts/docker-gate.sh
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Docker-Build (docker compose build)"
docker compose -f docker-compose.yml build

echo "==> Container-Start"
docker compose -f docker-compose.yml up -d
trap 'docker compose -f docker-compose.yml down' EXIT

echo "==> Health-Check (max. 60s)"
healthy=0
for _ in $(seq 1 30); do
  if curl -fsS http://localhost:8080/api/health >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 2
done

if [ "$healthy" -ne 1 ]; then
  echo "FEHLER: /api/health nicht erreichbar." >&2
  docker compose -f docker-compose.yml logs --tail=100
  exit 1
fi

echo "==> Docker-Gate OK"
