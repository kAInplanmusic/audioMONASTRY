#!/usr/bin/env bash
# agent-swarm/run-swarm.sh – 4 autonome Hintergrund-Agenten
# KI-Provider: Qwen3-Coder-Next + Qwen3-Coder-480B via HF Router
# (siehe .deepaudit.json – statt der allgemeinen DeepSeek/HF-Modelle).
set -u
REPO="/home/patrick/audioMONASTRY"
cd "$REPO" || exit 1
mkdir -p logs/agent-swarm

log() { echo "[swarm $(date -Is)] $*"; }
log "Start Agenten (Qwen Coder: Next + 480B, Aufgaben: AGENT_TASKS.json)"

# Agent 1: Deep-Audit mit Qwen3-Coder (Next/480B) – analysiert + aktualisiert MASTER_TODO
(npm run audit:deep -- --mode full --update-todo > logs/agent-swarm/agent1-audit.log 2>&1) &
p1=$!

# Agent 2: ESLint-Autofix (Mittel/Niedrig)
(npx eslint src server.ts server services scripts --ext .ts,.tsx,.js,.mjs --fix > logs/agent-swarm/agent2-eslint.log 2>&1) &
p2=$!

# Agent 3: Dependency-Security-Fix
(npm audit fix > logs/agent-swarm/agent3-auditfix.log 2>&1) &
p3=$!

# Agent 4: Verify-Gate nach Autofixes, Commit+Push nur bei grün
wait "$p2" "$p3"
log "Agent 4: verify nach Autofixes"
if npm run verify > logs/agent-swarm/agent4-verify.log 2>&1; then
  git add -A
  if ! git diff --cached --quiet; then
    git commit -m "Agent-Swarm: Qwen-Coder-Autofixes (Batch)" > logs/agent-swarm/agent4-commit.log 2>&1
    git push origin main >> logs/agent-swarm/agent4-commit.log 2>&1 || true
    log "Agent 4: verify grün + committet"
  else
    log "Agent 4: verify grün, nichts zu committen"
  fi
else
  log "Agent 4: verify rot – kein Commit (agent4-verify.log)"
fi

wait "$p1"
log "Swarm beendet."
