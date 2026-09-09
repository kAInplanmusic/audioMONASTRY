#!/usr/bin/env bash
# =============================================================================
# fleet-status.sh – Live-Status der gesamten sampleMONK-Flotte auf einen Blick
# -----------------------------------------------------------------------------
# Zeigt für alle Hetzner-Knoten: Status (off/running), aktuelle IPv4,
# SSH-Erreichbarkeit, Container-Status und App-/Master-Health.
#
# Die Knoten-IPs werden DYNAMISCH aus der Hetzner-API gelesen (keine
# hartkodierten Alt-IPs mehr; nach jedem Wake/Recreate bleiben sie korrekt).
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

# Serverliste als TSV: name<TAB>status<TAB>ip
python3 -c "
import json
d = json.load(open('/tmp/hc_fleet.json'))
rows = []
for s in d.get('servers', []):
    ip = (s.get('public_net') or {}).get('ipv4', {}).get('ip', '')
    rows.append((s['name'], s.get('status', '?'), ip))
    print(f\"{s['name']:24} {s.get('status','?'):8} {ip}\")
with open('/tmp/hc_fleet.tsv', 'w') as f:
    for name, status, ip in rows:
        f.write(f'{name}\t{status}\t{ip}\n')
"

echo ""
echo "--- Knoten-Details ---"
while IFS=$'\t' read -r name status ip; do
  [ -n "$ip" ] || continue
  printf "%-24s " "$name ($ip)"
  if [ "$status" != "running" ]; then
    echo "Server-Status: $status (nicht laufend)"
    continue
  fi
  $S "root@$ip" 'docker ps --format "{{.Names}}({{.Status}})" 2>/dev/null | tr "\n" " "; echo' 2>/dev/null || echo "SSH nicht erreichbar"
done < /tmp/hc_fleet.tsv

echo ""
echo "--- Health-Endpoints ---"
# App-Knoten (samplemonk-app-*) direkt prüfen
while IFS=$'\t' read -r name status ip; do
  [ -n "$ip" ] || continue
  case "$name" in
    samplemonk-app-*)
      CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 8 "http://$ip/api/health" 2>/dev/null || echo "000")
      echo "http://$ip/api/health ($name) -> HTTP $CODE"
      ;;
  esac
done < /tmp/hc_fleet.tsv

# Portal (öffentlicher Einstieg)
CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 8 "https://anunnakitools.de/api/health" 2>/dev/null || echo "000")
echo "https://anunnakitools.de/api/health -> HTTP $CODE"
echo "master: $(curl -s --max-time 8 https://master.anunnakitools.de/health 2>/dev/null || echo 'nicht erreichbar')"
