#!/usr/bin/env bash
# =============================================================================
# start-prod.sh  –  sampleMONK direkt auf einem Hetzner VPS starten
# =============================================================================
# Vorteil: ganzer Stack (App + REST API + WebRTC-Signaling) laeuft in EINEM
# Node-Prozess auf EINEM Port. Ideal fuer stundenlich abgerechnete Hetzner-VPS.
#
# Voraussetzungen (einmalig):
#   node >= 20  und  npm  (oder bun)
#   cp .env.hetzner.example .env   und dann .env befuellen
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")/../.."
echo "[start-prod] working dir: $(pwd)"

# 1) Dependencies
echo "[start-prod] installing dependencies..."
if command -v bun >/dev/null 2>&1; then
  bun install --frozen-lockfile --ignore-scripts
else
  npm ci --ignore-scripts
fi

# 2) Build
echo "[start-prod] building production bundle..."
npm run build

# 3) Run
echo "[start-prod] server listening on :${PORT:-8080} ..."
NODE_ENV=production exec node dist/server.cjs
