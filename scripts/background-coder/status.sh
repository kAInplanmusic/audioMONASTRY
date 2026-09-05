#!/usr/bin/env bash
# Background-Coder Status
set -u
REPO="/home/patrick/audioMONASTRY"
PIDFILE="$REPO/.background-coder.pid"
echo "--- Background-Coder Status ---"
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "Status: RUNNING (PID $(cat "$PIDFILE"))"
else
  echo "Status: STOPPED"
fi
echo
echo "--- AGENT_TODO.json Zähler ---"
if [ -f "$REPO/AGENT_TODO.json" ]; then
  node -e 'const p=require(process.cwd()+"/AGENT_TODO.json"); const c={}; for(const t of p.tasks) c[t.status]=(c[t.status]||0)+1; console.log(c); console.log("updated:", p.updated);' 2>/dev/null || echo "(JSON nicht lesbar)"
else
  echo "AGENT_TODO.json fehlt – Orchestrator ausführen."
fi
echo
echo "--- letzte Worker-Logs ---"
tail -10 "$REPO/logs/background-coder/worker.log" 2>/dev/null || tail -10 "$REPO/logs/background-coder/daemon.log" 2>/dev/null || echo "(keine Logs)"
