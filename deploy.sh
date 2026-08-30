#!/usr/bin/env bash
# ============================================================================
# deploy.sh – sampleMONK high-end deploy auf Hetzner (Google/Firebase-frei)
# ----------------------------------------------------------------------------
# Zwei Modi:
#   docker (Default, schnell):  Image wird LOKAL gebaut, per `docker save |
#                               ssh docker load` übertragen und remote nur noch
#                               gestartet (kein zweiter Remote-Build, kein
#                               npm ci auf dem VPS). Fallback: Remote-Build.
#   node:                       rsync + `scripts/hetzner/start-prod.sh` remote.
#
# Ablauf (docker):
#   1. Docker-Images lokal bauen (samplemonk + master-player)
#   2. Remote-Rollback-Image sichern (samplemonk:hetzner-rollback)
#   3. Images via `docker save | ssh docker load` übertragen
#   4. Config (Caddyfile, Compose, .env, Services) per rsync übertragen
#   5. Remote: docker compose up -d --no-build
#   6. Health-Wait + Smoke-Test + Rollback-Hinweis
#
# Voraussetzungen:
#   - Ausfuehrbar machen:  chmod +x deploy.sh
#   - Ziel definieren via env (alternativ in .env.deploy):
#        DEPLOY_HOST=1.2.3.4                 (oder root@1.2.3.4)
#        DEPLOY_DOMAIN=samplemonk.example    (Pflicht für iOS-Mikrofon/HTTPS)
#        DEPLOY_SSH_KEY=/pfad/zum/key
#        DEPLOY_MODE=docker|node             (Voreinstellung: docker)
#        DEPLOY_REMOTE_BUILD=1               (1 = Remote-Build statt Image-Transfer)
#        DEPLOY_SYNC_ENV=1|0                 (1 = lokale .env hochladen)
#        DEPLOY_SMOKE=1|0                    (1 = Smoke-Test nach Deploy)
#        DEPLOY_REMOTE_DIR=/opt/samplemonk
#        DEPLOY_PLATFORM=linux/amd64         (optional, Cross-Build via buildx)
#
#   - Auf der Ziel-Instanz muss Docker (Compose v2) installiert sein:
#        scripts/hetzner/provision.py erledigt das automatisch per Cloud-Init.
# ============================================================================
set -euo pipefail

# --- Konfiguration (aus env, sonst Prompt) ---
DEPLOY_HOST="${DEPLOY_HOST:-}"
DEPLOY_USER="${DEPLOY_USER:-root}"
DEPLOY_SSH_KEY="${DEPLOY_SSH_KEY:-}"
DEPLOY_MODE="${DEPLOY_MODE:-docker}"
DEPLOY_REMOTE_BUILD="${DEPLOY_REMOTE_BUILD:-0}"
DEPLOY_REMOTE_DIR="${DEPLOY_REMOTE_DIR:-/opt/samplemonk}"
DEPLOY_DOMAIN="${DEPLOY_DOMAIN:-}"
DEPLOY_SYNC_ENV="${DEPLOY_SYNC_ENV:-1}"
DEPLOY_SMOKE="${DEPLOY_SMOKE:-1}"
DEPLOY_PLATFORM="${DEPLOY_PLATFORM:-}"
IMAGE_APP="samplemonk:hetzner"
IMAGE_MASTER="samplemonk-master-player:hetzner"
COMPOSE_FILE="docker-compose.hetzner.yml"

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

docker_build() {
  local dockerfile="$1" tag="$2" context="$3"
  if [[ -n "$DEPLOY_PLATFORM" ]] && docker buildx version >/dev/null 2>&1; then
    docker buildx build --platform "$DEPLOY_PLATFORM" -t "$tag" -f "$dockerfile" "$context" --load
  else
    docker build -t "$tag" -f "$dockerfile" "$context"
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
RSYNC_EXCLUDES=(
  --exclude '.git' --exclude 'node_modules' --exclude 'dist' --exclude 'coverage'
  --exclude 'test-results' --exclude 'deepcode' --exclude '.continue'
  --exclude '.env' --exclude '.env.deploy'
  --exclude 'public/models' --exclude 'public/music'
)
if command -v rsync >/dev/null 2>&1; then
  rsync -az "${RSYNC_EXCLUDES[@]}" -e "${SSH[*]}" \
    ./ "$SSH_TARGET:$DEPLOY_REMOTE_DIR/"
else
  echo "rsync fehlt? Nutze scp-Fallback ..."
  "${SSH[@]}" "$SSH_TARGET" "rm -rf $DEPLOY_REMOTE_DIR"
  scp "${SCP_OPTS[@]}" -r \
    ./src ./public ./assets ./server ./services ./scripts ./database ./docs \
    ./package.json ./package-lock.json ./Dockerfile.hetzner \
    ./docker-compose.hetzner.yml ./docker-compose.sfu.yml \
    ./docker-compose.monitoring.yml ./docker-compose.fleet-test.yml \
    ./Caddyfile ./index.html \
    ./vite.config.ts ./tsconfig.json ./build-worklets.mjs ./vitest.config.ts \
    ./.dockerignore ./.env.hetzner.example \
    "$SSH_TARGET:$DEPLOY_REMOTE_DIR/"
fi

# --- .env auf den Server bringen ---
if [[ "$DEPLOY_SYNC_ENV" == "1" && -f ./.env ]]; then
  echo "--- lokale .env wird als Remote-.env hochgeladen ---"
  scp "${SCP_OPTS[@]}" ./.env "$SSH_TARGET:$DEPLOY_REMOTE_DIR/.env"
else
  echo "--- keine lokale .env zum Sync gefunden; nutze .env.hetzner.example ---"
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
    echo "--- docker compose up -d --no-build --force-recreate sample-monk master-player ---"
    "${SSH[@]}" "$SSH_TARGET" "cd $DEPLOY_REMOTE_DIR && \
       docker compose -f $COMPOSE_FILE up -d --no-build --force-recreate sample-monk master-player && \
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
echo "   Logs:      ssh $SSH_TARGET 'docker compose -f $DEPLOY_REMOTE_DIR/$COMPOSE_FILE logs -f sample-monk'"
echo "   Rollback:  ssh $SSH_TARGET 'docker tag ${IMAGE_APP}-rollback $IMAGE_APP && cd $DEPLOY_REMOTE_DIR && docker compose -f $COMPOSE_FILE up -d --no-build --force-recreate sample-monk'"
echo "   Optional Auto-Shutdown: ssh $SSH_TARGET 'sudo bash $DEPLOY_REMOTE_DIR/scripts/hetzner/install-idle-shutdown.sh'"
