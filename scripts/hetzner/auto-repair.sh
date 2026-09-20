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

LOG="${LOG:-/var/log/audiomonastry-auto-repair.log}"
APP_CONTAINER="${APP_CONTAINER:-audiomonastry}"
CADDY_CONTAINER="${CADDY_CONTAINER:-audiomonastry-caddy}"
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
  cat <<CONFIG
[auto-repair] Trockenlauf - es wird nichts ausgefuehrt.
  Log:                       $LOG
  App-Container:             $APP_CONTAINER
  Caddy-Container:           $CADDY_CONTAINER
  App-Health (Host):         $APP_HEALTH_URL
  App-Health (Container):    $APP_HEALTH_URL_IN_CONTAINER
  App-Health Weg:            docker inspect (Healthcheck) -> docker exec -> Host-curl
  Caddy-Health (Port 80):    $CADDY_HEALTH_URL
  App-Verzeichnis:           $APP_DIR
  Compose:                   docker compose ${COMPOSE_ARGS[*]}
  Versuche je Probe:         $CHECKS
  Reparatur App:             cd $APP_DIR && docker compose ${COMPOSE_ARGS[*]} up -d --force-recreate $APP_CONTAINER
  Reparatur Caddy:           cd $APP_DIR && docker compose ${COMPOSE_ARGS[*]} up -d --force-recreate $CADDY_CONTAINER
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
  ( cd "$APP_DIR" && docker compose "${COMPOSE_ARGS[@]}" up -d --force-recreate "$1" ) >/dev/null 2>&1 || true
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
if container_running "$CADDY_CONTAINER"; then
  if caddy_health; then
    CADDY_STATE="ok"
  else
    log "Caddy antwortet nicht auf $CADDY_HEALTH_URL -> $CADDY_CONTAINER neu erstellen"
    compose_recreate "$CADDY_CONTAINER"
    CADDY_STATE="repariert"
  fi
fi

log "Check abgeschlossen (unhealthy=${UNHEALTHY:-keine} app=$APP_STATE caddy=$CADDY_STATE)"
