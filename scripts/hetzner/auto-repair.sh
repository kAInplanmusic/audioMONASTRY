#!/usr/bin/env bash
# =============================================================================
# sampleMONK auto-repair – Watchdog für Container- und App-Gesundheit
# -----------------------------------------------------------------------------
# Läuft per systemd-Timer alle 2 Minuten auf App-Knoten:
#   1. Ungesunde Docker-Container neu starten (restart)
#   2. /api/health 3x prüfen; schlägt alles fehl -> sample-monk neu erstellen
#   3. Alles in /var/log/samplemonk-auto-repair.log protokollieren
#
# Installation: sudo bash scripts/hetzner/install-auto-repair.sh
# =============================================================================
set -uo pipefail
LOG="${LOG:-/var/log/samplemonk-auto-repair.log}"
ts() { date -u +%FT%TZ; }

log() { echo "[auto-repair] $(ts) $*" >> "$LOG"; }

if ! command -v docker >/dev/null 2>&1; then
  log "docker fehlt – überspringe"
  exit 0
fi

# --- 1) Ungesunde Container neu starten ---
UNHEALTHY=$(docker ps --filter "health=unhealthy" --format '{{.Names}}' 2>/dev/null || true)
if [[ -n "$UNHEALTHY" ]]; then
  for c in $UNHEALTHY; do
    log "Container ungesund: $c -> restart"
    docker restart "$c" >/dev/null 2>&1 || true
  done
fi

# --- 2) App-Health prüfen (nur wenn die App auf diesem Knoten läuft) ---
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^samplemonk$'; then
  FAILS=0
  for i in 1 2 3; do
    if curl -fsS --max-time 5 http://127.0.0.1/api/health >/dev/null 2>&1; then
      FAILS=0
      break
    fi
    FAILS=$((FAILS + 1))
    sleep 5
  done
  if [[ "$FAILS" -ge 3 ]]; then
    log "App-Health 3x fehlgeschlagen -> sample-monk neu erstellen"
    cd /opt/samplemonk 2>/dev/null || exit 0
    docker compose -f docker-compose.hetzner.yml up -d --force-recreate sample-monk >/dev/null 2>&1 || true
  fi
fi

log "Check abgeschlossen (unhealthy=$UNHEALTHY)"
