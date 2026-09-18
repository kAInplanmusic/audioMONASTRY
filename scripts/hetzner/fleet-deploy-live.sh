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
# =============================================================================
set -euo pipefail

IP="${1:?Knoten-IP angeben}"
TUNNEL="${2:-}"
SSH_KEY="${DEPLOY_SSH_KEY:-$HOME/.ssh/id_ed25519}"
REMOTE_DIR="${DEPLOY_REMOTE_DIR:-/opt/samplemonk}"
IMAGE="${DEPLOY_IMAGE:-audiomonastry:hetzner}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

step() { echo; echo "=== $* ==="; }
SSH=(ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)

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

step "4/4 Container neu hochfahren"
"${SSH[@]}" "root@$IP" "cd $REMOTE_DIR && docker compose -f docker-compose.hetzner.yml ${TUNNEL:+-f docker-compose.e2e-tunnel.yml} up -d --no-build --remove-orphans caddy audiomonastry && sleep 6 && docker compose -f docker-compose.hetzner.yml ps --format '{{.Service}}: {{.State}}' && curl -s -o /dev/null -w 'health am Knoten: %{http_code}\n' http://127.0.0.1:8080/api/health"

echo
echo "FERTIG. Naechster Schritt: SSH-Tunnel + E2E (siehe docs/OPS_RUNBOOK.md, Live-Beweise)."
