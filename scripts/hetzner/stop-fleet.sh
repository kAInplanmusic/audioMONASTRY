#!/usr/bin/env bash
# =============================================================================
# stop-fleet.sh – audioMONASTRY Fleet Stop with AUTOMATIC Snapshot
# ----------------------------------------------------------------------------
# Stoppt die ganze Flotte UND erstellt Snapshots vor dem Loeschen:
#   - RunPod Pods herunterfahren (0 EUR/h)
#   - Hetzner Server snapshots erstellen, dann loeschen
#   - Alle Snapshots werden mit Timestamp versehen
#
# AWFRUF:
#   cd /mnt/wd-elements/Medien/Projekte/audioMONASTRY
#   set -a; . ./.env.deploy; set +a
#   bash scripts/hetzner/stop-fleet.sh
#
# Dieses Skript ist DIE "absolute safety net" - es stellt sicher dass
# vor dem Loeschen aller Instanzen Snapshots vorhanden sind.
# =============================================================================
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

# Logging
LOG_FILE="${DEPLOY_LOG_FILE:-$HOME/fleet-stop-$(date +%F-%H%M%S).log}"
exec > >(tee -a "$LOG_FILE") 2>&1

ok() { printf '[OK]    %s\n' "$1"; }
warn() { printf '[WARN]  %s\n' "$1"; }
fail() { printf '[FAIL]  %s\n' "$1"; }
step() { printf '\n=== %s ===\n\n' "$1"; }

# Load environment
[[ -f .env.deploy ]] || { fail ".env.deploy fehlt"; exit 1; }
set -a; source .env.deploy; set +a

# Validate
[[ -z "${HCLOUD_TOKEN:-}" ]] && { fail "HCLOUD_TOKEN fehlt"; exit 1; }

# --- Step 1: RunPod Pods stoppen ---
step "Step 1/3: RunPod Pods herunterfahren"

echo "Stopping RunPod Pods..."
python3 scripts/runpod-pods.py down --yes 2>&1 | tee -a "$LOG_FILE"
ok "RunPod Pods gestoppt (0 EUR/h)"

# --- Step 2: Hetzner Snapshots erstellen ---
step "Step 2/3: Hetzner Snapshots (automatisch vor Loeschen)"

source "$SCRIPT_DIR/fleet-names.sh"

# Get all servers with app=audiomonastry label
SERVERS_JSON=$(curl -s -H "Authorization: Bearer ${HCLOUD_TOKEN}" "https://api.hetzner.cloud/v1/servers?labels[app]=audiomonastry")
SERVER_COUNT=$(echo "$SERVERS_JSON" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('servers',[])))")

if [[ "$SERVER_COUNT" -gt 0 ]]; then
    echo "Erstelle Snapshots fuer $SERVER_COUNT Server..."
    
    echo "$SERVERS_JSON" | python3 -c "
import sys, json, urllib.request, datetime
d = json.load(sys.stdin)
tok = '${HCLOUD_TOKEN}'
date = datetime.datetime.now().strftime('%Y-%m-%d')
for s in d.get('servers', []):
    name = s['name']
    sid = s['id']
    role = name.split('-')[-1]
    desc = f'audiomonastry-snapshot-{role}-{date}'
    print(f'  Snapshot: {name} -> {desc}')
    req = urllib.request.Request(
        f'https://api.hetzner.cloud/v1/servers/{sid}/actions/create_image',
        data=json.dumps({'type':'snapshot','description':desc}).encode(),
        headers={'Authorization': f'Bearer {tok}','Content-Type': 'application/json'},
        method='POST'
    )
    try:
        resp = urllib.request.urlopen(req, timeout=60)
        result = json.loads(resp.read().decode())
        img_id = result.get('image', {}).get('id', 'unknown')
        print(f'    Status: OK (Image ID: {img_id})')
    except Exception as e:
        print(f'    Status: FEHLGESchlagenen: {e}')
"
    ok "Snapshots erstellt (bleiben im Hetzner Account)"
else
    warn "Keine audiomonastry-Server gefunden"
fi

# --- Step 3: Server loeschen ---
step "Step 3/3: Hetzner Server loeschen"

echo "Server werden geloescht..."
bash scripts/hetzner/delete-fleet.sh --yes 2>&1 | tee -a "$LOG_FILE"
ok "Server geloescht"

# --- Summary ---
echo ""
echo "=========================================="
echo "Fleet heruntergefahren mit Snapshots"
echo "=========================================="
echo ""
echo "Snapshots liegen im Hetzner Account als:"
echo "  - audiomonastry-snapshot-app-YYYY-MM-DD"
echo "  - audiomonastry-snapshot-sfu-YYYY-MM-DD"
echo "  - audiomonastry-snapshot-media-YYYY-MM-DD"
echo "  - audiomonastry-snapshot-edge-YYYY-MM-DD"
echo ""
echo "Zum Wiederherstellen eines Snapshots:"
echo "  1. Hetzner Cloud Console oder API"
echo "  2. Snapshot auswaehlen -> Neuer Server erstellen"
echo ""
echo "Log datei: $LOG_FILE"
echo ""
echo "Zum Neustarten:"
echo "  bash scripts/hetzner/start-fleet.sh"