#!/usr/bin/env bash
# =============================================================================
# am-idle-snapshot-delete.sh – Idle-Erkennung auf dem AM-Testhost (ccx33)
# -----------------------------------------------------------------------------
# WAS DIESES SKRIPT TUT (laeuft AUF dem Zielserver, root, alle 5 Minuten)
#   Es prueft, ob der Host seit >= 25 Minuten unbenutzt ist:
#     1. keine Zeile im nginx-access.log innerhalb der letzten 25 min
#     2. kein chromium/chrome-Prozess
#     3. keine ESTABLISHED-WebSocket-Verbindung (Ports 80/443/3000/8080)
#     4. kein Schreibzugriff unter /workspace/work in den letzten 25 min
#     5. kein Agent-Prozess, dessen cwd unter /workspace/work liegt
#   Ist der Host >= 30 min idle, wird der Zustand festgehalten, ein JSON-
#   Auftrag nach /var/lib/am-idle/ geschrieben und das Skript endet.
#   Zusaetzlich werden AM-EIGENE Snapshots rotiert (siehe unten).
#
# WAS DIESES SKRIPT AUSDRUECKLICH NICHT TUT
#   Es snapshotet und loescht NICHT den Server, auf dem es selbst laeuft.
#   Ein Prozess kann die Maschine, die ihn traegt, nicht sichern und danach
#   loeschen: sobald der Snapshot geschrieben oder der Server geloescht ist,
#   ist der Prozess weg und kann den naechsten Schritt nicht mehr ausfuehren.
#   Ein Skript, das sich selbst `shutdown`/`poweroff` schickt und den Rest
#   "annimmt", ist ein Blindflug - der Server waere danach gestoppt, wuerde
#   aber weiter Disk-Grundpreis kosten, und niemand haette gesichert. Genau
#   das wird hier NICHT gebaut: es gibt in dieser Datei keinen Aufruf von
#   shutdown/poweroff/reboot und kein DELETE auf den eigenen Server.
#   Die Zerstoerung uebernimmt der Betreiber-Rechner:
#       scripts/audit/ensure-testhost-up.sh --teardown-request
#   Der Auftrag in /var/lib/am-idle/ ist die einzige Schnittstelle.
#
# SNAPSHOT-ROTATION (nur AM-eigene Images)
#   Snapshots mit description-Praefix "am-ccx33-" gehoeren zu diesem Testhost;
#   die neuesten 3 bleiben, aeltere werden geloescht. Jedes andere Image
#   (fremde Projekt-Snapshots, Backups anderer Rollen) wird NIE angefasst -
#   geloescht wird ausschliesslich, was exakt mit dem Praefix beginnt.
#   Ein Server darf erst geloescht werden, nachdem sein eigener Snapshot
#   `available` ist; das entscheidet der Controller, nicht dieses Skript.
#
# FEHLERVERHALTEN
#   Fail-closed: ist ein Kriterium nicht messbar (Log fehlt, /workspace/work
#   fehlt, Prozessliste unlesbar), gilt der Host als NICHT idle. Lieber ein
#   Tag zu viel bezahlt als eine laufende Sitzung zerschnitten.
#
# Aufruf:
#   bash scripts/audit/am-idle-snapshot-delete.sh               # pruefen
#   bash scripts/audit/am-idle-snapshot-delete.sh --rotate      # nur Rotation
#   bash scripts/audit/am-idle-snapshot-delete.sh --print-config
#   bash scripts/audit/am-idle-snapshot-delete.sh --help
#
# Exit: 0 = Lauf ok (aktiv / wartend / Auftrag geschrieben)
#       1 = fail-closed: Kriterium nicht messbar, Token/API-Fehler -> KEIN Auftrag
# Letzte Zeile auf stdout ist immer GENAU EIN JSON-Objekt; einzige Ausnahme
# ist --help (menschenlesbarer Text, keine Aktion).
#
# Overrides (Tests/andere Hosts):
#   AM_IDLE_STATE_DIR (/var/lib/am-idle), AM_HETZNER_TOKEN_FILE
#   (/etc/am/hetzner-token), AM_WORK_DIR (/workspace/work),
#   AM_NGINX_ACCESS_LOG (/var/log/nginx/access.log), AM_WSS_PORTS (80,443,3000,8080),
#   AM_IDLE_QUIET_MINUTES (25), AM_IDLE_TOTAL_MINUTES (30),
#   AM_SNAPSHOT_PREFIX (am-ccx33-), AM_KEEP_SNAPSHOTS (3), AM_SERVER_NAME (am-ccx33)
# =============================================================================
set -euo pipefail
umask 077

SCRIPT_NAME="am-idle-snapshot-delete"
STATE_DIR="${AM_IDLE_STATE_DIR:-/var/lib/am-idle}"
TOKEN_FILE="${AM_HETZNER_TOKEN_FILE:-/etc/am/hetzner-token}"
API_BASE="${AM_HETZNER_API:-https://api.hetzner.cloud/v1}"
UA="audiomonastry-am-idle/1.0"
QUIET_MIN="${AM_IDLE_QUIET_MINUTES:-25}"
TOTAL_MIN="${AM_IDLE_TOTAL_MINUTES:-30}"
WORK_DIR="${AM_WORK_DIR:-/workspace/work}"
NGINX_LOG="${AM_NGINX_ACCESS_LOG:-/var/log/nginx/access.log}"
WSS_PORTS="${AM_WSS_PORTS:-80,443,3000,8080}"
SNAPSHOT_PREFIX="${AM_SNAPSHOT_PREFIX:-am-ccx33-}"
KEEP_SNAPSHOTS="${AM_KEEP_SNAPSHOTS:-3}"
SERVER_NAME="${AM_SERVER_NAME:-am-ccx33}"

EMITTED=0

log() { printf '[%s] [am-idle] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }

# Genau eine maschinenlesbare Schlusszeile. $3 ist ein optionales JSON-Objekt,
# das die Basis-Felder ergaenzt (bei kaputtem JSON landet es als "detail").
emit_final() {
  AM_F_SCRIPT="$SCRIPT_NAME" \
  AM_F_STATUS="${1:-error}" \
  AM_F_REASON="${2:-}" \
  AM_F_EXTRA="${3:-}" \
  AM_F_HOST="$(hostname 2>/dev/null || echo unknown)" \
  python3 - <<'PY'
import datetime
import json
import os

obj = {
    "script": os.environ.get("AM_F_SCRIPT", "am-idle-snapshot-delete"),
    "status": os.environ.get("AM_F_STATUS", "error"),
    "reason": os.environ.get("AM_F_REASON", ""),
    "host": os.environ.get("AM_F_HOST", ""),
    "ts": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
}
extra = (os.environ.get("AM_F_EXTRA") or "").strip()
if extra:
    try:
        parsed = json.loads(extra)
    except ValueError:
        obj["detail"] = extra
    else:
        if isinstance(parsed, dict):
            obj.update(parsed)
        else:
            obj["detail"] = parsed
print(json.dumps(obj, ensure_ascii=False, sort_keys=True))
PY
  EMITTED=1
}

on_err() {
  local rc=$?
  if [[ "$EMITTED" -eq 0 ]]; then
    emit_final "error" "unexpected-failure" "{\"line\":${BASH_LINENO[0]:-0},\"exit_code\":$rc}"
  fi
  exit "$rc"
}
trap on_err ERR

usage() {
  awk 'NR > 1 && /^set -euo pipefail$/{exit} NR > 1{sub(/^# ?/, ""); print}' "$0"
}

print_config() {
  cat <<CONFIG
[$SCRIPT_NAME] Trockenlauf - es wird nichts geprueft, geschrieben oder geloescht.
  Server-Name:        $SERVER_NAME
  State/Auftrag:      $STATE_DIR
  Token-Datei:        $TOKEN_FILE  (Modus 0600 erwartet, Inhalt wird nie ausgegeben)
  API:                $API_BASE
  nginx-Access-Log:   $NGINX_LOG
  Arbeitsverzeichnis: $WORK_DIR
  WebSocket-Ports:    $WSS_PORTS (ESTABLISHED)
  Idle-Schwellen:     quiet=${QUIET_MIN}min, Auftrag ab ${TOTAL_MIN}min
  Snapshot-Praefix:   ${SNAPSHOT_PREFIX}*  (Rotation: neueste ${KEEP_SNAPSHOTS} behalten)
  Zerstoerung:        NICHT hier - scripts/audit/ensure-testhost-up.sh --teardown-request
CONFIG
}

# --- Token (wird nie ausgegeben, nie als Argument uebergeben) ----------------
load_token() {
  [[ -r "$TOKEN_FILE" ]] || { log "Token-Datei fehlt/unlesbar: $TOKEN_FILE"; return 1; }
  local mode
  mode="$(stat -c '%a' "$TOKEN_FILE" 2>/dev/null || true)"
  if [[ -n "$mode" && "$mode" != "600" && "$mode" != "400" ]]; then
    log "WARNUNG: $TOKEN_FILE hat Modus $mode (erwartet 0600) - Rechte korrigieren."
  fi
  AM_TOKEN="$(tr -d '\r\n' < "$TOKEN_FILE")"
  [[ -n "$AM_TOKEN" ]] || { log "Token-Datei ist leer: $TOKEN_FILE"; return 1; }
  export AM_TOKEN
}

json_get() { # $1 = Datei, $2 = dotted path; leer wenn nicht vorhanden
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

# --- 1. Messung: ist der Host idle? -----------------------------------------
measure_idle() {
  AM_WORK_DIR="$WORK_DIR" \
  AM_NGINX_ACCESS_LOG="$NGINX_LOG" \
  AM_WSS_PORTS="$WSS_PORTS" \
  AM_QUIET_MIN="$QUIET_MIN" \
  AM_TOTAL_MIN="$TOTAL_MIN" \
  AM_SELF_PID="$$" \
  python3 - <<'PY'
import json
import os
import re
import subprocess
import time
from datetime import datetime

work_dir = os.environ["AM_WORK_DIR"].rstrip("/") or "/"
log_path = os.environ["AM_NGINX_ACCESS_LOG"]
ports = {int(p) for p in os.environ["AM_WSS_PORTS"].split(",") if p.strip().isdigit()}
quiet_min = float(os.environ["AM_QUIET_MIN"])
total_min = float(os.environ["AM_TOTAL_MIN"])
self_pid = int(os.environ["AM_SELF_PID"])
now = time.time()

unknown = []
reasons = []
criteria = {}


def ppid_of(pid):
    try:
        with open("/proc/%d/status" % pid, "r") as fh:
            for line in fh:
                if line.startswith("PPid:"):
                    return int(line.split()[1])
    except (OSError, ValueError):
        pass
    return 0


def ancestors(pid):
    seen = set()
    cur = pid
    while cur > 1 and cur not in seen:
        seen.add(cur)
        cur = ppid_of(cur)
    return seen


excluded = ancestors(self_pid)
excluded.add(self_pid)


def nginx_ts(line):
    match = re.search(r"\[([^\]]+)\]", line)
    if not match:
        return None
    raw = match.group(1)
    for fmt in ("%d/%b/%Y:%H:%M:%S %z", "%Y-%m-%dT%H:%M:%S%z", "%d/%b/%Y:%H:%M:%S"):
        try:
            return datetime.strptime(raw, fmt).timestamp()
        except ValueError:
            continue
    return None


def log_activity():
    candidates = [log_path, log_path + ".1"]
    existing = [p for p in candidates if os.path.exists(p)]
    if not existing:
        return None, "missing"
    newest = None
    for path in existing:
        try:
            stat = os.stat(path)
            with open(path, "rb") as fh:
                fh.seek(max(0, stat.st_size - 65536))
                chunk = fh.read().decode("utf-8", "replace")
        except OSError:
            continue
        stamp = None
        for line in reversed([l for l in chunk.splitlines() if l.strip()][-50:]):
            stamp = nginx_ts(line)
            if stamp is not None:
                break
        if stamp is None:
            # Keine parsebare Zeitzeile: mtime ist die schwaechere, aber
            # einzige Aussage - Logrotate kann sie frisch setzen, deshalb
            # zaehlt sie nur als Obergrenze der Aktivitaet.
            stamp = stat.st_mtime
        newest = stamp if newest is None else max(newest, stamp)
    if newest is None:
        return None, "unreadable"
    return newest, "ok"


log_stamp, log_state = log_activity()
criteria["nginx_access_log"] = {"state": log_state, "last_line_epoch": log_stamp}
if log_state != "ok":
    unknown.append("nginx-log-%s" % log_state)


def workspace_activity():
    try:
        stat = os.stat(work_dir)
    except OSError:
        return None, "missing"
    cap_min = max(int(total_min) + 30, 60)
    cmd = [
        "find", work_dir, "-xdev", "-type", "f",
        "-mmin", "-%d" % cap_min, "-printf", "%T@\n",
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.TimeoutExpired):
        return None, "unmeasurable"
    if proc.returncode != 0:
        return None, "unmeasurable"
    stamps = []
    for line in proc.stdout.splitlines():
        try:
            stamps.append(float(line.strip()))
        except ValueError:
            continue
    if stamps:
        return max(stamps), "ok"
    # Nichts innerhalb des Fensters: der letzte Schreibzugriff liegt
    # mindestens cap_min zurueck - fuer die 30-Minuten-Entscheidung reicht
    # diese untere Schranke, mehr Genauigkeit kostet nur einen Vollwalk.
    return now - cap_min * 60, "older-than-window"


write_stamp, write_state = workspace_activity()
criteria["workspace_writes"] = {"state": write_state, "newest_epoch": write_stamp, "dir": work_dir}
if write_state in ("missing", "unmeasurable"):
    unknown.append("workspace-%s" % write_state)


browsers = []
agents = []
for entry in os.listdir("/proc"):
    if not entry.isdigit():
        continue
    pid = int(entry)
    if pid in excluded:
        continue
    try:
        with open("/proc/%d/comm" % pid, "r") as fh:
            comm = fh.read().strip()
    except OSError:
        continue
    try:
        with open("/proc/%d/cmdline" % pid, "rb") as fh:
            cmdline = fh.read().decode("utf-8", "replace").replace("\0", " ").strip()
    except OSError:
        cmdline = ""
    if "am-idle-snapshot-delete" in cmdline:
        continue
    if re.search(r"chrom(e|ium)", comm, re.I) or re.search(
        r"(^|[/ ])(chrome|chromium)( |$)", cmdline
    ):
        browsers.append({"pid": pid, "comm": comm})
        continue
    try:
        cwd = os.readlink("/proc/%d/cwd" % pid)
    except OSError:
        continue
    if cwd == work_dir or cwd.startswith(work_dir + "/"):
        agents.append({"pid": pid, "comm": comm, "cwd": cwd})

criteria["browser_processes"] = {"state": "ok", "count": len(browsers), "sample": browsers[:5]}
criteria["agent_processes"] = {"state": "ok", "count": len(agents), "sample": agents[:5]}
if browsers:
    reasons.append("chromium-laeuft (%d)" % len(browsers))
if agents:
    reasons.append("agent-cwd-unter-workspace (%d)" % len(agents))


def established_websocket_conns():
    """Eingehende, offene Sitzungen auf den Dienst-Ports.

    Nur die LOKALE Portnummer zaehlt: eine WebSocket-Sitzung ist eine vom
    Client aufgebaute Verbindung, die auf einem Dienst-Port des Hosts
    angenommen wird. Ausgehende Verbindungen des Hosts (z. B. ein Agent, der
    eine HTTPS-API ruft) haben einen kurzlebigen lokalen Port und wuerden den
    Host sonst dauerhaft als "benutzt" markieren - gemessen auf einer
    Workstation sind das sofort ~9 Verbindungen ohne einen einzigen Nutzer.
    Ausgehende Verbindungen werden deshalb nur INFORMATIV gezaehlt.
    """
    inbound = 0
    outbound = 0
    for path in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            with open(path, "r") as fh:
                lines = fh.read().splitlines()[1:]
        except OSError:
            continue
        for line in lines:
            fields = line.split()
            if len(fields) < 4 or fields[3] != "01":  # 01 = ESTABLISHED
                continue
            try:
                local = int(fields[1].split(":")[1], 16)
                remote = int(fields[2].split(":")[1], 16)
            except (IndexError, ValueError):
                continue
            if local in ports:
                inbound += 1
            elif remote in ports:
                outbound += 1
    return inbound, outbound


conns, outbound_conns = established_websocket_conns()
criteria["established_ws_conns"] = {
    "state": "ok",
    "count": conns,
    "outbound_informational": outbound_conns,
    "ports": sorted(ports),
}
if conns:
    reasons.append("established-websocket-verbindung (%d)" % conns)

quiet_minutes = None
if log_state == "ok" and write_state in ("ok", "older-than-window"):
    # Die JUENGSTE gemessene Aktivitaet bestimmt die Ruhezeit - nicht die
    # aelteste: ein Log von vor zwei Stunden und ein Schreibzugriff von vor
    # einer Minute heisst eine Minute Ruhe.
    last_activity = max(log_stamp, write_stamp)
    quiet_minutes = round((now - last_activity) / 60.0, 1)
    if quiet_minutes < quiet_min:
        reasons.append("aktivitaet-vor-%.1fmin (schwelle %.0f)" % (quiet_minutes, quiet_min))

if unknown:
    verdict = "blocked"
elif reasons:
    verdict = "active"
elif quiet_minutes is None:
    verdict = "blocked"
    unknown.append("quiet-window-unmeasurable")
elif quiet_minutes >= total_min:
    verdict = "idle-request"
else:
    verdict = "idle-waiting"

print(json.dumps({
    "verdict": verdict,
    "quiet_minutes": quiet_minutes,
    "thresholds": {"quiet": quiet_min, "request": total_min},
    "reasons": reasons,
    "unknown": unknown,
    "criteria": criteria,
    "measured_at": datetime.now().astimezone().astimezone().isoformat(timespec="seconds"),
    "now_epoch": int(now),
}, ensure_ascii=False, sort_keys=True))
PY
}

# --- 2. Wer bin ich? (Metadaten, kein Token noetig; API nur als Fallback) ---
resolve_identity() {
  AM_SERVER_NAME="$SERVER_NAME" python3 - <<'PY'
import json
import os
import urllib.request

def meta(path):
    try:
        with urllib.request.urlopen(
            "http://169.254.169.254/hetzner/v1/metadata/" + path, timeout=3
        ) as resp:
            return resp.read().decode("utf-8", "replace").strip()
    except Exception:
        return ""

instance_id = meta("instance-id")
out = {
    "server_id": int(instance_id) if instance_id.isdigit() else None,
    "server_ip": meta("public-ipv4"),
    "server_hostname": meta("hostname"),
    "source": "metadata",
}
print(json.dumps(out, ensure_ascii=False, sort_keys=True))
PY
}

resolve_identity_via_api() { # Fallback: Name -> ID (braucht Token)
  AM_SERVER_NAME="$SERVER_NAME" AM_API_BASE="$API_BASE" AM_UA="$UA" python3 - <<'PY'
import json
import os
import urllib.error
import urllib.parse
import urllib.request

url = "%s/servers?name=%s" % (
    os.environ["AM_API_BASE"].rstrip("/"),
    urllib.parse.quote(os.environ["AM_SERVER_NAME"]),
)
req = urllib.request.Request(url, method="GET", headers={
    "Authorization": "Bearer " + os.environ.get("AM_TOKEN", ""),
    "Content-Type": "application/json",
    "User-Agent": os.environ.get("AM_UA", "audiomonastry-am-idle/1.0"),
})
try:
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read() or b"{}")
except urllib.error.HTTPError as exc:
    print(json.dumps({"server_id": None, "error": "http-%d" % exc.code}))
    raise SystemExit(0)
except Exception as exc:
    print(json.dumps({"server_id": None, "error": str(exc)}))
    raise SystemExit(0)

servers = data.get("servers") or []
if not servers:
    print(json.dumps({"server_id": None, "error": "name-not-found"}))
    raise SystemExit(0)
server = servers[0]
print(json.dumps({
    "server_id": server.get("id"),
    "server_ip": ((server.get("public_net") or {}).get("ipv4") or {}).get("ip"),
    "server_hostname": server.get("name"),
    "source": "api",
}, ensure_ascii=False, sort_keys=True))
PY
}

# --- 3. Zustand + Auftrag schreiben -----------------------------------------
write_state() { # $1 = measure json, $2 = verdict, $3 = request path or ''
  AM_STATE_DIR="$STATE_DIR" \
  AM_MEASURE="$1" \
  AM_VERDICT="$2" \
  AM_REQUEST="$3" \
  python3 - <<'PY'
import datetime
import json
import os
import pathlib

state_dir = pathlib.Path(os.environ["AM_STATE_DIR"])
state_dir.mkdir(parents=True, exist_ok=True)
try:
    measure = json.loads(os.environ["AM_MEASURE"])
except ValueError:
    measure = {}
state = {
    "verdict": os.environ["AM_VERDICT"],
    "request": os.environ.get("AM_REQUEST", ""),
    "updated_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "measure": measure,
}
path = state_dir / "state.json"
tmp = state_dir / (".state.json.%d.tmp" % os.getpid())
tmp.write_text(json.dumps(state, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8")
tmp.chmod(0o600)
tmp.replace(path)
PY
}

write_request() { # $1 = measure json, $2 = identity json; echo Pfad
  AM_STATE_DIR="$STATE_DIR" \
  AM_MEASURE="$1" \
  AM_IDENTITY="$2" \
  AM_SNAPSHOT_PREFIX="$SNAPSHOT_PREFIX" \
  AM_SERVER_NAME="$SERVER_NAME" \
  python3 - <<'PY'
import datetime
import json
import os
import pathlib

state_dir = pathlib.Path(os.environ["AM_STATE_DIR"])
state_dir.mkdir(parents=True, exist_ok=True)
measure = json.loads(os.environ["AM_MEASURE"])
identity = json.loads(os.environ["AM_IDENTITY"])
server_id = identity.get("server_id")
if not isinstance(server_id, int):
    raise SystemExit("server-id-unbekannt")

path = state_dir / ("teardown-request-%d.json" % server_id)
now = datetime.datetime.now(datetime.timezone.utc)
stamp = now.strftime("%Y-%m-%dT%H:%M:%SZ")

attempts = 0
first_requested = stamp
if path.exists():
    try:
        old = json.loads(path.read_text(encoding="utf-8"))
        attempts = int(old.get("attempts") or 0)
        first_requested = old.get("first_requested_at") or old.get("timestamp") or stamp
    except (ValueError, OSError):
        attempts = 0

request = {
    "request": "teardown",
    "server_id": server_id,
    "server_name": identity.get("server_hostname") or os.environ["AM_SERVER_NAME"],
    "server_ip": identity.get("server_ip") or "",
    "reason": "idle >= %s min ohne Aktivitaet" % measure.get("thresholds", {}).get("request", 30),
    "quiet_minutes": measure.get("quiet_minutes"),
    "verdict": measure.get("verdict"),
    "criteria": measure.get("criteria"),
    "image_description": os.environ["AM_SNAPSHOT_PREFIX"] + now.strftime("%Y%m%dT%H%M%SZ"),
    "requested_by": "am-idle-snapshot-delete.sh",
    "first_requested_at": first_requested,
    "timestamp": stamp,
    "attempts": attempts + 1,
    "consume_with": "scripts/audit/ensure-testhost-up.sh --teardown-request",
}
tmp = state_dir / (".%s.tmp" % path.name)
tmp.write_text(json.dumps(request, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
               encoding="utf-8")
tmp.chmod(0o600)
tmp.replace(path)
print(str(path))
PY
}

# --- 4. Rotation: nur AM-eigene Snapshots, neueste N behalten ---------------
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

API = os.environ["AM_API_BASE"].rstrip("/")
PREFIX = os.environ["AM_SNAPSHOT_PREFIX"]
KEEP = int(os.environ.get("AM_KEEP_SNAPSHOTS") or 3)
UA = os.environ.get("AM_UA", "audiomonastry-am-idle/1.0")
TOKEN = os.environ.get("AM_TOKEN", "")


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        API + path,
        data=data,
        method=method,
        headers={
            "Authorization": "Bearer " + TOKEN,
            "Content-Type": "application/json",
            "User-Agent": UA,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as exc:
        raw = exc.read() or b""
        try:
            return exc.code, json.loads(raw)
        except ValueError:
            return exc.code, {"raw": raw.decode("utf-8", "replace")[:300]}
    except Exception as exc:  # Transportfehler: nicht raten, nicht loeschen
        return 0, {"transport_error": str(exc)}


images = []
page = 1
while page and page <= 50:
    status, data = call("GET", "/images?type=snapshot&sort=created:desc&per_page=50&page=%d" % page)
    if status != 200:
        print(json.dumps({"ok": False, "error": "list-http-%d" % status,
                          "detail": data.get("error") or data}, ensure_ascii=False))
        sys.exit(0)
    images.extend(data.get("images") or [])
    page = ((data.get("meta") or {}).get("pagination") or {}).get("next_page")

owned = [i for i in images if (i.get("description") or "").startswith(PREFIX)]
owned.sort(key=lambda i: i.get("created") or "", reverse=True)
victims = [i for i in owned[KEEP:] if i.get("status") == "available"]

deleted = []
errors = []
for image in victims:
    status, data = call("DELETE", "/images/%s" % image.get("id"))
    if status in (200, 204):
        deleted.append({"id": image.get("id"), "description": image.get("description")})
    else:
        errors.append({"id": image.get("id"), "http": status,
                       "detail": data.get("error") or data})

print(json.dumps({
    "ok": not errors,
    "prefix": PREFIX,
    "owned_total": len(owned),
    "kept": [{"id": i.get("id"), "description": i.get("description"),
              "status": i.get("status")} for i in owned[:KEEP]],
    "skipped_not_available": len([i for i in owned[KEEP:] if i.get("status") != "available"]),
    "deleted": deleted,
    "errors": errors,
}, ensure_ascii=False, sort_keys=True))
PY
}

# --- Ablauf -----------------------------------------------------------------
MODE="check"
case "${1:-}" in
  ""|--check) MODE="check" ;;
  --rotate) MODE="rotate" ;;
  --print-config) print_config; emit_final "ok" "print-config"; exit 0 ;;
  -h|--help) usage; exit 0 ;;
  *) log "unbekanntes Argument: $1"; emit_final "error" "bad-argument"; exit 1 ;;
esac

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR" 2>/dev/null || true

if ! load_token; then
  emit_final "error" "token-unavailable" "{\"token_file\":\"$TOKEN_FILE\"}"
  exit 1
fi

if [[ "$MODE" == "rotate" ]]; then
  rotation="$(rotate_snapshots)"
  if [[ "$(json_get <(printf '%s' "$rotation") "ok")" != "True" ]]; then
    emit_final "error" "snapshot-rotation-failed" "$rotation"
    exit 1
  fi
  emit_final "ok" "snapshot-rotation" "$rotation"
  exit 0
fi

measure="$(measure_idle)"
if [[ -z "$measure" ]]; then
  emit_final "error" "measurement-failed"
  exit 1
fi
verdict="$(json_get <(printf '%s' "$measure") "verdict")"

case "$verdict" in
  active)
    write_state "$measure" "active" ""
    log "aktiv: $(json_get <(printf '%s' "$measure") "reasons")"
    emit_final "ok" "active" "$measure"
    exit 0
    ;;
  blocked)
    write_state "$measure" "blocked" ""
    log "fail-closed: ein Kriterium ist nicht messbar -> kein Auftrag."
    emit_final "error" "criterion-unmeasurable" "$measure"
    exit 1
    ;;
  idle-waiting)
    write_state "$measure" "idle-waiting" ""
    log "idle seit $(json_get <(printf '%s' "$measure") "quiet_minutes") min - warte auf ${TOTAL_MIN} min."
    emit_final "ok" "idle-waiting" "$measure"
    exit 0
    ;;
  idle-request)
    ;;
  *)
    emit_final "error" "unknown-verdict:${verdict}" "$measure"
    exit 1
    ;;
esac

# Idle >= Schwelle: Identitaet, Auftrag, Rotation - dann ENDE.
identity="$(resolve_identity)"
if [[ "$(json_get <(printf '%s' "$identity") "server_id")" == "" ]]; then
  identity="$(resolve_identity_via_api)"
fi
server_id="$(json_get <(printf '%s' "$identity") "server_id")"
if [[ -z "$server_id" ]]; then
  write_state "$measure" "blocked" ""
  emit_final "error" "server-id-unresolvable" "$identity"
  exit 1
fi

if ! request_path="$(write_request "$measure" "$identity")"; then
  emit_final "error" "request-write-failed"
  exit 1
fi

write_state "$measure" "idle-requested" "$request_path"
log "Auftrag geschrieben: $request_path (Zerstoerung durch den Controller, nicht durch dieses Skript)."

rotation="$(rotate_snapshots)"
rotation_ok="$(json_get <(printf '%s' "$rotation") "ok")"
extra="$(python3 - "$measure" "$identity" "$request_path" "$rotation" <<'PY'
import json
import sys

measure, identity, request_path, rotation = (json.loads(a) for a in sys.argv[1:5])
out = dict(measure)
out["request_file"] = request_path
out["server_id"] = identity.get("server_id")
out["server_ip"] = identity.get("server_ip")
out["identity_source"] = identity.get("source")
out["rotation"] = rotation
print(json.dumps(out, ensure_ascii=False, sort_keys=True))
PY
)"
if [[ "$rotation_ok" == "True" ]]; then
  emit_final "ok" "idle-requested" "$extra"
  exit 0
fi
log "Rotation fehlgeschlagen - Auftrag bleibt bestehen, Rotation beim naechsten Lauf erneut."
emit_final "error" "snapshot-rotation-failed" "$extra"
exit 1
