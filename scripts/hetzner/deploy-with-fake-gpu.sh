#!/usr/bin/env bash
# =============================================================================
# deploy-with-fake-gpu.sh – Hetzner-Flotte mit PseudoGPU-Backend (keine Vast.ai)
# ----------------------------------------------------------------------------
# Startet die 4 Hetzner-Rollen und verwendet die Fake-Pods statt echter Vast.ai-Pods.
#
# WICHTIG: Dieses Script startet die Fake-Pods auf dem Hetzner-Server, nicht lokal!
#
# Aufruf:
#   bash scripts/hetzner/deploy-with-fake-gpu.sh           (mit Rückfrage)
#   bash scripts/hetzner/deploy-with-fake-gpu.sh --yes     (ohne Rückfrage)
#   bash scripts/hetzner/deploy-with-fake-gpu.sh --print-config (Trockenlauf)
#
# Was passiert:
#   1. Hetzner-Server provisionieren (falls nötig)
#   2. App auf app-1 deployen
#   3. Fake-Pods auf app-1 starten (nicht lokal!)
#   4. Health-Checks und Smoke-Tests
#
# Vorteil: Keine GPU-Kosten, rein CPU-basiert, für Tests/Entwicklung.
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/../.."

# --- Konfiguration -----------------------------------------------------------
if [[ -f .env.deploy ]]; then set -a; . ./.env.deploy; set +a; fi

SSH_KEY="${DEPLOY_SSH_KEY:-$HOME/.ssh/id_ed25519}"
DOMAIN="${DEPLOY_DOMAIN:-hallerbans.de}"
APP_URL="https://$DOMAIN"

# Fake-Pod Konfiguration
FAKE_GPU_PORT_START=18001
FAKE_GPU_HOST="127.0.0.1"
FAKE_SIM_DIR="${FAKE_SIM_DIR:-/tmp/audiomonastry-sim}"

# Trockenlauf
if [[ "${1:-}" == "--print-config" || "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  echo "[dry-run] Hetzner + Fake-GPU Deploy (keine Vast.ai-Pods)"
  echo "  Domain: $DOMAIN"
  echo "  App URL: $APP_URL"
  echo "  Fake-Pods: 8 Rollen auf $FAKE_GPU_HOST:$FAKE_GPU_PORT_START-18008"
  echo "  Sim-Log: $FAKE_SIM_DIR/requests.jsonl"
  echo "  Umgebungsdatei: $FAKE_SIM_DIR/sim-runtime.env"
  echo ""
  echo "  Ablauf:"
  echo "    1. Hetzner-Server (app-1, sfu-1, media-1, edge-1) provisionieren"
  echo "    2. App auf app-1 deployen"
  echo "    3. Fake-Pods auf app-1 starten"
  echo "    4. Health-Checks und Smoke-Tests"
  echo ""
  echo "  Start: bash scripts/hetzner/deploy-with-fake-gpu.sh --yes"
  exit 0
fi

[[ -n "${HCLOUD_TOKEN:-}" ]] || { echo "HCLOUD_TOKEN fehlt (.env.deploy)" >&2; exit 1; }

if [[ "${1:-}" != "--yes" ]]; then
  echo "Achtung: Die Flotte wird provisioniert und kostet netto ca. 39 €/Monat,"
  echo "solange die Server existieren (auch ausgeschaltet!)."
  echo ""
  echo "INFO: Dieses Skript verwendet Fake-Pods statt Vast.ai GPU-Pods."
  echo "      Keine GPU-Kosten, aber die AI-Flugrolle simuliert."
  read -r -p "Jetzt starten? [j/N] " ans
  [[ "$ans" == "j" || "$ans" == "J" ]] || { echo "Abgebrochen."; exit 0; }
fi

step() { echo; echo "=== $* ==="; }

# --- 1. Provisionieren -------------------------------------------------------
step "1/6 Hetzner-Server provisionieren"
bash scripts/hetzner/provision-fleet.sh

# --- 2. IPs ermitteln -------------------------------------------------------
step "2/6 IPs ermitteln"
source scripts/hetzner/fleet-names.sh
APP_IP=$(curl -s -H "Authorization: Bearer ***" \
  "https://api.hetzner.cloud/v1/servers?name=audiomonastry-app-1" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); s=d['servers'][0] if d['servers'] else None; print(s['public_net']['ipv4']['ip'] if s else '')")
SFU_IP=$(curl -s -H "Authorization: Bearer ***" \
  "https://api.hetzner.cloud/v1/servers?name=audiomonastry-sfu-1" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); s=d['servers'][0] if d['servers'] else None; print(s['public_net']['ipv4']['ip'] if s else '')")
MEDIA_IP=$(curl -s -H "Authorization: Bearer ***" \
  "https://api.hetzner.cloud/v1/servers?name=audiomonastry-media-1" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); s=d['servers'][0] if d['servers'] else None; print(s['public_net']['ipv4']['ip'] if s else '')")
EDGE_IP=$(curl -s -H "Authorization: Bearer ***" \
  "https://api.hetzner.cloud/v1/servers?name=audiomonastry-edge-1" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); s=d['servers'][0] if d['servers'] else None; print(s['public_net']['ipv4']['ip'] if s else '')")

[[ -n "$APP_IP" ]] || { echo "App-IP nicht gefunden" >&2; exit 1; }
echo "app=$APP_IP sfu=$SFU_IP media=$MEDIA_IP edge=$EDGE_IP"

# --- 3. App deployen ---------------------------------------------------------
step "3/6 App auf app-1 deployen"
DEPLOY_HOST="root@$APP_IP" DEPLOY_DOMAIN="$DOMAIN" bash deploy.sh

# --- 4. Fake-Pods auf app-1 starten -----------------------------------------
step "4/6 Fake-Pods auf app-1 starten (PseudoGPU-Backend)"

# SSH-Kommando zum Starten der Fake-Pods auf dem Hetzner-Server
SSH=(ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 root@$APP_IP)

# Fake-Pods starten und Umgebung für App generieren
$SSH "mkdir -p $FAKE_SIM_DIR && cd /opt/audiomonastry && bash scripts/sim/run_fake_fleet.sh '$FAKE_SIM_DIR'" 2>&1 | head -20 || {
  echo "  ⚠ Fake-Pods-Start fehlgeschlagen"
}

# Prüfen ob sim-runtime.env erstellt wurde
$SSH "ls -la $FAKE_SIM_DIR/sim-runtime.env" || {
  echo "  ❌ sim-runtime.env nicht erstellt"
  exit 1
}

# Umgebungsvariablen in die App .env einbinden
$SSH "cd /opt/audiomonastry && cp $FAKE_SIM_DIR/sim-runtime.env .env && echo 'AI_MODE=off #' >> .env && docker compose up -d --force-recreate audiomonastry"

# --- 5. Health-Checks ---------------------------------------------------------
step "5/6 Health-Checks"
echo "App-Health: $(curl -s http://127.0.0.1:8080/api/health)"

# --- 6. Smoke-Test ------------------------------------------------------------
step "6/6 Smoke-Test"
bash scripts/hetzner/smoke-test.sh "$APP_URL" || echo "⚠ Smoke-Test fehlgeschlagen"

echo ""
echo "=== FERTIG ==="
echo "App: $APP_URL"
echo "Fake-Pods laufen auf app-1 in $FAKE_SIM_DIR"
echo "Log: $FAKE_SIM_DIR/requests.jsonl"
echo ""
echo "Zum Stoppen der Fake-Pods: ssh root@$APP_IP 'cd /opt/audiomonastry && pkill -f fake_pod.py'"
echo "Zum Löschen:  ssh root@$APP_IP 'cd /opt/audiomonastry && docker compose down' && bash scripts/hetzner/delete-fleet.sh"