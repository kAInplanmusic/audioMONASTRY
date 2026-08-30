#!/usr/bin/env bash
# =============================================================================
# fleet-status.sh – Live-Status der gesamten sampleMONK-Flotte auf einen Blick
# -----------------------------------------------------------------------------
# Zeigt für alle 5 Knoten: Hetzner-Status (off/running), SSH erreichbar,
# Container-Status und App-/Master-Health.
#
# Aufruf (lokal, mit .env.deploy):
#   bash scripts/hetzner/fleet-status.sh
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")/../.."
if [[ -f .env.deploy ]]; then set -a; . ./.env.deploy; set +a; fi
[[ -n "${HCLOUD_TOKEN:-}" ]] || { echo "HCLOUD_TOKEN fehlt (.env.deploy)" >&2; exit 1; }

KEY="${DEPLOY_SSH_KEY:-$HOME/.ssh/id_ed25519}"
S="ssh -i $KEY -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null -o ConnectTimeout=8"

echo "=== sampleMONK Fleet-Status ($(date -u +%FT%TZ)) ==="
curl -s -H "Authorization: Bearer $HCLOUD_TOKEN" https://api.hetzner.cloud/v1/servers -o /tmp/hc_fleet.json
python3 -c "import json; d=json.load(open('/tmp/hc_fleet.json')); [print(f\"{s['name']:22} {s['status']:8} {(s.get('public_net') or {}).get('ipv4',{}).get('ip','')}\") for s in d.get('servers',[])]"

echo ""
echo "--- Knoten-Details ---"
for NODE in root@159.69.102.29 root@49.13.0.226 root@49.13.65.150 root@167.233.22.157 root@167.233.214.220; do
  printf "%-16s " "$NODE"
  $S "$NODE" 'docker ps --format "{{.Names}}({{.Status}})" 2>/dev/null | tr "\n" " "; echo' 2>/dev/null || echo "nicht erreichbar"
done

echo ""
echo "--- Health-Endpoints ---"
for URL in https://anunnakitools.de/api/health http://49.13.0.226/api/health http://167.233.214.220/api/health; do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 8 "$URL" 2>/dev/null || echo "000")
  echo "$URL -> HTTP $CODE"
done
echo "master: $(curl -s --max-time 8 https://master.anunnakitools.de/health 2>/dev/null || echo 'nicht erreichbar')"
