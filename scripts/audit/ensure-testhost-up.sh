#!/usr/bin/env bash
# =============================================================================
# ensure-testhost-up.sh – Testhost am-ccx33 vorhanden/fertig ODER kostenfrei weg
# -----------------------------------------------------------------------------
# Laeuft auf dem BETREIBER-Rechner (nicht auf dem Testhost). Modi:
#
#   (ohne Argument)      sicherstellen, dass der Testhost laeuft und benutzbar ist
#   --teardown           Snapshot -> warten auf `available` -> Rotation -> DELETE
#   --teardown-request   Auftraege aus /var/lib/am-idle einlesen und abarbeiten
#   --print-config       zeigt die wirksame Konfiguration, aendert nichts
#
# ABLAUF "ensure" (idempotent, mehrfach ausfuehrbar):
#   1. GET /v1/servers?name=am-ccx33 (HTTP 200 mit LEERER Liste = nicht vorhanden;
#      die API antwortet hier nie mit 404, ein 404 waere ein echter Fehler).
#   2. Fehlt der Server, wird der NEUESTE `available` Snapshot gewaehlt, dessen
#      description mit "am-ccx33-" beginnt - nicht der global neueste Snapshot
#      des Projekts (das ist regelmaessig ein fremdes Image).
#   3. POST /v1/servers {name, server_type=ccx33, location=hel1, image=<snapshot>,
#      ssh_keys=[AM_SSH_KEY_ID]}, dann Status bis `running` pollen.
#   4. SSH-Bereitschaft bis 60 s, danach node + chromium + Repo pruefen (30 s).
#   5. git status nur WARNEN (dirty Arbeitsbaum blockiert die Pruefung nicht).
#   Exit 0 = ready, Exit 1 = Grund im JSON.
#
# ABLAUF "--teardown":
#   create_image {type:snapshot, description:"am-ccx33-<ts>"} -> pollen bis
#   image.status `available` (Hetzner-Snapshots sind asynchron!). Erst danach
#   werden AM-eigene Snapshots auf die neuesten 3 rotiert und der Server per
#   DELETE entfernt. Ist der Snapshot nicht `available`, wird NICHTS geloescht:
#   ein laufender Server ist billiger als ein verlorener Stand.
#   `stop`/`shutdown` sind hier bewusst nicht der Endzustand - nur DELETE ist
#   kostenfrei, ein gestoppter Server bezahlt weiter seine Disk.
#
# ABLAUF "--teardown-request":
#   Liest die JSON-Auftraege, die scripts/audit/am-idle-snapshot-delete.sh auf
#   dem Host nach /var/lib/am-idle/ schreibt (lokal, oder per scp vom Host).
#   Ein Auftrag wird NUR ausgefuehrt, wenn seine server_id exakt zum aktuell
#   gefundenen Server passt; alles andere wird gemeldet und nicht angefasst.
#
# SICHERHEIT
#   * Token aus HCLOUD_TOKEN oder .env.deploy (HCLOUD_TOKEN); er wird nie
#     ausgegeben, nie als Kommandozeilen-Argument uebergeben.
#   * Jeder API-Aufruf traegt einen User-Agent (ohne ihn liefert Hetzner
#     gelegentlich leere Bodies).
#   * Fail-closed: unklare Antworten, fehlende Snapshots, HTTP != erwartet
#     oder nicht erreichbare Pruefungen fuehren zu Exit 1 - nie zu einem
#     DELETE "auf Verdacht".
#   * Rotation loescht ausschliesslich Images, deren description mit
#     "am-ccx33-" beginnt. Fremde Projekt-Snapshots werden nie angefasst.
#   * Letzte Zeile auf stdout ist immer GENAU EIN JSON-Objekt. Einzige
#     Ausnahme: --help (menschenlesbarer Text, keine Aktion).
#
# Overrides: AM_SERVER_NAME (am-ccx33), AM_SERVER_TYPE (ccx33), AM_LOCATION (hel1),
#   AM_SNAPSHOT_PREFIX (am-ccx33-), AM_KEEP_SNAPSHOTS (3), AM_SSH_KEY_ID (131146761),
#   AM_SSH_USER (root), AM_REPO_PATH (/opt/am-r15-fixed-ac2d37f),
#   AM_IDLE_REQUEST_DIR (/var/lib/am-idle), AM_SSH_WAIT_S (60),
#   AM_VERIFY_WAIT_S (30), AM_BOOT_WAIT_S (300), AM_SNAPSHOT_WAIT_S (900)
# =============================================================================
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_DEPLOY="${AM_ENV_DEPLOY:-$ROOT/.env.deploy}"

SERVER_NAME="${AM_SERVER_NAME:-am-ccx33}"
SERVER_TYPE="${AM_SERVER_TYPE:-ccx33}"
LOCATION="${AM_LOCATION:-hel1}"
SNAPSHOT_PREFIX="${AM_SNAPSHOT_PREFIX:-am-ccx33-}"
KEEP_SNAPSHOTS="${AM_KEEP_SNAPSHOTS:-3}"
SSH_KEY_ID="${AM_SSH_KEY_ID:-131146761}"
SSH_USER="${AM_SSH_USER:-root}"
REPO_PATH="${AM_REPO_PATH:-/opt/am-r15-fixed-ac2d37f}"
REQUEST_DIR="${AM_IDLE_REQUEST_DIR:-/var/lib/am-idle}"
SSH_WAIT_S="${AM_SSH_WAIT_S:-60}"
VERIFY_WAIT_S="${AM_VERIFY_WAIT_S:-30}"
BOOT_WAIT_S="${AM_BOOT_WAIT_S:-300}"
SNAPSHOT_WAIT_S="${AM_SNAPSHOT_WAIT_S:-900}"
API_BASE="${AM_HETZNER_API:-https://api.hetzner.cloud/v1}"
UA="audiomonastry-ensure-testhost/1.0"

MODE="ensure"
SERVER_ID=""
SERVER_IP=""
SERVER_STATUS=""
CREATED="false"
SNAPSHOT_ID=""
NODE_VERSION=""
CHROMIUM_PATH=""
REPO_STATE=""
GIT_STATE=""
DELETED_IMAGES="0"
WARNINGS=()
EMITTED=0

TMP="$(mktemp -d "${TMPDIR:-/tmp}/am-ensure.XXXXXX" 2>/dev/null)" || {
  # Ohne Temp-Verzeichnis gibt es keinen API-Pfad - trotzdem genau eine
  # maschinenlesbare Schlusszeile, damit der Aufrufer nicht ins Leere greift.
  printf '{"script":"ensure-testhost-up","status":"error","reason":"tmp-unavailable"}\n'
  exit 1
}
BODY="$TMP/body.json"
SSH_KNOWN_HOSTS="$TMP/known_hosts"
: >"$SSH_KNOWN_HOSTS"
SSH_OPTS=(
  -o BatchMode=yes
  -o ConnectTimeout=5
  -o StrictHostKeyChecking=accept-new
  -o UserKnownHostsFile="$SSH_KNOWN_HOSTS"
  -o LogLevel=ERROR
)
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

log() { printf '[%s] [ensure-testhost] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
warn() { WARNINGS+=("$*"); log "WARNUNG: $*"; }

emit_final() { # $1 = status, $2 = reason
  AM_F_STATUS="${1:-error}" \
  AM_F_REASON="${2:-}" \
  AM_F_MODE="$MODE" \
  AM_F_SERVER_ID="$SERVER_ID" \
  AM_F_SERVER_IP="$SERVER_IP" \
  AM_F_SERVER_STATUS="$SERVER_STATUS" \
  AM_F_CREATED="$CREATED" \
  AM_F_SNAPSHOT_ID="$SNAPSHOT_ID" \
  AM_F_NODE="$NODE_VERSION" \
  AM_F_CHROMIUM="$CHROMIUM_PATH" \
  AM_F_REPO="$REPO_STATE" \
  AM_F_GIT="$GIT_STATE" \
  AM_F_DELETED_IMAGES="$DELETED_IMAGES" \
  AM_F_WARNINGS="${WARNINGS[*]:-}" \
  AM_F_NAME="$SERVER_NAME" \
  python3 - <<'PY'
import datetime
import json
import os

warnings = [w for w in (os.environ.get("AM_F_WARNINGS") or "").split(" | ") if w]
server_id = (os.environ.get("AM_F_SERVER_ID") or "").strip()
snapshot_id = (os.environ.get("AM_F_SNAPSHOT_ID") or "").strip()
try:
    deleted = int(os.environ.get("AM_F_DELETED_IMAGES") or 0)
except ValueError:
    deleted = 0

obj = {
    "script": "ensure-testhost-up",
    "mode": os.environ.get("AM_F_MODE", ""),
    "status": os.environ.get("AM_F_STATUS", "error"),
    "reason": os.environ.get("AM_F_REASON", ""),
    "server_name": os.environ.get("AM_F_NAME", ""),
    "server_id": int(server_id) if server_id.isdigit() else None,
    "server_ip": os.environ.get("AM_F_SERVER_IP") or None,
    "server_status": os.environ.get("AM_F_SERVER_STATUS") or None,
    "created": os.environ.get("AM_F_CREATED") == "true",
    "snapshot_id": int(snapshot_id) if snapshot_id.isdigit() else None,
    "node": os.environ.get("AM_F_NODE") or None,
    "chromium": os.environ.get("AM_F_CHROMIUM") or None,
    "repo": os.environ.get("AM_F_REPO") or None,
    "git": os.environ.get("AM_F_GIT") or None,
    "deleted_images": deleted,
    "warnings": warnings,
    "ts": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
}
print(json.dumps(obj, ensure_ascii=False, sort_keys=True))
PY
  EMITTED=1
}

on_err() {
  local rc=$?
  if [[ "$EMITTED" -eq 0 ]]; then
    emit_final "error" "unexpected-failure-line-${BASH_LINENO[0]:-0}"
  fi
  exit "$rc"
}
trap on_err ERR

usage() {
  awk 'NR > 1 && /^set -euo pipefail$/{exit} NR > 1{sub(/^# ?/, ""); print}' "$0"
}

print_config() {
  cat <<CONFIG
[ensure-testhost-up] Trockenlauf - kein API-Aufruf, keine Aenderung.
  Modus:                $MODE
  Repo/.env.deploy:     $ROOT  ($ENV_DEPLOY)
  Server:               $SERVER_NAME  type=$SERVER_TYPE  location=$LOCATION
  Snapshot-Praefix:     ${SNAPSHOT_PREFIX}*  (Rotation: neueste $KEEP_SNAPSHOTS behalten)
  SSH-Key-ID:           $SSH_KEY_ID  (User: $SSH_USER)
  Repo auf dem Host:    $REPO_PATH
  Auftrags-Verzeichnis: $REQUEST_DIR
  Wartezeiten:          SSH ${SSH_WAIT_S}s, Verify ${VERIFY_WAIT_S}s, Boot ${BOOT_WAIT_S}s, Snapshot ${SNAPSHOT_WAIT_S}s
  API:                  $API_BASE
  Token:                HCLOUD_TOKEN oder HCLOUD_TOKEN= in $ENV_DEPLOY (wird nie ausgegeben)
CONFIG
}

# --- Token ------------------------------------------------------------------
read_env_value() { # $1 = Datei, $2 = Schluessel
  python3 - "$1" "$2" <<'PY'
import sys

path, key = sys.argv[1], sys.argv[2]
try:
    with open(path, "r", encoding="utf-8") as fh:
        lines = fh.read().splitlines()
except OSError:
    raise SystemExit(0)
for line in lines:
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    name, _, value = line.partition("=")
    if name.strip() == key:
        print(value.strip().strip('"').strip("'"))
        break
PY
}

resolve_token() {
  local token="${HCLOUD_TOKEN:-}"
  if [[ -z "$token" && -r "$ENV_DEPLOY" ]]; then
    token="$(read_env_value "$ENV_DEPLOY" HCLOUD_TOKEN)"
  fi
  [[ -n "$token" ]] || return 1
  AM_TOKEN="$token"
  export AM_TOKEN
}

# --- Hetzner-API: ein Aufruf, Body in $BODY, HTTP-Status auf stdout ---------
hapi() { # $1 = method, $2 = path, $3 = optionaler JSON-Body
  AM_HTTP_METHOD="$1" AM_HTTP_PATH="$2" AM_HTTP_BODY="${3:-}" \
  AM_API_BASE="$API_BASE" AM_UA="$UA" AM_BODY_OUT="$BODY" \
  python3 - "$BODY" <<'PY'
import json
import os
import sys
import urllib.error
import urllib.request

out = sys.argv[1]
method = os.environ["AM_HTTP_METHOD"]
path = os.environ["AM_HTTP_PATH"]
body = os.environ.get("AM_HTTP_BODY") or ""
base = os.environ["AM_API_BASE"].rstrip("/")
data = body.encode() if body else None
req = urllib.request.Request(
    base + path,
    data=data,
    method=method,
    headers={
        "Authorization": "Bearer " + os.environ.get("AM_TOKEN", ""),
        "Content-Type": "application/json",
        "User-Agent": os.environ.get("AM_UA", "audiomonastry-ensure-testhost/1.0"),
    },
)
try:
    with urllib.request.urlopen(req, timeout=60) as resp:
        raw = resp.read()
        status = resp.status
except urllib.error.HTTPError as exc:
    raw = exc.read() or b""
    status = exc.code
except Exception as exc:  # Transportfehler: Status 000, Grund im Body
    with open(out, "w", encoding="utf-8") as fh:
        json.dump({"error": {"code": "transport_error", "message": str(exc)}}, fh)
    print("000")
    raise SystemExit(0)
with open(out, "wb") as fh:
    fh.write(raw or b"{}")
print(status)
PY
}

json_get() { # $1 = Datei, $2 = dotted path
  python3 - "$1" "$2" <<'PY'
import json
import sys

try:
    with open(sys.argv[1], "r", encoding="utf-8") as fh:
        cur = json.load(fh)
except Exception:
    print("")
    raise SystemExit(0)

for part in sys.argv[2].split("."):
    if isinstance(cur, list):
        try:
            cur = cur[int(part)]
        except (ValueError, IndexError):
            print("")
            raise SystemExit(0)
    elif isinstance(cur, dict) and part in cur:
        cur = cur[part]
    else:
        print("")
        raise SystemExit(0)

if cur is None:
    print("")
elif isinstance(cur, (dict, list)):
    print(json.dumps(cur, ensure_ascii=False))
else:
    print(cur)
PY
}

api_error_text() {
  local code message
  code="$(json_get "$BODY" "error.code")"
  message="$(json_get "$BODY" "error.message")"
  printf '%s:%s' "${code:-unknown}" "${message:-no-detail}"
}

# --- Snapshot-Auswahl: neuester AM-eigener, `available` ---------------------
pick_snapshot() {
  AM_SNAPSHOT_PREFIX="$SNAPSHOT_PREFIX" \
  AM_API_BASE="$API_BASE" \
  AM_UA="$UA" \
  python3 - <<'PY'
import json
import os
import sys
import urllib.error
import urllib.request

base = os.environ["AM_API_BASE"].rstrip("/")
prefix = os.environ["AM_SNAPSHOT_PREFIX"]
ua = os.environ.get("AM_UA", "audiomonastry-ensure-testhost/1.0")
token = os.environ.get("AM_TOKEN", "")


def call(path):
    req = urllib.request.Request(base + path, method="GET", headers={
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
        "User-Agent": ua,
    })
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as exc:
        return exc.code, {}
    except Exception:
        return 0, {}


images = []
page = 1
while page and page <= 50:
    status, data = call("/images?type=snapshot&sort=created:desc&per_page=50&page=%d" % page)
    if status != 200:
        print(json.dumps({"ok": False, "reason": "images-http-%d" % status}))
        sys.exit(0)
    images.extend(data.get("images") or [])
    page = ((data.get("meta") or {}).get("pagination") or {}).get("next_page")

owned = [i for i in images if (i.get("description") or "").startswith(prefix)]
available = [i for i in owned if i.get("status") == "available"]
if not available:
    print(json.dumps({
        "ok": False,
        "reason": "no-available-am-snapshot",
        "prefix": prefix,
        "owned": len(owned),
        "statuses": sorted({str(i.get("status")) for i in owned}),
    }, ensure_ascii=False))
    sys.exit(0)

newest = max(available, key=lambda i: i.get("created") or "")
print(json.dumps({
    "ok": True,
    "id": newest.get("id"),
    "description": newest.get("description"),
    "created": newest.get("created"),
    "owned_total": len(owned),
}, ensure_ascii=False, sort_keys=True))
PY
}

# --- Rotation: nur AM-eigene Images, neueste N behalten ---------------------
rotate_snapshots() {
  AM_SNAPSHOT_PREFIX="$SNAPSHOT_PREFIX" \
  AM_KEEP_SNAPSHOTS="$KEEP_SNAPSHOTS" \
  AM_API_BASE="$API_BASE" \
  AM_UA="$UA" \
  python3 - <<'PY'
import json
import os
import sys
import urllib.error
import urllib.request

base = os.environ["AM_API_BASE"].rstrip("/")
prefix = os.environ["AM_SNAPSHOT_PREFIX"]
keep = int(os.environ.get("AM_KEEP_SNAPSHOTS") or 3)
ua = os.environ.get("AM_UA", "audiomonastry-ensure-testhost/1.0")
token = os.environ.get("AM_TOKEN", "")


def call(method, path):
    req = urllib.request.Request(base + path, method=method, headers={
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
        "User-Agent": ua,
    })
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as exc:
        raw = exc.read() or b""
        try:
            return exc.code, json.loads(raw)
        except ValueError:
            return exc.code, {}
    except Exception as exc:
        return 0, {"transport_error": str(exc)}


images = []
page = 1
while page and page <= 50:
    status, data = call("GET", "/images?type=snapshot&sort=created:desc&per_page=50&page=%d" % page)
    if status != 200:
        print(json.dumps({"ok": False, "error": "list-http-%d" % status}))
        sys.exit(0)
    images.extend(data.get("images") or [])
    page = ((data.get("meta") or {}).get("pagination") or {}).get("next_page")

owned = [i for i in images if (i.get("description") or "").startswith(prefix)]
owned.sort(key=lambda i: i.get("created") or "", reverse=True)
victims = [i for i in owned[keep:] if i.get("status") == "available"]
deleted = []
errors = []
for image in victims:
    status, data = call("DELETE", "/images/%s" % image.get("id"))
    if status in (200, 204):
        deleted.append({"id": image.get("id"), "description": image.get("description")})
    else:
        errors.append({"id": image.get("id"), "http": status})

print(json.dumps({
    "ok": not errors,
    "prefix": prefix,
    "owned_total": len(owned),
    "kept": [{"id": i.get("id"), "description": i.get("description")} for i in owned[:keep]],
    "deleted": deleted,
    "errors": errors,
}, ensure_ascii=False, sort_keys=True))
PY
}

# --- SSH --------------------------------------------------------------------
ssh_ready() {
  [[ -n "$SERVER_IP" ]] || return 1
  ssh "${SSH_OPTS[@]}" "${SSH_USER}@${SERVER_IP}" true >/dev/null 2>&1
}

wait_for_ssh() {
  local deadline=$(( $(date +%s) + SSH_WAIT_S ))
  while [[ "$(date +%s)" -lt "$deadline" ]]; do
    if ssh_ready; then
      return 0
    fi
    sleep 3
  done
  return 1
}

verify_remote() { # setzt NODE_VERSION, CHROMIUM_PATH, REPO_STATE, GIT_STATE
  local remote_script out node chromium repo gitdir dirty
  remote_script="$(cat <<'REMOTE'
repo="$1"
printf 'NODE=%s\n' "$(command -v node || echo MISSING)"
printf 'NODE_VERSION=%s\n' "$(node --version 2>/dev/null || echo MISSING)"
printf 'CHROMIUM=%s\n' "$(command -v chromium || command -v chromium-browser || command -v google-chrome || ls -d /root/.cache/ms-playwright/chromium-*/chrome-linux*/chrome 2>/dev/null | tail -1 || echo MISSING)"
if [ -d "$repo" ]; then printf 'REPO=PRESENT\n'; else printf 'REPO=MISSING\n'; fi
if [ -d "$repo/.git" ]; then printf 'GITDIR=PRESENT\n'; else printf 'GITDIR=MISSING\n'; fi
REMOTE
)"
  if ! out="$(ssh "${SSH_OPTS[@]}" "${SSH_USER}@${SERVER_IP}" \
      "bash -s -- $(printf '%q' "$REPO_PATH")" <<<"$remote_script" 2>/dev/null)"; then
    return 1
  fi
  node="$(printf '%s\n' "$out" | sed -n 's/^NODE=//p' | head -1)"
  NODE_VERSION="$(printf '%s\n' "$out" | sed -n 's/^NODE_VERSION=//p' | head -1)"
  chromium="$(printf '%s\n' "$out" | sed -n 's/^CHROMIUM=//p' | head -1)"
  repo="$(printf '%s\n' "$out" | sed -n 's/^REPO=//p' | head -1)"
  gitdir="$(printf '%s\n' "$out" | sed -n 's/^GITDIR=//p' | head -1)"
  [[ "$chromium" == "MISSING" ]] && chromium=""
  CHROMIUM_PATH="$chromium"
  [[ "$repo" == "PRESENT" ]] && REPO_STATE="present" || REPO_STATE="missing"
  [[ "${NODE_VERSION:-MISSING}" == "MISSING" || -z "${node:-}" || "$node" == "MISSING" ]] && NODE_VERSION=""
  [[ "$NODE_VERSION" != "" ]] && NODE_VERSION="${NODE_VERSION#v}"

  if [[ "$gitdir" == "PRESENT" && "$REPO_STATE" == "present" ]]; then
    dirty="$(ssh "${SSH_OPTS[@]}" "${SSH_USER}@${SERVER_IP}" \
      "bash -s -- $(printf '%q' "$REPO_PATH")" <<<'cd "$1" && git status --porcelain 2>/dev/null | head -10' 2>/dev/null || true)"
    if [[ -n "${dirty//[[:space:]]/}" ]]; then
      GIT_STATE="dirty"
      warn "git status auf dem Host ist dirty ($(printf '%s\n' "$dirty" | wc -l | tr -d ' ') Eintraege) - Snapshot sichert keinen sauberen Stand."
    else
      GIT_STATE="clean"
    fi
  else
    GIT_STATE="unknown"
  fi
  [[ -n "$NODE_VERSION" && -n "$CHROMIUM_PATH" && "$REPO_STATE" == "present" ]]
}

wait_for_verify() {
  local deadline=$(( $(date +%s) + VERIFY_WAIT_S ))
  while [[ "$(date +%s)" -lt "$deadline" ]]; do
    if verify_remote; then
      return 0
    fi
    sleep 3
  done
  return 1
}

# --- Server-Zustand ---------------------------------------------------------
find_server() { # setzt SERVER_ID, SERVER_IP, SERVER_STATUS (leer = nicht vorhanden)
  local status
  status="$(hapi GET "/servers?name=${SERVER_NAME}")"
  if [[ "$status" != "200" ]]; then
    log "GET /servers?name=$SERVER_NAME -> HTTP $status ($(api_error_text))"
    return 1
  fi
  SERVER_ID="$(json_get "$BODY" "servers.0.id")"
  SERVER_IP="$(json_get "$BODY" "servers.0.public_net.ipv4.ip")"
  SERVER_STATUS="$(json_get "$BODY" "servers.0.status")"
  return 0
}

wait_for_running() { # $1 = server id
  local id="$1" deadline=$(( $(date +%s) + BOOT_WAIT_S )) status state tried_poweron="no"
  while [[ "$(date +%s)" -lt "$deadline" ]]; do
    status="$(hapi GET "/servers/$id")"
    if [[ "$status" != "200" ]]; then
      log "GET /servers/$id -> HTTP $status"
      sleep 5
      continue
    fi
    state="$(json_get "$BODY" "server.status")"
    case "$state" in
      running) SERVER_STATUS="running"; return 0 ;;
      off)
        # Genau EIN poweron je Lauf: eine Schleife, die alle 5 s erneut
        # startet, ist kein Warten, sondern ein Retry-Sturm.
        if [[ "$tried_poweron" == "no" ]]; then
          log "Server $id ist 'off' - sende poweron."
          hapi POST "/servers/$id/actions/poweron" '{}' >/dev/null || true
          tried_poweron="yes"
        fi
        ;;
      *) : ;;
    esac
    sleep 5
  done
  SERVER_STATUS="${state:-unknown}"
  return 1
}

create_server() { # $1 = snapshot id
  local image="$1" body status
  body="$(AM_NAME="$SERVER_NAME" AM_TYPE="$SERVER_TYPE" AM_LOC="$LOCATION" \
          AM_IMAGE="$image" AM_KEY="$SSH_KEY_ID" python3 - <<'PY'
import json
import os

key = os.environ["AM_KEY"]
try:
    key_value = int(key)
except ValueError:
    key_value = key

print(json.dumps({
    "name": os.environ["AM_NAME"],
    "server_type": os.environ["AM_TYPE"],
    "location": os.environ["AM_LOC"],
    "image": int(os.environ["AM_IMAGE"]),
    "start_after_create": True,
    "automount": False,
    "ssh_keys": [key_value],
}, sort_keys=True))
PY
)"
  status="$(hapi POST "/servers" "$body")"
  if [[ "$status" != "201" ]]; then
    log "POST /servers -> HTTP $status ($(api_error_text))"
    WARNINGS+=("create-http-$status:$(api_error_text)")
    return 1
  fi
  SERVER_ID="$(json_get "$BODY" "server.id")"
  SERVER_IP="$(json_get "$BODY" "server.public_net.ipv4.ip")"
  SERVER_STATUS="$(json_get "$BODY" "server.status")"
  CREATED="true"
  [[ -n "$SERVER_ID" ]] || return 1
  return 0
}

# --- Modi -------------------------------------------------------------------
ensure_up() {
  if ! find_server; then
    emit_final "error" "server-lookup-failed"
    return 1
  fi

  if [[ -n "$SERVER_ID" ]]; then
    log "Server vorhanden: id=$SERVER_ID ip=$SERVER_IP status=$SERVER_STATUS"
    if [[ "$SERVER_STATUS" != "running" ]]; then
      # wait_for_running sendet genau ein poweron, falls der Server 'off' ist.
      if ! wait_for_running "$SERVER_ID"; then
        emit_final "error" "server-not-running:${SERVER_STATUS:-unknown}"
        return 1
      fi
      find_server >/dev/null 2>&1 || true
    fi
  else
    log "Kein Server '$SERVER_NAME' - suche AM-eigenen Snapshot (${SNAPSHOT_PREFIX}*, available)."
    local picked
    picked="$(pick_snapshot)"
    if [[ "$(json_get <(printf '%s' "$picked") "ok")" != "True" ]]; then
      log "Kein passender Snapshot: $picked"
      WARNINGS+=("snapshot:${picked}")
      emit_final "error" "no-available-am-snapshot"
      return 1
    fi
    SNAPSHOT_ID="$(json_get <(printf '%s' "$picked") "id")"
    log "Snapshot: id=$SNAPSHOT_ID $(json_get <(printf '%s' "$picked") "description")"
    if ! create_server "$SNAPSHOT_ID"; then
      emit_final "error" "server-create-failed"
      return 1
    fi
    if ! wait_for_running "$SERVER_ID"; then
      emit_final "error" "server-did-not-reach-running:${SERVER_STATUS:-unknown}"
      return 1
    fi
    find_server >/dev/null 2>&1 || true
  fi

  if ! wait_for_ssh; then
    emit_final "error" "ssh-not-ready-within-${SSH_WAIT_S}s"
    return 1
  fi
  log "SSH erreichbar: ${SSH_USER}@${SERVER_IP}"

  if ! wait_for_verify; then
    local missing=()
    [[ -z "$NODE_VERSION" ]] && missing+=("node")
    [[ -z "$CHROMIUM_PATH" ]] && missing+=("chromium")
    [[ "$REPO_STATE" != "present" ]] && missing+=("repo:$REPO_PATH")
    WARNINGS+=("missing:${missing[*]:-unknown}")
    emit_final "error" "verify-failed:${missing[*]:-unknown}"
    return 1
  fi

  emit_final "ready" "testhost-ready"
  return 0
}

snapshot_and_wait() { # $1 = server id; setzt SNAPSHOT_ID
  local id="$1" description body status image_id state deadline
  description="${SNAPSHOT_PREFIX}$(date -u +%Y%m%dT%H%M%SZ)"
  body="$(AM_DESC="$description" python3 -c 'import json,os;print(json.dumps({"type":"snapshot","description":os.environ["AM_DESC"]}))')"
  status="$(hapi POST "/servers/$id/actions/create_image" "$body")"
  if [[ "$status" != "201" ]]; then
    log "create_image -> HTTP $status ($(api_error_text))"
    WARNINGS+=("snapshot-http-$status")
    return 1
  fi
  image_id="$(json_get "$BODY" "image.id")"
  SNAPSHOT_ID="$image_id"
  [[ -n "$image_id" ]] || { WARNINGS+=("snapshot-no-image-id"); return 1; }
  log "Snapshot $image_id ($description) laeuft - warte auf status=available."

  deadline=$(( $(date +%s) + SNAPSHOT_WAIT_S ))
  while [[ "$(date +%s)" -lt "$deadline" ]]; do
    status="$(hapi GET "/images/$image_id")"
    if [[ "$status" == "200" ]]; then
      state="$(json_get "$BODY" "image.status")"
      if [[ "$state" == "available" ]]; then
        log "Snapshot $image_id ist available."
        return 0
      fi
      if [[ "$state" == "error" ]]; then
        WARNINGS+=("snapshot-status-error")
        return 1
      fi
    else
      log "GET /images/$image_id -> HTTP $status"
    fi
    sleep 10
  done
  WARNINGS+=("snapshot-not-available-within-${SNAPSHOT_WAIT_S}s")
  return 1
}

delete_server() { # $1 = server id
  local id="$1" status deadline
  status="$(hapi DELETE "/servers/$id")"
  if [[ "$status" != "200" && "$status" != "204" ]]; then
    log "DELETE /servers/$id -> HTTP $status ($(api_error_text))"
    return 1
  fi
  deadline=$(( $(date +%s) + 60 ))
  while [[ "$(date +%s)" -lt "$deadline" ]]; do
    if find_server && [[ -z "$SERVER_ID" ]]; then
      # Fuer den Report: die ID des Servers, der geloescht wurde - die Liste
      # ist jetzt leer, SERVER_ID waere sonst null.
      SERVER_ID="$id"
      return 0
    fi
    sleep 3
  done
  return 1
}

teardown() {
  if ! find_server; then
    emit_final "error" "server-lookup-failed"
    return 1
  fi
  if [[ -z "$SERVER_ID" ]]; then
    log "Kein Server '$SERVER_NAME' vorhanden - nichts zu sichern, nichts zu loeschen."
    emit_final "ok" "already-absent"
    return 0
  fi

  if ! snapshot_and_wait "$SERVER_ID"; then
    emit_final "error" "snapshot-not-available-server-kept"
    return 1
  fi

  local rotation
  rotation="$(rotate_snapshots)"
  if [[ "$(json_get <(printf '%s' "$rotation") "ok")" != "True" ]]; then
    warn "Snapshot-Rotation fehlgeschlagen: $rotation"
  else
    DELETED_IMAGES="$(json_get <(printf '%s' "$rotation") "deleted" | python3 -c 'import json,sys;d=sys.stdin.read().strip() or "[]";print(len(json.loads(d)))' 2>/dev/null || echo 0)"
  fi

  local id="$SERVER_ID"
  if ! delete_server "$id"; then
    emit_final "error" "delete-failed"
    return 1
  fi
  SERVER_STATUS="deleted"
  log "Server $id geloescht - 0 EUR/h erreicht (Snapshots bleiben)."
  emit_final "ok" "torn-down"
  return 0
}

consume_requests() {
  local request_src="" files=() file verdict
  if ! find_server; then
    emit_final "error" "server-lookup-failed"
    return 1
  fi

  if [[ -d "$REQUEST_DIR" ]] && compgen -G "$REQUEST_DIR/*.json" >/dev/null; then
    request_src="$REQUEST_DIR"
  elif [[ -n "$SERVER_IP" ]] && ssh_ready; then
    mkdir -p "$TMP/requests"
    if scp -q "${SSH_OPTS[@]}" -r "${SSH_USER}@${SERVER_IP}:${REQUEST_DIR}/." "$TMP/requests/" 2>/dev/null; then
      request_src="$TMP/requests"
    fi
  fi

  if [[ -z "$request_src" ]]; then
    # Ohne lesbare Quelle ist "kein Auftrag" nicht beweisbar: ein Server, der
    # laeuft, aber per SSH nicht erreichbar ist, kann einen Auftrag tragen.
    # Ein wirklich fehlender Server ist dagegen eindeutig - nichts zu tun.
    if [[ -n "$SERVER_ID" ]]; then
      warn "Auftrags-Verzeichnis $REQUEST_DIR auf ${SERVER_IP:-<keine IP>} ist nicht lesbar - fail-closed."
      emit_final "error" "request-source-unreachable"
      return 1
    fi
    emit_final "ok" "no-request"
    return 0
  fi

  shopt -s nullglob
  files=("$request_src"/*.json)
  shopt -u nullglob
  if [[ "${#files[@]}" -eq 0 ]]; then
    emit_final "ok" "no-request"
    return 0
  fi

  local blocked=0
  for file in "${files[@]}"; do
    verdict="$(AM_FILE="$file" AM_EXPECT_ID="${SERVER_ID:-}" AM_EXPECT_NAME="$SERVER_NAME" python3 - <<'PY'
import json
import os
import sys

path = os.environ["AM_FILE"]
expect_id = (os.environ.get("AM_EXPECT_ID") or "").strip()
expect_name = os.environ.get("AM_EXPECT_NAME") or ""
try:
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
except Exception as exc:
    print("invalid:%s" % exc)
    sys.exit(0)

if not isinstance(data, dict):
    print("invalid:not-an-object")
    sys.exit(0)
if data.get("request") != "teardown":
    print("invalid:request-not-teardown")
    sys.exit(0)
requested_id = str(data.get("server_id") or "")
requested_name = str(data.get("server_name") or "")
if not requested_id.isdigit():
    print("invalid:server_id-missing")
    sys.exit(0)
if expect_id and requested_id != expect_id:
    print("foreign:server_id-%s" % requested_id)
    sys.exit(0)
if requested_name and expect_name and requested_name != expect_name:
    print("foreign:server_name-%s" % requested_name)
    sys.exit(0)
print("ok:%s" % requested_id)
PY
)"
    case "$verdict" in
      ok:*)
        log "Gueltiger Auftrag: $file (server_id=${verdict#ok:})"
        if teardown; then
          if [[ "$request_src" == "$REQUEST_DIR" ]]; then
            mkdir -p "$REQUEST_DIR/done"
            mv -f "$file" "$REQUEST_DIR/done/" 2>/dev/null || true
          fi
          return 0
        fi
        return 1
        ;;
      foreign:*)
        warn "Auftrag $file zeigt auf ${verdict#foreign:} - passt nicht zum gefundenen Server ${SERVER_ID:-<none>}, wird nicht ausgefuehrt."
        blocked=1
        ;;
      *)
        warn "Auftrag $file ist unbrauchbar (${verdict}) - fail-closed, keine Aktion."
        blocked=1
        ;;
    esac
  done

  if [[ "$blocked" -eq 1 ]]; then
    emit_final "error" "request-not-actionable"
    return 1
  fi
  emit_final "ok" "no-request"
  return 0
}

# --- Einstieg ---------------------------------------------------------------
case "${1:-}" in
  ""|--ensure) MODE="ensure" ;;
  --teardown) MODE="teardown" ;;
  --teardown-request) MODE="request" ;;
  --print-config) MODE="print-config" ;;
  -h|--help) usage; exit 0 ;;
  *) log "unbekanntes Argument: $1"; MODE="ensure"; emit_final "error" "bad-argument"; exit 1 ;;
esac

if [[ "${1:-}" == "--print-config" ]]; then
  print_config
  emit_final "ok" "print-config"
  exit 0
fi

if ! resolve_token; then
  log "Kein HCLOUD_TOKEN (weder Umgebung noch $ENV_DEPLOY) - fail-closed."
  emit_final "error" "token-unavailable"
  exit 1
fi

case "$MODE" in
  ensure)
    ensure_up || exit 1
    ;;
  teardown)
    teardown || exit 1
    ;;
  request)
    consume_requests || exit 1
    ;;
  *)
    emit_final "error" "unknown-mode"
    exit 1
    ;;
esac
exit 0
