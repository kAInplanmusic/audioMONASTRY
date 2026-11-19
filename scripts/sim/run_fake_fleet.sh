#!/usr/bin/env bash
# Startet 8 Ersatz-Pods (eine je Rolle) auf 127.0.0.1:18001-18008 und schreibt die App-Umgebung nach $SIM_DIR/sim-runtime.env.
# Aufruf: bash scripts/sim/run_fake_fleet.sh [SIM_DIR]   (Standard: ./sim)   Stoppen: kill $(cat $SIM_DIR/pids)
# Optionen per Umgebung: READY_AFTER=Sekunden, FAIL_ROLE=<rolle> + FAIL_TASK=<task>, LATENCY=Sekunden, HOST=127.0.0.1,
#   SKIP_ROLE=<rolle> (Pod fehlt), EUR_PER_HOUR=0.5 (Preis je Pod fuer das App-Budget), NO_PRICE=1 (Preise weglassen -> App muss blocken),
#   READY_TIMEOUT_MS=30000 (App-Wartezeit auf /ready)
set -euo pipefail
cd "$(dirname "$0")/../.."
SIM_DIR="${1:-sim}"; HOST="${HOST:-127.0.0.1}"
mkdir -p "$SIM_DIR/certs"; SIM_DIR="$(cd "$SIM_DIR" && pwd)"; : > "$SIM_DIR/pids"; : > "$SIM_DIR/ca.pem"
TOKEN="${AI_POD_TOKEN:-$(python3 -c 'import secrets;print(secrets.token_urlsafe(48))')}"
ROLES=(brain ears voice music studio audio-brain song vis)
{
  echo "AI_GPU_PROVIDER=vast"; echo "AI_FLEET_MODE=pods"; echo "AI_POD_TOKEN=$TOKEN"
  echo "NODE_EXTRA_CA_CERTS=$SIM_DIR/ca.pem"
  echo "AI_POD_READY_TIMEOUT_MS=${READY_TIMEOUT_MS:-30000}"; echo "AI_POD_READY_POLL_MS=1000"
} > "$SIM_DIR/sim-runtime.env"
port=18001
for role in "${ROLES[@]}"; do
  name=$(echo "$role" | tr 'a-z-' 'A-Z_')
  [ "${NO_PRICE:-0}" = "1" ] || echo "VAST_POD_EUR_PER_HOUR_$name=${EUR_PER_HOUR:-0.5}" >> "$SIM_DIR/sim-runtime.env"
  if [ "${SKIP_ROLE:-}" = "$role" ]; then port=$((port + 1)); continue; fi
  c="$SIM_DIR/certs/$role.pem"; k="$SIM_DIR/certs/$role.key"
  openssl req -x509 -newkey rsa:2048 -nodes -keyout "$k" -out "$c" -days 7 -subj "/CN=$HOST" -addext "subjectAltName=IP:$HOST" >/dev/null 2>&1
  cat "$c" >> "$SIM_DIR/ca.pem"
  extra=()
  [ "${FAIL_ROLE:-}" = "$role" ] && extra+=(--fail-task "${FAIL_TASK:-}")
  python3 scripts/sim/fake_pod.py --role "$role" --port "$port" --host "$HOST" --cert "$c" --key "$k" --token "$TOKEN" \
    --log "$SIM_DIR/requests.jsonl" --ready-after "${READY_AFTER:-0}" --latency "${LATENCY:-0}" "${extra[@]}" >> "$SIM_DIR/fake-pods.log" 2>&1 &
  echo $! >> "$SIM_DIR/pids"
  echo "VAST_POD_URL_$name=https://$HOST:$port" >> "$SIM_DIR/sim-runtime.env"
  port=$((port + 1))
done
sleep 1
echo "Ersatz-Pods laufen (PIDs in $SIM_DIR/pids). App-Umgebung: $SIM_DIR/sim-runtime.env  Protokoll: $SIM_DIR/requests.jsonl"
