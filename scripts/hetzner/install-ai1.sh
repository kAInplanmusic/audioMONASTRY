#!/usr/bin/env bash
# =============================================================================
# install-ai1.sh – ai-1 (Stem-AI-CPU-Fallback) idempotent einrichten
# -----------------------------------------------------------------------------
# Aufruf:  bash scripts/hetzner/install-ai1.sh root@<ai-1-ip>
#
# Macht (idempotent, kann mehrfach laufen):
#   1. Repo per rsync nach /opt/audiomonastry syncen
#   2. Stem-AI (Demucs) venv + systemd-Unit anlegen und starten
#   3. Health-Check http://127.0.0.1:8000/health
#
# Hinweis: Ollama wurde am 2026-10-06 aus dem Projekt entfernt (es gab nie
# eine lokale Instanz, die es bedienen konnte) - das Skript richtet nur noch
# den Stem-AI-CPU-Fallback ein.
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/../.."

HOST="${1:?Host angeben, z.B. root@49.13.65.150}"
SSH_KEY="${DEPLOY_SSH_KEY:-$HOME/.ssh/id_ed25519}"
SSH_OPTS=(-i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)
RSYNC_E="ssh -i $SSH_KEY -o StrictHostKeyChecking=accept-new"

echo "== Sync Repo → $HOST:/opt/audiomonastry =="
# ACHTUNG `--delete`: gleicher Vertrag wie bring-up-fleet.sh und
# fleet-deploy-live.sh. Auf ai-1 liegt heute kein Knoten-eigener Top-Level-Pfad
# (gemessen 2026-09-21: nur Repo-Inhalte + die Rollen-.env), die Ausschluesse
# sind aber dieselben - sonst wandert der Fix beim naechsten Rollen-Sync nicht
# mit und ein spaeterer Knoten-Zustand waere ohne Vorwarnung loeschbar
# (Test: FleetSyncDeleteGuardTest).
rsync -az --delete -e "$RSYNC_E" \
  --exclude node_modules --exclude dist --exclude .git --exclude coverage --exclude test-results \
  --exclude public/data/orchestral --exclude public/models --exclude public/music \
  --exclude media --exclude certs --exclude Caddyfile --exclude runtime \
  --exclude target --exclude '.venv*' --exclude .worktrees --exclude .agents --exclude logs \
  --exclude __pycache__ \
  ./ "$HOST:/opt/audiomonastry/"

echo "== Installiere Stem-AI (idempotent) =="
ssh "${SSH_OPTS[@]}" "$HOST" 'bash -s' <<'REMOTE'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

# --- Stem-AI (Demucs CPU-Fallback) ---
cd /opt/audiomonastry/services/stem-ai
if [ ! -d .venv ]; then
  python3 -m venv .venv 2>/dev/null || {
    apt-get update -qq && apt-get install -y -qq python3.12-venv
    python3 -m venv .venv
  }
fi
. .venv/bin/activate
python -m pip install --quiet --upgrade pip || true
pip install --quiet -r requirements.txt

cat > /etc/systemd/system/stem-ai.service <<UNIT
[Unit]
Description=audioMONASTRY stem-ai (Demucs CPU-Fallback)
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/audiomonastry/services/stem-ai
Environment=AI_DEVICE=cpu
Environment=AI_MAX_UPLOAD_MB=50
ExecStart=/opt/audiomonastry/services/stem-ai/.venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now stem-ai
sleep 5
curl -fsS http://127.0.0.1:8000/health
REMOTE

echo "✅ ai-1 bereit: stem-ai (CPU) aktiv"
