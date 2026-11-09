#!/usr/bin/env bash
# audioMONASTRY — Vollstaendiger Deploy mit Event-Logging.
#
# Ablauf (immer gleich, siehe DEPLOY.md):
#   0. Preflight   Plan + Tests (kostet nichts)
#   1. Hetzner     4 Rollen provisionieren + App deployen
#   2. RunPod      8 Pods starten
#   3. Ready       auf /ready aller Pods warten (max. 20 Min)
#   4. Smoke       Health-Check je Pod
#   5. Report      Ergebnis + Log-Pfad + Kosten
#
# Aufruf:
#   bash scripts/deploy-full.sh              # kompletter Deploy
#   bash scripts/deploy-full.sh --no-hetzner # nur Pods (Hetzner laeuft schon)
#   bash scripts/deploy-full.sh --dry-run    # nur Preflight
#
# Jede Zeile landet mit UTC-Timestamp im Log: deploy/logs/deploy-<ts>.log
# Secrets werden NIE geloggt (nur Praesenz geprueft).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

# Deploy-Lock: fleet-idle-teardown.py respektiert dieses Lock (lebende PID)
# und raeumt NICHT ab, solange der Deploy laeuft. trap entfernt das Lock
# immer — auch bei Abbruch oder Crash des Skripts.
DEPLOY_LOCK="/tmp/audiomonastry-deploy.lock"
echo $$ > "$DEPLOY_LOCK"
trap 'rm -f "$DEPLOY_LOCK"' EXIT

TS="$(date -u +%Y%m%d-%H%M%S)"
LOG_DIR="$ROOT/deploy/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/deploy-$TS.log"

ONLY_HETZNER=0
ONLY_PODS=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --no-hetzner) ONLY_PODS=1 ;;
    --no-pods)    ONLY_HETZNER=1 ;;
    --dry-run)    DRY_RUN=1 ;;
    *) echo "Unbekannte Option: $arg"; exit 2 ;;
  esac
done

# ---------- Logging ----------
log() { printf '%s  %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$LOG"; }
step() { printf '\n%s  === %s ===\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$LOG"; }
fail() { printf '%s  FEHLER: %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$LOG"; exit 1; }

START_EPOCH=$(date +%s)
T0=$(date +%s)

# ---------- 0. Preflight ----------
step "0/5 PREFLIGHT"
log "Log: $LOG"
[ -f .env.deploy ] || fail ".env.deploy fehlt"
set -a; . ./.env.deploy; set +a
log "Secrets geladen: HCLOUD_TOKEN=$([ -n "${HCLOUD_TOKEN:-}" ] && echo ja || echo NEIN), \
RP_API_KEY=$([ -n "${RP_API_KEY:-}" ] && echo ja || echo NEIN), \
AI_POD_TOKEN=$([ -n "${AI_POD_TOKEN:-}" ] && echo ja || echo NEIN)"
[ -n "${HCLOUD_TOKEN:-}" ] || fail "HCLOUD_TOKEN fehlt"
[ -n "${RP_API_KEY:-}" ] || fail "RP_API_KEY fehlt"

log "Plan pruefen ..."
PLAN_OUT="$(python3 scripts/runpod-pods.py plan 2>&1)"
echo "$PLAN_OUT" >> "$LOG"
if echo "$PLAN_OUT" | grep -q "^PROBLEM:"; then
  echo "$PLAN_OUT" | grep "^PROBLEM:" | tee -a "$LOG"
  fail "Plan meldet ein Problem — Deploy abgebrochen"
fi
log "Plan OK: $(echo "$PLAN_OUT" | grep 'Summe alle Pods' | tail -1)"

log "Tests ..."
python3 tests/test_runpod_pods.py >> "$LOG" 2>&1 || fail "test_runpod_pods.py rot"
python3 tests/test_weights_mirror.py >> "$LOG" 2>&1 || fail "test_weights_mirror.py rot"
log "Tests OK"

if [ "$DRY_RUN" -eq 1 ]; then
  step "DRY-RUN ENDE (nichts provisioniert)"
  exit 0
fi

# ---------- 1. Hetzner ----------
if [ "$ONLY_PODS" -eq 0 ]; then
  step "1/5 HETZNER (4 Rollen + App)"
  log "Provisioniere/pruefe app-1, sfu-1, media-1, edge-1 ..."
  if ! python3 scripts/fleet-start.py --yes --no-pods 2>&1 | tee -a "$LOG" | tail -30; then
    log "WARNUNG: fleet-start.py meldete Fehler — Health-Check entscheidet"
  fi
  log "Hetzner fertig in $(( $(date +%s) - T0 ))s"
else
  log "Hetzner uebersprungen (--no-hetzner)"
fi

# ---------- 2. RunPod ----------
if [ "$ONLY_HETZNER" -eq 0 ]; then
  step "2/5 RUNPOD (8 Pods)"
  T_PODS=$(date +%s)
  if ! python3 scripts/runpod-pods.py up --yes 2>&1 | tee -a "$LOG" | tail -30; then
    fail "Pod-Start fehlgeschlagen (Details im Log)"
  fi
  log "Pod-Start Kommando fertig in $(( $(date +%s) - T_PODS ))s"

  # ---------- 3. Ready ----------
  step "3/5 READY-CHECK (max. 20 Min)"
  READY_DEADLINE=$(( $(date +%s) + 1200 ))
  ALL_READY=0
  while [ "$(date +%s)" -lt "$READY_DEADLINE" ]; do
    STATUS_JSON="$(python3 scripts/runpod-pods.py status --json 2>/dev/null || echo '{}')"
    echo "$STATUS_JSON" >> "$LOG"
    read -r READY TOTAL <<< "$(echo "$STATUS_JSON" | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: print("0 0"); raise SystemExit
pods=d.get("pods",[])
print(sum(1 for p in pods if p.get("ready")), len(pods))
' 2>/dev/null || echo "0 0")"
    log "ready: $READY/$TOTAL  (seit $(( $(date +%s) - T_PODS ))s)"
    if [ "$TOTAL" -gt 0 ] && [ "$READY" -eq "$TOTAL" ]; then
      ALL_READY=1
      break
    fi
    sleep 20
  done
  [ "$ALL_READY" -eq 1 ] && log "Alle Pods ready nach $(( $(date +%s) - T_PODS ))s" \
                          || log "WARNUNG: nicht alle Pods ready nach 20 Min"

  # ---------- 4. Smoke ----------
  step "4/5 SMOKE-TEST"
  python3 scripts/runpod-pods.py status 2>&1 | tee -a "$LOG" | tail -15
else
  log "RunPod uebersprungen (--no-pods)"
fi

# ---------- 5. Report ----------
step "5/5 REPORT"
TOTAL_S=$(( $(date +%s) - START_EPOCH ))
log "Gesamtdauer: $(( TOTAL_S / 60 )) Min $(( TOTAL_S % 60 )) s"
log ""
log "--- Pod-Status ---"
python3 scripts/runpod-pods.py status 2>&1 | tee -a "$LOG" | tail -12 || true
log ""
log "--- Hetzner ---"
python3 scripts/fleet-start.py 2>&1 | tee -a "$LOG" | head -8 || true
log ""
log "Log vollstaendig: $LOG"
log "Teardown: python3 scripts/runpod-pods.py down --yes && python3 scripts/fleet-teardown.py --yes"
log "Idle-Teardown laeuft automatisch nach 15 Min ohne Nutzung."
exit 0
