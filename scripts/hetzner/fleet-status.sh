#!/usr/bin/env bash
# =============================================================================
# fleet-status.sh – Live-Status der gesamten audioMONASTRY-Flotte auf einen Blick
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

# NOMEN-P1-001 / F10: Namen aus der EINEN Quelle (Knoten, Container,
# Compose-Projekt, Pfade). Sourcing ist seiteneffektfrei; der Altpraefix steht
# ausschliesslich dort - dieses Skript kennt nur die Variablen.
source "$(dirname "$0")/fleet-names.sh"
FLEET_PROJECT="$(fleet_compose_project)"

echo "=== audioMONASTRY Fleet-Status ($(date -u +%FT%TZ)) ==="
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
echo "--- Knoten-Details (Container + Compose-Projekt) ---"
while IFS=$'\t' read -r name status ip; do
  [ -n "$ip" ] || continue
  printf "%-24s " "$name ($ip)"
  if [ "$status" != "running" ]; then
    echo "Server-Status: $status (nicht laufend)"
    continue
  fi
  # F10: das Compose-Projekt je Container mit ausgeben. Ein Knoten, dessen
  # Projekt noch alt heisst (Altname aus fleet-names.sh), wird unten laut
  # gemeldet - das ist genau der Befund aus F10 (Container/Projekt laufen
  # auseinander), und sichtbar wird er nur, wenn man ihn abfragt.
  PS_OUT=$($S "root@$ip" 'docker ps --format "{{.Names}}({{.Status}})[projekt={{.Label \"com.docker.compose.project\"}}]" 2>/dev/null | tr "\n" " "; echo' 2>/dev/null) \
    || PS_OUT="SSH nicht erreichbar"
  echo "$PS_OUT"
  if [[ "$PS_OUT" == *"[projekt=$LEGACY_COMPOSE_PROJECT]"* ]]; then
    echo "   ⚠ mindestens ein Container laeuft im ALT-Projekt '$LEGACY_COMPOSE_PROJECT' (erwartet: $FLEET_PROJECT)"
    echo "     Migration: bash scripts/hetzner/migrate-project-name.sh <ip> --role <rolle>  (docs/HETZNER_DEPLOY.md, F10)"
  fi
done < /tmp/hc_fleet.tsv

echo ""
echo "--- Health-Endpoints ---"
# App-Knoten direkt prüfen. NOMEN-P1-001/F10: die Muster kommen aus
# fleet-names.sh (FLEET_PREFIX/LEGACY_FLEET_PREFIX) - der Health-Check muss BEIDE
# Schreibweisen akzeptieren, sonst bleibt er bei einer noch nicht umbenannten
# Flotte stumm.
while IFS=$'\t' read -r name status ip; do
  [ -n "$ip" ] || continue
  case "$name" in
    "${FLEET_PREFIX}"app-*|"${LEGACY_FLEET_PREFIX}"app-*)
      CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 8 "http://$ip/api/health" 2>/dev/null || echo "000")
      echo "http://$ip/api/health ($name) -> HTTP $CODE"
      ;;
  esac
done < /tmp/hc_fleet.tsv

# Portal (öffentlicher Einstieg)
CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 8 "https://anunnakitools.de/api/health" 2>/dev/null || echo "000")
echo "https://anunnakitools.de/api/health -> HTTP $CODE"
echo "master: $(curl -s --max-time 8 https://master.anunnakitools.de/health 2>/dev/null || echo 'nicht erreichbar')"
