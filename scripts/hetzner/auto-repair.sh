#!/usr/bin/env bash
# =============================================================================
# audioMONASTRY auto-repair – Watchdog für Container- und App-Gesundheit
# -----------------------------------------------------------------------------
# Läuft per systemd-Timer alle 2 Minuten auf den Flotten-Knoten:
#   1. Ungesunde Docker-Container neu starten (restart)
#   2. App prüfen  -> bei 3x krank: Container `audiomonastry` neu erstellen
#   3. Caddy prüfen -> bei totem Proxy: Container `audiomonastry-caddy` neu erstellen
#   4. Alles in /var/log/audiomonastry-auto-repair.log protokollieren
#
# INFRA-HETZNER-005: Die Vorfassung fragte `http://127.0.0.1/api/health` ab - das
# ist Port 80 und damit CADDY, nicht die App. Starb Caddy, meldete der Watchdog die
# App als krank und reparierte die falsche Seite (Fehldiagnose per Konstruktion).
# Jetzt sind es zwei getrennte Proben mit getrennten Reparaturen:
#
#   * App:   `docker inspect`-Health des Containers `audiomonastry` (dessen
#            Healthcheck fragt genau /api/health). WARUM nicht einfach
#            `curl http://127.0.0.1:8080/api/health` vom Host: der App-Container
#            veroeffentlicht 8080 NICHT auf den Host (`expose`, siehe
#            docker-compose.hetzner.yml) - ein Host-curl auf 127.0.0.1:8080
#            könnte gar nicht antworten und wäre selbst eine Fehldiagnose.
#            Fallback (Image ohne Healthcheck bzw. node-Modus aus start-prod.sh,
#            der auf dem Host lauscht): `docker exec` im Container, dann Host-curl.
#   * Caddy: `curl http://127.0.0.1:80/` - Port 80 gehört Caddy und ist der
#            einzige oeffentliche Port des app-Knotens. JEDE HTTP-Antwort zählt
#            als lebendig (auch 404/502: die App dahinter kann krank sein, das
#            ist die ANDERE Diagnose) - nur ein Verbindungsfehler ist "Caddy tot".
#
# Installation: sudo bash scripts/hetzner/install-auto-repair.sh
#   (bring-up-fleet.sh installiert ihn beim Flottenstart auf allen Knoten)
# Trockenlauf:  bash scripts/hetzner/auto-repair.sh --print-config
# =============================================================================
set -uo pipefail

# F10 · Namespace-Paritaet:
#   Namen kommen aus der EINEN Quelle scripts/hetzner/fleet-names.sh (dort
#   stehen Compose-Projekt und Pfade). Der Projektname wird explizit gesetzt
#   und die tatsaechlichen Container ueber fleet_name_variants aufgeloest
#   (seit der Bestands-Ausmusterung die kanonische Schreibweise).
HERE_SRC="$(cd "$(dirname "$0")" && pwd)"
# Die Namensquelle wird NEBEN dem Skript erwartet (so laeuft es im Repo) - der
# Installer kopiert den Watchdog aber nach /usr/local/bin, und dort lag
# `fleet-names.sh` am 2026-09-20 NICHT: der Timer schrieb bei jedem Lauf
# "No such file or directory" + "FLEET_COMPOSE_PROJECT: unbound variable" und
# reparierte stillschweigend nichts. Deshalb jetzt zwei Orte: Seite an Seite
# (Repo/Installer) und der Repo-Pfad auf dem Knoten (ueber FLEET_NAMES_SOURCE
# umstellbar, damit Tests ihn setzen koennen). Faellt beides weg, endet der Lauf
# mit Klartext statt mit einer stummen Nicht-Reparatur.
FLEET_NAMES_SOURCE="${FLEET_NAMES_SOURCE:-/opt/audiomonastry/scripts/hetzner/fleet-names.sh}"
NAMES_FOUND=""
for candidate in "$HERE_SRC/fleet-names.sh" "$FLEET_NAMES_SOURCE"; do
  if [[ -f "$candidate" ]]; then
    # shellcheck source=scripts/hetzner/fleet-names.sh
    # shellcheck disable=SC1091
    source "$candidate"
    NAMES_FOUND="$candidate"
    break
  fi
done
if [[ -z "$NAMES_FOUND" || -z "${FLEET_COMPOSE_PROJECT:-}" ]]; then
  echo "❌ Namensquelle fleet-names.sh nicht gefunden (gesucht: $HERE_SRC/fleet-names.sh, $FLEET_NAMES_SOURCE)" >&2
  exit 3
fi

LOG="${LOG:-/var/log/audiomonastry-auto-repair.log}"
# Kanonische Namen (Rolle app = Projektname, Caddy = Projektname-caddy); die
# Aufloesung auf den LAUFENDEN Namen passiert unten ueber fleet_name_variants.
APP_CONTAINER="${APP_CONTAINER:-$FLEET_COMPOSE_PROJECT}"
CADDY_CONTAINER="${CADDY_CONTAINER:-$FLEET_COMPOSE_PROJECT-caddy}"
# Compose-Projekt explizit: sonst haengt es am Verzeichnisnamen (APP_DIR) und
# eine Reparatur koennte ein ZWEITES Projekt erzeugen statt den Stack zu heilen.
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-$FLEET_COMPOSE_PROJECT}"
# App-Health aus dem Host-Netz (nur im node-Modus erreichbar) bzw. im Container.
APP_HEALTH_URL="${APP_HEALTH_URL:-http://127.0.0.1:8080/api/health}"
APP_HEALTH_URL_IN_CONTAINER="${APP_HEALTH_URL_IN_CONTAINER:-http://localhost:8080/api/health}"
CADDY_HEALTH_URL="${CADDY_HEALTH_URL:-http://127.0.0.1:80/}"
APP_DIR="${APP_DIR:-/opt/audiomonastry}"
# Compose-Dateien des Knotens; auf app-1/edge-1 identisch (nur die Basis).
COMPOSE_FILES="${COMPOSE_FILES:--f docker-compose.hetzner.yml}"
CHECKS="${CHECKS:-3}"

ts() { date -u +%FT%TZ; }

log() { echo "[auto-repair] $(ts) $*" >> "$LOG"; }

# Compose-Dateien einmal in ein Array zerlegen (kein unquoted Expandieren).
read -r -a COMPOSE_ARGS <<< "$COMPOSE_FILES"

print_config() {
  local app_names caddy_names
  app_names="$(fleet_name_variants "$APP_CONTAINER" | tr '\n' ' ')"
  caddy_names="$(fleet_name_variants "$CADDY_CONTAINER" | tr '\n' ' ')"
  cat <<CONFIG
[auto-repair] Trockenlauf - es wird nichts ausgefuehrt.
  Log:                       $LOG
  App-Container:             $APP_CONTAINER
  App-Container akzeptiert:  $app_names(neu zuerst, Aufloesung zur Laufzeit)
  Caddy-Container:           $CADDY_CONTAINER
  Caddy-Container akzeptiert: $caddy_names
  Compose-Projekt:           $COMPOSE_PROJECT_NAME  (COMPOSE_PROJECT_NAME)
  App-Health (Host):         $APP_HEALTH_URL
  App-Health (Container):    $APP_HEALTH_URL_IN_CONTAINER
  App-Health Weg:            docker inspect (Healthcheck) -> docker exec -> Host-curl
  Caddy-Health (Port 80):    $CADDY_HEALTH_URL
  App-Verzeichnis:           $APP_DIR
  Compose:                   docker compose ${COMPOSE_ARGS[*]}
  Versuche je Probe:         $CHECKS
  Reparatur App:             cd $APP_DIR && COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT_NAME docker compose ${COMPOSE_ARGS[*]} up -d --force-recreate $APP_CONTAINER
  Reparatur Caddy:           cd $APP_DIR && COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT_NAME docker compose ${COMPOSE_ARGS[*]} up -d --force-recreate $CADDY_CONTAINER
CONFIG
}

if [[ "${1:-}" == "--print-config" || "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  print_config
  exit 0
fi

if ! command -v docker >/dev/null 2>&1; then
  log "docker fehlt – überspringe"
  exit 0
fi

container_running() {
  docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$1"
}

# F10: Erster LAUFENDER Container aus den akzeptierten Schreibweisen (neu
# zuerst, Quelle fleet-names.sh). Findet der Watchdog keinen, kommt der
# kanonische Name zurueck - der Aufrufpfad meldet dann "nicht-vorhanden", statt
# still nichts zu tun.
resolve_container() {
  local canonical="$1" candidate
  while read -r candidate; do
    if container_running "$candidate"; then printf '%s\n' "$candidate"; return 0; fi
  done < <(fleet_name_variants "$canonical")
  printf '%s\n' "$canonical"
}

# healthy | unhealthy | starting | none (kein Healthcheck) | missing
container_health() {
  docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$1" 2>/dev/null || echo missing
}

# 0 = App gesund, 1 = App krank/nicht erreichbar.
app_health() {
  case "$(container_health "$APP_CONTAINER")" in
    healthy) return 0 ;;
    # Erster Start/Neustart: der Health-Timer laeuft noch - nicht eingreifen.
    starting) return 0 ;;
  esac
  for _ in $(seq 1 "$CHECKS"); do
    # Genau die Probe des Compose-Healthchecks (Node ist im Image vorhanden).
    if docker exec "$APP_CONTAINER" node -e \
      "fetch('$APP_HEALTH_URL_IN_CONTAINER').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" \
      >/dev/null 2>&1; then
      return 0
    fi
    # node-Modus (start-prod.sh): die App lauscht direkt auf dem Host.
    if curl -fsS --max-time 5 "$APP_HEALTH_URL" >/dev/null 2>&1; then
      return 0
    fi
    sleep 5
  done
  return 1
}

# 0 = Caddy antwortet (irgendein HTTP-Status), 1 = Caddy tot.
caddy_health() {
  local code
  code="$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' "$CADDY_HEALTH_URL" 2>/dev/null)" || return 1
  [[ -n "$code" && "$code" != "000" ]]
}

compose_recreate() {
  ( cd "$APP_DIR" && COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT_NAME" docker compose "${COMPOSE_ARGS[@]}" up -d --force-recreate "$1" ) >/dev/null 2>&1 || true
}

# --- 1) Ungesunde Container neu starten ---
UNHEALTHY=$(docker ps --filter "health=unhealthy" --format '{{.Names}}' 2>/dev/null || true)
if [[ -n "$UNHEALTHY" ]]; then
  for c in $UNHEALTHY; do
    log "Container ungesund: $c -> restart"
    docker restart "$c" >/dev/null 2>&1 || true
  done
fi

# --- 2) App prüfen (nur wenn die App auf diesem Knoten läuft) ---
APP_STATE="nicht-vorhanden"
# F10: den TATSAECHLICH laufenden Namen aufloesen (Quelle fleet-names.sh).
APP_CONTAINER="$(resolve_container "$APP_CONTAINER")"
if container_running "$APP_CONTAINER"; then
  if app_health; then
    APP_STATE="ok"
  else
    log "App-Health ${CHECKS}x fehlgeschlagen ($APP_CONTAINER) -> neu erstellen"
    compose_recreate "$APP_CONTAINER"
    APP_STATE="repariert"
  fi
fi

# --- 3) Caddy prüfen (eigene Diagnose: toter Proxy != kranke App) ---
CADDY_STATE="nicht-vorhanden"
CADDY_CONTAINER="$(resolve_container "$CADDY_CONTAINER")"
if container_running "$CADDY_CONTAINER"; then
  if caddy_health; then
    CADDY_STATE="ok"
  else
    log "Caddy antwortet nicht auf $CADDY_HEALTH_URL -> $CADDY_CONTAINER neu erstellen"
    compose_recreate "$CADDY_CONTAINER"
    CADDY_STATE="repariert"
  fi
fi

# --- 4) Idle-Shutdown wirklich installiert? (INFRA-HETZNER-025) --------------
# GEMESSEN 2026-10-17: nach dem Flotten-Rebuild fehlte auf app-1 die Unit
# audiomonastry-idle-shutdown.timer KOMPLETT, und auf allen vier Knoten standen
# die Schwellen in der Knoten-.env auskommentiert - der Auto-Stop waere still nie
# angelaufen (50 EUR Betreiber-Kosten). Der Watchdog alarmiert das jetzt bei jedem
# Lauf im Log; er INSTALLIERT nichts (das macht bring-up-fleet.sh / der Installer),
# damit ein fehlender Token keinen Reparatur-Loop alle 2 Minuten erzeugt.
IDLE_STATE="uebersprungen"
IDLE_PRUEFUNG="${APP_DIR}/scripts/hetzner/check-idle-shutdown.sh"
# Dieselben Ziele, die der Check per Default liest - hier einmal definiert, damit
# ein Override (Tests, anderer Pfad) fuer Alarm UND Token-Pruefung gilt.
IDLE_TOKEN_ENV_FILE="${IDLE_TOKEN_ENV_FILE:-/etc/audiomonastry/idle-check.env}"
IDLE_APP_ENV_FILE="${APP_ENV_FILE:-${APP_DIR}/.env}"
if [[ -f "$IDLE_PRUEFUNG" ]]; then
  if IDLE_BEFUND="$(APP_ENV_FILE="$IDLE_APP_ENV_FILE" TOKEN_ENV_FILE="$IDLE_TOKEN_ENV_FILE" bash "$IDLE_PRUEFUNG" 2>&1)"; then
    IDLE_STATE="ok"
  else
    IDLE_STATE="ALARM"
    log "[ALARM] Idle-Shutdown ist auf diesem Knoten NICHT wirksam - der Knoten schaltet sich NICHT ab (Kosten laufen weiter):"
    while IFS= read -r zeile; do
      if [[ -n "$zeile" ]]; then
        log "  ${zeile}"
      fi
    done <<< "$IDLE_BEFUND"
  fi
else
  # Kein stiller Fehlschlag, aber auch kein falscher Alarm: ein alter Repo-Stand
  # hat das Pruefskript noch nicht - das ist ein Befund eigener Art.
  IDLE_STATE="pruefung-fehlt"
  log "[warn] Idle-Shutdown-Pruefung nicht verfuegbar ($IDLE_PRUEFUNG fehlt) - Repo-Stand aktualisieren, sonst keine Aussage ueber den Auto-Stop."
fi

# --- 5) Idle-Token plausibel gegen den App-Container? (026) ------------------
# Der Timer kann nur ausloesen, wenn der Token im idle-check.env DERSELBE ist, den
# die App kennt. Am 2026-10-17 stand in sfu-1s idle-check.env ein halbiertes
# Kommando-Fragment ('... | cut -c1-64'): Header ungueltig, 401, SIGNAL=unavailable,
# nie ein Shutdown - fail-safe, aber unwirksam. Geprueft wird NUR (kein Schreiben):
# ein Watchdog, der Zugangsdaten rotiert, waere selbst ein Risiko.
IDLE_TOKEN_STATE="uebersprungen"

read_env_val() {  # $1 = Name, $2 = Env-Datei
  local file="$2" value=""
  [[ -f "$file" ]] || return 0
  value=$(grep -E "^[[:space:]]*(export[[:space:]]+)?$1=" "$file" 2>/dev/null | head -1 | cut -d= -f2- || true)
  value=$(printf '%s' "$value" | tr -d '"'"'"'\r' | sed 's/[[:space:]]*#.*$//' | tr -d '[:space:]')
  printf '%s' "$value"
}

token_ok() { [[ "${1:-}" =~ ^[A-Za-z0-9+/=_-]{32,}$ ]]; }

# Strukturell kaputt (das live gemessene Fragment) - NICHT dasselbe wie "kurz":
# ein alter, kurzer Token kann funktionieren, ein Shell-Ausdruck nie.
token_fragment() {
  local wert="${1:-}"
  [[ "$wert" == *'$'* || "$wert" == *'('* || "$wert" == *')'* || "$wert" == *'|'* \
     || "$wert" == *'`'* || "$wert" == *';'* || "$wert" == *'&'* \
     || "$wert" == *'<'* || "$wert" == *'>'* ]]
}

if container_running "$APP_CONTAINER"; then
  CT_TOKEN="$(docker exec "$APP_CONTAINER" printenv SCRAPE_TOKEN 2>/dev/null || true)"
  [[ -n "$CT_TOKEN" ]] || CT_TOKEN="$(docker exec "$APP_CONTAINER" printenv STUDIO_ACCESS_TOKEN 2>/dev/null || true)"
  FILE_TOKEN="$(read_env_val SCRAPE_TOKEN "$IDLE_TOKEN_ENV_FILE")"
  [[ -n "$FILE_TOKEN" ]] || FILE_TOKEN="$(read_env_val STUDIO_ACCESS_TOKEN "$IDLE_TOKEN_ENV_FILE")"
  if [[ -z "$CT_TOKEN" ]]; then
    IDLE_TOKEN_STATE="unbekannt"
    log "[warn] Idle-Token: App-Container meldet weder SCRAPE_TOKEN noch STUDIO_ACCESS_TOKEN - Plausibilitaet nicht pruefbar."
  elif token_fragment "$CT_TOKEN"; then
    IDLE_TOKEN_STATE="ALARM"
    log "[ALARM] Idle-Token im App-Container ist ein KOMMANDO-FRAGMENT (kein Wert) - der Idle-Check bekommt 401 und loest NIE aus. Remediation: install-idle-shutdown.sh auf dem Knoten ausfuehren (ersetzt Fragmente)."
  elif [[ -z "$FILE_TOKEN" ]]; then
    IDLE_TOKEN_STATE="ALARM"
    log "[ALARM] ${IDLE_TOKEN_ENV_FILE} hat keinen lesbaren Token - der Idle-Check laeuft ohne Auth (fail-safe, aber blind). Remediation: install-idle-shutdown.sh."
  elif token_fragment "$FILE_TOKEN"; then
    IDLE_TOKEN_STATE="ALARM"
    log "[ALARM] Idle-Token in ${IDLE_TOKEN_ENV_FILE} ist ein KOMMANDO-FRAGMENT (kein Wert) - der Check bekommt 401 und loest NIE aus. Remediation: install-idle-shutdown.sh."
  elif [[ "$FILE_TOKEN" != "$CT_TOKEN" ]]; then
    IDLE_TOKEN_STATE="ALARM"
    log "[ALARM] Idle-Token weicht vom Token des App-Containers ab - der Idle-Check bekommt 401 und loest NIE aus. Remediation: App-Container neu erstellen (docker compose up -d --force-recreate $APP_CONTAINER) oder install-idle-shutdown.sh erneut ausfuehren."
  else
    IDLE_TOKEN_STATE="ok"
    if ! token_ok "$CT_TOKEN"; then
      # Kurz, aber syntaktisch ein Wert: schwaecher als die 32-Zeichen-Zusage,
      # aber kein Grund fuer einen Fehlalarm (der Vergleich stimmt).
      log "[warn] Idle-Token ist kuerzer als 32 Zeichen - funktioniert, ist aber schwaecher als die Zusage; bei Gelegenheit erneuern (install-idle-shutdown.sh)."
    fi
  fi
fi

log "Check abgeschlossen (unhealthy=${UNHEALTHY:-keine} app=$APP_STATE caddy=$CADDY_STATE idle=$IDLE_STATE idle-token=$IDLE_TOKEN_STATE app-container=$APP_CONTAINER caddy-container=$CADDY_CONTAINER projekt=$COMPOSE_PROJECT_NAME)"

