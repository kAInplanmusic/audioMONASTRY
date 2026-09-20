#!/usr/bin/env bash
# =============================================================================
# fleet-deploy-live.sh – aktuellen lokalen Stand + lokal gebautes Image auf
# einen laufenden Flotten-Knoten bringen (für Live-Beweise).
# -----------------------------------------------------------------------------
# Warum nicht deploy.sh? deploy.sh rsynct auch die .env und zieht weitere Images
# (master-player). Für einen Live-BEWEIS will ich nur:
#   1. Repo-Stand (ohne .env des Knotens anzufassen) per rsync,
#   2. das lokal gebaute App-Image per `docker save | gzip | ssh docker load`,
#   3. Container neu hochfahren (--no-build --remove-orphans),
#   4. optional eine Test-Overlay-Datei, die den App-Port nur an Loopback
#      veroeffentlicht (fuer den SSH-Tunnel des E2E; die App bleibt unveraendert).
#
# Aufruf:
#   bash scripts/hetzner/fleet-deploy-live.sh <ip> [--tunnel-port]
#   bash scripts/hetzner/fleet-deploy-live.sh --print-config     (Trockenlauf)
#
# INFRA-HETZNER-009 - Zielpfad:
#   Default ist der kanonische Pfad aus scripts/hetzner/fleet-names.sh
#   (FLEET_HOME=/opt/audiomonastry) - derselbe Pfad wie deploy.sh, der
#   Portal-Worker (Cloud-Init), auto-repair.sh und bring-up-fleet.sh. Eine
#   Bestands-Flotte liegt dagegen noch unter dem Altpfad (LEGACY_FLEET_HOME aus
#   fleet-names.sh); fuer sie MUSS DEPLOY_REMOTE_DIR gesetzt werden:
#       DEPLOY_REMOTE_DIR=$(bash -c '. scripts/hetzner/fleet-names.sh; fleet_legacy_home') \
#         bash scripts/hetzner/fleet-deploy-live.sh <ip>
#   Ohne diesen Wert wuerde der Deploy in ein leeres Verzeichnis schreiben und
#   einen ZWEITEN Stack starten (Kosten + zwei widersprechende Installationen).
#   Deshalb prueft das Skript vorher, aus welchem Verzeichnis der laufende
#   App-Container kommt, und bricht bei Abweichung ab (statt still fehlzudeployen).
#   Bewusster Neuaufbau neben dem laufenden Stack: DEPLOY_ALLOW_FOREIGN_DIR=1.
#
# F10 - Namespace-Paritaet:
#   Der Altname steht im Repo NUR in scripts/hetzner/fleet-names.sh (dort auch
#   der Altpfad und der Alt-Projektname). Dieses Skript fragt die Namen dort ab:
#   * Container des laufenden Stacks: beide Schreibweisen (fleet_name_variants),
#     sonst bliebe der Guard auf einer Bestands-Installation stumm;
#   * Compose-Projekt: COMPOSE_PROJECT_NAME aus fleet_compose_project - der
#     Projektname haengt damit nicht mehr am Verzeichnisnamen, und der Deploy
#     trifft immer dasselbe Projekt/dieselben Volumes (idempotent).
#   Umbenennung eines Bestands-Knotens (Altprojekt + Altpfad -> kanonisch):
#   scripts/hetzner/migrate-project-name.sh, Schritte in docs/HETZNER_DEPLOY.md.
# =============================================================================
set -euo pipefail

SSH_KEY="${DEPLOY_SSH_KEY:-$HOME/.ssh/id_ed25519}"
# F10: Namen/Pfade aus der EINEN Quelle (Servernamen, Container-Schreibweisen,
# Compose-Projekt, kanonischer + Alt-Pfad). Sourcing ist seiteneffektfrei.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/hetzner/fleet-names.sh
# shellcheck disable=SC1091
source "$SCRIPT_DIR/fleet-names.sh"

# Zielarchitektur-Pfad; der Altpfad der laufenden Flotte ist nur noch ein
# Erkennungswert fuer den Guard unten (Bestands-Kompatibilitaet).
REMOTE_DIR="${DEPLOY_REMOTE_DIR:-$FLEET_HOME}"
LEGACY_REMOTE_DIR="${DEPLOY_LEGACY_REMOTE_DIR:-$LEGACY_FLEET_HOME}"
COMPOSE_PROJECT="$(fleet_compose_project)"
ALLOW_FOREIGN_DIR="${DEPLOY_ALLOW_FOREIGN_DIR:-0}"
IMAGE="${DEPLOY_IMAGE:-audiomonastry:hetzner}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# Trockenlauf: 1 = nur Zielpfad/Guard zeigen, nichts uebertragen und nichts starten.
DRY_RUN="${DEPLOY_DRY_RUN:-0}"
# Test-Haken fuer den Guard: ersetzt die SSH-Abfrage des laufenden
# Verzeichnisses durch einen lokalen Befehl (z. B. 'echo $FLEET_HOME').
STACK_DIR_CMD="${DEPLOY_STACK_DIR_CMD:-}"

step() { echo; echo "=== $* ==="; }

# Container-Namen des laufenden Stacks: kanonisch UND Altname - auf einer noch
# nicht migrierten Installation heisst die App anders, und ein Guard, der nur den
# neuen Namen kennt, waere dort stumm (F10).
APP_CONTAINER_CANDIDATES=()
while read -r candidate; do
  [[ -n "$candidate" ]] && APP_CONTAINER_CANDIDATES+=("$candidate")
done < <(fleet_name_variants audiomonastry)

# Verzeichnis, aus dem der laufende App-Container gestartet wurde
# (Compose-Label) - leer, wenn kein Container laeuft (frischer Knoten).
stack_dir() {
  local ip="$1" container dir
  if [[ -n "$STACK_DIR_CMD" ]]; then
    bash -c "$STACK_DIR_CMD"
    return 0
  fi
  for container in "${APP_CONTAINER_CANDIDATES[@]}"; do
    # Erste nicht-leere Antwort gewinnt: so findet der Guard den laufenden Stack
    # auch dann, wenn die App dort noch unter dem Altnamen laeuft.
    dir="$(ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 "root@$ip" \
      "docker inspect -f '{{ index .Config.Labels \"com.docker.compose.project.working_dir\" }}' $container 2>/dev/null || true" \
      | tr -d '\r' | head -1)"
    if [[ -n "$dir" ]]; then printf '%s\n' "$dir"; return 0; fi
  done
  return 0
}

if [[ "${1:-}" == "--print-config" ]]; then
  echo "fleet-deploy-live.sh - effektive Konfiguration (kein SSH, kein rsync)"
  printf '  REMOTE_DIR=%s   (DEPLOY_REMOTE_DIR, kanonisch aus fleet-names.sh)\n' "$REMOTE_DIR"
  printf '  LEGACY_REMOTE_DIR=%s   (nur Guard-Erkennung, aus fleet-names.sh)\n' "$LEGACY_REMOTE_DIR"
  # F10: der effektive Compose-Projektname + die Container-Schreibweisen, unter
  # denen der laufende Stack gefunden wird (beide, neu zuerst).
  printf '  COMPOSE_PROJECT_NAME=%s   (aus scripts/hetzner/fleet-names.sh)\n' "$COMPOSE_PROJECT"
  printf '  APP_CONTAINER=%s\n' "${APP_CONTAINER_CANDIDATES[*]}"
  printf '  IMAGE=%s\n' "$IMAGE"
  printf '  DEPLOY_ALLOW_FOREIGN_DIR=%s\n' "$ALLOW_FOREIGN_DIR"
  printf '  DEPLOY_DRY_RUN=%s\n' "$DRY_RUN"
  exit 0
fi

IP="${1:?Knoten-IP angeben}"
TUNNEL="${2:-}"
SSH=(ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)

# --- Guard: trifft der Deploy den laufenden Stack? (INFRA-HETZNER-009) -------
RUNNING_DIR="$(stack_dir "$IP" || true)"
echo "Zielverzeichnis: $REMOTE_DIR | laufender App-Container aus: ${RUNNING_DIR:-<keiner>}"
# Zweiter Erkennungspfad fuer Bestands-Knoten: laeuft gerade kein Container, kann
# im Altpfad trotzdem eine Installation liegen (ausgeschalteter/gestoppter Stack).
# Dann ist ein Deploy in den Defaultpfad praktisch immer ein Fehldeploy.
LEGACY_INSTALL="0"
if [[ -z "$RUNNING_DIR" && "$REMOTE_DIR" != "$LEGACY_REMOTE_DIR" ]]; then
  if ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 "root@$IP" \
       "test -f $LEGACY_REMOTE_DIR/docker-compose.hetzner.yml" 2>/dev/null; then
    LEGACY_INSTALL="1"
    echo "Hinweis: im Altpfad $LEGACY_REMOTE_DIR liegt eine Installation (kein laufender Container)."
  fi
fi
if [[ "$LEGACY_INSTALL" == "1" && "$ALLOW_FOREIGN_DIR" != "1" ]]; then
  echo "❌ $LEGACY_REMOTE_DIR enthaelt den Bestands-Stack, Ziel ist aber $REMOTE_DIR." >&2
  echo "   Richtig deployen:   DEPLOY_REMOTE_DIR=$LEGACY_REMOTE_DIR bash $0 $IP" >&2
  echo "   Bewusst daneben:    DEPLOY_ALLOW_FOREIGN_DIR=1 bash $0 $IP" >&2
  exit 1
fi
if [[ -n "$RUNNING_DIR" && "$RUNNING_DIR" != "$REMOTE_DIR" ]]; then
  echo "❌ Zielverzeichnis weicht vom LAUFENDEN Stack ab - so wuerde ein zweiter Stack entstehen." >&2
  echo "   laufender Stack: $RUNNING_DIR" >&2
  echo "   Ziel dieses Aufrufs: $REMOTE_DIR" >&2
  if [[ "$ALLOW_FOREIGN_DIR" == "1" ]]; then
    echo "   DEPLOY_ALLOW_FOREIGN_DIR=1 gesetzt - fahre bewusst fort." >&2
  else
    echo "   Richtig deployen:  DEPLOY_REMOTE_DIR=$RUNNING_DIR bash $0 $IP" >&2
    echo "   Bewusst daneben:   DEPLOY_ALLOW_FOREIGN_DIR=1 bash $0 $IP" >&2
    exit 1
  fi
fi
if [[ "$DRY_RUN" == "1" ]]; then
  echo "Trockenlauf (DEPLOY_DRY_RUN=1): Ende vor rsync/Image-Transfer."
  exit 0
fi

step "1/4 Repo-Stand rsyncen (ohne .env, .git, node_modules, dist)"
rsync -az --delete -e "ssh -i $SSH_KEY -o StrictHostKeyChecking=accept-new" \
  --exclude node_modules --exclude dist --exclude .git --exclude coverage \
  --exclude test-results --exclude logs --exclude .env --exclude '.env.*' \
  --exclude public/data/orchestral --exclude public/music --exclude target \
  --exclude .venv-runpod --exclude .agents --exclude 'playwright-report' \
  "$REPO_ROOT/" "root@$IP:$REMOTE_DIR/"

step "2/4 Container-Definition des Knotens ansehen"
"${SSH[@]}" "root@$IP" "cd $REMOTE_DIR && grep -E '^  [a-z0-9-]+:' docker-compose.hetzner.yml | tr -d ' :' | tr '\n' ' '; echo"

if [[ -n "$TUNNEL" ]]; then
  step "2b/4 Test-Overlay: App-Port nur an 127.0.0.1:$TUNNEL"
  "${SSH[@]}" "root@$IP" "cat > $REMOTE_DIR/docker-compose.e2e-tunnel.yml <<'YAML'
# NUR fuer Live-Beweise: veroeffentlicht den App-Port am Loopback, damit der
# E2E-Test ueber einen SSH-Tunnel gegen den echten Knoten fahren kann.
# Die App selbst bleibt unveraendert; kein Port nach aussen (Firewall unberuehrt).
services:
  audiomonastry:
    ports:
      - \"127.0.0.1:${TUNNEL}:8080\"
YAML
echo overlay geschrieben"
fi

step "3/4 Image uebertragen ($IMAGE)"
docker save "$IMAGE" | gzip -1 | "${SSH[@]}" "root@$IP" "gunzip | docker load"

step "4/4 Container neu hochfahren (Compose-Projekt $COMPOSE_PROJECT)"
"${SSH[@]}" "root@$IP" "cd $REMOTE_DIR && COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT docker compose -f docker-compose.hetzner.yml ${TUNNEL:+-f docker-compose.e2e-tunnel.yml} up -d --no-build --remove-orphans caddy audiomonastry && sleep 6 && COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT docker compose -f docker-compose.hetzner.yml ps --format '{{.Service}}: {{.State}}' && curl -s -o /dev/null -w 'health am Knoten: %{http_code}\n' http://127.0.0.1:8080/api/health"

echo
echo "FERTIG. Naechster Schritt: SSH-Tunnel + E2E (siehe docs/OPS_RUNBOOK.md, Live-Beweise)."
