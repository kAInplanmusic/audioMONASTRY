#!/usr/bin/env bash
# =============================================================================
# deploy-with-fake-gpu-local.sh – Lokaler Test mit Fake-GPU Backend
# ----------------------------------------------------------------------------
# Führt einen lokalen Test mit Fake-Pods durch (ohne Hetzner-Server).
#
# Aufruf:
#   bash scripts/sim/test-fake-gpu-local.sh
#
# Was passiert:
#   1. Fake-Pods lokal starten
#   2. App lokal starten
#   3. Browser-Test (optional)
#
# Vorteil: Kein Hetzner-Kosten, rein lokale Tests.
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/../.."

SIM_DIR="${SIM_DIR:-/tmp/audiomonastry-sim-local}"

step() { echo; echo "=== $* ==="; }

# --- 1. Fake-Pods starten -----------------------------------------------------
step "1/3 Fake-Pods starten (PseudoGPU-Backend)"

# Alte Pods stoppen falls vorhanden
pkill -f "fake_pod.py" 2>/dev/null || true
sleep 1

# Fake-Pods starten
export AI_GPU_PROVIDER="vast"
export AI_FLEET_MODE="pods"
bash scripts/sim/run_fake_fleet.sh "$SIM_DIR"

echo "Fake-Pods gestartet in $SIM_DIR"
cat "$SIM_DIR/sim-runtime.env"

# --- 2. App lokal starten ----------------------------------------------------
step "2/3 App lokal starten"

# Prüfen ob .env existiert oder erstellen
if [[ ! -f .env ]]; then
  echo "Erstelle .env aus sim-runtime.env..."
  cp "$SIM_DIR/sim-runtime.env" .env
else
  echo "Aktualisiere .env mit Fake-Pod URLs..."
  cp "$SIM_DIR/sim-runtime.env" .env
fi

# AI-Modus auf off setzen (keine echten GPU-Jobs)
echo "AI_MODE=off" >> .env

# App starten
echo "Starte App..."
docker compose up -d --build 2>&1 | tail -20 &

# Warten bis App bereit ist
echo "Warte auf App-Health..."
for i in {1..30}; do
  if curl -s http://127.0.0.1:8080/api/health 2>/dev/null | grep -q "ok"; then
    echo "App bereit!"
    break
  fi
  if [[ $i -eq 30 ]]; then
    echo "App nicht bereit nach 30s - prüfe Logs"
    docker compose logs --tail=50 audiomonastry || true
    exit 1
  fi
  sleep 1
done

# --- 3. Browser-Test ---------------------------------------------------------
step "3/3 Browser-Test"

echo "App läuft auf http://127.0.0.1:8080"
echo ""
echo "=== Test-Optionen ==="
echo "  1. Browser öffnen:     firefox http://127.0.0.1:8080"
echo "  2. Health-Check:       curl http://127.0.0.1:8080/api/health"
echo "  3. Web-RTC-Config:     curl http://127.0.0.1:8080/api/webrtc-config"
echo "  4. AI-Mode-Check:      curl http://127.0.0.1:8080/api/ai/mode"
echo ""
echo "=== Fake-Pod-Status ==="
curl -k -s -H "Authorization: Bearer testtoken" https://127.0.0.1:18001/health 2>&1 || echo "Brain-Pod nicht erreichbar"

echo ""
echo "=== FERTIG ==="
echo "App: http://127.0.0.1:8080"
echo "Fake-Pods: $SIM_DIR (Ports 18001-18008)"
echo ""
echo "Zum Stoppen: docker compose down && pkill -f fake_pod.py"