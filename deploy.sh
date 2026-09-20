#!/usr/bin/env bash
# ============================================================================
# deploy.sh – audioMONASTRY high-end deploy auf Hetzner (Google/Firebase-frei)
# ----------------------------------------------------------------------------
# Zwei Modi:
#   docker (Default, schnell):  Image wird LOKAL gebaut, per `docker save |
#                               ssh docker load` übertragen und remote nur noch
#                               gestartet (kein zweiter Remote-Build, kein
#                               npm ci auf dem VPS). Fallback: Remote-Build.
#   node:                       rsync + `scripts/hetzner/start-prod.sh` remote.
#
# Ablauf (docker):
#   1. Docker-Images lokal bauen (audiomonastry + master-player)
#   2. Remote-Rollback-Image sichern (audiomonastry:hetzner-rollback)
#   3. Images via `docker save | ssh docker load` übertragen
#   4. Config (Compose, Services, .env) per rsync übertragen
#   5. Remote: docker compose up -d --no-build
#   6. Health-Wait + Smoke-Test + Rollback-Hinweis
#
# Voraussetzungen:
#   - Ausfuehrbar machen:  chmod +x deploy.sh
#   - Ziel definieren via env (alternativ in .env.deploy):
#        DEPLOY_HOST=1.2.3.4                 (oder root@1.2.3.4)
#        DEPLOY_DOMAIN=audiomonastry.example    (Pflicht für iOS-Mikrofon/HTTPS)
#        DEPLOY_SSH_KEY=/pfad/zum/key
#        DEPLOY_MODE=docker|node             (Voreinstellung: docker)
#        DEPLOY_REMOTE_BUILD=1               (1 = Remote-Build statt Image-Transfer)
#        DEPLOY_SYNC_ENV=1|0                 (1 = lokale .env hochladen, Default 0)
#        DEPLOY_SMOKE=1|0                    (1 = Smoke-Test nach Deploy)
#        DEPLOY_REMOTE_DIR=/opt/audiomonastry
#        DEPLOY_PLATFORM=linux/amd64         (optional, Cross-Build via buildx)
#        DEPLOY_PRINT_CONFIG=1               (nur Konfiguration ausgeben, dann Ende)
#
#   - Auf der Ziel-Instanz muss Docker (Compose v2) installiert sein:
#        scripts/hetzner/provision.py erledigt das automatisch per Cloud-Init.
#
# INFRA-HETZNER-001 - warum DEPLOY_SYNC_ENV per Default 0 ist:
#   Die .env auf einem Flotten-Knoten gehoert dem Portal-Worker und ist
#   ROLLEN-SKOPIERT (services/portal-worker/src/index.js, envFile(): pro Rolle
#   nur die noetigen Schluessel, TRUST_PROXY=1 z. B. ausschliesslich fuer die
#   Rolle app). Die lokale Repo-.env enthaelt dagegen ALLES (Supabase, R2,
#   Replicate, Studio-Token ...). Ein Sync hebt damit die Rollentrennung auf und
#   ersetzt Produktionswerte durch Entwicklerwerte - und zwar bei JEDEM
#   Flottenstart. Wer bewusst synchronisieren will (frischer Knoten ohne Portal),
#   setzt DEPLOY_SYNC_ENV=1: dann wird die vorhandene Remote-.env vorher nach
#   .env.bak-predeploy gesichert und das Skript sagt laut, was es ueberschreibt.
#
# INFRA-HETZNER-002 - warum 'Caddyfile' NICHT per rsync uebertragen wird:
#   app-1 faehrt Origin-TLS: der Portal-Worker kopiert beim Flottenstart
#   scripts/hetzner/Caddyfile.origin nach /opt/audiomonastry/Caddyfile und legt
#   die Zertifikate unter certs/ ab (index.js, Cloud-Init-Rolle app). Das
#   Repo-Caddyfile nutzt dagegen automatisches ACME - ein rsync wuerde die
#   Origin-TLS-Variante nach jedem Deploy wieder ueberschreiben. Die Datei ist
#   deshalb ausgeschlossen; nur ein bewusster Wechsel auf ACME laedt sie hoch
#   (DEPLOY_INSTALL_CADDYFILE=1).
# ============================================================================
set -euo pipefail

# --- Konfiguration (aus env, sonst Prompt) ---
DEPLOY_HOST="${DEPLOY_HOST:-}"
DEPLOY_USER="${DEPLOY_USER:-root}"
DEPLOY_SSH_KEY="${DEPLOY_SSH_KEY:-}"
DEPLOY_MODE="${DEPLOY_MODE:-docker}"
DEPLOY_REMOTE_BUILD="${DEPLOY_REMOTE_BUILD:-0}"
DEPLOY_REMOTE_DIR="${DEPLOY_REMOTE_DIR:-/opt/audiomonastry}"
DEPLOY_DOMAIN="${DEPLOY_DOMAIN:-}"
# INFRA-HETZNER-001: Default 0 - die Knoten-.env gehoert dem Portal-Worker
# (rollen-skopiert, siehe Kopfkommentar). Sync nur explizit per DEPLOY_SYNC_ENV=1.
DEPLOY_SYNC_ENV="${DEPLOY_SYNC_ENV:-0}"
DEPLOY_SMOKE="${DEPLOY_SMOKE:-1}"
DEPLOY_PLATFORM="${DEPLOY_PLATFORM:-}"
# INFRA-HETZNER-002: 1 = Repo-Caddyfile (ACME) bewusst auf den Knoten laden und
# damit die Origin-TLS-Variante des Portal-Workers ersetzen.
DEPLOY_INSTALL_CADDYFILE="${DEPLOY_INSTALL_CADDYFILE:-0}"
IMAGE_APP="audiomonastry:hetzner"
IMAGE_MASTER="audiomonastry-master-player:hetzner"
COMPOSE_FILE="docker-compose.hetzner.yml"

# Trockenlauf fuer Nachweise (INFRA-HETZNER-001/002): gibt die effektive
# Konfiguration aus und endet VOR Build/SSH - die Default-Aufloesung ist damit
# ohne Ziel-Instanz pruefbar (und ohne versehentlichen Deploy).
if [[ "${DEPLOY_PRINT_CONFIG:-0}" == "1" ]]; then
  echo "deploy.sh - effektive Konfiguration (kein Build, kein SSH)"
  printf '  DEPLOY_HOST=%s\n' "${DEPLOY_HOST:-<leer>}"
  printf '  DEPLOY_MODE=%s\n' "$DEPLOY_MODE"
  printf '  DEPLOY_REMOTE_DIR=%s\n' "$DEPLOY_REMOTE_DIR"
  printf '  DEPLOY_SYNC_ENV=%s\n' "$DEPLOY_SYNC_ENV"
  printf '  DEPLOY_INSTALL_CADDYFILE=%s\n' "$DEPLOY_INSTALL_CADDYFILE"
  printf '  DEPLOY_REMOTE_BUILD=%s\n' "$DEPLOY_REMOTE_BUILD"
  printf '  DEPLOY_SMOKE=%s\n' "$DEPLOY_SMOKE"
  printf '  DEPLOY_DOMAIN=%s\n' "${DEPLOY_DOMAIN:-<leer>}"
  exit 0
fi

if [[ -z "$DEPLOY_HOST" ]]; then
  echo -n "Ziel-Host (IP oder Domain, ohne user@): "
  read -r DEPLOY_HOST
fi
if [[ -z "$DEPLOY_SSH_KEY" ]]; then
  DEPLOY_SSH_KEY="$HOME/.ssh/id_ed25519"
fi
if [[ ! -f "$DEPLOY_SSH_KEY" ]]; then
  echo "SSH-Key nicht gefunden: $DEPLOY_SSH_KEY"
  echo -n "Pfad zum SSH-Key: "
  read -r DEPLOY_SSH_KEY
fi

# DEPLOY_HOST kann "1.2.3.4" oder "root@1.2.3.4" sein
if [[ "$DEPLOY_HOST" == *"@"* ]]; then
  SSH_TARGET="$DEPLOY_HOST"
else
  SSH_TARGET="$DEPLOY_USER@$DEPLOY_HOST"
fi

SSH=(ssh -i "$DEPLOY_SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)
SCP_OPTS=(-i "$DEPLOY_SSH_KEY" -o StrictHostKeyChecking=accept-new)

# PROD-P0-003: App-Version aus package.json als Build-Arg mitgeben, damit
# /api/health die laufende Version nennt (Deploy-/Rollback-Nachweis).
# DEPLOY_VERSION ueberschreibt sie bewusst (z. B. fuer einen Rollback-Drill auf
# einen aelteren Stand) - ohne die package.json anzufassen.
APP_VERSION="${DEPLOY_VERSION:-$(node -p "require('./package.json').version" 2>/dev/null || echo dev)}"

docker_build() {
  local dockerfile="$1" tag="$2" context="$3"
  if [[ -n "$DEPLOY_PLATFORM" ]] && docker buildx version >/dev/null 2>&1; then
    docker buildx build --platform "$DEPLOY_PLATFORM" -t "$tag" -f "$dockerfile" "$context" --build-arg "BUILD_VERSION=$APP_VERSION" --load
  else
    docker build -t "$tag" -f "$dockerfile" "$context" --build-arg "BUILD_VERSION=$APP_VERSION"
  fi
}

wait_health() {
  local base_url="$1" attempts="${2:-30}" delay="${3:-4}"
  if ! command -v curl >/dev/null 2>&1; then
    echo "⚠️  curl fehlt lokal – Health-Wait übersprungen."
    return 0
  fi
  echo "--- Warte auf $base_url/api/health (max. $(( attempts * delay ))s) ---"
  for _ in $(seq 1 "$attempts"); do
    if curl -fsS "$base_url/api/health" >/dev/null 2>&1; then
      echo "✅ Health-Check OK: $base_url/api/health"
      return 0
    fi
    sleep "$delay"
  done
  echo "❌ Health-Check fehlgeschlagen: $base_url/api/health" >&2
  return 1
}

echo "=== [1/5] Images lokal bauen ==="
if [[ "$DEPLOY_MODE" == "docker" && "$DEPLOY_REMOTE_BUILD" != "1" ]]; then
  if ! command -v docker >/dev/null 2>&1; then
    echo "docker lokal nicht gefunden -> Fallback auf Remote-Build."
    DEPLOY_REMOTE_BUILD=1
  else
    docker_build Dockerfile.hetzner "$IMAGE_APP" .
    docker_build services/master-player/Dockerfile "$IMAGE_MASTER" services/master-player
  fi
else
  echo "Überspringe lokalen Build (Remote-Build oder node-Modus)."
fi

echo "=== [2/5] Remote-Verzeichnis vorbereiten ($SSH_TARGET:$DEPLOY_REMOTE_DIR) ==="
"${SSH[@]}" "$SSH_TARGET" "mkdir -p $DEPLOY_REMOTE_DIR"

echo "=== [3/5] Config + Build-Kontext hochladen (rsync) ==="
# INFRA-HETZNER-002: 'Caddyfile' steht bewusst NICHT in der Liste - die Datei auf
# app-1 ist die Origin-TLS-Variante des Portal-Workers (Caddyfile.origin) und darf
# von einem Deploy nicht auf die ACME-Variante zurueckgedreht werden. Ein bewusster
# Wechsel laeuft ueber DEPLOY_INSTALL_CADDYFILE=1 (siehe unten).
RSYNC_EXCLUDES=(
  --exclude '.git' --exclude 'node_modules' --exclude 'dist' --exclude 'coverage'
  --exclude 'test-results' --exclude 'deepcode' --exclude '.continue'
  --exclude '.env' --exclude '.env.deploy'
  --exclude 'Caddyfile'
  --exclude 'public/models' --exclude 'public/music'
  --exclude 'public/data/orchestral' --exclude 'services/audio-runtime/target'
  --exclude 'target' --exclude '.venv-runpod' --exclude '.agents' --exclude 'logs'
)
if command -v rsync >/dev/null 2>&1; then
  rsync -az "${RSYNC_EXCLUDES[@]}" -e "${SSH[*]}" \
    ./ "$SSH_TARGET:$DEPLOY_REMOTE_DIR/"
else
  echo "rsync fehlt? Nutze scp-Fallback ..."
  "${SSH[@]}" "$SSH_TARGET" "rm -rf $DEPLOY_REMOTE_DIR"
  # Auch hier OHNE ./Caddyfile (gleicher Grund wie im rsync-Ausschluss oben).
  scp "${SCP_OPTS[@]}" -r \
    ./src ./public ./assets ./server ./services ./scripts ./database ./docs \
    ./package.json ./package-lock.json ./Dockerfile.hetzner \
    ./docker-compose.hetzner.yml ./docker-compose.sfu.yml \
    ./docker-compose.monitoring.yml ./docker-compose.fleet-test.yml \
    ./index.html \
    ./vite.config.ts ./tsconfig.json ./build-worklets.mjs ./vitest.config.ts \
    ./.dockerignore ./.env.hetzner.example \
    "$SSH_TARGET:$DEPLOY_REMOTE_DIR/"
fi

# --- Caddyfile auf dem Knoten (INFRA-HETZNER-002) ---
if [[ "$DEPLOY_INSTALL_CADDYFILE" == "1" ]]; then
  echo "⚠️  DEPLOY_INSTALL_CADDYFILE=1: Repo-Caddyfile (ACME) ersetzt die Origin-TLS-Variante auf $SSH_TARGET"
  scp "${SCP_OPTS[@]}" ./Caddyfile "$SSH_TARGET:$DEPLOY_REMOTE_DIR/Caddyfile"
elif ! "${SSH[@]}" "$SSH_TARGET" "test -f $DEPLOY_REMOTE_DIR/Caddyfile"; then
  # Kein stiller Fehlpfad: ohne Caddyfile startet der Caddy-Container in eine
  # Restart-Schleife. Nur pruefen (nichts schreiben) und laut melden - die
  # Installation gehoert dem Portal-Worker (Origin-TLS) bzw. dem Repo-Clone.
  echo "❌ $SSH_TARGET:$DEPLOY_REMOTE_DIR enthaelt kein Caddyfile (Caddy wuerde neu starten und scheitern)." >&2
  echo "   Origin-TLS (Regelfall app-1):  ssh $SSH_TARGET 'cp $DEPLOY_REMOTE_DIR/scripts/hetzner/Caddyfile.origin $DEPLOY_REMOTE_DIR/Caddyfile'" >&2
  echo "   ACME-Variante bewusst:         DEPLOY_INSTALL_CADDYFILE=1 bash $0" >&2
fi

# --- .env auf den Server bringen (INFRA-HETZNER-001) ---
# Default ist 0 (siehe Kopfkommentar): die Knoten-.env ist rollen-skopiert und
# gehoert dem Portal-Worker. Ein Sync muss deshalb bewusst angefordert werden.
if [[ "$DEPLOY_SYNC_ENV" == "1" && -f ./.env ]]; then
  echo "⚠️  DEPLOY_SYNC_ENV=1: die lokale .env ERSETZT die rollen-skopierte .env auf $SSH_TARGET"
  echo "    Betroffen: $DEPLOY_REMOTE_DIR/.env (Rollen-Secrets wie TRUST_PROXY/STUDIO_ACCESS_TOKEN inklusive)"
  # Vorher sichern: der Sync darf die Rollenkonfiguration nicht ohne Wiederweg
  # verwerfen (`.env.bak-predeploy` bleibt auf dem Knoten liegen).
  "${SSH[@]}" "$SSH_TARGET" "cd $DEPLOY_REMOTE_DIR && if [ -f .env ]; then cp .env .env.bak-predeploy && echo '   Remote-.env gesichert: $DEPLOY_REMOTE_DIR/.env.bak-predeploy'; fi"
  scp "${SCP_OPTS[@]}" ./.env "$SSH_TARGET:$DEPLOY_REMOTE_DIR/.env"
else
  if [[ "$DEPLOY_SYNC_ENV" == "1" ]]; then
    echo "⚠️  DEPLOY_SYNC_ENV=1 gesetzt, aber ./.env fehlt lokal - es wird nichts synchronisiert."
  else
    echo "--- .env-Sync aus (DEPLOY_SYNC_ENV=0): die Knoten-.env bleibt unangetastet ---"
  fi
  # Nur ein KALTSTART-Fallback: `cp -n` ueberschreibt eine vorhandene .env NICHT.
  "${SSH[@]}" "$SSH_TARGET" "cd $DEPLOY_REMOTE_DIR && cp -n .env.hetzner.example .env 2>/dev/null || true"
fi

# --- DOMAIN in Remote-.env setzen/leeren ---
if [[ -n "$DEPLOY_DOMAIN" ]]; then
  echo "--- DOMAIN=$DEPLOY_DOMAIN in Remote-.env setzen ---"
  "${SSH[@]}" "$SSH_TARGET" "cd $DEPLOY_REMOTE_DIR && \
    (grep -q '^DOMAIN=' .env && sed -i 's|^DOMAIN=.*|DOMAIN=${DEPLOY_DOMAIN}|' .env) || \
    echo 'DOMAIN=${DEPLOY_DOMAIN}' >> .env"
else
  echo "--- kein DEPLOY_DOMAIN gesetzt; DOMAIN wird leer gelassen (nur http/IP-Test) ---"
  "${SSH[@]}" "$SSH_TARGET" "cd $DEPLOY_REMOTE_DIR && \
    (grep -q '^DOMAIN=' .env && sed -i 's|^DOMAIN=.*|DOMAIN=|' .env) || true"
fi

if [[ "$DEPLOY_MODE" == "docker" ]]; then
  echo "=== [4/5] Remote starten (Modus: docker) ==="
  if [[ "$DEPLOY_REMOTE_BUILD" != "1" ]]; then
    echo "--- Rollback-Image sichern (remote) ---"
    "${SSH[@]}" "$SSH_TARGET" "docker image tag $IMAGE_APP ${IMAGE_APP}-rollback 2>/dev/null || true"
    echo "--- Images via docker save | ssh docker load übertragen ---"
    docker save "$IMAGE_APP" "$IMAGE_MASTER" | "${SSH[@]}" "$SSH_TARGET" "docker load"
    echo "--- docker compose up -d --no-build --force-recreate audiomonastry master-player ---"
    "${SSH[@]}" "$SSH_TARGET" "cd $DEPLOY_REMOTE_DIR && \
       docker compose -f $COMPOSE_FILE up -d --no-build --force-recreate audiomonastry master-player && \
       docker compose -f $COMPOSE_FILE up -d caddy"
  else
    echo "--- Remote-Build (docker compose up -d --build) ---"
    "${SSH[@]}" "$SSH_TARGET" "cd $DEPLOY_REMOTE_DIR && \
       docker compose -f $COMPOSE_FILE up -d --build"
  fi
else
  echo "=== [4/5] Remote starten (Modus: node) ==="
  "${SSH[@]}" "$SSH_TARGET" "cd $DEPLOY_REMOTE_DIR && \
     bash scripts/hetzner/start-prod.sh"
fi

if [[ -n "$DEPLOY_DOMAIN" ]]; then
  BASE_URL="https://$DEPLOY_DOMAIN"
else
  BASE_URL="http://${DEPLOY_HOST#*@}"
fi

echo "=== [5/5] Health-Check + Smoke-Test ==="
wait_health "$BASE_URL" || true

if [[ "$DEPLOY_SMOKE" == "1" ]] && command -v curl >/dev/null 2>&1; then
  echo "--- Smoke-Test (Basispfade) ---"
  for path in /api/health /api/cloud/health /api/master/health; do
    echo "==> GET $BASE_URL$path"
    curl -fsS "$BASE_URL$path" || echo "⚠️  $path nicht erreichbar"
    echo
  done
fi

echo ""
echo "✅ Deployment abgeschlossen: $BASE_URL"
echo ""
echo "   Logs:      ssh $SSH_TARGET 'docker compose -f $DEPLOY_REMOTE_DIR/$COMPOSE_FILE logs -f audiomonastry'"
echo "   Rollback:  ssh $SSH_TARGET 'docker tag ${IMAGE_APP}-rollback $IMAGE_APP && cd $DEPLOY_REMOTE_DIR && docker compose -f $COMPOSE_FILE up -d --no-build --force-recreate audiomonastry'"
echo "   Optional Auto-Shutdown: ssh $SSH_TARGET 'sudo bash $DEPLOY_REMOTE_DIR/scripts/hetzner/install-idle-shutdown.sh'"
