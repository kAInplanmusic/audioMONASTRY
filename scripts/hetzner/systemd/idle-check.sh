#!/usr/bin/env bash
# =============================================================================
# audioMONASTRY Hetzner idle check – läuft periodisch per systemd-Timer.
# Fährt die Instanz herunter, wenn über IDLE_MINUTES keine NUTZUNG messbar ist
# (stündliche Abrechnung → Kosten sparen).
#
# -----------------------------------------------------------------------------
# F9-Fix (docs/FIXPLAN_2026-09-20_externer_apptest.md, F9)
# -----------------------------------------------------------------------------
# VORZUSTAND (Belegstelle: Zeilen 34-38 dieser Datei vor dem Fix):
#   ONLINE_USERS=$(curl -fsS --max-time 5 http://127.0.0.1/api/online 2>/dev/null \
#     | awk -F'"online":' '{n=$2+0} END{print n+0}' 2>/dev/null || echo 0)
# Zwei strukturelle Fehler in EINER Zeile:
#   * Port 80 ist Caddy. Ein Klartext-`http://`-Aufruf bekommt dort **308** auf
#     https — der Body ist leer, `awk` liest nichts und druckt die 0 seines
#     END-Blocks. Der Exit-Code bleibt 0: der Fehlschlag war unsichtbar.
#   * In Produktion verlangt `/api/online` den Studio-/Scrape-Token. Ohne Token
#     kommt **401**; mit `-f` schlägt curl fehl, `|| echo 0` setzt ebenfalls 0.
# Ergebnis: das PRIMÄRsignal war strukturell immer 0 (Log: ausnahmslos
# `ONLINE=0`) — die Entscheidung hing faktisch an `HTTP_ACTIVE`, also an
# Keep-Alive-Verbindungen auf 80/443/8080 (Caddy/Monitoring), nicht an Nutzung.
#
# JETZT: Der Timer fragt die APP nach EINER Entscheidung
# (`GET /api/idle-signal`; die Regeln stehen rein und getestet in
# server/idleSignal.ts) und liefert dazu nur seine Host-Fakten mit (offene
# Sockets, SSH-Sitzungen, Load, beschäftigte Container). Die App kennt, was der
# Host nicht wissen kann: aktive Socket-Verbindungen (F8-Messwert) und den
# letzten ERFOLGREICHEN App-Request. Die Idle-Dauer führt die App über
# Zeitstempel — kein Zählerfile auf dem Knoten mehr. Eine nicht lesbare Antwort
# ist KEINE 0, sondern `SIGNAL=unavailable` → kein Shutdown (fail-safe) und mit
# HTTP-Status im Log sichtbar.
#
# Nutzung:
#   audiomonastry-idle-check.sh               → prüfen, bei Bedarf herunterfahren
#   audiomonastry-idle-check.sh --dry-run     → nur prüfen + loggen (kein Shutdown)
#   audiomonastry-idle-check.sh --print-facts → nur Host-Fakten ausgeben
#
# Konfiguration (Umgebung bzw. EnvironmentFile, siehe install-idle-shutdown.sh):
#   IDLE_CHECK_URL    Ziel der App (Default http://127.0.0.1:8080/api/idle-signal)
#   SCRAPE_TOKEN      Token für Maschinen-Clients (Fallback STUDIO_ACCESS_TOKEN)
#   IDLE_MINUTES      Schwelle, wird als thresholdSec übergeben (App-Default: 30;
#                     für Trockenläufe sind Bruchteile erlaubt, z. B. 0.05 = 3 s)
#   LOG               Logdatei (Default /var/log/audiomonastry-idle-shutdown.log)
# =============================================================================
set -uo pipefail

# Reihenfolge bewusst: ENV_FILE/LOG zuerst nur so weit, dass die Argument-Schleife
# loggen kann. Danach wird das EnvironmentFile GELESEN und erst DANACH werden die
# Defaults angewendet — sonst wuerde jeder Wert aus der Datei von den Defaults
# ueberschrieben (erster Trockenlauf 2026-09-20: der Timer rief Port 8080 an,
# obwohl die Datei 18099 konfiguriert hatte).
LOG="${LOG:-/var/log/audiomonastry-idle-shutdown.log}"
ENV_FILE="${IDLE_CHECK_ENV_FILE:-/etc/audiomonastry/idle-check.env}"
IDLE_MINUTES="${IDLE_MINUTES:-30}"

ts() { date -u +%FT%TZ; }
log() { printf '%s\n' "$*" >> "$LOG"; }

DRY_RUN=0
PRINT_FACTS=0
for arg in "$@"; do
  case "$arg" in
    --dry-run|-n) DRY_RUN=1 ;;
    --print-facts) PRINT_FACTS=1 ;;
    -h|--help)
      sed -n '2,45p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) log "[idle-check] $(ts)  WARNUNG: unbekanntes Argument '$arg' (ignoriert)" ;;
  esac
done

# Zugangsdaten/Ziel aus dem EnvironmentFile (vom Installer angelegt, Modus 0600).
# Prioritaet: EnvironmentFile > Prozess-Umgebung > Default (die Datei ist der
# konfigurierte Ort; siehe Reihenfolge-Hinweis oben).
if [[ -f "$ENV_FILE" ]]; then
  set -o allexport
  # shellcheck disable=SC1090  # bewusst: der Pfad ist per Env konfigurierbar
  . "$ENV_FILE"
  set +o allexport
fi

# Defaults NACH dem Sourcing (siehe oben).
LOG="${LOG:-/var/log/audiomonastry-idle-shutdown.log}"
IDLE_MINUTES="${IDLE_MINUTES:-30}"
IDLE_URL="${IDLE_URL:-${IDLE_CHECK_URL:-http://127.0.0.1:8080/api/idle-signal}}"
TOKEN="${SCRAPE_TOKEN:-${STUDIO_ACCESS_TOKEN:-}}"

# --- Host-Fakten (was die App nicht wissen kann) -----------------------------
OPEN_SOCKETS=$(ss -tn state established 2>/dev/null | awk 'NR>1 && $4 ~ /:(8080|443|80)$/ {n++} END{print n+0}')
SSH_SESSIONS=$(who 2>/dev/null | grep -c 'pts/' || true)
LOAD1=$(cut -d' ' -f1 /proc/loadavg 2>/dev/null | cut -d'.' -f1 || echo 0)
BUSY_CONTAINERS=0
if command -v docker >/dev/null 2>&1; then
  BUSY_CONTAINERS=$(docker stats --no-stream --format '{{.CPUPerc}}' 2>/dev/null \
    | awk -F'%' '{gsub(/ /,"",$1); if ($1+0 > 5) n++} END{print n+0}')
fi
OPEN_SOCKETS=${OPEN_SOCKETS:-0}
SSH_SESSIONS=${SSH_SESSIONS:-0}
LOAD1=${LOAD1:-0}
BUSY_CONTAINERS=${BUSY_CONTAINERS:-0}
TOKEN_STATE=$([[ -n "$TOKEN" ]] && echo gesetzt || echo FEHLT)

if [[ "$PRINT_FACTS" == "1" ]]; then
  echo "OPEN_SOCKETS=${OPEN_SOCKETS} SSH=${SSH_SESSIONS} LOAD1=${LOAD1} BUSY_CONTAINERS=${BUSY_CONTAINERS} URL=${IDLE_URL} TOKEN=${TOKEN_STATE}"
  exit 0
fi

if ! command -v curl >/dev/null 2>&1; then
  log "[idle-check] $(ts)  SIGNAL=unavailable GRUND=curl-fehlt OPEN_SOCKETS=${OPEN_SOCKETS} SSH=${SSH_SESSIONS} LOAD1=${LOAD1} BUSY_CONTAINERS=${BUSY_CONTAINERS} VERDICT=unknown SHUTDOWN=no (fail-safe: kein Shutdown ohne Signal)"
  exit 0
fi

# --- Entscheidung der App holen ----------------------------------------------
# `format=text` liefert genau die Log-Zeile der App (echte Zahlen + Zeitstempel),
# `x-idle-verdict`/`x-idle-shutdown` sind maschinenlesbar. Der HTTP-Status wird
# EXPLIZIT geprüft: ein 308 (Caddy) oder 401 (Token) darf nie wieder still zu
# "0 Nutzer" werden.
THRESHOLD_SEC=$(awk "BEGIN{print ${IDLE_MINUTES}*60}")
QUERY="openSockets=${OPEN_SOCKETS}&sshSessions=${SSH_SESSIONS}&load1=${LOAD1}&busyContainers=${BUSY_CONTAINERS}&thresholdSec=${THRESHOLD_SEC}&format=text"
BODY_FILE=$(mktemp) || exit 1
HEADER_FILE=$(mktemp) || exit 1
trap 'rm -f "$BODY_FILE" "$HEADER_FILE"' EXIT

CURL_ARGS=(curl -sS --max-time 5 -o "$BODY_FILE" -D "$HEADER_FILE" -w '%{http_code}')
if [[ -n "$TOKEN" ]]; then
  CURL_ARGS+=(-H "x-scrape-token: ${TOKEN}")
fi
HTTP_CODE=$("${CURL_ARGS[@]}" "${IDLE_URL}?${QUERY}" 2>/dev/null) || HTTP_CODE=000

if [[ "$HTTP_CODE" != "200" ]]; then
  log "[idle-check] $(ts)  SIGNAL=unavailable HTTP=${HTTP_CODE} URL=${IDLE_URL} OPEN_SOCKETS=${OPEN_SOCKETS} SSH=${SSH_SESSIONS} LOAD1=${LOAD1} BUSY_CONTAINERS=${BUSY_CONTAINERS} TOKEN=${TOKEN_STATE} VERDICT=unknown SHUTDOWN=no (fail-safe: kein Shutdown ohne Signal. 308 = IDLE_CHECK_URL zeigt auf Caddy statt auf die App/Port 8080; 401 = Token fehlt in ${ENV_FILE})"
  exit 0
fi

# Die App liefert die komplette Log-Zeile (dieselbe Quelle wie die JSON-Antwort).
while IFS= read -r line; do
  [[ -n "$line" ]] && log "$line"
done < "$BODY_FILE"

header_value() {
  grep -i "^$1:" "$HEADER_FILE" 2>/dev/null | head -1 | tr -d '\r' | awk '{print tolower($2)}'
}
SHUTDOWN_STATE=$(header_value 'x-idle-shutdown')
VERDICT_STATE=$(header_value 'x-idle-verdict')
# Rückfall über den Textvertrag (eine Zeile, stabiles `field=value`), falls ein
# Proxy die Zusatz-Header schluckt: die Zeile ist der Vertrag, nicht die Header.
if [[ -z "$SHUTDOWN_STATE" ]]; then
  if grep -q 'SHUTDOWN=yes' "$BODY_FILE"; then SHUTDOWN_STATE=yes; else SHUTDOWN_STATE=no; fi
fi
if [[ -z "$VERDICT_STATE" ]]; then
  VERDICT_STATE=$(sed -n 's/.*VERDICT=\([a-z]*\).*/\1/p' "$BODY_FILE" | head -1)
fi

if [[ "$SHUTDOWN_STATE" == "yes" ]]; then
  if [[ "$DRY_RUN" == "1" ]]; then
    log "[idle-check] $(ts)  DRY-RUN: Shutdown unterdrueckt (VERDICT=${VERDICT_STATE:-unbekannt} SHUTDOWN=yes)"
    exit 0
  fi
  log "[idle-check] $(ts)  ** IDLE (${IDLE_MINUTES} min, VERDICT=${VERDICT_STATE:-unbekannt}) - shutting down **"
  shutdown -h now "audioMONASTRY: idle shutdown after ${IDLE_MINUTES} min ohne Nutzung"
fi
exit 0
