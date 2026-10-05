#!/usr/bin/env bash
# =============================================================================
# deep-test-run.sh – Autonomer Deep-Test-Lauf Hetzner-only (docs/DEEP-TEST-PLAN.md)
# -----------------------------------------------------------------------------
# Orchestriert die Phasen T0–T5 in EINEM Lauf:
#   T0  Preflight (lokal: Env, Snapshots, Kosten aus der Hetzner-Pricing-API)
#   T1  Playwright-Infra reparieren + Trockenlauf ALLER Specs gegen die lokale App
#   T2  Flotte (5 Knoten, Test-Subdomain, AI_MODE=off) deployen + Smoke
#   T3  Infra-Checks (Prometheus/Grafana/Timer/Security-Negativ/AI-OFF-Env)
#   T4  Playwright gegen die HETZNER-Instanz (trace+video+screenshot, JSON+JUnit,
#       Server-Logs einsammeln, AI-OFF-Netzprobe auf ai-1)
#   T5  Report docs/DEEPTEST-REPORT-<ts>.md + lifecycle.sh stop (IMMER, auch bei
#       Fehler – über den EXIT-Trap)
#
# Sicherheiten (Plan §3):
#   * stop-on-red mit GENAU EINEM Retry je Phase
#   * Hard-Timeout je Phase, konfigurierbar:
#       DEEPTEST_PHASE_TIMEOUT_<PHASE>  >  DEEPTEST_PHASE_TIMEOUT  >  Default je Phase
#     Defaults: T1 3600 s, T4 5400 s (gemessen: die Suite braucht >34 min mit
#     workers:1 + video/screenshot), sonst 1800 s.
#   * Prozessgruppen-Kill: eine Phase laeuft in eigener Prozessgruppe (set -m),
#     Timeout/Retry/Trap beenden NIE nur die Subshell, sondern den ganzen Baum.
#     (Befund 2026-09-29: ein verwaister Playwright-Prozess schrieb nach dem
#     Phasenabbruch weiter und liess T1 faelschlich als "gruen" erscheinen.)
#   * Frische-Beweis fuer JUnit: Report wird vor dem Lauf geloescht; bewertet wird
#     nur, wenn er nach dem Phasenstart entstanden ist, Testfaelle enthaelt und
#     waehrend der Bewertung unveraendert bleibt (junit_guard).
#   * Kosten-Zeile je Phase (echte cx23-Stundensätze aus der Hetzner-Pricing-API,
#     Fallback DEEPTEST_COST_EUR_H)
#   * DNS-Vertrag (T2): DOMAIN=<ZONE>, Zielhosts in *.$DEPLOY_DOMAIN,
#     Scope-Guard in cf-dns-ensure.py (SUBDOMAIN=...) verhindert jeden Schreib-
#     zugriff auf die Produktionsnamen origin./sfu.anunnakitools.de.
#   * Observability (Betreiber-Pflicht): je Phase Timestamped-Log in
#     ~/MONK/logs/deeptest-<ts>/phase-<n>.log + progress.json (Phase, Status,
#     Zeit, Kosten-Schätzung); Playwright-Artefakte nach
#     test-results/e2e-hetzner/<ts>/; Server-Exzerpte in den Report.
#   * KEIN RunPod, KEIN RP_API_KEY auf den Knoten, pa-test-01 wird nicht angefasst
#     (bring-up/lifecycle operieren ausschließlich auf audiomonastry-*).
#
# Aufruf:
#   bash scripts/hetzner/deep-test-run.sh                 # voller Lauf T0→T5
#   bash scripts/hetzner/deep-test-run.sh --from T2       # T0/T1 als erledigt ansehen
#   bash scripts/hetzner/deep-test-run.sh --stop-after T1 # nur bis T1 (keine Kosten)
#   DEEPTEST_DNS_DOMAIN=anunnakitools.de DEEPTEST_SUBDOMAIN=deeptest ...
# =============================================================================
set -uo pipefail

cd "$(cd "$(dirname "$0")/../.." && pwd)"
REPO="$(pwd)"
TS="$(date +%Y%m%d-%H%M%S)"
GIT_SHA="$(git rev-parse HEAD 2>/dev/null || echo unknown)"

# --- Konfiguration -----------------------------------------------------------
if [[ -f .env.deploy ]]; then set -a; . ./.env.deploy; set +a; fi   # HCLOUD/CF/ADMIN/TURN
if [[ -f .env ]]; then set -a; . ./.env; set +a; set +x 2>/dev/null; fi  # STUDIO/Supabase/…

DNS_DOMAIN="${DEEPTEST_DNS_DOMAIN:-anunnakitools.de}"   # Hauptdomain für die Zone
SUBDOMAIN="${DEEPTEST_SUBDOMAIN:-deeptest}"             # Test-Subdomain (Betreiber-OK)
DEPLOY_DOMAIN="${DEPLOY_DOMAIN_OVERRIDE:-${SUBDOMAIN}.${DNS_DOMAIN}}"  # ÜBERSTEUERUNG: nie die Produktionsdomain
PHASE_TIMEOUT="${DEEPTEST_PHASE_TIMEOUT:-}"              # globaler Override (leer = je Phase s. u.)
RETRIES=1                                                # stop-on-red mit GENAU EINEM Retry
RUNROOT="${DEEPTEST_RUNROOT:-$HOME/MONK/logs/deeptest-$TS}"
PWOUT="$REPO/test-results/e2e-hetzner/$TS"
COST_EUR_H_FALLBACK="${DEEPTEST_COST_EUR_H:-0.013}"      # Fallback je Knoten, wenn Pricing-API scheitert
V2_LIVE_SKIP="${V2_LIVE_SKIP:-1}"                        # Live-Gate-Spec im Autolauf skippen (skipped sichtbar)
FROM="${DEEPTEST_FROM:-T0}"                              # --from
STOP_AFTER="${DEEPTEST_STOP_AFTER:-}"                    # --stop-after
while [[ $# -gt 0 ]]; do
  case "$1" in
    --from) FROM="${2:?}"; shift 2 ;;
    --stop-after) STOP_AFTER="${2:?}"; shift 2 ;;
    *) echo "Unbekanntes Argument: $1 (nutze --from T<n> / --stop-after T<n>)" >&2; exit 2 ;;
  esac
done

STUDIO_ACCESS_TOKEN="$(grep -m1 '^STUDIO_ACCESS_TOKEN=' .env 2>/dev/null | cut -d= -f2- | tr -d '\"' || true)"
export STUDIO_ACCESS_TOKEN DEEPTEST_RUN=1 PWOUT PWREPORTERS V2_LIVE_SKIP

# --- Hard-Timeout JE PHASE ----------------------------------------------------
# GEMESSEN (Deep-Test 2026-09-29 19:41): die lokale Playwright-Suite brauchte
# 34,5 min (61 Tests, workers:1, video+screenshot an). Mit dem damaligen
# pauschalen 1800-s-Limit wurde T1 MITTEN im Lauf abgeschnitten - der verwaiste
# Playwright-Prozess schrieb danach JUnit/Artefakte weiter (mtime 20:15, also
# 3 min NACH dem gemeldeten Phasenende 20:12), und T1 galt faelschlich als gruen.
# Deshalb: eigene Defaults je Phase + Overrides.
#   DEEPTEST_PHASE_TIMEOUT_<PHASE>  (z. B. _T4)  >  DEEPTEST_PHASE_TIMEOUT  >  Default
DEFAULT_PHASE_TIMEOUT=1800        # T0/T2/T3/T5: Netz-/SSH-Phasen
DEFAULT_PHASE_TIMEOUT_T1=3600     # lokaler Trockenlauf: Suite >34 min gemessen
DEFAULT_PHASE_TIMEOUT_T4=5400     # Hetzner-Suite: gleiche Suite + Netzlatenz
phase_timeout_for() {             # $1 Phase -> Sekunden
  local specific="DEEPTEST_PHASE_TIMEOUT_$1" glob="DEEPTEST_PHASE_TIMEOUT" val=""
  val="${!specific:-}"
  [[ -n "$val" ]] || val="${!glob:-}"
  [[ -n "$val" ]] || { local def="DEFAULT_PHASE_TIMEOUT_$1"; val="${!def:-$DEFAULT_PHASE_TIMEOUT}"; }
  printf '%s' "$val"
}

mkdir -p "$RUNROOT" "$PWOUT"
PROGRESS="$RUNROOT/progress.json"

# --- Progress-Datei (Betreiber-Observability, Plan-Aufgabe a) -----------------
# JSON per Python gepflegt (jq nicht vorausgesetzt). Initialgerüst einmalig.
init_progress() {
  [[ -s "$PROGRESS" ]] && return 0
  python3 - "$PROGRESS" "$RUNROOT" "$GIT_SHA" "$DEPLOY_DOMAIN" \
    "$(python3 -c "import json;print(json.dumps({'T1':int('$(phase_timeout_for T1)'),'T4':int('$(phase_timeout_for T4)'),'default':int('$DEFAULT_PHASE_TIMEOUT')}))")" <<'PY'
import json, sys, time
path, runroot, sha, domain = sys.argv[1:5]
timeouts = json.loads(sys.argv[5]) if len(sys.argv) > 5 else {}
doc = {"run": {"started": time.strftime("%FT%T%z"), "git_sha": sha, "deploy_domain": domain,
               "runroot": runroot, "phase_timeouts_s": timeouts},
       "phases": []}
open(path, "w").write(json.dumps(doc, indent=2))
PY
}
init_progress || true

update_progress() {  # $1 Phase  $2 Status  $3 Dauer_s  $4 Kosten-EUR  $5 Notiz
  python3 - "$PROGRESS" "$@" <<'PY'
import json, sys, time
path, phase, status, dur, cost, note = sys.argv[1:7]
doc = json.load(open(path))
entry = {"phase": phase, "status": status, "finished": time.strftime("%FT%T%z"),
         "duration_min": round(int(dur) / 60, 2), "cost_estimate_eur": cost, "note": note}
doc["phases"] = [p for p in doc["phases"] if p.get("phase") != phase] + [entry]
doc["last_update"] = time.strftime("%FT%T%z")
open(path, "w").write(json.dumps(doc, indent=2))
PY
}

FLEET_UP=0           # LEGACY-Hinweis: der Trap liest $RUNROOT/.fleet-up (Subshell-sicher)
PHASE_NUM=0
CURRENT_LOG=""
COST_PER_H="?"       # EUR/h für die GESAMTE Flotte (5 Knoten), T0-Ermittlung

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

# SSH-Shortcuts der Phasen (gleicher Key-Vertrag wie die Flotten-Skripte).
ssh_root() {  # $1 IP  $2… Befehl
  local ip="$1"; shift
  ssh -i "${DEPLOY_SSH_KEY:-$HOME/.ssh/id_ed25519}" \
    -o StrictHostKeyChecking=accept-new -o ConnectTimeout=12 "root@$ip" "$*"
}

# cx23-Stundensätze (gross) aus der Hetzner-Pricing-API -> t0-cost.txt Zeile.
fleet_pricing_parse() {  # $1 = Pricing-JSON
  python3 - "$1" <<'PY'
import json, sys
d = json.loads(sys.argv[1])
st = {x["name"]: x for x in d.get("pricing", {}).get("server_types", [])}
per_node = None
for p in (st.get("cx23") or {}).get("prices", []):
    per_node = float(p["price_hourly"]["gross"])
    break
if per_node is None:
    sys.exit(1)
line = f"cx23-Satz: {per_node} EUR/h gross je Knoten -> 5 Knoten: {5*per_node:.4f} EUR/h"
try:
    fp = d["pricing"]["floating_ips"]["prices"][0]
    line += f"; Floating-IP: {fp['price_monthly']['gross']} EUR/Monat"
except Exception:
    pass
print(line)
PY
}

# --- Kosten (T0 ermittelt echte Sätze; je Phase als Zeile) --------------------
# Phasen laufen in Subshells (Hard-Timeout) -> Zustand per DATEI, nicht Variable.
FLEET_UP_FILE="$RUNROOT/.fleet-up"
COST_FILE="$RUNROOT/cost-per-h.txt"
fleet_cost_line() {  # $1 Dauer_s -> Klartext-Zeile
  local dur="$1" eur="?" up=0 cph="?"
  [[ -f "$FLEET_UP_FILE" ]] && up=1
  [[ -f "$COST_FILE" ]] && cph="$(cat "$COST_FILE")"
  if [[ "$up" = "1" && "$cph" != "?" ]]; then
    eur="$(python3 -c "print(f'{$cph * $dur / 3600:.2f}')")"
  elif [[ "$up" = "1" ]]; then
    eur="$(python3 -c "print(f'{5 * $COST_EUR_H_FALLBACK * $dur / 3600:.2f}')")"
  else
    eur="0.00 (keine Flotte)"
  fi
  printf 'Kosten-Schätzung Phase: ~%s EUR (Flotte: %s; Satz/H: %s)' "$eur" \
    "$([[ $up = 1 ]] && echo 5 Knoten || echo aus)" "$cph"
}

# --- Hard-Timeout-Wrapper (eigene Prozessgruppe + Watchdog) -------------------
# WARUM Prozessgruppe (Befund Deep-Test 2026-09-29): `( func ) &` + `kill $pid`
# beendet nur die Subshell. npm/npx/node/Chromium darunter liefen als Waisen
# weiter, schrieben JUnit/Artefakte noch minutenlang fort und liessen die Phase
# faelschlich gruen aussehen (T1 "gruen 74s", Artefakte mtime 20:15).
# Mit `set -m` bekommt jeder Hintergrund-Job eine EIGENE Prozessgruppe
# (PGID == Kind-PID): `kill -TERM -PGID` trifft dann den ganzen Baum. Die PGID
# bleibt auch nach einem Reparenting erhalten - Nachzuegler sind damit auch
# nach dem Timeout noch sicher zu fassen.
# Guard: die EIGENE Gruppe wird nie signalisiert (sonst killt sich die Shell).
set -m 2>/dev/null || true

own_pgid() { ps -o pgid= -p $$ 2>/dev/null | tr -d ' '; }

# Eigene Shell + alle Vorfahren (Schutzliste fuer Muster-basierte Kills).
self_and_ancestors() {
  local p=$$ out=""
  while [[ -n "$p" && "$p" != "0" && "$p" != "1" ]]; do
    out="$out $p"
    # shellcheck disable=SC2005
    p="$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')"
  done
  printf '%s' "$out"
}

phase_group_kill() {  # $1 PID (bzw. erwartete PGID)  $2 Signal (TERM|KILL)
  local pid="$1" sig="${2:-TERM}" pgid guard
  [[ -n "$pid" ]] || return 0
  pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')"
  [[ -n "$pgid" ]] || pgid="$pid"      # Prozess schon weg -> PGID == PID annehmen
  guard="$(own_pgid)"
  if [[ -n "$guard" && ( "$pgid" = "$guard" || "$pgid" = "$$" ) ]]; then
    echo "SICHERHEITS-GUARD: PGID $pgid ist die EIGENE Prozessgruppe – Kill uebersprungen."
    return 0
  fi
  kill "-$sig" -- "-$pgid" 2>/dev/null || true
}

# Nachzuegler eines LAUFS beenden. Kein pkill-Muster, das die eigene Shell
# treffen kann: gematcht wird ausschliesslich der laufspezifische Artefakt-Pfad
# (enthaelt den Zeitstempel $TS) in der Kommandozeile, und eigene Shell +
# Vorfahren sind explizit ausgenommen.
mopup_run_leftovers() {
  local pids p skip
  pids="$(pgrep -f -- "$PWOUT" 2>/dev/null || true)"
  [[ -n "$pids" ]] || return 0
  skip="$(self_and_ancestors)"
  for p in $pids; do
    [[ " $skip " == *" $p "* ]] && continue
    echo "  Nachzuegler beendet: PID $p ($(ps -o args= -p "$p" 2>/dev/null | cut -c1-90))"
    kill -TERM "$p" 2>/dev/null || true
  done
  sleep 2
  for p in $pids; do
    [[ " $skip " == *" $p "* ]] && continue
    kill -KILL "$p" 2>/dev/null || true
  done
}

with_timeout() {  # $1 Sekunden; Rest: Funktion + Argumente
  local secs="$1"; shift
  local pid wd rc=0 pgid
  ( "$@" ) &
  pid=$!
  pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')"
  [[ -n "$pgid" ]] || pgid="$pid"
  if [[ "$pgid" != "$pid" ]]; then
    echo "WARNUNG: Phase laeuft NICHT in eigener Prozessgruppe (pgid=$pgid != pid=$pid) – Timeout-Kill trifft nur die Subshell, Nachzuegler werden ueber $PWOUT nachgeraeumt."
  fi
  PHASE_PGID="$pgid"
  ( sleep "$secs" \
      && echo "HARD-TIMEOUT: Phase ueberschreitet ${secs}s – beende Prozessgruppe $pgid (TERM, dann KILL)." \
      && phase_group_kill "$pgid" TERM && sleep 10 && phase_group_kill "$pgid" KILL ) &
  wd=$!
  set +e; wait "$pid"; rc=$?; set -e
  kill "$wd" 2>/dev/null; wait "$wd" 2>/dev/null
  phase_group_kill "$wd" KILL 2>/dev/null || true   # Watchdog-Rest (sleep) mitnehmen
  # Nachzuegler IMMER einsammeln (auch bei rc=0): hier lebte der verwaiste
  # Playwright-Prozess weiter und ueberschrieb den Report der naechsten Phase.
  phase_group_kill "$pgid" TERM
  sleep 1
  phase_group_kill "$pgid" KILL
  mopup_run_leftovers
  return $rc
}
set +e   # Phasen-Fehler behandelt run_phase selbst (stop-on-red mit 1 Retry)

# --- Phasen-Runner: Log + Timeout + 1 Retry + Progress + Kosten ---------------
run_phase() {  # $1 Name (T0..T5); Rest: Funktionsname
  local name="$1"; shift
  PHASE_NUM=$((PHASE_NUM + 1))
  CURRENT_LOG="$RUNROOT/phase-$PHASE_NUM-$name.log"
  local attempt rc=0 start=0 end dur costline ptimeout
  ptimeout="$(phase_timeout_for "$name")"
  for attempt in 1 $((RETRIES + 1)); do
    log "▶ Phase $name (Versuch $attempt, Hard-Timeout ${ptimeout}s) – Log: $CURRENT_LOG"
    start=$(date +%s)
    PHASE_START_EPOCH=$start     # Bewertungs-Vertrag: Reports muessen NACH diesem Wert entstanden sein
    rc=0
    with_timeout "$ptimeout" "$@" >>"$CURRENT_LOG" 2>&1 || rc=$?
    end=$(date +%s); dur=$((end - start))
    if [[ $rc -eq 0 ]]; then break; fi
    if [[ $attempt -le $RETRIES ]]; then
      log "✗ Phase $name rot (rc=$rc, ${dur}s) – EIN Retry folgt (Nachzuegler werden vorher beendet)."
      mopup_run_leftovers
      update_progress "$name" "retry" "$dur" "-" "rc=$rc, retry läuft"
    fi
  done
  end=$(date +%s); dur=$((end - start))
  if [[ $rc -eq 0 ]]; then
    costline="$(fleet_cost_line "$dur")"
    log "✓ Phase $name grün (${dur}s). $costline"
    update_progress "$name" "green" "$dur" "${costline#Kosten-Schätzung Phase: ~}" "ok"
  else
    log "✗ Phase $name ENDGÜLTIG rot (rc=$rc, ${dur}s) – Abbruch nach Plan (lifecycle stop läuft über den Trap)."
    costline="$(fleet_cost_line "$dur")"
    update_progress "$name" "red" "$dur" "${costline#Kosten-Schätzung Phase: ~}" "rc=$rc nach $((RETRIES + 1)) Versuchen"
    tail -25 "$CURRENT_LOG" || true
  fi
  return $rc
}

# --- Trap: lifecycle.sh stop IMMER (auch bei Abort/Strg-C), Plan-Pflicht -----
cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  log "TRAP: Räumung (rc=$rc) – lifecycle.sh stop wird IMMER ausgeführt …"
  if [[ -f "$RUNROOT/.fleet-up" ]]; then
    set +e
    # API-Probe vor dem Stop: Flotte noch da? (spart einen sinnlosen API-Fehllauf,
    # 429-Limit schont) – read-only GET.
    local fleet_json still_there=1
    fleet_json="$(curl -s -m 20 -H "Authorization: Bearer ${HCLOUD_TOKEN:-}" 'https://api.hetzner.cloud/v1/servers?per_page=50' 2>/dev/null || echo '{}')"
    still_there="$(python3 -c "
import json,sys
try: d=json.loads(sys.argv[1])
except Exception: d={}
running=[s for s in d.get('servers',[]) if s.get('name','').startswith('audiomonastry-')]
print(1 if running else 0)
" "$fleet_json" 2>/dev/null || echo 1)"
    if [[ "$still_there" = "1" ]]; then
      bash scripts/hetzner/lifecycle.sh stop >> "$RUNROOT/lifecycle-stop.log" 2>&1
    else
      echo "0" > "$RUNROOT/.fleet-up"
      echo "$(date +%FT%TZ) Flotte laut API bereits weg (0 audiomonastry-*) – lifecycle stop übersprungen." >> "$RUNROOT/lifecycle-stop.log"
    fi
    local lrc=$?
    set -e
    if [[ $lrc -eq 0 ]]; then
      log "TRAP: lifecycle stop OK (Snapshots angelegt, Server gelöscht, 0 €/h)."
      update_progress "lifecycle-stop" "green" 0 "0.00" "Fleet gestoppt (Trap oder T5)"
    else
      log "TRAP-WARNUNG: lifecycle stop rc=$lrc – BITTE PRÜFEN (Kosten!): bash scripts/hetzner/fleet-status.sh"
      update_progress "lifecycle-stop" "red" 0 "offen" "rc=$lrc – manuelle Prüfung nötig"
    fi
  else
    log "TRAP: Flotte war nicht hochgefahren – kein Stop nötig."
  fi
  # Verwaiste Prozesse dieses Laufs beenden (Befund 2026-09-29: ein Waisen-
  # Playwright lief nach dem Phasen-Abbruch weiter, schrieb JUnit/Artefakte fort
  # und liess den naechsten Versuch als "gruen" erscheinen).
  phase_group_kill "${PHASE_PGID:-}" TERM
  phase_group_kill "${PHASE_PGID:-}" KILL
  mopup_run_leftovers
  systemctl --user stop deeptest-local-app.service 2>/dev/null || true
  log "RUNROOT: $RUNROOT · Playwright-Artefakte: $PWOUT"
  exit $rc
}
trap cleanup EXIT INT TERM
set -e

# =============================================================================
# T0 – Preflight (lokal)
# =============================================================================
t0() {
  log "T0: Git-Stand einfrieren: $GIT_SHA"
  echo "$GIT_SHA" > "$RUNROOT/git-sha.txt"
  [[ -n "${HCLOUD_TOKEN:-}" ]] || { echo "HCLOUD_TOKEN fehlt (.env.deploy)"; return 1; }
  [[ -n "${CLOUDFLARE_API_TOKEN:-}" || -n "${CF_API_KEY:-}" ]] || { echo "Cloudflare-Tokens fehlen (.env.deploy) – DNS-Vertrag nicht erfüllbar"; return 1; }
  [[ -n "${STUDIO_ACCESS_TOKEN:-}" ]] || { echo "STUDIO_ACCESS_TOKEN fehlt (lokale .env) – Studio-Gate des Deploys würde fail-closed bleiben"; return 1; }
  [[ -n "${ADMIN_USER:-}" && -n "${ADMIN_PASSWORD:-}" ]] || echo "WARN: ADMIN_USER/ADMIN_PASSWORD leer – Monitoring-Logins ggf. ungesetzt."

  log "T0: fleet-preflight.sh check (read-only)"
  bash scripts/hetzner/fleet-preflight.sh check || echo "WARN: preflight check meldete Abweichungen (Details oben) – Snapshots werden in T2 geprüft."

  log "T0: Live-Bestand (pa-test-01 unberührt lassen!)"
  curl -s -H "Authorization: Bearer $HCLOUD_TOKEN" 'https://api.hetzner.cloud/v1/servers?per_page=50' \
    | python3 -c "import sys,json; d=json.load(sys.stdin); [print(' server:', s['name'], s.get('status')) for s in d.get('servers',[])]" \
    | tee "$RUNROOT/t0-servers.txt"

  log "T0: Snapshots der 5 Rollen vorhanden? (bring-up braucht sie für den Schnellstart)"
  curl -s -H "Authorization: Bearer $HCLOUD_TOKEN" 'https://api.hetzner.cloud/v1/images?per_page=50&sort=created:desc' -o "$RUNROOT/t0-images.json"
  python3 - "$RUNROOT/t0-images.json" <<'PY'
import json, re, sys
d = json.load(open(sys.argv[1]))
imgs = [((i.get("name") or "") + " " + (i.get("description") or "")) for i in d.get("images", [])]
for role in ("app", "sfu", "ai", "master", "edge"):
    hits = [s for s in imgs if re.search(rf"audiomonastry-{role}\b|audiomonastry-snapshot-{role}\b", s)]
    print(f"  Rolle {role}: {'Snapshot vorhanden (' + str(len(hits)) + ')' if hits else 'KEIN Snapshot-Treffer (bring-up fällt ggf. auf Neuaufbau)'}")
PY

  log "T0: Kosten-Gate – echte Stundensätze aus der Hetzner-Pricing-API"
  local pricing
  pricing="$(curl -s -H "Authorization: Bearer $HCLOUD_TOKEN" https://api.hetzner.cloud/v1/pricing)"
  fleet_pricing_parse "$pricing" > "$RUNROOT/t0-cost.txt" 2>/dev/null || true
  if [[ -s "$RUNROOT/t0-cost.txt" ]]; then
    log "  $(cat "$RUNROOT/t0-cost.txt")"
    python3 -c "import re;print(float(re.search(r'5 Knoten: ([0-9.]+)', open('$RUNROOT/t0-cost.txt').read()).group(1)))" \
      > "$COST_FILE" 2>/dev/null || echo "$(python3 -c "print(5*$COST_EUR_H_FALLBACK)")" > "$COST_FILE"
  else
    echo "$(python3 -c "print(5*$COST_EUR_H_FALLBACK)")" > "$COST_FILE"
    echo "  Pricing-API nicht lesbar – Fallback-Satz 5×$COST_EUR_H_FALLBACK EUR/h."
  fi
  # BEFUND (Lauf 2026-09-29): hier stand `print(f'{$COST_PER_H*3.5:.2f}')` –
  # $COST_PER_H ist im Skript nie gesetzt (bleibt "?"), deshalb brach die Zeile
  # mit einem SyntaxError ab und der Kostenausdruck war leer. Der echte Satz
  # steht in $COST_FILE (5 Knoten).
  local cph_file
  cph_file="$(cat "$COST_FILE" 2>/dev/null || echo 0)"
  echo "  Geschätzter Voll-Lauf (Flotte ~3–4 h): $(awk -v c="$cph_file" 'BEGIN{printf "%.2f", (c+0)*3.5}') EUR."
  log "T0: Betreiber-Freigaben sind laut Auftrag erteilt (Kosten OK, Subdomain, 5 Knoten, AI_MODE=off)."
}

# --- Frische-Beweis fuer JUnit-Reports ---------------------------------------
# WARUM (Befund Deep-Test 2026-09-29): T1 wurde als "grün (74s)" verbucht,
# obwohl Versuch 1 allein 34,5 min lief und abgebrochen wurde – der Bewerter las
# eine (leere/alte) junit.xml, 0 Testfaelle = 0 rot = exit 0. Ein Report ist nur
# dann ein Beweis, wenn er (a) NACH dem Start dieses Versuchs entstanden ist,
# (b) Testfaelle enthaelt und (c) waehrend der Bewertung nicht weitergeschrieben
# wird (verwaister Schreiber). Genau diese drei Faelle prueft dieser Guard.
junit_guard() {  # $1 junit-Pfad  $2 Start-Epoch des Versuchs  [$3 erwartete sha256]
  python3 - "$@" <<'PY'
import hashlib, os, sys, xml.etree.ElementTree as ET
path, since = sys.argv[1], int(sys.argv[2])
expect_sha = sys.argv[3] if len(sys.argv) > 3 else ""
ok = True
if not os.path.isfile(path):
    print(f"  FRISCHE-BEWEIS ROT: {path} existiert nicht – kein Report = kein Beweis.")
    raise SystemExit(1)
st = os.stat(path)
sha = hashlib.sha256(open(path, "rb").read()).hexdigest()
if st.st_mtime < since:
    print(f"  FRISCHE-BEWEIS ROT: {path} ist ALT (mtime {int(st.st_mtime)} < Start {since}) – Ergebnis eines Vorlaufs/verwaisten Prozesses.")
    ok = False
if expect_sha and sha != expect_sha:
    print(f"  FRISCHE-BEWEIS ROT: {path} wurde waehrend der Bewertung veraendert ({sha[:12]} != {expect_sha[:12]}) – verwaister Schreiber.")
    ok = False
try:
    root = ET.parse(path).getroot()
except Exception as error:  # noqa: BLE001
    print(f"  FRISCHE-BEWEIS ROT: {path} ist kein gueltiges XML ({error}).")
    raise SystemExit(1)
n = sum(1 for _ in root.iter("testcase"))
if n == 0:
    print(f"  FRISCHE-BEWEIS ROT: {path} enthaelt 0 Testfaelle – ein leerer Report ist KEIN gruener Lauf.")
    ok = False
if ok:
    print(f"  FRISCHE-BEWEIS OK: {path} frisch (mtime {int(st.st_mtime)} >= {since}), {n} Testfaelle, sha {sha[:12]}")
else:
    # WICHTIG: Die Abschlusszeile darf NUR bei ok=1 'frisch/gueltig' behaupten.
    # Vorher stand sie unbedingt da – bei einem alten Report las man also direkt
    # nach der ROT-Meldung "frisch (mtime alt >= start)", also einen Widerspruch.
    print(f"  FRISCHE-BEWEIS ROT: {path} NICHT verwertbar ({n} Testfaelle, sha {sha[:12]}) - siehe Meldung oben.")
raise SystemExit(0 if ok else 1)
PY
}

# =============================================================================
# T1 – Playwright-Infra reparieren + lokaler Trockenlauf (keine Kosten)
# =============================================================================
t1() {
  log "T1: Root-Deps sind die Quelle (@playwright/test im Root-package.json); Subpaket bleibt manifest-frei."
  [[ -d node_modules/@playwright/test ]] || { echo "Root-Deps fehlen: npm install --include=dev"; npm install --include=dev; }
  log "T1: playwright install chromium (idempotent)"
  npx playwright install chromium
  npx playwright --version

  log "T1: lokale App starten (systemd-run --user, Port 8080; NODE_ENV=development gegen Env-Gift – 'test' würde den Autostart in server.ts unterdrücken, Zeile ~1115; DISABLE_HMR=true gegen Vite-Full-Reloads)"
  # WARUM DISABLE_HMR (Befund Deep-Test 2026-09-29, im Journal belegt):
  # Vite laedt die Seite bei JEDER Aenderung im Projektbaum neu ("[vite] (client)
  # page reload tests/e2e/…"). Waehrend des Laufs gleichzeitig editierte Dateien
  # (Tests/Harness/Report) setzten die SPA damit mitten im Test auf den
  # Startbildschirm zurueck – T2-4 (prepareStudio), Responsive iPad 16:9 (nav
  # buttons = 0) und der Stresstest liefen deshalb in ihre Timeouts.
  # vite.config.ts sieht dafuer den dokumentierten Schalter vor:
  # `watch: process.env.DISABLE_HMR === 'true' ? null : {}`.
  systemctl --user stop deeptest-local-app.service 2>/dev/null || true
  # API_RATE_LIMIT_MAX: Befund 2026-09-29 (nach mehreren Laeufen in Folge):
  # der Server drosselt per Default auf 60 Requests/Minute je Session/IP
  # (server.ts:294, API_RATE_LIMIT_MAX). Die Suite ueberschreitet das im
  # Normalbetrieb -> HTTP 429 "Too many requests" in /api/session/reset usw., und
  # EIN 429 faerbt ganze Spec-Gruppen rot (startState 3x, pluginCloseSync,
  # visual-Studio-Baseline).
  # AI_RATE_EXPENSIVE_MAX: ZUSÄTZLICH haengt an /api/ai/* (und /api/voice,
  # /api/sound, /api/cloud/upload, …) der `expensiveLimiter` – Default nur
  # **10 Requests/Minute** (src/config/aiRateLimits.ts: expensiveMax=10,
  # server.ts:625). Die AI-Negativ-Suite allein sprengt das:
  # /api/ai/compose und /api/ai/vision/* antworteten 429 statt 200/401.
  # Die Repo-eigenen Unit-Tests heben dieselben Schalter an (tests/*.test.ts
  # setzen API_RATE_LIMIT_MAX=1000/10000) – hier passiert dasselbe, nur explizit
  # und je Lauf konfigurierbar. Der Hetzner-Lauf (T4) behaelt die Produktionswerte.
  systemd-run --user --unit=deeptest-local-app --collect \
    bash -c "cd '$REPO' && exec env NODE_ENV=development AUDIOMONASTRY_TEST_RESET=1 DISABLE_HMR=true API_RATE_LIMIT_MAX='${DEEPTEST_LOCAL_RATE_LIMIT_MAX:-10000}' AI_RATE_EXPENSIVE_MAX='${DEEPTEST_LOCAL_RATE_LIMIT_MAX:-10000}' npm run dev" >/dev/null
  local up=0
  for _ in $(seq 1 60); do
    if curl -sf http://localhost:8080/api/health >/dev/null 2>&1; then up=1; break; fi
    sleep 2
  done
  [[ $up = 1 ]] || { journalctl --user -u deeptest-local-app -n 40 --no-pager 2>/dev/null || true; echo "lokale App wurde nicht gesund"; return 1; }
  log "T1: lokale App gesund (http://localhost:8080/api/health)"

  log "T1: Trockenlauf ALLER Specs (19 Dateien) gegen die lokale App"
  local junit="$PWOUT/local/junit.xml" pw_rc=0 ev_rc=0 sha_before sha_after
  # FRISCHE-BEWEIS vorbereiten: alten Report VOR dem Lauf loeschen. Sonst ist
  # nicht unterscheidbar, ob die unten gelesene junit.xml aus DIESEM Versuch
  # stammt – genau daran entstand am 2026-09-29 das falsche "T1 grün (74s)".
  rm -f "$junit" "$junit.summary" "$PWOUT/local/report.json"
  ( cd "$REPO" && unset E2E_BASE_URL && \
    NODE_ENV=test DEEPTEST_RUN=1 V2_LIVE_SKIP="$V2_LIVE_SKIP" PWOUTPUT="$PWOUT/local" PWREPORTERS="[[\"list\"],[\"json\",{\"outputFile\":\"$PWOUT/local/report.json\"}],[\"junit\",{\"outputFile\":\"$PWOUT/local/junit.xml\"}]]" \
    npx playwright test --output="$PWOUT/local" --retries="${DEEPTEST_RETRIES:-1}" ) || pw_rc=$?
  # WARUM --retries (Befund 2026-09-29): dieser Rechner erzeugt unter Last
  # sporadische SIGSEGVs in beliebigen Prozessen (dmesg: "BUG: Bad page state",
  # "segfault ... in libcrypto", auch in sudo/apt und im TypeScript-Compiler).
  # Ein abgestuerzter Browser-Worker ist damit ERWARTBAR und darf nicht als
  # App-Fehler erscheinen. Der Retry macht solche Aussetzer sichtbar (Playwright
  # meldet sie als "flaky"), statt sie zu verschweigen – die Bewertung unten zählt
  # Crashes getrennt und erklärt den Lauf bei Crashes fuer NICHT verwertbar.
  echo "T1: Playwright-Prozess rc=$pw_rc (Retries: ${DEEPTEST_RETRIES:-1})"
  # UMGEBUNGS-CRASH-ERKENNUNG (Befund 2026-09-29): stirbt der Dev-Server
  # WAEHREND des Laufs, laufen alle folgenden Tests in ECONNREFUSED/Timeout und
  # sehen wie 40 App-Fehler aus – real ist es EIN Umgebungsausfall. Journal-Beleg
  # des Befunds: "Process <pid> (node) dumped core", Module tailwindcss-oxide /
  # lightningcss / rollup (native Vite-Toolchain), status=139 (SIGSEGV).
  local app_alive=1
  curl -sf http://localhost:8080/api/health >/dev/null 2>&1 || app_alive=0
  if [[ $app_alive = 0 ]]; then
    echo "UMGEBUNGS-BEFUND: die lokale App hat den Playwright-Lauf NICHT ueberlebt (kein /api/health mehr)."
    systemctl --user is-active deeptest-local-app.service 2>&1 | sed 's/^/    systemd: /' || true
    journalctl --user -u deeptest-local-app -n 20 --no-pager 2>/dev/null | cut -c1-160 | sed 's/^/    /' || true
    echo "  -> Die roten Tests dieses Versuchs sind NICHT als App-Fehler lesbar (der Server war weg)."
    ev_rc=1
  fi
  systemctl --user stop deeptest-local-app.service 2>/dev/null || true

  log "T1: lokales Ergebnis bewerten (skips sind erwartet: @ai-Route-Abhängige + Live-Gate)"
  sha_before="$(sha256sum "$junit" 2>/dev/null | cut -d' ' -f1)"
  junit_guard "$junit" "${PHASE_START_EPOCH:-$(date +%s)}" || ev_rc=1
  python3 - "$junit" <<'PY' || ev_rc=$?
import json, os, re, sys, xml.etree.ElementTree as ET

# Umgebungs-Crashes getrennt zaehlen (Befund 2026-09-29): dieser Rechner erzeugt
# unter Last SIGSEGVs in Browser/Node (dmesg: "BUG: Bad page state", segfault in
# libcrypto, Abstuerze in sudo/apt und im TypeScript-Compiler). Solche Roten sind
# KEINE App-Fehler – aber sie machen den Lauf unverwertbar. Deshalb: getrennt
# melden und einen eigenen Exitcode (2) vergeben, statt sie wegzupassen.
CRASH = re.compile(
    r"worker process exited unexpectedly|Target crashed|SIGSEGV|"
    r"browser has been closed|Target page, context or browser has been closed",
    re.I,
)

path = sys.argv[1]
root = ET.parse(path).getroot()
cases = list(root.iter("testcase"))
n = f = s = 0
failed, crashes = [], []
for c in cases:
    n += 1
    bad = c.find("failure")
    if bad is None:
        bad = c.find("error")
    name = f"{c.get('classname', '')}.{c.get('name', '')}"
    if bad is not None:
        text = " ".join(t for t in (bad.get("message"), bad.text) if t)
        if CRASH.search(text):
            first = (text.strip().splitlines() or [""])[0][:110]
            crashes.append(f"{name} | {first}")
        else:
            f += 1
            failed.append(name)
    elif c.find("skipped") is not None:
        s += 1

green = n - f - s - len(crashes)
print(f"T1-DRYRUN: {n} Tests, {green} grün, {f} rot, {s} skipped, {len(crashes)} Umgebungs-Crash")
for x in failed:
    print("  ROT:", x)
if crashes:
    print(f"  UMGEBUNGS-CRASH ({len(crashes)}) – kein App-Fehler, aber der Lauf ist NICHT verwertbar:")
    for x in crashes:
        print("    CRASH:", x)

# Retry-Sichtbarkeit: Playwright meldet Tests, die erst im Wiederholungslauf gruen
# wurden, als "flaky" – das ist genau der SIGSEGV-Aussetzer dieses Rechners.
try:
    with open(os.path.join(os.path.dirname(path), "report.json"), encoding="utf-8") as handle:
        stats = json.load(handle)["stats"]
    print(f"  PLAYWRIGHT: erwartet {stats.get('expected')}, unerwartet {stats.get('unexpected')}, "
          f"flaky {stats.get('flaky')} (erst im Retry gruen), skipped {stats.get('skipped')}")
    if stats.get("flaky"):
        print("    -> flaky heisst: der Retry hat den Test gerettet. Haeuft sich das, ist der Rechner das Problem, nicht die App.")
except Exception as error:  # noqa: BLE001 - Diagnose darf den Lauf nicht kippen
    print(f"  (report.json nicht lesbar: {error})")

summary = f"total={n} failed={f} skipped={s} crashes={len(crashes)}\n"
for x in failed:
    summary += f"RED {x}\n"
for x in crashes:
    summary += f"CRASH {x}\n"
open(path + ".summary", "w").write(summary)  # noqa: SIM115 - Kurzschreiben, kein Kontext noetig

# Rueckgabecode: 2 = nicht verwertbar (Umgebungs-Crash), 1 = rote Tests, 0 = gruen.
sys.exit(2 if crashes else (1 if f else 0))
PY
  if [[ $ev_rc = 2 ]]; then
    echo "T1: ERGEBNIS NICHT VERWERTBAR – der Lauf enthaelt Umgebungs-Crashes (Browser-/Node-SIGSEGV)."
    echo "    Das ist KEIN App-Fehler, aber auch kein gruener Lauf: auf stabilem Rechner wiederholen."
    echo "    Beleg pruefen mit: dmesg -T | grep -E 'Bad page state|segfault' | tail"
  fi
  if [[ $pw_rc -ne 0 && $ev_rc != 2 ]]; then
    echo "T1: Playwright-prozess meldete rc=$pw_rc – das ist kein grüner Lauf (Exitcode wird nicht mehr verschluckt)."
    ev_rc=1
  fi
  sha_after="$(sha256sum "$junit" 2>/dev/null | cut -d' ' -f1)"
  if [[ -n "$sha_before" && "$sha_before" != "$sha_after" ]]; then
    echo "T1: JUnit wurde WÄHREND der Bewertung verändert (sha $sha_before -> $sha_after) – ein verwaister Prozess schreibt weiter, das Ergebnis ist nicht belastbar -> NICHT grün."
    ev_rc=1
  fi
  return $ev_rc
}

# =============================================================================
# T2 – Flotte hochziehen (Subdomain, AI_MODE=off) + Smoke
# =============================================================================
t2() {
  # --- DNS-Vertrag (Befund Deep-Test 2026-09-29) -------------------------------
  # `DOMAIN` in cf-dns-ensure.py ist die ZONE (Lookup: GET /zones?name=$DOMAIN).
  # Hier stand vorher DOMAIN="$DEPLOY_DOMAIN" (Subdomain!) – der Lookup findet
  # dann keine Zone und T2 wird rot, obwohl der Token gueltig ist. Richtig:
  #   DOMAIN=<Zone>, ORIGIN_HOST=origin.$DEPLOY_DOMAIN, SFU_HOST=sfu.$DEPLOY_DOMAIN,
  #   APP_HOST=$DEPLOY_DOMAIN (der oeffentliche Smoke-Zielhost).
  # Der Scope-Guard (SUBDOMAIN=...) ist dabei hart: nichts darf ausserhalb von
  # $DEPLOY_DOMAIN geschrieben werden (die Produktions-Records
  # origin./sfu.anunnakitools.de sind in der Zone belegt und duerfen sich NIE
  # aendern).
  local CF_TOKEN="${CLOUDFLARE_API_TOKEN:-${CF_API_KEY:-}}"
  [[ -n "$CF_TOKEN" ]] || { echo "CLOUDFLARE_API_TOKEN/CF_API_KEY fehlt (.env.deploy) – DNS-Vertrag nicht erfuellbar."; return 1; }

  log "T2: DNS-Vorcheck (Trockenlauf, KEIN Schreibzugriff) – Zone $DNS_DOMAIN, Zielhosts in *.$DEPLOY_DOMAIN, Scope-Guard aktiv"
  local dns_probe
  dns_probe="$(CLOUDFLARE_API_TOKEN="$CF_TOKEN" DOMAIN="$DNS_DOMAIN" \
    ORIGIN_HOST="origin.$DEPLOY_DOMAIN" SFU_HOST="sfu.$DEPLOY_DOMAIN" APP_HOST="$DEPLOY_DOMAIN" \
    SUBDOMAIN="$SUBDOMAIN" \
    python3 scripts/hetzner/cf-dns-ensure.py 2>&1 || true)"
  echo "$dns_probe" | sed 's/^/  /'
  echo "$dns_probe" | grep -q "keine Zone" && { echo "ABBRUCH-KRITERIUM: keine Zone für $DNS_DOMAIN – Produktionsdomain würde genutzt. Phase T2 bricht ab."; return 1; }
  echo "$dns_probe" | grep -q "ABBRUCH (Scope-Guard)" && { echo "ABBRUCH-KRITERIUM: Scope-Guard hat den DNS-Trockenlauf gestoppt – Zielhosts liegen ausserhalb von *.$DEPLOY_DOMAIN."; return 1; }
  echo "$dns_probe" | grep -q "FRISCHE\|Traceback" && { echo "ABBRUCH-KRITERIUM: cf-dns-ensure.py meldete einen Fehler (siehe oben)."; return 1; }

  log "T2: Flotte hochfahren (bring-up-fleet.sh --yes, DEPLOY_DOMAIN=$DEPLOY_DOMAIN, Snapshots 2026-09-25)"
  log "    Entlastung im Autolauf: Smoke/Stress/SFU-Echtpfad macht T2-Tail selbst, Deep-Test macht T4."
  # INFRA-HETZNER-017: Der Trap-Vertrag muss VOR dem Aufbau gelten. Stand er
  # danach, lief die Flotte nach einem Abbruch INNERHALB von bring-up-fleet.sh
  # (z. B. Schritt 4/9 SSH-Timeout) ungestoppt weiter - der Trap fand keine
  # .fleet-up und uebersprang lifecycle stop (real passiert: 5 Server liefen
  # ~3 h weiter, manueller Stop noetig). Daher: Datei setzen, sobald der Aufbau
  # beginnen soll; der Trap raeumt dann jeden Abbruch ab diesem Punkt.
  touch "$RUNROOT/.fleet-up"
  DEPLOY_DOMAIN="$DEPLOY_DOMAIN" DEEPTEST_SKIP_TESTS=1 \
    bash scripts/hetzner/bring-up-fleet.sh --yes || return 1

  log "T2: Knoten-IPs aus der API lesen"
  curl -s -H "Authorization: Bearer $HCLOUD_TOKEN" 'https://api.hetzner.cloud/v1/servers?per_page=50' -o "$RUNROOT/t2-servers.json"
  python3 - "$RUNROOT/t2-servers.json" "$RUNROOT" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
ips = {s["name"]: (s.get("public_net") or {}).get("ipv4", {}).get("ip", "") for s in d.get("servers", [])}
want = ["app", "sfu", "ai", "master", "edge"]
out = {}
for role in want:
    hits = [ip for n, ip in ips.items() if n == f"audiomonastry-{role}-1"]
    out[role] = hits[0] if hits else ""
    print(f"  {role}-1: {out[role] or 'FEHLT'}")
open(f"{sys.argv[2]}/node-ips.json", "w").write(json.dumps(out, indent=2))
missing = [r for r, ip in out.items() if not ip]
sys.exit(1 if missing else 0)
PY
  APP_IP="$(python3 -c "import json;print(json.load(open('$RUNROOT/node-ips.json'))['app'])")"
  SFU_IP="$(python3 -c "import json;print(json.load(open('$RUNROOT/node-ips.json'))['sfu'])")"
  AI_IP="$(python3 -c "import json;print(json.load(open('$RUNROOT/node-ips.json'))['ai'])")"
  MASTER_IP="$(python3 -c "import json;print(json.load(open('$RUNROOT/node-ips.json'))['master'])")"
  EDGE_IP="$(python3 -c "import json;print(json.load(open('$RUNROOT/node-ips.json'))['edge'])")"
  export APP_IP SFU_IP AI_IP MASTER_IP EDGE_IP

  log "T2: DNS-Records für die Test-Subdomain setzen – A/DNS-only: origin.$DEPLOY_DOMAIN + sfu.$DEPLOY_DOMAIN; A/proxied: $DEPLOY_DOMAIN (öffentlicher Smoke-Host)"
  CLOUDFLARE_API_TOKEN="$CF_TOKEN" DOMAIN="$DNS_DOMAIN" \
  ORIGIN_HOST="origin.$DEPLOY_DOMAIN" SFU_HOST="sfu.$DEPLOY_DOMAIN" APP_HOST="$DEPLOY_DOMAIN" \
  SUBDOMAIN="$SUBDOMAIN" \
  SFU_IP="$SFU_IP" APP_IP="$APP_IP" \
    python3 scripts/hetzner/cf-dns-ensure.py --apply || { echo "DNS-Einrichtung FEHLGESCHLAGEN – Abbruch, keine Verwendung der Produktionsdomain."; return 1; }
  # Nachweis: der oeffentliche Smoke-Host muss in DNS existieren (der Smoke in
  # T2-Tail laeuft gegen https://$DEPLOY_DOMAIN). Ohne diesen Record lief T2
  # frueher in einen Zeituberschlag bei ensure-tls-terminator.sh.
  local app_host_ip
  app_host_ip="$(getent ahostsv4 "$DEPLOY_DOMAIN" 2>/dev/null | awk 'NR==1{print $1}')"
  echo "  DNS-Aufloesung $DEPLOY_DOMAIN -> ${app_host_ip:-<keine>}"

  log "T2: app-.env auf dem Knoten: AI_MODE=off erzwingen, kein RP_API_KEY"
  for ip in "$APP_IP" "$SFU_IP" "$AI_IP" "$MASTER_IP" "$EDGE_IP"; do
    log "  AI-OFF auf $ip sichern (env + ggf. recreate)"
    ssh_root "$ip" 'cd /opt/audiomonastry \
      && { grep -q "^AI_MODE=" .env && sed -i "s|^AI_MODE=.*|AI_MODE=off|" .env || printf "AI_MODE=off\n" >> .env; } \
      && sed -i "/^RP_API_KEY=/d" .env \
      && grep -q "^RP_API_KEY=" .env && exit 9 || true' || return 1
  done

  log "T2: TLS-Terminator gegen die Subdomain prüfen/herstellen"
  APP_IP="$APP_IP" DOMAIN="$DEPLOY_DOMAIN" bash scripts/hetzner/ensure-tls-terminator.sh || { echo "TLS-Terminator nicht gesund."; return 1; }

  log "T2: Knoten-.env (Supabase/R2) versorgen + Scrape-Token verdrahten"
  APP_IP="$APP_IP" QUELLE="$REPO/.env" bash scripts/hetzner/push-node-env.sh || echo "WARN: push-node-env meldete Lücken (Details oben; Persistenz ggf. degraded – T4 zeigt es)."
  ssh_root "$APP_IP" 'cd /opt/audiomonastry && bash scripts/hetzner/wire-scrape-token.sh app' || echo "WARN: scrape-token app"
  ssh_root "$EDGE_IP" "ssh -o StrictHostKeyChecking=no root@$APP_IP \"grep '^SCRAPE_TOKEN=' /opt/audiomonastry/.env\" | bash /opt/audiomonastry/scripts/hetzner/wire-scrape-token.sh edge" || echo "WARN: scrape-token edge"

  log "T2: Gates – Medienports + Fleet-Status"
  ssh_root "$SFU_IP" 'bash /opt/audiomonastry/scripts/hetzner/check-media-ports.sh' || { echo "Medienports auf sfu-1 blockiert."; return 1; }
  bash scripts/hetzner/fleet-status.sh | tee "$RUNROOT/t2-fleet-status.txt"

  log "T2: Smoke-Test gegen https://$DEPLOY_DOMAIN"
  BASE_URL="https://$DEPLOY_DOMAIN" bash scripts/hetzner/smoke-test.sh "https://$DEPLOY_DOMAIN" || return 1
  echo "https://$DEPLOY_DOMAIN" > "$RUNROOT/base-url.txt"
}

# =============================================================================
# T3 – Infra-Tiefe: Monitoring, Timer, Security-Negativ, AI-OFF-Env-Nachweis
# =============================================================================
t3() {
  APP_IP="$(python3 -c "import json;print(json.load(open('$RUNROOT/node-ips.json'))['app'])")"
  SFU_IP="$(python3 -c "import json;print(json.load(open('$RUNROOT/node-ips.json'))['sfu'])")"
  AI_IP="$(python3 -c "import json;print(json.load(open('$RUNROOT/node-ips.json'))['ai'])")"
  MASTER_IP="$(python3 -c "import json;print(json.load(open('$RUNROOT/node-ips.json'))['master'])")"
  EDGE_IP="$(python3 -c "import json;print(json.load(open('$RUNROOT/node-ips.json'))['edge'])")"

  log "T3: Prometheus-Targets auf edge-1 (127.0.0.1:9090)"
  ssh_root "$EDGE_IP" 'wget -qO- http://127.0.0.1:9090/-/ready && echo && wget -qO- http://127.0.0.1:9090/api/v1/targets | head -c 4000' \
    | tee "$RUNROOT/t3-prometheus-targets.txt" || return 1
  grep -q '"health":"up"' "$RUNROOT/t3-prometheus-targets.txt" || { echo "Prometheus-Targets nicht alle up"; return 1; }

  log "T3: Grafana reachable (127.0.0.1:3000)"
  ssh_root "$EDGE_IP" 'wget -qO- http://127.0.0.1:3000/api/health' | tee "$RUNROOT/t3-grafana.txt" || return 1

  log "T3: Idle-Shutdown- + Backup-Timer aktiv (Kostenbremse, Plan T3-Pflicht)"
  local timers_ok=1
  for ip in "$APP_IP" "$SFU_IP" "$AI_IP" "$MASTER_IP" "$EDGE_IP"; do
    ssh_root "$ip" 'systemctl is-active audiomonastry-idle-shutdown.timer' || timers_ok=0
  done
  ssh_root "$APP_IP" 'systemctl is-active audiomonastry-backup.timer 2>/dev/null || systemctl list-timers --no-pager | grep -i backup' || { echo "Backup-Timer auf app-1 fehlt"; timers_ok=0; }
  [[ $timers_ok = 1 ]] || { echo "Nicht alle Timer aktiv"; return 1; }

  log "T3: Security-Negativ vom Client (Studio-Gate fail-closed von außen)"
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' "https://$DEPLOY_DOMAIN/api/session/reset")"
  echo "  /api/session/reset ohne Token: HTTP $code"
  [[ "$code" = "401" || "$code" = "403" || "$code" = "404" || "$code" = "405" ]] || { echo "Studio-Gate von außen nicht fail-closed (HTTP $code)"; return 1; }
  code="$(curl -s -o /dev/null -w '%{http_code}' "https://$DEPLOY_DOMAIN/api/health")"
  [[ "$code" = "200" ]] || { echo "/api/health nicht 200 von außen (HTTP $code)"; return 1; }

  log "T3: Portcheck von außen – offen: 80/443 (+ICMP); zu: 3000/9090/8080/5432/11434"
  local pbad=0
  for p in 3000 9090 8080 5432 11434; do
    if timeout 6 bash -c "</dev/tcp/$APP_IP/$p" 2>/dev/null; then echo "  APP-PORT $p OFFEN (soll zu)"; pbad=1; fi
    if timeout 6 bash -c "</dev/tcp/$EDGE_IP/$p" 2>/dev/null && [ "$p" != 3000 ] && [ "$p" != 9090 ]; then :; fi
  done
  for p in 3000 9090; do
    timeout 6 bash -c "</dev/tcp/$EDGE_IP/$p" 2>/dev/null && { echo "  EDGE-PORT $p OFFEN (soll zu – Grafana/Prometheus nur lokal)"; pbad=1; }
  done
  [[ $pbad = 0 ]] || { echo "Portcheck rot"; return 1; }

  log "T3: AI-OFF-Env-Nachweis auf ALLEN Knoten (AI_MODE=off, kein RP_API_KEY)"
  for ip in "$APP_IP" "$SFU_IP" "$AI_IP" "$MASTER_IP" "$EDGE_IP"; do
    local out
    out="$(ssh_root "$ip" 'grep -c "^AI_MODE=off$" /opt/audiomonastry/.env; grep -c "^RP_API_KEY=" /opt/audiomonastry/.env || true')"
    echo "  $ip: AI_MODE=off Zeilen: $(echo "$out" | sed -n 1p), RP_API_KEY Zeilen: $(echo "$out" | sed -n 2p)"
    [[ "$(echo "$out" | sed -n 1p)" = "1" && "$(echo "$out" | sed -n 2p)" = "0" ]] || { echo "AI-OFF-Env verletzt auf $ip"; return 1; }
  done

  log "T3: conntrack/ip route Vorab-Probe auf ai-1 (Basis für T4-Differenz)"
  ssh_root "$AI_IP" 'ip route get 1.1.1.1; conntrack -C 2>/dev/null || cat /proc/sys/net/netfilter/nf_conntrack_count' \
    | tee "$RUNROOT/t3-ai1-baseline.txt" || true
}

# =============================================================================
# T4 – Playwright GEGEN DIE HETZNER-INSTANZ + Observability + AI-OFF-Netzprobe
# =============================================================================
t4() {
  local BASE_URL="https://$DEPLOY_DOMAIN"  # lokal lesbar, keine Zuweisung nach außen
  APP_IP="$(python3 -c "import json;print(json.load(open('$RUNROOT/node-ips.json'))['app'])")"
  SFU_IP="$(python3 -c "import json;print(json.load(open('$RUNROOT/node-ips.json'))['sfu'])")"
  AI_IP="$(python3 -c "import json;print(json.load(open('$RUNROOT/node-ips.json'))['ai'])")"
  MASTER_IP="$(python3 -c "import json;print(json.load(open('$RUNROOT/node-ips.json'))['master'])")"
  EDGE_IP="$(python3 -c "import json;print(json.load(open('$RUNROOT/node-ips.json'))['edge'])")"

  log "T4: Netz-Probe auf ai-1 scharf schalten (tcpdump, Fallback: ss/conntrack-Sampler)"
  if ssh_root "$AI_IP" 'command -v tcpdump >/dev/null && systemd-run --unit=deeptest-ai-probe --collect tcpdump -i any -n -U -w /tmp/deeptest-ai-probe.pcap not tcp port 22' 2>/dev/null; then
    echo "tcpdump-Probe via systemd-run aktiv" | tee "$RUNROOT/t4-ai-probe-mode.txt"
    PROBE=pcap
  else
    ( for i in $(seq 1 60); do
        ssh_root "$AI_IP" 'ss -tunap 2>/dev/null | grep -v ":22 " ; echo "---"' >> "$RUNROOT/t4-ai1-ss-samples.log" 2>/dev/null
        sleep 30
      done ) &
    SAMPLER_PID=$!
    echo "ss/conntrack-Sampler aktiv (PID $SAMPLER_PID)" | tee "$RUNROOT/t4-ai-probe-mode.txt"
    PROBE=ss
  fi

  log "T4: Playwright-Suite gegen $BASE_URL (trace+video+screenshot, JSON+JUnit)"
  local junit="$PWOUT/hetzner/junit.xml" sha_before sha_after ev_rc=0
  # FRISCHE-BEWEIS (wie T1): alten Report vor dem Lauf entfernen, sonst ist ein
  # Report aus einem Vorlauf/verwaisten Prozess nicht unterscheidbar.
  rm -f "$junit" "$junit.summary" "$PWOUT/hetzner/report.json"
  ( cd "$REPO" && \
    NODE_ENV=test E2E_BASE_URL="$BASE_URL" STUDIO_ACCESS_TOKEN="$STUDIO_ACCESS_TOKEN" \
    AI_OFF_PROOF=1 \
    DEEPTEST_RUN=1 V2_LIVE_SKIP="$V2_LIVE_SKIP" PWOUTPUT="$PWOUT/hetzner" \
    PWREPORTERS="[[\"list\"],[\"json\",{\"outputFile\":\"$PWOUT/hetzner/report.json\"}],[\"junit\",{\"outputFile\":\"$PWOUT/hetzner/junit.xml\"}]]" \
    npx playwright test --output="$PWOUT/hetzner" )
  local PW_RC=$?
  [[ -n "${SAMPLER_PID:-}" ]] && kill "$SAMPLER_PID" 2>/dev/null
  # Sampler-Prozessgruppe (set -m) mitnehmen, sonst laeuft sie in T5 hinein.
  [[ -n "${SAMPLER_PID:-}" ]] && phase_group_kill "$SAMPLER_PID" TERM
  echo "T4 Playwright rc=$PW_RC" | tee "$RUNROOT/t4-rc.txt"

  log "T4: AI-OFF-Netzprobe auswerten"
  if [[ "${PROBE:-ss}" = "pcap" ]]; then
    ssh_root "$AI_IP" 'systemctl stop deeptest-ai-probe.service 2>/dev/null; tcpdump -nn -r /tmp/deeptest-ai-probe.pcap 2>/dev/null | awk "{print \$3, \$5}" | grep -oE "\>[0-9.]+\." | sort -u | head -40; echo "PCAP_LINES=$(tcpdump -nn -r /tmp/deeptest-ai-probe.pcap 2>/dev/null | wc -l)"' \
      | tee "$RUNROOT/t4-ai1-remote-dsts.txt"
    ssh_root "$AI_IP" 'rm -f /tmp/deeptest-ai-probe.pcap'
  else
    tail -40 "$RUNROOT/t4-ai1-ss-samples.log" || true
  fi
  ssh_root "$AI_IP" 'ss -tunp 2>/dev/null | grep -v ":22 " | grep -vE "127.0.0.1|::1" | head -20; echo "conntrack_count=$(cat /proc/sys/net/netfilter/nf_conntrack_count 2>/dev/null)"' \
    | tee "$RUNROOT/t4-ai1-final-flows.txt" || true

  log "T4: Server-Exzerpte einsammeln (app/master/sfu/edge: docker-Logfehler + journal err + Targets + fleet-status)"
  {
    echo "=== $(date -u +%FT%TZ) Server-Exzerpte (45 min Fenster) ==="
    for ip in "$APP_IP" "$MASTER_IP" "$SFU_IP" "$EDGE_IP" "$AI_IP"; do
      echo; echo "---- $ip: docker errors (45m) ----"
      ssh_root "$ip" 'docker ps --format "{{.Names}}" | while read -r c; do echo "## $c"; docker logs --since 45m "$c" 2>&1 | grep -iE "\[error\]|fatal|unhandled|exception" | tail -15; done' 2>/dev/null || echo "(ssh/logs nicht lesbar)"
      echo; echo "---- $ip: journalctl -p err (letzte 30) ----"
      ssh_root "$ip" 'journalctl -p err -n 30 --no-pager 2>/dev/null | tail -30' || true
    done
    echo; echo "---- Prometheus-Targets-Snapshot ----"
    ssh_root "$EDGE_IP" 'wget -qO- http://127.0.0.1:9090/api/v1/targets' 2>/dev/null | head -c 6000 || true
    echo; echo "---- fleet-status.sh ----"
    bash scripts/hetzner/fleet-status.sh 2>/dev/null || true
  } > "$RUNROOT/server-logs-$TS.txt" 2>&1
  grep -c '' "$RUNROOT/server-logs-$TS.txt" >/dev/null && echo "  Server-Exzerpte: $RUNROOT/server-logs-$TS.txt ($(wc -l < "$RUNROOT/server-logs-$TS.txt") Zeilen)"

  log "T4: JUnit-Ergebnis bewerten"
  sha_before="$(sha256sum "$junit" 2>/dev/null | cut -d' ' -f1)"
  junit_guard "$junit" "${PHASE_START_EPOCH:-$(date +%s)}" || ev_rc=1
  python3 - "$junit" <<'PY' || ev_rc=1
import sys, xml.etree.ElementTree as ET
t = ET.parse(sys.argv[1]); r = t.getroot()
n = f = s = 0; failed = []
for c in r.iter("testcase"):
    n += 1
    if c.find("failure") is not None or c.find("error") is not None:
        f += 1; failed.append((c.get("classname", "") + "." + c.get("name", "")))
    elif c.find("skipped") is not None:
        s += 1
print(f"T4-HETZNER: {n} Tests, {n-f-s} grün, {f} rot, {s} skipped")
for x in failed: print("  ROT:", x)
open(f"{sys.argv[1]}.summary", "w").write(f"total={n} failed={f} skipped={s}\n")
for x in failed: open(f"{sys.argv[1]}.summary", "a").write(f"RED {x}\n")
sys.exit(1 if f else 0)
PY
  if [[ $PW_RC -ne 0 ]]; then
    echo "T4: Playwright-Prozess meldete rc=$PW_RC – Exitcode wird nicht verschluckt."
    ev_rc=1
  fi
  sha_after="$(sha256sum "$junit" 2>/dev/null | cut -d' ' -f1)"
  if [[ -n "$sha_before" && "$sha_before" != "$sha_after" ]]; then
    echo "T4: JUnit wurde WÄHREND der Bewertung verändert ($sha_before -> $sha_after) – verwaister Schreiber, Ergebnis nicht belastbar."
    ev_rc=1
  fi
  # Plan: alle NICHT-@ai-Specs müssen grün sein; rote Specs beenden die Phase.
  return $ev_rc
}

# =============================================================================
# T5 – Report + SSOT-Hinweis (lifecycle stop macht der Trap IMMER)
# =============================================================================
t5() {
  local BASE_URL; BASE_URL="$(cat "$RUNROOT/base-url.txt" 2>/dev/null || echo "https://$DEPLOY_DOMAIN")"
  local junit="$PWOUT/hetzner/junit.xml"
  local summary="kein JUnit gefunden (T4 nicht erreicht oder Playwright-Start fehlgeschlagen)"
  [[ -f "$junit" ]] && summary="$(cat "$junit.summary" 2>/dev/null || echo "$summary")"
  local t1s="kein T1-Lauf"; [[ -f "$PWOUT/local/junit.xml.summary" ]] && t1s="$(cat "$PWOUT/local/junit.xml.summary")"
  {
    echo "# DEEP-TEST-REPORT $TS (Hetzner-only, docs/DEEP-TEST-PLAN.md)"
    echo
    echo "- **Git-Deploy-SHA:** $GIT_SHA"
    echo "- **Test-Subdomain:** $BASE_URL (Produktionsdomain anunnakitools.de unberührt)"
    echo "- **Flotte:** 5 Knoten (app/sfu/ai/master/edge, cx23, Snapshots 2026-09-25) – nach dem Lauf via lifecycle.sh stop wieder gelöscht (Snapshots verbleiben)"
    echo "- **AI-OFF-Nachweis:** AI_MODE=off auf allen 5 Knoten (T3-Env-Check), Negativ-Suite (tests/e2e/aiNegative.spec.ts): /api/ai/* mit Token → 503 AI_DISABLED, ohne Token → fail-closed; Netzprobe auf ai-1 während der Suite: $(cat "$RUNROOT/t4-ai-probe-mode.txt" 2>/dev/null || echo 'n/a') – Auswertung t4-ai1-*.txt, keine RunPod-Ziele"
    echo "- **Kosten-Schätzung:** $(cat "$RUNROOT/t0-cost.txt" 2>/dev/null || echo "Fallback-Satz: 5×$COST_EUR_H_FALLBACK EUR/h") · tatsächlich abgerechnet: Stunden der 5 Knoten bis lifecycle stop"
    echo "- **T1 lokal (Trockenlauf):** $t1s"
    echo "- **T4 Hetzner (JUnit):** $summary"
    echo "- **Artefakte:** Traces/Videos/Screenshots: test-results/e2e-hetzner/$TS/ · Logs+progress.json: $RUNROOT"
    echo
    echo "## Phasen"
    python3 - "$PROGRESS" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
for p in doc.get("phases", []):
    print(f"- {p['phase']}: {p['status']} · {p['duration_min']} min · {p.get('cost_estimate_eur','-')} · {p.get('note','')}")
PY
    echo
    echo "## Server-Exzerpte (Auszug, vollständige Datei im RUNROOT)"
    grep -A6 "^---- .*docker errors" "$RUNROOT/server-logs-$TS.txt" 2>/dev/null | head -60 || echo "(keine Exzerpte)"
  } > "docs/DEEPTEST-REPORT-$TS.md"
  log "T5: Report geschrieben: docs/DEEPTEST-REPORT-$TS.md"
  git add "docs/DEEPTEST-REPORT-$TS.md" 2>/dev/null || true
  git commit -m "test(hetzner): Deep-Test-Report $TS (autonomer Lauf, Hetzner-only, AI off)" --only "docs/DEEPTEST-REPORT-$TS.md" 2>/dev/null \
    && log "T5: Report committet ($(git rev-parse --short HEAD))" || log "T5: Commit übersprungen (nichts zu committen oder Fremdänderungen)"
  log "T5: lifecycle.sh stop über den EXIT-Trap (Snapshot je Knoten, dann Löschen → 0 €/h)."
}

# =============================================================================
# Ablaufsteuerung
# =============================================================================
declare -A ORDER=( [T0]=t0 [T1]=t1 [T2]=t2 [T3]=t3 [T4]=t4 [T5]=t5 )
SEEN=0
for p in T0 T1 T2 T3 T4 T5; do
  if [[ "$p" == "$FROM" ]]; then SEEN=1; fi
  [[ $SEEN = 1 ]] || continue
  if run_phase "$p" "${ORDER[$p]}"; then
    if [[ -n "$STOP_AFTER" && "$p" == "$STOP_AFTER" ]]; then
      if [[ -f "$RUNROOT/.fleet-up" ]]; then
        log "Stopp nach $p gewünscht (--stop-after) – Flotte läuft, lifecycle stop folgt."
        bash scripts/hetzner/lifecycle.sh stop || true
      else
        log "Stopp nach $p gewünscht (--stop-after) – keine Flotte, kein Stop nötig."
      fi
      exit 0
    fi
  else
    exit 1   # Trap macht lifecycle stop (solange $RUNROOT/.fleet-up existiert)
  fi
done
log "✅ Deep-Test-Lauf abgeschlossen. Report: docs/DEEPTEST-REPORT-$TS.md · RUNROOT: $RUNROOT"
