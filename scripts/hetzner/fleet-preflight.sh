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
#   3. dns        – prüft die Cloudflare-DNS-Verdrahtung (NUR GET-Requests,
#                   keine Schreiboperation): Token/Zone/Record. Ohne diese
#                   Verdrahtung liefert https://PORTAL_DOMAIN HTTP 522, weil der
#                   Worker den Origin nicht erreicht (siehe
#                   docs/ORIGIN_TLS_DNS_RUNBOOK.md).
#
# PROD-P1-F4 – Staleness-Gate (real gemessen am 2026-09-20: app-1 lief auf einem
# Image vom 18.09., das Repo stand auf ae5e749 vom 20.09.; /api/health nannte nur
# eine Version, die sich nicht mit jedem Commit aendert):
#   * Der lokale Repo-Commit geht als `expectedCommit` an /api/wake und als
#     `?expected=` an /api/status - der Portal-Worker meldet dann "Flotte laeuft
#     Stand X, Repo ist Y" (state 'stale') statt "ready".
#   * `check`/`apply` vergleichen zusaetzlich den von /api/health gemeldeten
#     Commit des laufenden Knotens (scripts/hetzner/lib/build-parity.sh, dieselbe
#     Bibliothek wie deploy.sh) und enden bei belegter Abweichung mit Exit 1.
#   * Bewusst abweichend weiterfahren: `--allow-stale` (bzw. ALLOW_STALE=1).
#     "Nicht pruefbar" (Image vor F4 ohne commit-Feld) blockiert NICHT - es wird
#     laut gemeldet.
#
# Konfiguration (env oder .env.deploy im Repo-Root):
#   PORTAL_URL         https://anunnakitools.de
#   DEPLOY_DOMAIN      anunnakitools.de
#   ADMIN_USER         Portal-Admin-User
#   ADMIN_PASSWORD     Portal-Admin-Passwort
#   DEPLOY_SSH_KEY     Pfad zum SSH-Key (Default ~/.ssh/id_ed25519)
#   HCLOUD_TOKEN       optional: für Status der übrigen Rollen
#   CLOUDFLARE_API_TOKEN  nur für 'dns': Token mit Zone:DNS:Edit (wird NIE ausgegeben)
#   PORTAL_DOMAIN      nur für 'dns': Zone (Default anunnakitools.de)
#   ORIGIN_HOST        nur für 'dns': Default origin.$PORTAL_DOMAIN
#   APP_IP             nur für 'dns': erwartete app-1-IP (Abweichung = Fehler)
#   CF_API_BASE        nur für 'dns': API-Basis (Default Cloudflare v4; für den
#                      Offline-Test gegen einen lokalen Stub überschreibbar)
#   ALLOW_STALE        1 = belegte Commit-Abweichung bewusst erlauben (Default 0)
#
# Aufruf:
#   bash scripts/hetzner/fleet-preflight.sh check
#   bash scripts/hetzner/fleet-preflight.sh apply
#   bash scripts/hetzner/fleet-preflight.sh dns
#   bash scripts/hetzner/fleet-preflight.sh dns --print-config   (ohne Netz)
#   bash scripts/hetzner/fleet-preflight.sh check --allow-stale  (bewusst abweichend)
#
# Betreiber-Schritte bei 'dns'-Fehlern (Details: docs/ORIGIN_TLS_DNS_RUNBOOK.md):
#   1. Token mit Zone:DNS:Edit prüfen (Fehlercode 9109 = Token ungültig).
#   2. A-Record ORIGIN_HOST -> app-1-IP anlegen, type A, proxied=false (DNS-only).
#   3. Origin-Zertifikat auf den Knoten bringen: deploy.sh mit ORIGIN_CERT/ORIGIN_KEY
#      (Caddyfile-Quelle: scripts/hetzner/Caddyfile.origin).
#   4. Verify: curl -sS -o /dev/null -w '%{http_code}\n' https://PORTAL_DOMAIN/api/health
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/../.."

# Vergleich der Commits (PROD-P1-F4) - dieselbe Bibliothek wie deploy.sh.
# shellcheck source=scripts/hetzner/lib/build-parity.sh
# shellcheck disable=SC1091
source scripts/hetzner/lib/build-parity.sh

# Aufruf: <check|apply|dns> [--allow-stale] [--print-config (nur dns)];
# ALLOW_STALE=1 wirkt ebenso (env/.env.deploy).
MODE="${1:-check}"
CLI_ALLOW_STALE=0
MODE_ARGS=()
if [[ $# -gt 0 ]]; then shift; fi
for arg in "$@"; do
  case "$arg" in
    --allow-stale) CLI_ALLOW_STALE=1 ;;
    --print-config) MODE_ARGS+=("$arg") ;;
    *) echo "Unbekannte Option: $arg (erlaubt: --allow-stale, --print-config)" >&2; exit 1 ;;
  esac
done

if [[ -f .env.deploy ]]; then set -a; . ./.env.deploy; set +a; fi

# Bewusste Freigabe: CLI schlaegt env/Datei (--allow-stale gewinnt).
if [[ "$CLI_ALLOW_STALE" == "1" || "${ALLOW_STALE:-0}" == "1" ]]; then
  ALLOW_STALE=1
else
  ALLOW_STALE=0
fi
# JSON-taugliche Form fuer den Wake-Body (true/false waere hier auch moeglich,
# 1/0 haelt Worker-Seite, Portal und Shell auf derselben Schreibweise).
if [[ "$ALLOW_STALE" == "1" ]]; then ALLOW_STALE_JSON=1; else ALLOW_STALE_JSON=0; fi

PORTAL_URL="${PORTAL_URL:-https://anunnakitools.de}"
DEPLOY_DOMAIN="${DEPLOY_DOMAIN:-anunnakitools.de}"
DEPLOY_SSH_KEY="${DEPLOY_SSH_KEY:-$HOME/.ssh/id_ed25519}"
COOKIE_JAR="/tmp/audiomonastry-portal.cookies"
SSH_OPTS=(-i "$DEPLOY_SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -o BatchMode=yes)

# --- Cloudflare-DNS (Unterbefehl 'dns') -------------------------------------
# Alles Nur-Lesen: der Unterbefehl prueft und meldet, er repariert nichts.
CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN:-}"
PORTAL_DOMAIN="${PORTAL_DOMAIN:-anunnakitools.de}"
ORIGIN_HOST="${ORIGIN_HOST:-origin.$PORTAL_DOMAIN}"
APP_IP="${APP_IP:-}"
CF_API_BASE="${CF_API_BASE:-https://api.cloudflare.com/client/v4}"

# Toleranter Zustands-Lookup: 'dns' darf nicht davon abhaengen, dass node/git
# im PATH liegen (der Unterbefehl kommt ohne beides aus).
LOCAL_COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo unknown)"

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

portal_status() {
  # PROD-P1-F4: der erwartete Repo-Commit geht mit - nur damit kann der Worker
  # "stale" (Flotte laeuft auf einem anderen Stand) von "ready" unterscheiden.
  local url="$PORTAL_URL/api/status?expected=$LOCAL_COMMIT"
  if [[ "$ALLOW_STALE" == "1" ]]; then url="$url&allowStale=1"; fi
  curl -fsS -b "$COOKIE_JAR" "$url" 2>/dev/null || echo '{"state":"unreachable"}'
}

list_snapshots() { curl -fsS -b "$COOKIE_JAR" "$PORTAL_URL/api/snapshots" 2>/dev/null || echo '{"snapshots":[]}'; }

# PROD-P1-F4: Die Paritaetsmeldung aus einer /api/status- bzw. Wake-Antwort.
# Der Wortlaut kommt vom Worker, damit Portal-Konsole, CLI und Log dasselbe sagen.
parity_message() {
  python3 -c 'import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    print("")
    sys.exit(0)
print((data.get("parity") or {}).get("message") or "")'
}

snapshot_is_current() {
  python3 -c 'import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    print("unknown"); sys.exit(0)
target = sys.argv[1]
app = [s for s in data.get("snapshots", []) if s.get("role") == "app"]
if not app:
    print("missing")
else:
    print("current" if app[0].get("commit") == target else "stale")' "$1"
}

wake_and_wait() {
  local status parity
  status="$(portal_status)"
  if [[ "$status" == *'"state":"off"'* ]]; then
    log "Flotte ist AUS → wecke sie (Portal-Wake, expectedCommit=$LOCAL_COMMIT)."
    # PROD-P1-F4: Der erwartete Commit geht mit - der Worker vergleicht ihn mit
    # den Snapshot-Labels (der laufende Container bootet erst) und meldet eine
    # veraltete Wake-Quelle laut zurueck.
    curl -fsS -b "$COOKIE_JAR" -H 'content-type: application/json' \
      -d "{\"expectedCommit\":\"$LOCAL_COMMIT\",\"allowStale\":$ALLOW_STALE_JSON}" \
      -X POST "$PORTAL_URL/api/wake" > /tmp/audiomonastry-wake.json || die "Wake fehlgeschlagen."
    parity="$(parity_message < /tmp/audiomonastry-wake.json)"
    if [[ -n "$parity" ]]; then log "Wake-Paritaet: $parity"; fi
  fi

  log "Warte auf Flotte (ready + Commit-Paritaet) …"
  for _ in $(seq 1 180); do
    status="$(portal_status)"
    if [[ "$status" == *'"state":"ready"'* ]]; then
      parity="$(printf '%s' "$status" | parity_message)"
      log "Flotte ready.${parity:+ Paritaet: $parity}"
      return 0
    fi
    if [[ "$status" == *'"state":"stale"'* ]]; then
      parity="$(printf '%s' "$status" | parity_message)"
      if [[ "$ALLOW_STALE" == "1" ]]; then
        log "⚠️  ${parity:-Stand abweichend} (bewusst erlaubt: --allow-stale)"
        return 0
      fi
      die "Flotte laeuft auf einem veralteten Stand: ${parity:-unbekannt} — Deploy nachziehen oder bewusst mit --allow-stale starten."
    fi
    sleep 4
  done
  log "Letzter Status: $status"
  die "Flotte wurde nicht rechtzeitig ready (max. 12 min)."
}

# PROD-P1-F4: Nach Deploy/Snapshot-Refresh muss der LAUFENDE Knoten den
# Repo-Commit melden - hier wird der Stand des Knotens direkt gemessen
# (/api/health ueber die Portal-Domain, dieselbe Bibliothek wie deploy.sh).
check_running_parity() {
  log "Pruefe Commit-Paritaet des laufenden Knotens (Repo=$LOCAL_COMMIT) …"
  local have verdict
  have="$(health_commit "$PORTAL_URL")"
  if verdict="$(build_parity_report "$LOCAL_COMMIT" "$have" app-1)"; then
    case "${verdict%% *}" in
      OK) log "✅ ${verdict#* }" ;;
      *) log "⚠️  ${verdict#* } (vor F4 gebaute Images tragen keinen Commit)" ;;
    esac
    return 0
  fi
  if [[ "$ALLOW_STALE" == "1" ]]; then
    log "⚠️  ${verdict#* } (bewusst erlaubt: --allow-stale)"
    return 0
  fi
  die "${verdict#* } — Neu deployen: bash deploy.sh (bzw. '$0 apply') oder bewusst: --allow-stale"
}

app_ip_from_status() {
  python3 -c 'import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    print(""); sys.exit(0)
print(data.get("appIp") or "")'
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
  echo "Lokal:   commit=$LOCAL_COMMIT  version=$VERSION  allowStale=$ALLOW_STALE_JSON"
  local status
  status="$(portal_status)"
  echo "Portal:  $status"

  # PROD-P1-F4: Was der LAUFENDE Knoten meldet, ist die zweite Haelfte der
  # Paritaet (die Snapshots sind nur die erste - was bootet beim naechsten Wake).
  check_running_parity

  if [[ -n "${ADMIN_USER:-}" && -n "${ADMIN_PASSWORD:-}" ]]; then
    login
    echo "Snapshots (app):"
    list_snapshots | python3 -c 'import json,sys; d=json.load(sys.stdin); [print("  %s: %s · %s · %s · %s" % (s.get("role"), s.get("commit") or "-", s.get("version") or "-", s.get("description"), s.get("status"))) for s in d.get("snapshots", [])]' || true
    echo "App-Snapshot ist: $(list_snapshots | snapshot_is_current "$LOCAL_COMMIT")"
  else
    echo "Hinweis: ohne ADMIN_USER/ADMIN_PASSWORD (.env.deploy) kann der Snapshot-Abgleich nicht geprüft werden."
  fi
  # Einzeiler als Bruecke: der DNS-Zustand ist die zweite haeufige Ursache fuer
  # ein nicht erreichbares Portal (522) und braucht keinen Login.
  echo "Hinweis: Cloudflare-DNS-Verdrahtung pruefen: bash scripts/hetzner/fleet-preflight.sh dns"
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

  # PROD-P1-F4: "Fertig" heisst jetzt Health UND Commit-Paritaet. Der Deploy
  # selbst bricht bei belegter Abweichung schon ab (parity_gate in deploy.sh) -
  # hier wird der laufende Knoten danach unabhaengig noch einmal gemessen.
  check_running_parity

  echo "✅ Preflight abgeschlossen. Nächster Flotten-Start nutzt den aktuellen Stand."
}

# =============================================================================
# dns - Cloudflare-DNS-Verdrahtung pruefen (INFRA-HETZNER-002)
# -----------------------------------------------------------------------------
# Nur GET-Requests: dieser Unterbefehl repariert nichts, er meldet. Fehler ->
# exit 2 (Operateur muss handeln), damit ein Skript/Automat den Zustand erkennt.
# Der Token wird NIE ausgegeben - nur 'gesetzt: ja/nein'.
# =============================================================================
cf_get() {
  # $1 = API-Pfad, $2 = Datei fuer den Antwortkoerper. Gibt den HTTP-Status aus.
  # Ohne -X: curl macht einen GET (die Zusage "nicht destruktiv" steckt hier).
  curl -sS --max-time 20 -o "$2" -w '%{http_code}' \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    -H 'accept: application/json' \
    "${CF_API_BASE}${1}"
}

cf_parse() {
  # Bewertet eine Cloudflare-Antwort: $1 = Modus (zone|record), $2 = Bodydatei,
  # $3 = HTTP-Status, $4.. = erwartete Werte. Bei einem Befund wird der Klartext
  # nach stderr geschrieben und mit exit 2 abgebrochen (set -e beendet das Skript
  # damit an genau dieser Stelle); im Erfolgsfall steht der Nutzwert auf stdout.
  python3 - "$@" <<'PY'
import json
import pathlib
import sys

mode, body_path, http_status = sys.argv[1], sys.argv[2], sys.argv[3]
extra = sys.argv[4:]
RUNBOOK = "   Betreiber-Schritte + Kommandos: docs/ORIGIN_TLS_DNS_RUNBOOK.md"


def fail(lines):
    print("\n".join(lines), file=sys.stderr)
    sys.exit(2)


def http_code(raw):
    try:
        return int(str(raw).strip() or "0")
    except ValueError:
        return 0


def detail(payload):
    """Cloudflare-Fehlercode + Message im Klartext (z. B. '9109 Invalid access token')."""
    if not isinstance(payload, dict):
        return "keine JSON-Antwort"
    parts = []
    for err in payload.get("errors") or []:
        if isinstance(err, dict):
            parts.append(f"{err.get('code')} {err.get('message') or ''}".strip())
    if parts:
        return "; ".join(parts)
    return "keine Fehlermeldung im Body"


raw = pathlib.Path(body_path).read_text(encoding="utf-8") if pathlib.Path(body_path).exists() else ""
try:
    payload = json.loads(raw or "{}")
except ValueError as exc:
    payload = None
    parse_error = str(exc)
else:
    parse_error = None

code = http_code(http_status)
results = payload.get("result") if isinstance(payload, dict) else None

if mode == "zone":
    domain = extra[0]
    if parse_error is not None or not isinstance(payload, dict):
        fail([f"Cloudflare-Zonenabfrage '{domain}' lieferte kein auswertbares JSON (HTTP {code}): {parse_error}",
              "DNS-Verdrahtung fehlt: Token ohne Zone:DNS:Edit",
              RUNBOOK])
    if code >= 400 or not payload.get("success") or not results:
        fail([f"Cloudflare-Zonenabfrage '{domain}' fehlgeschlagen (HTTP {code}): {detail(payload)}",
              "DNS-Verdrahtung fehlt: Token ohne Zone:DNS:Edit",
              RUNBOOK])
    print(results[0].get("id") or "")
    sys.exit(0)

if mode == "record":
    host = extra[0]
    expected_ip = extra[1] if len(extra) > 1 else ""
    if parse_error is not None or not isinstance(payload, dict):
        fail([f"Cloudflare-DNS-Abfrage '{host}' lieferte kein auswertbares JSON (HTTP {code}): {parse_error}",
              RUNBOOK])
    if code >= 400 or not payload.get("success"):
        fail([f"Cloudflare-DNS-Abfrage '{host}' fehlgeschlagen (HTTP {code}): {detail(payload)}", RUNBOOK])
    if not results:
        fail([f"DNS-Verdrahtung fehlt: A-Record '{host}' existiert nicht in der Zone.",
              "   Ohne diesen Record erreicht der Cloudflare-Worker den Origin nicht (HTTP 522 am Portal).",
              RUNBOOK])
    record = results[0] if isinstance(results[0], dict) else {}
    record_type = str(record.get("type") or "").upper()
    proxied = record.get("proxied")
    content = str(record.get("content") or "")
    problems = []
    if record_type != "A":
        problems.append(f"DNS-Verdrahtung fehlt: Record '{host}' hat type={record_type or '?'} statt A.")
    if proxied is not False:
        problems.append(f"DNS-Verdrahtung fehlt: Cloudflare-Proxy ist AN (proxied={str(proxied).lower()}) - "
                        f"der Record '{host}' muss DNS-only sein (graue Wolke).")
    if expected_ip and content != expected_ip:
        problems.append(f"DNS-Verdrahtung fehlt: Record '{host}' zeigt auf {content or '<leer>'} "
                        f"statt auf APP_IP {expected_ip}.")
    if problems:
        fail(problems + [RUNBOOK])
    print(content)
    sys.exit(0)

fail([f"Unbekannter Pruefmodus: {mode}", RUNBOOK])
PY
}

cmd_dns() {
  local print_only="nein"
  if [[ "${1:-}" == "--print-config" || "${DEPLOY_PRINT_CONFIG:-0}" == "1" ]]; then
    print_only="ja"
  fi

  if [[ "$print_only" == "ja" ]]; then
    # Trockenlauf: keine Netzwerkzugriffe, keine Werte - nur die effektive Konfiguration.
    local token_state="nein"
    if [[ -n "$CLOUDFLARE_API_TOKEN" ]]; then token_state="ja"; fi
    echo "fleet-preflight.sh dns - effektive Konfiguration (kein Netz, nur GET-Pfade)"
    printf '  CF_API_BASE=%s\n' "$CF_API_BASE"
    printf '  PORTAL_DOMAIN=%s\n' "$PORTAL_DOMAIN"
    printf '  ORIGIN_HOST=%s\n' "$ORIGIN_HOST"
    printf '  APP_IP=%s\n' "${APP_IP:-<nicht gesetzt>}"
    printf '  CLOUDFLARE_API_TOKEN gesetzt: %s\n' "$token_state"
    return 0
  fi

  # Schritt 1: ohne Token gibt es nichts zu pruefen - Klartextfehler, kein Rateversuch.
  if [[ -z "$CLOUDFLARE_API_TOKEN" ]]; then
    echo "DNS-Verdrahtung fehlt: CLOUDFLARE_API_TOKEN nicht gesetzt" >&2
    echo "   Betreiber-Schritte + Kommandos: docs/ORIGIN_TLS_DNS_RUNBOOK.md" >&2
    exit 2
  fi

  local tmp
  tmp="$(mktemp -d)"
  # Aufraeumen in jedem Fall (auch bei exit 2 aus cf_parse). Der Pfad liegt
  # ausserhalb der lokalen Variablen, sonst ist er im EXIT-Trap nicht mehr gesetzt.
  DNS_TMP_DIR="$tmp"
  trap 'rm -rf "${DNS_TMP_DIR:-}"' EXIT

  # Schritt 2: Zone zur Domain aufloesen (Token-Test).
  local zone_body="$tmp/zones.json" zone_http zone_id
  if ! zone_http="$(cf_get "/zones?name=$PORTAL_DOMAIN" "$zone_body")"; then
    echo "DNS-Verdrahtung fehlt: Cloudflare-API nicht erreichbar ($CF_API_BASE)" >&2
    echo "   Betreiber-Schritte + Kommandos: docs/ORIGIN_TLS_DNS_RUNBOOK.md" >&2
    exit 2
  fi
  zone_id="$(cf_parse zone "$zone_body" "$zone_http" "$PORTAL_DOMAIN")"
  echo "▶ Zone gefunden: $PORTAL_DOMAIN (id=$zone_id)"

  # Schritt 3: Origin-A-Record pruefen (Existenz, Typ, DNS-only, Ziel-IP).
  local rec_body="$tmp/records.json" rec_http origin_ip
  if ! rec_http="$(cf_get "/zones/$zone_id/dns_records?name=$ORIGIN_HOST" "$rec_body")"; then
    echo "DNS-Verdrahtung fehlt: Cloudflare-API nicht erreichbar ($CF_API_BASE)" >&2
    echo "   Betreiber-Schritte + Kommandos: docs/ORIGIN_TLS_DNS_RUNBOOK.md" >&2
    exit 2
  fi
  origin_ip="$(cf_parse record "$rec_body" "$rec_http" "$ORIGIN_HOST" "$APP_IP")"

  # Schritt 4: Erfolg melden + Remediation/Verify fuer den Betreiber.
  echo "✅ DNS-Verdrahtung ok: $ORIGIN_HOST -> $origin_ip (type A, DNS-only)"
  echo "   Remediation (falls sich die app-1-IP aendert oder der Record fehlt):"
  echo "     Record '$ORIGIN_HOST' als type A auf die app-1-Floating-IP setzen, proxied=false -"
  echo "     dafuer braucht der Token Zone:DNS:Edit; Kommandos: docs/ORIGIN_TLS_DNS_RUNBOOK.md"
  echo "   Verify: curl -sS -o /dev/null -w '%{http_code}\n' https://$PORTAL_DOMAIN/api/health   # erwartet 200"
}

case "$MODE" in
  check) cmd_check ;;
  apply) cmd_apply ;;
  dns) cmd_dns ${MODE_ARGS[@]+"${MODE_ARGS[@]}"} ;;
  *) echo "Nutzung: $0 {check|apply|dns [--print-config]} [--allow-stale]" >&2; exit 1 ;;
esac
