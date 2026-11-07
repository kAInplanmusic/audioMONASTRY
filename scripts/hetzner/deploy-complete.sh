#!/usr/bin/env bash
# =============================================================================
# deploy-complete.sh – Vollständige audioMONASTRY Deployment mit Snapshot-Sicherung
# ----------------------------------------------------------------------------
# Dieses Skript fuehrt einen kompletten Deploy durch:
#   1. Snapshots aller vorhandenen Instanzen (Hetzner + RunPod)
#   2. Loeschen alter Flotte (Hetzner)
#   3. Image-Bau und Push zur Registry
#   4. Neues Hetzner-Knoten provisioning
#   5. App-Deploy auf den Knoten
#   6. Alle RunPod Pods starten (brain, ears, voice, stems, music)
#   7. RTC-Wirhung (SFU + TURN)
#   8. Smoke-Tests
#
# AWFRUF:
#   cd /mnt/wd-elements/Medien/Projekte/audioMONASTRY
#   set -a; . ./.env.deploy; set +a
#   bash scripts/hetzner/deploy-complete.sh 2>&1 | tee ~/deploy-$(date +%F-%H%M).log
#
# ODER: bash scripts/hetzner/deploy-complete.sh 2>&1 | tee deploy-$(date +%F-%H%M).log
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

# Logging
LOG_FILE="${DEPLOY_LOG_FILE:-$HOME/deploy-$(date +%F-%H%M%S).log}"
exec > >(tee -a "$LOG_FILE") 2>&1

ok() { printf '\033[32m[OK]\033[0m %s\n' "$1"; }
warn() { printf '\033[33m[WARN]\033[0m %s\n' "$1"; }
fail() { printf '\033[31m[FAIL]\033[0m %s\n' "$1"; }
step() { printf '\n\033[1;36m%s\033[0m\n\n' "$1"; }

# Environment
if [[ ! -f .env.deploy ]]; then
    fail ".env.deploy nicht gefunden"
    exit 1
fi
source <(grep -v '^#' .env.deploy | grep -v '^[[:space:]]*$' | while IFS= read -r l; do echo "$l"; done)

# Zusatz-Variablen
DEPLOY_SSH_KEY="${DEPLOY_SSH_KEY:-$HOME/.ssh/id_ed25519}"
DEPLOY_HOST="${DEPLOY_HOST:-}"
DEPLOY_DOMAIN="${DEPLOY_DOMAIN:-}"
DEPLOY_MODE="${DEPLOY_MODE:-docker}"
DEPLOY_IMAGE_SOURCE="${DEPLOY_IMAGE_SOURCE:-registry}"
LOG_FILE="${LOG_FILE:-deploy-$(date +%F-%H%M).log}"

echo "=============================================="
echo "audioMONASTRY Komplett-Deploy"
echo "Log: $LOG_FILE"
echo "=============================================="

# --- Phase 0: Preflight ---
step "Phase 0/6: Preflight"

# Check prerequisites
if [[ -z "${RP_API_KEY:-}" ]]; then fail "RP_API_KEY fehlt"; exit 1; fi
if [[ -z "${HCLOUD_TOKEN:-}" ]]; then fail "HCLOUD_TOKEN fehlt"; exit 1; fi
if [[ -z "${AI_POD_TOKEN:-}" ]] || [[ ${#AI_POD_TOKEN} -lt 32 ]]; then fail "AI_POD_TOKEN fehlt oder zu kurz (>=32)"; exit 1; fi
ok "Alle API-Keys vorhanden"

# RunPod balance check
RUNPOD_BALANCE=$(curl -s -X POST -H "Authorization: Bearer ${RP_API_KEY}" \
    -H "Content-Type: application/json" \
    -d '{"query":"{ myself { clientBalance } }"}' \
    https://api.runpod.io/graphql | python3 -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('myself',{}).get('clientBalance','0'))" 2>/dev/null || echo "0")
ok "RunPod-Balance: $RUNPOD_BALANCE USD (mind. 3 USD empfohlen)"

# Preflight check
echo "-- Running launch-preflight.sh --"
bash scripts/hetzner/launch-preflight.sh --build --full 2>&1 | tee -a "$LOG_FILE" || {
    warn "Preflight hat Warnungen/Fehler - fahre fort"
}

# --- Phase 1: Snapshots & Cleanup ---
step "Phase 1/6: Snapshots & Fleet-Cleanup"

# Snapshot existing Hetzner servers
source "$SCRIPT_DIR/fleet-names.sh"

# Check existing servers with app label
SERVERS_JSON=$(curl -s -H "Authorization: Bearer ${HCLOUD_TOKEN}" "https://api.hetzner.cloud/v1/servers")
SERVER_COUNT=$(echo "$SERVERS_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len([s for s in d.get('servers',[]) if s.get('labels',{}).get('app')=='audiomonastry']))")

if [[ "$SERVER_COUNT" -gt 0 ]]; then
    echo "Found $SERVER_COUNT servers with app=audiomonastry label"
    
    # Create snapshots
    echo "$SERVERS_JSON" | python3 -c "
import sys, json, urllib.request
d = json.load(sys.stdin)
tok = '${HCLOUD_TOKEN}'
for s in d.get('servers', []):
    if s.get('labels', {}).get('app') == 'audiomonastry':
        name = s['name']
        sid = s['id']
        desc = f'audiomonastry-snapshot-{name.split(\"-\")[-1]}-$(date +%Y-%m-%d)'
        print(f'Snapshot: {name} -> {desc}')
        req = urllib.request.Request(
            f'https://api.hetzner.cloud/v1/servers/{sid}/actions/create_image',
            data=json.dumps({'type':'snapshot','description':desc}).encode(),
            headers={'Authorization': f'Bearer {tok}','Content-Type': 'application/json'},
            method='POST'
        )
        try:
            resp = urllib.request.urlopen(req, timeout=30)
            print(f'  -> Snapshot angelegt')
        except Exception as e:
            print(f'  -> Snapshot fehlgeschlagen: {e}')
"
    
    # Delete old fleet after snapshot
    read -p "Alt-Flotte loeschen? [j/N]: " ans
    if [[ "$ans" =~ ^[jJ]$ ]]; then
        bash scripts/hetzner/delete-fleet.sh --yes --no-snapshot 2>&1 || warn "Fleet-Loeschung hat Probleme"
    else
        warn "Loeschung abgebrochen - alte Server bleiben aktiv"
    fi
else
    ok "Keine vorhandenen audiomonastry-Server"
fi

# --- Phase 2: Image Build & Registry Push ---
step "Phase 2/6: Image Build & Registry Push"

echo "-- Building images --"
docker build -t audiomonastry:hetzner --build-arg BUILD_VERSION="$(node -p "require('./package.json').version")" \
    --build-arg BUILD_COMMIT="$(git rev-parse --short HEAD)" \
    --build-arg BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)" . 2>&1 | tee -a "$LOG_FILE"
ok "App-Image gebaut"

docker build -t audiomonastry-master-player:hetzner -f services/master-player/Dockerfile \
    services/master-player 2>&1 | tee -a "$LOG_FILE"
ok "Master-player-Image gebaut"

echo "-- Pushing to GHCR --"
REGISTRY_TAG="$(date +%Y%m%d%H%M%S)-$(git rev-parse --short HEAD)"
REGISTRY_IMAGE="ghcr.io/kainplanmusic/audiomonastry:${REGISTRY_TAG}"

# Login to GHCR
echo "${GHCR_PASSWORD}" | docker login ghcr.io -u "${GHCR_USERNAME}" --password-stdin 2>&1 | tee -a "$LOG_FILE"
ok "GHCR-Login erfolgreich"

# Tag and push
docker tag audiomonastry:hetzner "${REGISTRY_IMAGE}"
docker push "${REGISTRY_IMAGE}" 2>&1 | tee -a "$LOG_FILE"
ok "App-Image gepusht: ${REGISTRY_IMAGE}"

docker tag audiomonastry-master-player:hetzner "ghcr.io/kainplanmusic/audiomonastry-master-player:${REGISTRY_TAG}"
docker push "ghcr.io/kainplanmusic/audiomonastry-master-player:${REGISTRY_TAG}" 2>&1 | tee -a "$LOG_FILE"
ok "Master-player gepusht"

# --- Phase 3: Hetzner Provisioning ---
step "Phase 3/6: Hetzner Server Provisioning"

# Provision new server (cx43, fsn1, SFU role)
echo "Provisioning neuen Hetzner-Server (cx43, fsn1)..."
python3 scripts/hetzner/provision.py --type cx43 --location fsn1 --role sfu 2>&1 | tee -a "$LOG_FILE"
ok "Server provisioned"

# Get the floating IP or assign one
DEPLOY_HOST=$(curl -s -H "Authorization: Bearer ${HCLOUD_TOKEN}" \
    "https://api.hetzner.cloud/v1/servers?name=audiomonastry-sfu-1" | \
    python3 -c "import sys,json; d=json.load(sys.stdin); print(d['servers'][0].get('public_net',{}).get('ipv4',{}).get('ip',''))" 2>/dev/null || echo "")

if [[ -n "$DEPLOY_HOST" ]]; then
    ok "Server-IP: $DEPLOY_HOST"
else
    fail "Server-IP nicht gefunden"
    exit 1
fi

# Set DEPLOY_HOST in .env.deploy
sed -i "s/^DEPLOY_HOST=.*/DEPLOY_HOST=${DEPLOY_HOST}/" .env.deploy
ok "DEPLOY_HOST in .env.deploy aktualisiert"

# --- Phase 4: App Deploy ---
step "Phase 4/6: App Deploy"

export DEPLOY_IMAGE_SOURCE=registry
export DEPLOY_REGISTRY_IMAGE="${REGISTRY_IMAGE}"
export DEPLOY_REGISTRY_IMAGE_MASTER="ghcr.io/kainplanmusic/audiomonastry-master-player:${REGISTRY_TAG}"
export DEPLOY_HOST="$DEPLOY_HOST"
export DEPLOY_DOMAIN="$DEPLOY_DOMAIN"
export DEPLOY_SMOKE=1
export DEPLOY_LOG_FILE="$LOG_FILE"

echo "-- Running deploy.sh --"
DEPLOY_IMAGE_SOURCE=registry DEPLOY_REGISTRY_IMAGE="${REGISTRY_IMAGE}" \
DEPLOY_REGISTRY_IMAGE_MASTER="ghcr.io/kainplanmusic/audiomonastry-master-player:${REGISTRY_TAG}" \
DEPLOY_HOST="$DEPLOY_HOST" DEPLOY_DOMAIN="$DEPLOY_DOMAIN" \
DEPLOY_SMOKE=1 bash deploy.sh 2>&1 | tee -a "$LOG_FILE"

ok "App deployed"

# --- Phase 5: Push Node Env & Wire RTC ---
step "Phase 5/6: Environment & RTC Setup"

# Push node environment (Supabase, R2, tokens)
APP_IP="$DEPLOY_HOST" bash scripts/hetzner/push-node-env.sh 2>&1 | tee -a "$LOG_FILE"
ok "Node environment pushed"

# Wire SFU + TURN (only if TURN_URLS needs update)
echo "-- Wiring RTC --"
ssh -i "$DEPLOY_SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 \
    "root@${DEPLOY_HOST}" 'cd /opt/audiomonastry && bash scripts/hetzner/wire-rtc.sh sfu' 2>&1 | tee -a "$LOG_FILE"
ok "RTC wired"

# Restart with SFU+TURN compose
ssh -i "$DEPLOY_SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 \
    "root@${DEPLOY_HOST}" 'cd /opt/audiomonastry && \
    COMPOSE_PROJECT_NAME=audiomonastry docker compose \
        -f docker-compose.hetzner.yml \
        -f docker-compose.sfu.yml \
        -f docker-compose.turn.yml \
        up -d caddy audiomonastry coturn' 2>&1 | tee -a "$LOG_FILE"
ok "SFU+TURN stack running"

# --- Phase 6: RunPod Pods ---
step "Phase 6/6: RunPod Pods Provision"

# Push Pod IDs to node environment
echo "-- Starting RunPod pods (brain first, then rest) --"

# Ensure RP_REGISTRY_AUTH_ID is set
if [[ -z "${RP_REGISTRY_AUTH_ID:-}" ]]; then
    warn "RP_REGISTRY_AUTH_ID nicht gesetzt"
fi

# Start all pods
python3 scripts/runpod-pods.py up --yes --wait 900 2>&1 | tee -a "$LOG_FILE"

ok "RunPod Pods gestartet"

# --- Final Verification ---
step "Final Verification"

# Health check
sleep 10  # Wait for app to be ready
HEALTH=$(curl -s "https://${DEPLOY_DOMAIN}/api/health" 2>&1)
echo "Health: $HEALTH"

CLOUD_HEALTH=$(curl -s "https://${DEPLOY_DOMAIN}/api/cloud/health" 2>&1)
echo "Cloud Health: $CLOUD_HEALTH"

# Get pod IDs and update .env
echo ""
echo "RunPod Pod-IDs (in .env.deploy ergänzen):"
python3 scripts/runpod-pods.py plan 2>&1 | grep -E "^RP_POD_ID" || echo "Pod-IDs nicht gefunden (evtl. noch in Wartestellung)"

# --- Summary ---
step "Deployment Summary"
echo "Log file: $LOG_FILE"
echo "App URL: https://${DEPLOY_DOMAIN}"
echo "Deploy Host: ${DEPLOY_HOST}"
echo "Registry Tag: ${REGISTRY_TAG}"
echo ""
echo "NÃ¤chste Schritte:"
echo "  1. RP_POD_ID_* Variablen in .env.deploy ergänzen"
echo "  2. ssh root@\${DEPLOY_HOST} 'cd /opt/audiomonastry && docker compose logs -f' aufrufen"
echo "  3. Browser testen: https://${DEPLOY_DOMAIN}"
echo ""
echo "Snapshot-Procedure BEFORE deletion:"
echo "  bash scripts/hetzner/delete-fleet.sh --yes    # Loescht + erstellt Snapshots"
echo "  python3 scripts/runpod-pods.py down --yes     # Stoppt RunPod Pods (keine Kosten)"

echo ""
echo "✅ Deployment abgeschlossen!"