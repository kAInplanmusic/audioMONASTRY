#!/usr/bin/env bash
# =============================================================================
# fleet-deploy-live.sh – aktuellen lokalen Stand + lokal gebautes Image auf
# einen laufenden Flotten-Knoten bringen (für Live-Beweise).
# -----------------------------------------------------------------------------
# Warum nicht deploy.sh? deploy.sh rsynct auch die .env und zieht weitere Images
# (master-player). Für einen Live-BEWEIS will ich nur:
#   1. Repo-Stand (ohne .env des Knotens anzufassen) per rsync,
#   2. das App-Image auf den Knoten bringen - entweder per
#      `docker save | gzip | ssh docker load` oder (PERF-P1-004) per
#      DEPLOY_REMOTE_BUILD=1 als rsync-Delta + Build auf dem Knoten,
#   3. Container neu hochfahren,
#   4. optional eine Test-Overlay-Datei, die den App-Port nur an Loopback
#      veroeffentlicht (fuer den SSH-Tunnel des E2E; die App bleibt unveraendert).
#
# Beide Image-Wege sichern VORHER das Rollback-Tag (<image>-rollback) und nehmen
# das Medien-Overlay mit, wenn auf dem Knoten Inhalte liegen - sonst maskieren
# leere Bind-Mounts die Pfade des Images (Library leer, /models 404).
#
# PROD-P2-REG (2026-09-21): dritter Image-Weg `DEPLOY_IMAGE_SOURCE=registry`.
#   Der Knoten ZIEHT dann (`docker pull` + `docker tag` auf den lokalen Namen aus
#   docker-compose.hetzner.yml) - KEIN `docker save`. Grund (gemessen): die
#   Leitung Betreiber -> Knoten macht ~1 MB/s hoch, das App-Image ist 1,43 GB ->
#   25-40 min je Knoten. Einmal mit scripts/hetzner/registry-push.sh nach GHCR
#   schieben, danach zieht jeder Knoten im Rechenzentrums-Tempo. Der Default
#   bleibt `local` (Transfer) - nichts schwenkt still um.
#   Referenz: DEPLOY_REGISTRY_IMAGE=<ghcr-ref> (sonst Owner aus dem git-Remote +
#   `git rev-parse --short HEAD`); Zugangsdaten aus REGISTRY_ENV_FILE (Default
#   <repo>/.env, 'none' = nur Umgebung), der WERT nie in Ausgabe oder Argument.
#
# Aufruf:
#   bash scripts/hetzner/fleet-deploy-live.sh <ip> [--tunnel-port]
#   bash scripts/hetzner/fleet-deploy-live.sh --print-config     (Trockenlauf)
#   bash scripts/hetzner/fleet-deploy-live.sh --help
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
# PROD-P2-REG: Registry-Weg (Referenz-Bildung, Tag, Zugangsdaten, Login + Pull +
# Tag auf dem Knoten) aus derselben Bibliothek wie deploy.sh und registry-push.sh.
# shellcheck source=scripts/hetzner/lib/registry.sh
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/registry.sh"

# Zielarchitektur-Pfad; der Altpfad der laufenden Flotte ist nur noch ein
# Erkennungswert fuer den Guard unten (Bestands-Kompatibilitaet).
REMOTE_DIR="${DEPLOY_REMOTE_DIR:-$FLEET_HOME}"
LEGACY_REMOTE_DIR="${DEPLOY_LEGACY_REMOTE_DIR:-$LEGACY_FLEET_HOME}"
COMPOSE_PROJECT="$(fleet_compose_project)"
ALLOW_FOREIGN_DIR="${DEPLOY_ALLOW_FOREIGN_DIR:-0}"
IMAGE="${DEPLOY_IMAGE:-audiomonastry:hetzner}"
# PERF-P1-004 (2026-09-21): 1 = Image auf dem Knoten BAUEN statt es hochzuschieben.
# Grund (gemessen): die Leitung Host -> Knoten macht ~1 MB/s hoch, das App-Image
# ist 338 MB Tar -> ~6 min je Knoten, und zstd/gzip holen nichts heraus (die
# Layer sind schon gepackt). Der rsync-Delta derselben Aenderung ist wenige MB.
# Voraussetzung: der Knoten hat genug RAM fuer den Build (>=8 GB gemessen
# unkritisch; auf 3,8-GB-Knoten laeuft die App waehrend des Builds weiter, dort
# ist der Image-Transfer der sicherere Weg).
REMOTE_BUILD="${DEPLOY_REMOTE_BUILD:-0}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# PROD-P2-REG: Image-Quelle. `local` (Default) = heutiges Verhalten (Transfer
# bzw. Remote-Build). `registry` = der Knoten ZIEHT die Images - kein docker save;
# die Leitung ist der Engpass (~1 MB/s hoch, App-Image 1,43 GB -> 25-40 min je
# Knoten, gemessen 2026-09-21). Referenz + Zugangsdaten kommen aus der
# gemeinsamen Bibliothek scripts/hetzner/lib/registry.sh.
IMAGE_SOURCE="${DEPLOY_IMAGE_SOURCE:-local}"
case "$IMAGE_SOURCE" in
  local | registry) ;;
  *)
    echo "❌ DEPLOY_IMAGE_SOURCE=$IMAGE_SOURCE ist unbekannt (erlaubt: local, registry)." >&2
    exit 1
    ;;
esac
REGISTRY_ENV_FILE="${REGISTRY_ENV_FILE:-$REPO_ROOT/.env}"
REGISTRY_IMAGE="${DEPLOY_REGISTRY_IMAGE:-}"
if [[ "$IMAGE_SOURCE" == "registry" && -z "$REGISTRY_IMAGE" ]]; then
  # Default-Referenz aus git-Remote-Owner + Repo-Stand: derselbe Tag, den
  # registry-push.sh gepusht hat (eine Bibliothek, kein zweiter Tag-Begriff).
  REGISTRY_OWNER_EFFECTIVE="$(registry_owner "$REPO_ROOT")"
  if [[ -z "$REGISTRY_OWNER_EFFECTIVE" ]]; then
    echo "❌ DEPLOY_IMAGE_SOURCE=registry, aber keine Registry-Referenz ermittelbar" >&2
    echo "   (kein git-Remote 'origin'); bitte DEPLOY_REGISTRY_IMAGE=<ghcr-ref> setzen." >&2
    exit 1
  fi
  REGISTRY_IMAGE="$(registry_image "$REGISTRY_OWNER_EFFECTIVE" "$(registry_app_name)" "$(registry_default_tag "$REPO_ROOT")")"
fi
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

# --help darf NICHTS uebertragen: ohne diesen Zweig landete "--help" als IP im
# Guard/rsync (gemessen 2026-09-21: rsync brach mit "Invalid remote host:
# hostnames may not start with '-'" ab - der Aufruf hatte den Deploy schon
# begonnen). Gleiche Form wie bring-up-/provision-fleet.sh.
if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<'USAGE'
fleet-deploy-live.sh - einen Flotten-Knoten auf den lokalen Stand bringen

Aufruf:
  bash scripts/hetzner/fleet-deploy-live.sh <ip> [--tunnel-port]
  bash scripts/hetzner/fleet-deploy-live.sh --print-config    (nur Konfiguration)
  bash scripts/hetzner/fleet-deploy-live.sh --help

Schalter (Umgebung):
  DEPLOY_REMOTE_BUILD=1        Image auf dem Knoten BAUEN statt hochschieben
                               (die Leitung ist der Engpass: gemessen ~1 MB/s
                               hoch, App-Image 338 MB Tar -> ~6 min je Knoten)
  DEPLOY_IMAGE_SOURCE=registry der Knoten ZIEHT das Image (docker pull + docker
                               tag, KEIN Image-Transfer). Vorher einmal pushen:
                               bash scripts/hetzner/registry-push.sh
  DEPLOY_REGISTRY_IMAGE=<ref>  Referenz fuer den Registry-Weg
                               (Default: ghcr.io/<owner>/audiomonastry:<kurzhash>)
  REGISTRY_ENV_FILE=<pfad>     Quelle der GHCR-Zugangsdaten (Default <repo>/.env,
                               'none' = nur die Umgebung); Werte nie in der Ausgabe
  DEPLOY_REMOTE_DIR=<pfad>     Zielpfad (Default: kanonischer Pfad aus
                               scripts/hetzner/fleet-names.sh)
  DEPLOY_ALLOW_FOREIGN_DIR=1   bewusst neben einem laufenden Stack deployen
  DEPLOY_DRY_RUN=1             Guard anzeigen, dann vor rsync/Transfer abbrechen
  DEPLOY_DRY_RUN=2             Sync als Trockenlauf gegen den Knoten
                               (--dry-run --itemize-changes, zeigt den
                               Loeschplan von --delete) und danach Ende
  DEPLOY_SSH_KEY=<pfad>        SSH-Schluessel (Default ~/.ssh/id_ed25519)

Rollback am Knoten (das Tag setzt dieses Skript vor jedem Deploy):
  docker tag <image>-rollback <image> && docker compose ... up -d --no-build
USAGE
  exit 0
fi

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
  printf '  DEPLOY_DRY_RUN=%s   (0 = scharf, 1 = Guard und Ende, 2 = Sync-Trockenlauf)\n' "$DRY_RUN"
  printf '  DEPLOY_REMOTE_BUILD=%s   (1 = Build auf dem Knoten statt Image-Transfer)\n' "$REMOTE_BUILD"
  # PROD-P2-REG: Image-Quelle + die Referenz, die der Knoten ziehen wuerde -
  # ohne SSH, ohne Docker, ohne Secret (nur ein Boolean).
  printf '  DEPLOY_IMAGE_SOURCE=%s   (local = Transfer/Build, registry = Knoten zieht)\n' "$IMAGE_SOURCE"
  printf '  DEPLOY_REGISTRY_IMAGE=%s\n' "${REGISTRY_IMAGE:-<leer>}"
  printf '  REGISTRY_ENV_FILE=%s (%s)\n' "$REGISTRY_ENV_FILE" "$([[ -f "$REGISTRY_ENV_FILE" ]] && echo vorhanden || echo fehlt)"
  printf '  GHCR-Zugangsdaten=%s (Wert wird nie ausgegeben, Login nur per --password-stdin)\n' \
    "$(registry_credentials_state "$REPO_ROOT" "$REGISTRY_ENV_FILE")"
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
# ACHTUNG --delete: was hier nicht ausgeschlossen ist und auf dem Knoten liegt,
# wird GELOESCHT. Am Knoten app-1 gemessen (2026-09-21) - genau diese drei Pfade
# existieren NUR dort und sind nicht reproduzierbar:
#   media/   3,3 GB Overlay-Inhalt (orchestral/models/music, deliver-media.sh).
#            Ohne den Ausschluss raeumt der Sync ihn weg, MEDIA_OVERLAY bleibt
#            aus (leere Mounts maskieren die Image-Pfade: Library/Instrumente
#            leer, /models/htdemucs.onnx 404) und die 3,3 GB muessten ueber die
#            langsame Leitung neu geliefert werden.
#   certs/   origin.crt|key (0600) - das Origin-Zertifikat von Cloudflare, das
#            deploy.sh per Pipe setzt. Weg = kein TLS mehr fuer origin.<domain>.
#   Caddyfile  Knoten-Variante mit Origin-TLS. deploy.sh schuetzt sie aus
#            demselben Grund (dort als --exclude 'Caddyfile').
# public/models ist wie orchestral/music ein Overlay-Baum (291 MB) und liegt auf
# dem Knoten unter media/ - ohne Ausschluss wandert er bei jedem Lauf mit.
# DEPLOY_DRY_RUN=2 (PERF-P1-004): den ECHTEN Sync als Trockenlauf gegen den
# Knoten fahren (--dry-run --itemize-changes) und danach aufhoeren. Weil rsync
# mit --delete spiegelt, ist das die einzige Art, den Loeschplan VORHER zu
# lesen - die Ausschluesse unten sind die Logik, die man dabei prueft.
RSYNC_DRY=()
if [[ "$DRY_RUN" == "2" ]]; then
  RSYNC_DRY=(--dry-run --itemize-changes)
fi
rsync -az --delete "${RSYNC_DRY[@]}" -e "ssh -i $SSH_KEY -o StrictHostKeyChecking=accept-new" \
  --exclude node_modules --exclude dist --exclude .git --exclude coverage \
  --exclude test-results --exclude logs --exclude .env --exclude '.env.*' \
  --exclude __pycache__ \
  --exclude media --exclude certs --exclude Caddyfile --exclude runtime \
  --exclude public/data/orchestral --exclude public/models --exclude public/music \
  --exclude target --exclude '.venv*' --exclude .worktrees --exclude .agents \
  --exclude 'playwright-report' \
  "$REPO_ROOT/" "root@$IP:$REMOTE_DIR/"

if [[ "$DRY_RUN" == "2" ]]; then
  echo
  echo "Trockenlauf (DEPLOY_DRY_RUN=2): nur der Sync-Plan. Kein Image, kein Container,"
  echo "kein Tunnel-Overlay - der Knoten wurde nicht angefasst."
  exit 0
fi

step "2/4 Container-Definition des Knotens ansehen"
"${SSH[@]}" "root@$IP" "cd $REMOTE_DIR && grep -E '^  [a-z0-9-]+:' docker-compose.hetzner.yml | tr -d ' :' | tr '\n' ' '; echo"

if [[ -n "$TUNNEL" ]]; then
  # Hinweis: docker-compose.e2e-tunnel.yml ist bewusst NICHT vom rsync
# ausgeschlossen - sie ist ein Artefakt dieses Skripts und soll zwischen zwei
# Laeufen verschwinden (der naechste Lauf mit --tunnel-port legt sie neu an).
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

# Medien-Overlay (docker-compose.media.yml) nur mitnehmen, wenn auf dem Knoten
# wirklich Inhalte liegen: sonst maskieren leere Bind-Mounts die Pfade des Images
# (Library/Instrumente leer, /models/htdemucs.onnx 404). Gleiche Regel wie deploy.sh.
MEDIA_OVERLAY=""
if "${SSH[@]}" "root@$IP" "test -f $REMOTE_DIR/docker-compose.media.yml && [ -n \"\$(ls -A $REMOTE_DIR/media 2>/dev/null)\" ]"; then
  MEDIA_OVERLAY=" -f docker-compose.media.yml"
  echo "--- Medien-Overlay aktiv ($REMOTE_DIR/media gefunden) ---"
fi

# SFU-Overlay (INFRA-HETZNER-015). Nur auf dem SFU-Knoten noetig - dort aber
# zwingend: docker-compose.sfu.yml veroeffentlicht die Medienports 40000-40099
# (UDP und TCP) und docker-compose.turn.yml bringt coturn. Ohne die Overlays
# startet der Knoten zwar und meldet gesund, aber ohne veroeffentlichte
# Medienports - der Echtpfadtest scheitert dann mit "rtp-stats bytes=0
# packets=0", waehrend die ganze Signalisierung sauber durchlaeuft. Genau dieser
# Zustand wurde am 2026-09-24 gemessen.
# Erkannt wird am ZUSTAND, nicht an einem Schalter: laeuft im Container
# ENABLE_SFU=1, ist es ein SFU-Knoten. Ein Schalter, den man vergessen kann,
# waere genau die Fehlerklasse, die hier schon mehrfach Zeit gekostet hat.
SFU_OVERLAY=""
if "${SSH[@]}" "root@$IP" "docker exec audiomonastry printenv ENABLE_SFU 2>/dev/null | grep -q '^1$'"; then
  if "${SSH[@]}" "root@$IP" "test -f $REMOTE_DIR/docker-compose.sfu.yml"; then
    SFU_OVERLAY=" -f docker-compose.sfu.yml -f docker-compose.turn.yml"
    echo "--- SFU-Overlay aktiv (ENABLE_SFU=1 auf dem Knoten) ---"
  else
    echo "--- WARNUNG: ENABLE_SFU=1, aber docker-compose.sfu.yml fehlt auf dem Knoten ---"
  fi
fi

OVERLAYS="-f docker-compose.hetzner.yml$MEDIA_OVERLAY$SFU_OVERLAY${TUNNEL:+ -f docker-compose.e2e-tunnel.yml}"

if [[ "$REMOTE_BUILD" == "1" ]]; then
  step "3/4 Build auf dem Knoten (kein Image-Transfer)"
  # PERF-P1-004: Rueckweg, bevor der Build das Image ersetzt. Der Tag kostet
  # keinen Speicher (dieselben Layer) und macht den Rollback ohne Netzzugriff
  # moeglich; auf einem frischen Knoten existiert noch kein Image -> || true.
  echo "--- Rollback-Image sichern (remote) ---"
  "${SSH[@]}" "root@$IP" "docker image tag $IMAGE ${IMAGE}-rollback 2>/dev/null || true"
  # Stempel: der Knoten baut den per rsync uebertragenen Stand, also muessen
  # Version/Commit/Zeit von HIER kommen - sonst stuende "unknown" in /api/health
  # und die Commit-Paritaet waere fuer den Knoten nicht pruefbar
  # (docker-compose.hetzner.yml liest die Werte als Build-Args).
  STAMP_VERSION="$(node -p "require('$REPO_ROOT/package.json').version" 2>/dev/null || echo dev)"
  STAMP_COMMIT="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  STAMP_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "--- Stempel: version=$STAMP_VERSION commit=$STAMP_COMMIT built=$STAMP_TIME ---"
  "${SSH[@]}" "root@$IP" "cd $REMOTE_DIR && \
     AUDIOMONASTRY_VERSION='$STAMP_VERSION' AUDIOMONASTRY_COMMIT='$STAMP_COMMIT' AUDIOMONASTRY_BUILD_TIME='$STAMP_TIME' \
     COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT docker compose $OVERLAYS up -d --build --remove-orphans caddy audiomonastry"
else
  if [[ "$IMAGE_SOURCE" == "registry" ]]; then
    # PROD-P2-REG: der Knoten ZIEHT. Kein `docker save` - genau der Transfer ist
    # der Engpass (~1 MB/s hoch, App-Image 1,43 GB). Rollback-Tag, Login und
    # `docker tag` auf den lokalen Namen laufen in registry_pull_images.
    step "3/4 Image ziehen (Quelle: registry, kein docker save)"
    echo "    Referenz: $REGISTRY_IMAGE  ->  $IMAGE"
    if ! registry_pull_images "$SSH_KEY" "root@$IP" "$REPO_ROOT" "$REGISTRY_ENV_FILE" "$IMAGE" "$REGISTRY_IMAGE"; then
      echo "❌ Registry-Weg fehlgeschlagen (Login/Pull/Tag auf $IP) - der laufende Container bleibt unangetastet." >&2
      echo "   Das Rollback-Tag ${IMAGE}-rollback ist gesetzt; Referenz/Tag pruefen" >&2
      echo "   (gepusht? bash scripts/hetzner/registry-push.sh) oder lokal deployen." >&2
      exit 1
    fi
    step "4/4 Container neu hochfahren (Compose-Projekt $COMPOSE_PROJECT)"
    "${SSH[@]}" "root@$IP" "cd $REMOTE_DIR && COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT docker compose $OVERLAYS up -d --no-build --remove-orphans caddy audiomonastry"
  else
    step "3/4 Image uebertragen ($IMAGE)"
    echo "--- Rollback-Image sichern (remote) ---"
    "${SSH[@]}" "root@$IP" "docker image tag $IMAGE ${IMAGE}-rollback 2>/dev/null || true"
    docker save "$IMAGE" | gzip -1 | "${SSH[@]}" "root@$IP" "gunzip | docker load"

    step "4/4 Container neu hochfahren (Compose-Projekt $COMPOSE_PROJECT)"
    "${SSH[@]}" "root@$IP" "cd $REMOTE_DIR && COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT docker compose $OVERLAYS up -d --no-build --remove-orphans caddy audiomonastry"
  fi
fi

step "Health + Container-Status am Knoten"
"${SSH[@]}" "root@$IP" "cd $REMOTE_DIR && COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT docker compose $OVERLAYS ps --format '{{.Service}}: {{.State}}' && sleep 2 && curl -s http://127.0.0.1:8080/api/health; echo"

echo
echo "FERTIG. Naechster Schritt: SSH-Tunnel + E2E (siehe docs/OPS_RUNBOOK.md, Live-Beweise)."
echo
echo "Rollback am Knoten:"
echo "  ssh root@$IP 'docker tag $IMAGE ${IMAGE}-rollback && cd $REMOTE_DIR && COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT docker compose $OVERLAYS up -d --no-build --force-recreate audiomonastry'"
