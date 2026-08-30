#!/usr/bin/env bash
# =============================================================================
# provision-fleet.sh – sampleMONK 5er-Hetzner-Flotte provisionieren
# -----------------------------------------------------------------------------
#   app-1     CX33 (4 vCPU/8GB)   Rolle app     + Floating IP (DNS)
#   sfu-1     CX33 (4 vCPU/8GB)   Rolle sfu     (RTP-Ports 40000-40099 offen)
#   ai-1      CX33 (4 vCPU/8GB)   Rolle ai      (Ollama/Stem-CPU-Fallback)
#   master-1  CX23 (2 vCPU/4GB)   Rolle master  (master-player)
#   edge-1    CX23 (2 vCPU/4GB)   Rolle app     (Staging/Monitoring/Smoke)
#
# Alle Einheiten: stündlich abgerechnet, Auto-Shutdown installierbar.
# Voraussetzung: HCLOUD_TOKEN in .env.deploy (oder Umgebung).
#
# Aufruf:
#   bash scripts/hetzner/provision-fleet.sh
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/../.."

# .env.deploy laden, falls vorhanden
if [[ -f .env.deploy ]]; then
  set -a; . ./.env.deploy; set +a
fi
[[ -n "${HCLOUD_TOKEN:-}" ]] || { echo "HCLOUD_TOKEN fehlt (.env.deploy)" >&2; exit 1; }

PY=python3
PROV=scripts/hetzner/provision.py
LOG_DIR=/tmp/samplemonk-fleet
mkdir -p "$LOG_DIR"

provision_one() {
  local name="$1" type="$2" role="$3" fw="$4" fip="$5"
  echo "=== Provisioniere $name ($type, role=$role, firewall=$fw, floating-ip=$fip) ==="
  SERVER_NAME="$name" SERVER_TYPE="$type" ROLE="$role" FIREWALL_NAME="$fw" FLOATING_IP_NAME="$fip" \
    "$PY" "$PROV" >"$LOG_DIR/$name.log" 2>&1 || {
      echo "❌ $name fehlgeschlagen – siehe $LOG_DIR/$name.log"
      return 1
    }
  echo "✅ $name fertig: $(grep 'Feste IP:' "$LOG_DIR/$name.log" | sed 's/^ *//' || true)"
}

provision_one samplemonk-app-1    cx33 app    samplemonk-app    samplemonk-floating
provision_one samplemonk-sfu-1    cx33 sfu    samplemonk-sfu    none
provision_one samplemonk-ai-1     cx33 ai     samplemonk-ai     none
provision_one samplemonk-master-1 cx23 master samplemonk-master none
provision_one samplemonk-edge-1   cx23 app    samplemonk-edge   none

echo ""
echo "=============================================================="
echo "Flotte provisioniert. Deploy-Befehle:"
echo "=============================================================="
echo "  app-1:    DEPLOY_HOST=root@<app-1-ip>    DEPLOY_DOMAIN=anunnakitools.de bash deploy.sh"
echo "  sfu-1:    DEPLOY_HOST=root@<sfu-1-ip>    DEPLOY_DOMAIN= bash deploy.sh  + docker-compose.sfu.yml"
echo "  ai-1:     SSH ai-1  -> Ollama + Stem-AI (siehe docs/SERVER_FLEET.md)"
echo "  master-1: SSH master-1 -> docker compose -f docker-compose.hetzner.yml up -d master-player"
echo "  edge-1:   SSH edge-1 -> Monitoring-Stack + Smoke-Tests"
echo "  Auto-Shutdown: ssh root@<ip> 'bash /opt/samplemonk/scripts/hetzner/install-idle-shutdown.sh'"
