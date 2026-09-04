#!/usr/bin/env bash
# =============================================================================
# fleet-preflight.sh – Flotten-Stand vor dem manuellen Start prüfen/erneuern
# -----------------------------------------------------------------------------
# Stellt sicher, dass die Hetzner-Flotte mit dem AKTUELLEN Repo-Stand startet:
#   1. check      – zeigt lokalen Commit/Version, Flotten-Status und ob die
#                   Rollen-Snapshots den aktuellen Commit tragen.
#   2. apply      – weckt die Flotte falls nötig, deployed den aktuellen Stand
#                   auf app-1 und erneuert die Rollen-Snapshots (mit Commit-/
#                   Versions-Label).
#
# Konfiguration (env oder .env.deploy im Repo-Root):
#   PORTAL_URL         https://anunnakitools.de
#   DEPLOY_DOMAIN      anunnakitools.de
#   ADMIN_USER         Portal-Admin-User
#   ADMIN_PASSWORD     Portal-Admin-Passwort
#   DEPLOY_SSH_KEY     Pfad zum SSH-Key (Default ~/.ssh/id_ed25519)
#   HCLOUD_TOKEN       optional: für Status der übrigen Rollen
#
# Aufruf:
#   bash scripts/hetzner/fleet-preflight.sh check
#   bash scripts/hetzner/fleet-preflight.sh apply
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/../.."

if [[ -f .env.deploy ]]; then set -a; . ./.env.deploy; set +a; fi

PORTAL_URL="${PORTAL_URL:-https://anunnakitools.de}"
DEPLOY_DOMAIN="${DEPLOY_DOMAIN:-anunnakitools.de}"
DEPLOY_SSH_KEY="${DEPLOY_SSH_KEY:-$HOME/.ssh/id_ed25519}"
COOKIE_JAR="/tmp/samplemonk-portal.cookies"
SSH_OPTS=(-i "$DEPLOY_SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -o BatchMode=yes)

LOCAL_COMMIT="$(git rev-parse --short HEAD)"
VERSION="$(node -p "require('./package.json').version")"

log() { echo "▶ $*"; }
die() { echo "❌ $*" >&2; exit 1; }

need_login_env() {
  [[ -n "${ADMIN_USER:-}" && -n "${ADMIN_PASSWORD:-}" ]] || \
    die "ADMIN_USER/ADMIN_PASSWORD fehlen (env oder .env.deploy)."
}

login() {
  need_login_env
  curl -fsS -c "$COOKIE_JAR" -H 'content-type: application/json' \
    -d "{\"user\":\"$ADMIN_USER\",\"pass\":\"$ADMIN_PASSWORD\"}" \
    "$PORTAL_URL/api/login" >/dev/null || die "Portal-Login fehlgeschlagen."
  log "Portal-Login ok."
}

portal_status() { curl -fsS -b "$COOKIE_JAR" "$PORTAL_URL/api/status" 2>/dev/null || echo '{"state":"unreachable"}'; }

list_snapshots() { curl -fsS -b "$COOKIE_JAR" "$PORTAL_URL/api/snapshots" 2>/dev/null || echo '{"snapshots":[]}'; }

snapshot_is_current() {
  python3 - "$1" <<'PY'
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    print("unknown"); sys.exit(0)
target = sys.argv[1]
app = [s for s in data.get("snapshots", []) if s.get("role") == "app"]
if not app:
    print("missing")
else:
    newest = app[0]
    print("current" if newest.get("commit") == target else "stale")
PY
}

wake_and_wait() {
  local status
  status="$(portal_status)"
  if [[ "$status" == *'"state":"off"'* ]]; then
    log "Flotte ist AUS → wecke sie (Portal-Wake)."
    curl -fsS -b "$COOKIE_JAR" -X POST "$PORTAL_URL/api/wake" >/dev/null || die "Wake fehlgeschlagen."
  fi

  log "Warte auf Flotte (ready) …"
  for _ in $(seq 1 180); do
    status="$(portal_status)"
    if [[ "$status" == *'"state":"ready"'* ]]; then log "Flotte ready."; return 0; fi
    sleep 4
  done
  log "Letzter Status: $status"
  die "Flotte wurde nicht rechtzeitig ready (max. 12 min)."
}

app_ip_from_status() {
  python3 - <<'PY'
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    print(""); sys.exit(0)
print(data.get("appIp") or "")
PY
}

apply_update() {
  local app_ip="$1"
  log "Deploy aktuellen Stand ($LOCAL_COMMIT) auf app-1 ($app_ip) …"
  # Remote-Build-Modus: kein lokales Docker nötig; lokale .env wird NICHT
  # hochgeladen (die Produktions-.env auf dem Server bleibt unangetastet).
  DEPLOY_HOST="$app_ip" \
  DEPLOY_DOMAIN="$DEPLOY_DOMAIN" \
  DEPLOY_SSH_KEY="$DEPLOY_SSH_KEY" \
  DEPLOY_SYNC_ENV=0 \
  DEPLOY_SMOKE=0 \
  DEPLOY_REMOTE_BUILD=1 \
  bash deploy.sh
  log "app-1 ist aktualisiert."
}

refresh_snapshots() {
  log "Erneuere Rollen-Snapshots (commit=$LOCAL_COMMIT, version=$VERSION) …"
  curl -fsS -b "$COOKIE_JAR" -H 'content-type: application/json' \
    -d "{\"commit\":\"$LOCAL_COMMIT\",\"version\":\"$VERSION\"}" \
    "$PORTAL_URL/api/refresh-snapshots" || die "Snapshot-Refresh fehlgeschlagen."
}

cmd_check() {
  echo "Lokal:   commit=$LOCAL_COMMIT  version=$VERSION"
  local status
  status="$(curl -fsS "$PORTAL_URL/api/status" 2>/dev/null || echo '{"state":"unreachable"}')"
  echo "Portal:  $status"

  if [[ -n "${ADMIN_USER:-}" && -n "${ADMIN_PASSWORD:-}" ]]; then
    login
    echo "Snapshots (app):"
    list_snapshots | python3 -c 'import json,sys; d=json.load(sys.stdin); [print(f"  {s.get(\"role\")}: {s.get(\"commit\") or \"-\"} · {s.get(\"version\") or \"-\"} · {s.get(\"description\")} · {s.get(\"status\")}") for s in d.get("snapshots", [])]' || true
    echo "App-Snapshot ist: $(list_snapshots | snapshot_is_current "$LOCAL_COMMIT")"
  else
    echo "Hinweis: ohne ADMIN_USER/ADMIN_PASSWORD (.env.deploy) kann der Snapshot-Abgleich nicht geprüft werden."
  fi
}

cmd_apply() {
  need_login_env
  login
  wake_and_wait

  local status app_ip
  status="$(portal_status)"
  app_ip="$(app_ip_from_status <<<"$status")"
  [[ -n "$app_ip" ]] || die "app-1-IP nicht im Status gefunden."

  local snap_state
  snap_state="$(list_snapshots | snapshot_is_current "$LOCAL_COMMIT")"
  if [[ "$snap_state" == "current" ]]; then
    log "App-Snapshot ist bereits aktuell – kein Deploy nötig."
  else
    log "App-Snapshot ist $snap_state (lokal: $LOCAL_COMMIT) → Update + Snapshot-Refresh."
    apply_update "$app_ip"
    refresh_snapshots
  fi

  echo "✅ Preflight abgeschlossen. Nächster Flotten-Start nutzt den aktuellen Stand."
}

case "${1:-check}" in
  check) cmd_check ;;
  apply) cmd_apply ;;
  *) echo "Nutzung: $0 {check|apply}" >&2; exit 1 ;;
esac
