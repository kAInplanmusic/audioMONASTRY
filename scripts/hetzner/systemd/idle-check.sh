#!/usr/bin/env bash
# =============================================================================
# sampleMONK Hetzner idle check – läuft periodisch per systemd-Timer.
# Fährt die Instanz herunter, wenn über IDLE_MINUTES keine Aktivität messbar
# ist (stündliche Abrechnung → Kosten sparen).
#
# Aktivitäts-Signale:
#   1. Aktive User-Sessions (Socket.io) via /api/online (primär)
#   2. Etablierte TCP-Verbindungen auf App-/Proxy-Ports (80/443/8080)
#   3. Aktive SSH-Sessions
#   4. CPU-Load >= 1 (Builds, Stem-/Mastering-Jobs)
#   5. Docker-Container mit > 5 % CPU (optionale Erkennung aktiver Jobs)
# =============================================================================
set -uo pipefail
LOG="${LOG:-/var/log/samplemonk-idle-shutdown.log}"
STATE_FILE="${STATE_FILE:-/run/samplemonk-idle-count}"
IDLE_MINUTES="${IDLE_MINUTES:-30}"
CHECK_INTERVAL="${CHECK_INTERVAL:-5}"
IDLE_CYCLES=$(( IDLE_MINUTES / CHECK_INTERVAL ))
ts() { date -u +%FT%TZ; }

HTTP_ACTIVE=$(ss -tn state established 2>/dev/null | awk 'NR>1 && $4 ~ /:(8080|443|80)$/ {n++} END{print n+0}')
SSH_SESSIONS=$(who 2>/dev/null | grep -c 'pts/' || true)
LOAD1=$(cut -d' ' -f1 /proc/loadavg 2>/dev/null | cut -d'.' -f1 || echo 0)
BUSY_CONTAINERS=0
if command -v docker >/dev/null 2>&1; then
  BUSY_CONTAINERS=$(docker stats --no-stream --format '{{.CPUPerc}}' 2>/dev/null \
    | awk -F'%' '{gsub(/ /,"",$1); if ($1+0 > 5) n++} END{print n+0}')
fi

# Primär: aktive User-Sessions über die App-API (via Caddy localhost:80).
# Auf Knoten ohne App (master/ai) schlägt curl fehl -> ONLINE_USERS bleibt 0,
# aber HTTP/SSH/Load/Busy-Container greifen weiterhin als Fallback.
ONLINE_USERS=0
if command -v curl >/dev/null 2>&1; then
  ONLINE_USERS=$(curl -fsS --max-time 5 http://127.0.0.1/api/online 2>/dev/null \
    | awk -F'"online":' '{n=$2+0} END{print n+0}' 2>/dev/null || echo 0)
fi

echo "[idle-check] $(ts)  ONLINE=$ONLINE_USERS HTTP=$HTTP_ACTIVE SSH=$SSH_SESSIONS LOAD1=$LOAD1 BUSY_CONTAINERS=$BUSY_CONTAINERS" >> "$LOG"

if [[ "$ONLINE_USERS" -gt 0 || "$HTTP_ACTIVE" -gt 0 || "$SSH_SESSIONS" -gt 0 || "${LOAD1:-0}" -ge 1 || "$BUSY_CONTAINERS" -gt 0 ]]; then
  echo "0" > "$STATE_FILE"
  exit 0
fi

CURRENT=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
NEXT=$(( CURRENT + 1 ))
echo "$NEXT" > "$STATE_FILE"

if [[ "$NEXT" -ge "$IDLE_CYCLES" ]]; then
  echo "[idle-check] $(ts)  ** IDLE ($IDLE_MINUTES min) - shutting down **" >> "$LOG"
  shutdown -h now "sampleMONK: idle shutdown after ${IDLE_MINUTES} min"
fi
