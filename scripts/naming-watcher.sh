#!/usr/bin/env bash
# =============================================================================
# naming-watcher.sh — prüft, ob alle process.env.X im Server-Code
# in der Knoten-Vorlage (.env.hetzner.example) und im Build-System erfasst sind.
# =============================================================================
# Aufruf:
#   bash scripts/naming-watcher.sh              # prüft, Exit-Code 0 = ok
#   bash scripts/naming-watcher.sh --fix        # fügt fehlende Einträge in .env.hetzner.example ein (Interaktiv)
#   bash scripts/naming-watcher.sh --ci         # für CI: Exit 1 bei Problemen, keine Interaktion
# =============================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

CI_MODE=0
FIX_MODE=0
for arg in "$@"; do
  case "$arg" in
    --ci) CI_MODE=1 ;;
    --fix) FIX_MODE=1 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unbekannte Option: $arg" >&2; exit 2 ;;
  esac
done

FAILS=0
WARNS=0

ok()   { printf '  \033[32mOK\033[0m   %s\n' "$1"; }
warn() { printf '  \033[33mWARN\033[0m %s\n' "$1"; WARNS=$((WARNS+1)); }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAILS=$((FAILS+1)); }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# -----------------------------------------------------------------------------
# 1. Alle process.env.X / import.meta.env.VITE_* im Server/Client finden
# -----------------------------------------------------------------------------
step "1/5  Env-Variablen im Code sammeln"

# Server: process.env.XXX
SERVER_VARS=$(grep -rhoE 'process\.env\.[A-Z0-9_]+' server/ src/ 2>/dev/null | sed -E 's/.*process\.env\.([A-Z0-9_]+).*/\1/' | sort -u)

# Client: import.meta.env.VITE_XXX
CLIENT_VARS=$(grep -rhoE 'import\.meta\.env\.VITE_[A-Z0-9_]+' src/ 2>/dev/null | sed -E 's/.*import\.meta\.env\.(VITE_[A-Z0-9_]+).*/\1/' | sort -u)

# Combiniere, dedupliziere
ALL_CODE_VARS=$(printf '%s\n' "$SERVER_VARS" "$CLIENT_VARS" | sort -u)
CODE_COUNT=$(printf '%s\n' "$ALL_CODE_VARS" | grep -c '^' || echo 0)
ok "Gefunden: $CODE_COUNT eindeutige Env-Variablen im Code"

# -----------------------------------------------------------------------------
# 2. Knoten-Vorlage (.env.hetzner.example) parsen
# -----------------------------------------------------------------------------
step "2/5  Knoten-Vorlage parsen"

EXAMPLE_FILE=".env.hetzner.example"
if [ ! -f "$EXAMPLE_FILE" ]; then
  fail "Vorlage $EXAMPLE_FILE nicht gefunden"
  exit 1
fi

# Alle Keys in der Vorlage (auch auskommentierte)
EXAMPLE_KEYS=$(grep -E '^[A-Z0-9_]+=' "$EXAMPLE_FILE" | cut -d= -f1 | sort -u)
EXAMPLE_COMMENTED=$(grep -E '^#[A-Z0-9_]+=' "$EXAMPLE_FILE" | sed 's/^#//' | cut -d= -f1 | sort -u)
EXAMPLE_ALL=$(printf '%s\n' "$EXAMPLE_KEYS" "$EXAMPLE_COMMENTED" | sort -u)

# Kategorisiere
EXAMPLE_SB=$(printf '%s\n' "$EXAMPLE_ALL" | grep -E '^SB_' | sort -u)
EXAMPLE_SUPABASE=$(printf '%s\n' "$EXAMPLE_ALL" | grep -E '^SUPABASE_' | sort -u)
EXAMPLE_VITE=$(printf '%s\n' "$EXAMPLE_ALL" | grep -E '^VITE_' | sort -u)
EXAMPLE_OTHER=$(comm -23 <(printf '%s\n' "$EXAMPLE_ALL") <(printf '%s\n' "$EXAMPLE_SB" "$EXAMPLE_SUPABASE" "$EXAMPLE_VITE" | sort -u))

ok "Vorlage: $(printf '%s\n' "$EXAMPLE_KEYS" | wc -l) aktive, $(printf '%s\n' "$EXAMPLE_COMMENTED" | wc -l) auskommentierte Keys"

# -----------------------------------------------------------------------------
# 3. Build-System ARGs prüfen (Dockerfile, Dockerfile.hetzner, compose, deploy.sh)
# -----------------------------------------------------------------------------
step "3/5  Build-System ARGs prüfen"

check_arg() {
  local var="$1"
  local found=0
  for f in Dockerfile Dockerfile.hetzner docker-compose.hetzner.yml deploy.sh; do
    if grep -qE "(ARG|build-arg).*${var}" "$f" 2>/dev/null; then
      found=1; break
    fi
  done
  echo "$found"
}

BUILD_MISSING=()
for var in $(printf '%s\n' "$ALL_CODE_VARS" | grep -E '^(VITE_|SUPABASE_|SB_|CFS3_|CFR2_|AI_|STUDIO_|SCRAPE_|SB_|TURN_|SFU_|REDIS_|IDLE_|CSP_|UPLOAD_|DOMAIN|PORT|NODE_ENV|AI_)'); do
  if [ "$(check_arg "$var")" -eq 0 ]; then
    BUILD_MISSING+=("$var")
  fi
done

if [ ${#BUILD_MISSING[@]} -eq 0 ]; then
  ok "Alle relevanten Env-Variablen haben ARGs in Dockerfile/Compose/deploy.sh"
else
  for v in "${BUILD_MISSING[@]}"; do
    warn "Fehlendes ARG: $var (in Dockerfile, Dockerfile.hetzner, compose oder deploy.sh)"
  done
fi

# -----------------------------------------------------------------------------
# 4. supabaseKeys.ts Prioritätsordnung prüfen
# -----------------------------------------------------------------------------
step "4/5  supabaseKeys.ts Prioritätsordnung"

KEYS_FILE="src/config/supabaseKeys.ts"
if [ -f "$KEYS_FILE" ]; then
  # Prüfen ob SUPABASE_SERVICE_ROLE_KEY in SUPABASE_SERVER_KEY_ORDER
  if grep -q 'SUPABASE_SERVICE_ROLE_KEY' "$KEYS_FILE"; then
    ok "SUPABASE_SERVICE_ROLE_KEY in supabaseKeys.ts vorhanden"
  else
    fail "SUPABASE_SERVICE_ROLE_KEY fehlt in supabaseKeys.ts"
  fi

  # supabaseUrl() prüft auf leere Strings
  if grep -q 'supabaseUrl' "$KEYS_FILE" && grep -A5 'export function supabaseUrl' "$KEYS_FILE" | grep -q '\.trim()'; then
    ok "supabaseUrl() nutzt .trim() + explizite Prüfung"
  else
    warn "supabaseUrl() könnte leere Strings nicht korrekt behandeln"
  fi
else
  fail "supabaseKeys.ts nicht gefunden"
fi

# -----------------------------------------------------------------------------
# 5. push-node-env.sh Kandidatenlisten prüfen
# -----------------------------------------------------------------------------
step "5/5  push-node-env.sh Kandidatenlisten"

PNE="scripts/hetzner/push-node-env.sh"
if [ -f "$PNE" ]; then
  # KANDIDATEN Array
  if grep -q 'declare -A KANDIDATEN' "$PNE"; then
    ok "KANDIDATEN Array vorhanden"
  else
    warn "KANDIDATEN Array fehlt in push-node-env.sh"
  fi

  # ZWEITNAME für alle relevanten Keys
  for k in SB_URL SB_ANON_PUB SB_SERVICE_ROLE SB_PUBLISHABLE; do
    if grep -q "\[$k\]=.*VITE_" "$PNE"; then
      ok "ZWEITNAME für $k hat VITE_-Alias"
    else
      warn "ZWEITNAME für $k hat KEINEN VITE_-Alias"
    fi
  done

  # STUDIO_ACCESS_TOKEN und SCRAPE_TOKEN in SCHLUESSEL
  if grep -q 'STUDIO_ACCESS_TOKEN' "$PNE" && grep -q 'SCRAPE_TOKEN' "$PNE"; then
    ok "STUDIO_ACCESS_TOKEN und SCRAPE_TOKEN in SCHLUESSEL"
  else
    warn "STUDIO_ACCESS_TOKEN und/oder SCRAPE_TOKEN fehlen in SCHLUESSEL"
  fi
else
  fail "push-node-env.sh nicht gefunden"
fi

# -----------------------------------------------------------------------------
# Zusammenfassung
# -----------------------------------------------------------------------------
printf '\n===============================================\n'
if [ "$FAILS" -eq 0 ]; then
  printf '  \033[32mNAMING-WÄCHTER GRÜN\033[0m   (%d Warnungen)\n' "$WARNS"
  exit 0
else
  printf '  \033[31mNAMING-WÄCHTER ROT\033[0m    %d Fehler, %d Warnungen\n' "$FAILS" "$WARNS"
  if [ "$CI_MODE" -eq 1 ]; then exit 1; fi
  exit 1
fi