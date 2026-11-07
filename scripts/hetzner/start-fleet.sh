#!/usr/bin/env bash
# =============================================================================
# start-fleet.sh – audioMONASTRY Fleet Start Script (Agent & User Ready)
# ----------------------------------------------------------------------------
# Startet die komplette audioMONASTRY-Flotte:
#   - RunPod AI Pods (brain, ears, voice, stems, music)
#   - Hetzner Server (falls nicht vorhanden)
#   - App-Deploy (falls nötig)
#   - RTC-Wirhung
#
# AWFRUF:
#   cd /mnt/wd-elements/Medien/Projekte/audioMONASTRY
#   set -a; . ./.env.deploy; set +a
#   bash scripts/hetzner/start-fleet.sh
#
# ALLES andere wird automatisch erkannt und übersprungen.
# =============================================================================
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

# Logging
LOG_FILE="${DEPLOY_LOG_FILE:-$HOME/fleet-start-$(date +%F-%H%M%S).log}"
exec > >(tee -a "$LOG_FILE") 2>&1

ok() { printf '[OK]    %s\n' "$1"; }
warn() { printf '[WARN]  %s\n' "$1"; }
fail() { printf '[FAIL]  %s\n' "$1"; }
step() { printf '\n=== %s ===\n\n' "$1"; }

# Load environment
[[ -f .env.deploy ]] || { fail ".env.deploy fehlt"; exit 1; }
set -a; source .env.deploy; set +a

# Validate required keys
[[ -z "${RP_API_KEY:-}" ]] && { fail "RP_API_KEY fehlt"; exit 1; }
[[ -z "${AI_POD_TOKEN:-}" ]] && { fail "AI_POD_TOKEN fehlt"; }
[[ ${#AI_POD_TOKEN} -lt 32 ]] && { fail "AI_POD_TOKEN zu kurz (>=32)"; exit 1; }
ok "API-Keys vorhanden"

# --- Check RunPod Pods ---
step "RunPod Pods Status"

PODS_RUNNING=$(curl -s -H "Authorization: Bearer ${RP_API_KEY}" "https://rest.runpod.io/v1/pods" | python3 -c "import sys,json; pods=json.load(sys.stdin); print(len([p for p in pods if p.get('status')=='RUNNING']))" 2>/dev/null || echo "0")

if [[ "$PODS_RUNNING" == "0" ]]; then
    step "Starting RunPod Pods"
    python3 scripts/runpod-pods.py up --yes --wait 900 2>&1 | tee -a "$LOG_FILE"
    ok "RunPod Pods gestartet"
else
    warn "$PODS_RUNNING Pods laufen bereits"
fi

# --- Check Hetzner Server ---
step "Hetzner Server Status"

SERVERS=$(curl -s -H "Authorization: Bearer ${HCLOUD_TOKEN}" "https://api.hetzner.cloud/v1/servers?name=audiomonastry-sfu-1" | python3 -c "import sys,json; d=json.load(sys.stdin); s=d['servers'][0] if d.get('servers') else None; print(s['id'] if s else '')" 2>/dev/null || echo "")

if [[ -n "$SERVERS" ]]; then
    DEPLOY_HOST=$(curl -s -H "Authorization: Bearer ${HCLOUD_TOKEN}" "https://api.hetzner.cloud/v1/servers?name=audiomonastry-sfu-1" | python3 -c "import sys,json; d=json.load(sys.stdin); s=d['servers'][0] if d.get('servers') else None; print(s.get('public_net',{}).get('ipv4',{}).get('ip','') if s else '')" 2>/dev/null || echo "")
    warn "Server existiert bereits: $DEPLOY_HOST"
else
    step "Provisioning Hetzner Server"
    python3 scripts/hetzner/provision.py --type cx43 --location fsn1 --role sfu 2>&1 | tee -a "$LOG_FILE"
    ok "Server provisioned"
    
    DEPLOY_HOST=$(curl -s -H "Authorization: Bearer ${HCLOUD_TOKEN}" "https://api.hetzner.cloud/v1/servers?name=audiomonastry-sfu-1" | python3 -c "import sys,json; d=json.load(sys.stdin); s=d['servers'][0] if d.get('servers') else None; print(s.get('public_net',{}).get('ipv4',{}).get('ip','') if s else '')" 2>/dev/null || echo "")
fi

# --- Check App Health ---
step "App Health Check"

sleep 5  # Wait for services
HEALTH=$(curl -s "https://${DEPLOY_DOMAIN}/api/health" 2>&1)
if echo "$HEALTH" | grep -q '"status".*"ok"'; then
    ok "App healthy: $HEALTH"
else
    warn "App nicht bereit: $HEALTH"
    echo "Starte erneut den Deploy..."
    DEPLOY_IMAGE_SOURCE=registry DEPLOY_HOST="$DEPLOY_HOST" DEPLOY_DOMAIN="$DEPLOY_DOMAIN" bash deploy.sh 2>&1 | tee -a "$LOG_FILE"
fi

# --- Update RP_POD_ID in .env ---
step "RunPod Pod-IDs"

python3 scripts/runpod-pods.py status 2>&1 | grep "RP_POD_ID_" || warn "Pod-IDs abfragen..."

# --- Summary ---
echo ""
echo "Fleet Status:"
echo "  - Log: $LOG_FILE"
echo "  - App: https://$DEPLOY_DOMAIN"
echo "  - Host: $DEPLOY_HOST"
echo ""
echo "Zum Beenden (mit Snapshot):"
echo "  bash scripts/hetzner/delete-fleet.sh --yes"
echo "  python3 scripts/runpod-pods.py down --yes"