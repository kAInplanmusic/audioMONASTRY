#!/usr/bin/env bash
# =============================================================================
# delete-fleet.sh – audioMONASTRY Hetzner-Flotte KOMPLETT löschen (0 €)
# -----------------------------------------------------------------------------
# Löscht alle 5 Server. Die Floating-IP (3 €/Monat) bleibt bewusst erhalten,
# damit die DNS (anunnakitools.de) weiterhin auf die feste IP zeigen kann.
#
# WICHTIG: Nur LÖSCHEN stoppt die Hetzner-Kosten – ausgeschaltete Server
# werden weiter berechnet (Ressourcen bleiben reserviert).
#
# Aufruf:
#   bash scripts/hetzner/delete-fleet.sh          (mit Rückfrage)
#   bash scripts/hetzner/delete-fleet.sh --yes    (ohne Rückfrage)
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")/../.."

if [[ -f .env.deploy ]]; then set -a; . ./.env.deploy; set +a; fi
[[ -n "${HCLOUD_TOKEN:-}" ]] || { echo "HCLOUD_TOKEN fehlt (.env.deploy)" >&2; exit 1; }

NAMES=(samplemonk-app-1 samplemonk-sfu-1 samplemonk-ai-1 samplemonk-master-1 samplemonk-edge-1)

if [[ "${1:-}" != "--yes" ]]; then
  echo "Folgende Server werden ENDGÜLTIG gelöscht:"
  printf '  - %s\n' "${NAMES[@]}"
  echo "Die Floating-IP (${FLOATING_IP_NAME:-samplemonk-floating}) bleibt reserviert (3 €/Monat)."
  read -r -p "Wirklich löschen? [j/N] " ans
  [[ "$ans" == "j" || "$ans" == "J" ]] || { echo "Abgebrochen."; exit 0; }
fi

for name in "${NAMES[@]}"; do
  id=$(curl -s -H "Authorization: Bearer $HCLOUD_TOKEN" "https://api.hetzner.cloud/v1/servers?name=$name" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); s=d['servers'][0] if d['servers'] else None; print(s['id'] if s else '')")
  if [[ -n "$id" ]]; then
    echo -n "Lösche $name (id=$id) … "
    code=$(curl -s -X DELETE -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $HCLOUD_TOKEN" "https://api.hetzner.cloud/v1/servers/$id")
    echo "$code"
  else
    echo "Überspringe $name (existiert nicht)."
  fi
done

echo
echo "== Verbleibende Server =="
curl -s -H "Authorization: Bearer $HCLOUD_TOKEN" "https://api.hetzner.cloud/v1/servers" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('Anzahl Server:', len(d['servers']))"
echo "== Floating-IPs (bleiben) =="
curl -s -H "Authorization: Bearer $HCLOUD_TOKEN" "https://api.hetzner.cloud/v1/floating_ips" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); [print(' ', f['ip'], '| server:', f.get('server')) for f in d['floating_ips']]"
echo
echo "✅ Flotte gelöscht – es fallen keine Server-Kosten mehr an."
echo "   Wieder hochfahren:  bash scripts/hetzner/bring-up-fleet.sh"
