#!/usr/bin/env bash
# =============================================================================
# lifecycle.sh – audioMONASTRY Fleet-Lebenszyklus (Snapshot-Backup-Automatik)
# -----------------------------------------------------------------------------
# stop:  Erstellt für ALLE laufenden Server einen Instanz-Snapshot
#        (`<name>-auto-<timestamp>`), wartet per Action-Poll auf Abschluss,
#        räumt danach nach der Retention-Regel auf (SNAPSHOT_RETENTION, Default 2
#        je Rolle – dieselbe Regel wie der Portal-Worker) und LÖSCHT dann die
#        Server (0 €/Monat). Floating-IP bleibt reserviert.
# prune: Räumt nur auf (ohne Snapshot/Stop). PRUNE_DRY_RUN=1 zeigt nur, was
#        gelöscht WÜRDE – der Befehl schreibt dabei nichts.
# start: Holt aktuelle Repo-Änderungen in die lokale Arbeitskopie, bringt die
#        Flotte hoch (provisioniert, deployt den aktuellen Stand, Smoke-Test).
#
# Aufruf:
#   bash scripts/hetzner/lifecycle.sh stop
#   bash scripts/hetzner/lifecycle.sh start
#   PRUNE_DRY_RUN=1 bash scripts/hetzner/lifecycle.sh prune
#
# INFRA-HETZNER-010: Ohne diese Retention wuchs der Snapshot-Bestand bei jedem
# `stop` um fünf Images (5 Rollen), weil der CLI-Pfad sie zwar anlegte, aber nie
# aufräumte - nur der Portal-Worker hatte eine (services/portal-worker/src/index.js,
# SNAPSHOT_RETENTION=2 je Rolle). Erfasst werden BEIDE Familien: die des Workers
# (`<prefix>snapshot-<rolle>-<datum>`, inkl. Alt-Präfix aus fleet-names.sh) und
# die eigene (`<servername>-auto-<timestamp>`) - sonst wüchse der Bestand weiter.
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")/../.."
if [[ -f .env.deploy ]]; then set -a; . ./.env.deploy; set +a; fi
[[ -n "${HCLOUD_TOKEN:-}" ]] || { echo "HCLOUD_TOKEN fehlt (.env.deploy)" >&2; exit 1; }

# NOMEN-P1-001: auch hier beide Schreibweisen (Altbestand darf nicht liegen bleiben).
source "$(dirname "$0")/fleet-names.sh"
CANONICAL_NAMES=(audiomonastry-app-1 audiomonastry-master-1 audiomonastry-edge-1 audiomonastry-sfu-1 audiomonastry-ai-1)
NAMES=()
for n in "${CANONICAL_NAMES[@]}"; do
  while read -r candidate; do NAMES+=("$candidate"); done < <(fleet_candidates "$n")
done
TS="$(date -u +%Y%m%d-%H%M)"

# --- Retention + Wartezeit (INFRA-HETZNER-010) --------------------------------
# SNAPSHOT_RETENTION: wie im Portal-Worker (dort fest 2) - hier per env
# ueberschreibbar, damit ein Knoten mit vielen Rollen nicht unbegrenzt Images
# ansammelt (Snapshots kosten ~0,01 EUR/GB/Monat).
SNAPSHOT_RETENTION="${SNAPSHOT_RETENTION:-2}"
# Zeitbudget je Snapshot-Action (Sekunden) fuer den Status-Poll.
SNAPSHOT_WAIT_TIMEOUT="${SNAPSHOT_WAIT_TIMEOUT:-600}"
# 1 = nur zeigen, was geloescht wuerde (kein DELETE) - fuer Nachweise/Vorabpruefung.
PRUNE_DRY_RUN="${PRUNE_DRY_RUN:-0}"

hz_get() { curl -s -H "Authorization: Bearer ${HCLOUD_TOKEN}" "https://api.hetzner.cloud/v1$1"; }

# Action-Status pollen statt festem `sleep 30`: die alte Wartezeit war eine Wette
# (ein 80-GB-Snapshot braucht laenger, ein kleinerer ist laengst fertig) und sagte
# nichts ueber Erfolg oder Fehler. Best effort mit Timeout - laeuft die Action
# weiter, wird nur gemeldet (kein Abbruch, der Snapshot entsteht serverseitig).
wait_snapshot_action() {
  local action_id="$1" name="$2" waited=0 status
  if [[ -z "$action_id" ]]; then
    echo "  ⚠ $name: kein Action-Id erhalten (Snapshot-Anlage fehlgeschlagen)."
    return 1
  fi
  while (( waited < SNAPSHOT_WAIT_TIMEOUT )); do
    status=$(hz_get "/actions/$action_id" \
      | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('action',{}).get('status',''))" 2>/dev/null)
    case "$status" in
      success) echo "  ✓ $name: Snapshot fertig (nach ${waited}s)"; return 0 ;;
      error)   echo "  ❌ $name: Snapshot-Action Fehler (Action $action_id)"; return 1 ;;
    esac
    sleep 5
    waited=$(( waited + 5 ))
  done
  echo "  ⏱ $name: noch nicht fertig nach ${SNAPSHOT_WAIT_TIMEOUT}s - laeuft serverseitig weiter (Action $action_id)."
  return 1
}

# Aufraeumen nach der Retentionsregel. Rollen-Erkennung wie im Portal-Worker:
# Label `role`, sonst aus Name/Beschreibung (`<prefix>snapshot-<rolle>-<datum>`
# bzw. `<servername>-auto-<timestamp>`). Prefixes kommen aus fleet-names.sh -
# der Altname steht damit weiterhin an GENAU einer Stelle im Repo.
prune_snapshots() {
  echo "=== Snapshot-Retention: letzte ${SNAPSHOT_RETENTION} je Rolle behalten (Dry-Run=${PRUNE_DRY_RUN}) ==="
  FLEET_PREFIX="$FLEET_PREFIX" LEGACY_FLEET_PREFIX="$LEGACY_FLEET_PREFIX" \
  SNAPSHOT_RETENTION="$SNAPSHOT_RETENTION" PRUNE_DRY_RUN="$PRUNE_DRY_RUN" \
  python3 - <<'PY'
import json, os, re, urllib.request

tok = os.environ["HCLOUD_TOKEN"]
keep = int(os.environ["SNAPSHOT_RETENTION"])
dry = os.environ.get("PRUNE_DRY_RUN") == "1"
prefixes = [p for p in (os.environ.get("FLEET_PREFIX"), os.environ.get("LEGACY_FLEET_PREFIX")) if p]
roles = "app|sfu|ai|master|edge"

def api(method, path):
    req = urllib.request.Request("https://api.hetzner.cloud/v1" + path, method=method,
                                headers={"Authorization": "Bearer " + tok})
    with urllib.request.urlopen(req, timeout=30) as r:
        body = r.read()
    return json.loads(body) if body else {}

def role_of(img):
    label = (img.get("labels") or {}).get("role")
    if label:
        return label
    text = ("%s %s" % (img.get("name") or "", img.get("description") or "")).strip()
    for p in prefixes:
        if re.search(re.escape(p) + r"snapshot-(" + roles + r")(?![a-z])", text):
            return re.search(re.escape(p) + r"snapshot-(" + roles + r")(?![a-z])", text).group(1)
        m = re.match(re.escape(p) + r"(" + roles + r")-\d+-auto-", text)
        if m:
            return m.group(1)
    return None

images = api("GET", "/images?type=snapshot&per_page=100&sort=created:desc").get("images", [])
by_role = {}
unassigned = []
for img in images:
    role = role_of(img)
    (by_role.setdefault(role, []) if role else unassigned).append(img)

kept = deleted = 0
for role in sorted(by_role):
    lst = sorted(by_role[role], key=lambda i: str(i.get("created") or ""), reverse=True)
    kept += len(lst[:keep])
    for img in lst[keep:]:
        desc = img.get("description") or img.get("name") or str(img.get("id"))
        if dry:
            print("  [dry-run] wuerde loeschen: %s (%s GB, %s, id=%s, Rolle %s)"
                  % (desc, img.get("disk_size"), img.get("created"), img.get("id"), role))
        else:
            api("DELETE", "/images/%s" % img["id"])
            print("  geloescht: %s (%s GB, %s, id=%s, Rolle %s)"
                  % (desc, img.get("disk_size"), img.get("created"), img.get("id"), role))
        deleted += 1

print("  Rollen: %s" % (", ".join("%s=%d" % (r, len(v)) for r, v in sorted(by_role.items())) or "keine"))
print("  behalten: %d | %s: %d | nicht zuordenbar (bleiben unangetastet): %d"
      % (kept, "waeren geloescht" if dry else "geloescht", deleted, len(unassigned)))
PY
}

snapshot_all() {
  echo "=== Snapshot-Backup ($TS) ==="
  for NAME in "${NAMES[@]}"; do
    ID=$(hz_get "/servers?name=$NAME" \
      | python3 -c "import sys,json; d=json.load(sys.stdin); s=d['servers'][0] if d['servers'] else None; print(s['id'] if s else '')")
    if [[ -z "$ID" ]]; then
      echo "Überspringe $NAME (existiert nicht)."
      continue
    fi
    DESC="${NAME}-auto-${TS}"
    ACTION=$(curl -s -X POST -H "Authorization: Bearer ${HCLOUD_TOKEN}" -H "Content-Type: application/json" \
      -d "{\"description\":\"$DESC\",\"type\":\"snapshot\"}" \
      "https://api.hetzner.cloud/v1/servers/$ID/actions/create_image" \
      | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('action',{}).get('id',''))" 2>/dev/null)
    echo "$NAME → Snapshot '$DESC' (Action ${ACTION:-?})"
    wait_snapshot_action "$ACTION" "$NAME" || true
  done
  echo "--- Snapshot-Status geprueft (Action-Poll, Timeout ${SNAPSHOT_WAIT_TIMEOUT}s) ---"
  prune_snapshots
}

cmd_stop() {
  if [[ "${1:-}" != "--yes" ]]; then
    echo "Stoppt die Flotte: Snapshot-Backup (inkl. Retention-Aufraeumen) + Server-LÖSCHEN (0 €/Monat)."
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
  prune) prune_snapshots ;;
  *) echo "Nutzung: $0 stop [--yes] | start | prune   (prune: PRUNE_DRY_RUN=1 zeigt nur)"; exit 1 ;;
esac
