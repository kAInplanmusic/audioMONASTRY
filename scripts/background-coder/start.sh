#!/usr/bin/env bash
# Background-Coder Pipeline starten (Orchestrator einmalig, Worker als Daemon)
set -u
REPO="/home/patrick/audioMONASTRY"
cd "$REPO" || exit 1
mkdir -p logs/background-coder

PIDFILE="$REPO/.background-coder.pid"
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "Background-Coder läuft bereits (PID $(cat "$PIDFILE"))."
  exit 0
fi

if [ -f "$REPO/AGENT_TODO.json" ] && [ "${1:-}" != "--reorchestrate" ]; then
  echo "[start] AGENT_TODO.json vorhanden – Queue fortführen (Orchestrator überspringen)."
else
  echo "[start] Orchestrator: MASTER_TODO → AGENT_TODO"
  node scripts/background-coder/orchestrator.mjs || { echo "Orchestrator fehlgeschlagen"; exit 1; }
fi

echo "[start] Worker-Daemon starten"
nohup node scripts/background-coder/worker.mjs --daemon > logs/background-coder/daemon.log 2>&1 &
echo $! > "$PIDFILE"
echo "Background-Coder gestartet (PID $(cat "$PIDFILE"))."
echo "Status: bash scripts/background-coder/status.sh"
echo "Stop:   bash scripts/background-coder/stop.sh"
