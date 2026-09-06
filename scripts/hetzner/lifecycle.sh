#!/usr/bin/env bash
# =============================================================================
# lifecycle.sh – audioMONASTRY Fleet-Lebenszyklus (Snapshot-Backup-Automatik)
# -----------------------------------------------------------------------------
# stop:  Erstellt für ALLE laufenden Server einen Instanz-Snapshot
#        (`<name>-auto-<timestamp>`), wartet auf Abschluss und LÖSCHT danach
#        die Server (0 €/Monat). Floating-IP bleibt reserviert.
# start: Holt aktuelle Repo-Änderungen in die lokale Arbeitskopie, bringt die
#        Flotte hoch (provisioniert, deployt den aktuellen Stand, Smoke-Test).
#
# Aufruf:
#   bash scripts/hetzner/lifecycle.sh stop
#   bash scripts/hetzner/lifecycle.sh start
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")/../.."
if [[ -f .env.deploy ]]; then set -a; . ./.env.deploy; set +a; fi
[[ -n "${HCLOUD_TOKEN:-}" ]] || { echo "HCLOUD_TOKEN fehlt (.env.deploy)" >&2; exit 1; }

NAMES=(samplemonk-app-1 samplemonk-master-1 samplemonk-edge-1 samplemonk-sfu-1 samplemonk-ai-1)
TS="$(date -u +%Y%m%d-%H%M)"

snapshot_all() {
  echo "=== Snapshot-Backup ($TS) ==="
  for NAME in "${NAMES[@]}"; do
    ID=$(curl -s -H "Authorization: Bearer $HCLOUD_TOKEN" "https://api.hetzner.cloud/v1/servers?name=$NAME" \
      | python3 -c "import sys,json; d=json.load(sys.stdin); s=d['servers'][0] if d['servers'] else None; print(s['id'] if s else '')")
    if [[ -z "$ID" ]]; then
      echo "Überspringe $NAME (existiert nicht)."
      continue
    fi
    DESC="${NAME}-auto-${TS}"
    RESP=$(curl -s -X POST -H "Authorization: Bearer $HCLOUD_TOKEN" -H "Content-Type: application/json" \
      -d "{\"description\":\"$DESC\",\"type\":\"snapshot\"}" \
      "https://api.hetzner.cloud/v1/servers/$ID/actions/create_image")
    ACTION=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('action',{}).get('id',''))" 2>/dev/null)
    echo "$NAME → Snapshot '$DESC' (Action $ACTION)"
  done
  echo "Warte 30 s auf Snapshot-Finalisierung …"; sleep 30
}

cmd_stop() {
  if [[ "${1:-}" != "--yes" ]]; then
    echo "Stoppt die Flotte: Snapshot-Backup + Server-LÖSCHEN (0 €/Monat)."
    read -r -p "Fortfahren? [j/N] " ans
    [[ "$ans" == "j" || "$ans" == "J" ]] || { echo "Abgebrochen."; exit 0; }
  fi
  snapshot_all
  echo "=== Server löschen ==="
  bash scripts/hetzner/delete-fleet.sh --yes
}

cmd_start() {
  echo "=== Lokalen Repo-Stand aktualisieren ==="
  git fetch origin main 2>/dev/null && git merge --ff-only origin/main 2>/dev/null \
    || echo "Hinweis: lokale Arbeitskopie bleibt unverändert (kein ff-only möglich)."
  echo "=== Flotte hochfahren (provisionieren + deployen + Smoke) ==="
  bash scripts/hetzner/bring-up-fleet.sh --yes
}

case "${1:-}" in
  stop)  cmd_stop "${2:-}" ;;
  start) cmd_start ;;
  *) echo "Nutzung: $0 stop [--yes] | start"; exit 1 ;;
esac
