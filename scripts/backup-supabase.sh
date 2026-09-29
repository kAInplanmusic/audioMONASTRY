#!/usr/bin/env bash
# audioMONASTRY – Supabase-Datenbank-Backup (logisch, offsite)
# =============================================================================
# WARUM: Die Supabase-DB traegt den echten Zustand (Prompts, Sample-Metadaten,
# Musik-Tracks, AI-Logs). Sie hatte NULL Backups. Die 6,3 GB Audio liegen in
# Cloudflare R2 (separater Pfad), das App-Bundle-Backup deckt nur dist/+public/.
#
# WAS: pg_dump (Schema+ Daten des/der konfigurierten Schemas) -> gzip -> offsite
# auf den S3-kompatiblen Backup-Speicher (BACKUP_S3_* -> HOS_S3_* -> CFS3_*),
# via scripts/r2-backup.mjs. Lokale und entfernte Retention.
#
# SECRET: NICHT im Repo, NICHT im Chat. Quelle (erste vollstaendige gewinnt):
#   1) Umgebung  SUPABASE_DB_URL  (vollstaendige DSN)
#      oder       SUPABASE_DB_PASSWORD (+ SUPABASE_DB_HOST/PORT/NAME/USER)
#   2) ~/.config/monk/keys.env  (chmod 600) mit denselben Variablen
#
# Aufruf:  bash scripts/backup-supabase.sh [--dry-run] [--keep-local N] [--keep-remote N]
# Exit: 0 ok · 1 Vorbedingung fehlt · 2 pg_dump-Fehler · 3 Upload-Fehler
# =============================================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

DRY=0
KEEP_LOCAL="${KEEP_LOCAL:-7}"
KEEP_REMOTE="${KEEP_REMOTE:-14}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --keep-local) KEEP_LOCAL="${2:?}"; shift 2 ;;
    --keep-remote) KEEP_REMOTE="${2:?}"; shift 2 ;;
    *) echo "[db-backup] unbekanntes Argument: $1" >&2; exit 1 ;;
  esac
done

log() { echo "[db-backup $(date -Is)] $*"; }
loud_fail() { echo "[db-backup FEHLER] $*" >&2; exit "${2:-1}"; }

# --- 1) Secret laden (env gewinnt, sonst keys.env) --------------------------
if [[ -z "${SUPABASE_DB_URL:-}" && -z "${SUPABASE_DB_PASSWORD:-}" ]]; then
  KEYS="$HOME/.config/monk/keys.env"
  if [[ -f "$KEYS" ]]; then
    # shellcheck disable=SC1090
    set -a; . "$KEYS"; set +a
  fi
fi

DB_HOST="${SUPABASE_DB_HOST:-db.pwtwtqbcynsjtkxlkrwh.supabase.co}"
DB_PORT="${SUPABASE_DB_PORT:-5432}"
DB_NAME="${SUPABASE_DB_NAME:-postgres}"
DB_USER="${SUPABASE_DB_USER:-postgres}"

if [[ -n "${SUPABASE_DB_URL:-}" ]]; then
  CONN="$SUPABASE_DB_URL"
else
  [[ -n "${SUPABASE_DB_PASSWORD:-}" ]] || loud_fail \
    "Kein DB-Secret. Bitte in ~/.config/monk/keys.env hinterlegen: SUPABASE_DB_URL=postgresql://postgres:PASSWORT@$DB_HOST:$DB_PORT/$DB_NAME (Datei chmod 600)."
  CONN="postgresql://${DB_USER}:${SUPABASE_DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
fi

# Passwort nie auf der Kommandozeile zeigen: DSN an pg_dump uebergeben, aber
# in Logs ausschliesslich maskiert ausgeben.
MASKED="$(printf '%s' "$CONN" | sed -E 's#://([^:]+):[^@]+@#://\1:***@#')"
SCHEMAS="${SUPABASE_DB_SCHEMAS:-public}"
DRIVER="${SUPABASE_DUMP_DRIVER:-auto}"   # auto | local | docker

# --- 2) Dump-Treiber waehlen -------------------------------------------------
have_local() { command -v pg_dump >/dev/null 2>&1; }
have_docker() { command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; }

if [[ "$DRIVER" == "auto" ]]; then
  if have_local; then DRIVER=local; elif have_docker; then DRIVER=docker; else
    loud_fail "Weder pg_dump noch docker vorhanden – Dump nicht möglich."; fi
fi

# --- 3) Dump -----------------------------------------------------------------
STAMP="$(date +%Y%m%d_%H%M%S)"
OUT_DIR="${BACKUP_DIR:-$HOME/backups/supabase}"
mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/audiomonastry_db_${STAMP}.sql.gz"

declare -a SCHEMA_ARGS=()
IFS=',' read -r -a _schemas <<< "$SCHEMAS"
for s in "${_schemas[@]}"; do SCHEMA_ARGS+=(--schema "$s"); done

log "Dump startet: $MASKED (Schemas: $SCHEMAS, Treiber: $DRIVER) -> $OUT"
if [[ "$DRY" == "1" ]]; then
  log "Trockenlauf: keine Datei geschrieben."
  exit 0
fi

set +e
if [[ "$DRIVER" == "local" ]]; then
  pg_dump "$CONN" --no-owner --no-privileges --clean --if-exists "${SCHEMA_ARGS[@]}" \
    | gzip -9 > "$OUT"
  rc=${PIPESTATUS[0]}
else
  docker run --rm --network=host -e PGCONNECT_TIMEOUT=20 \
    postgres:16-alpine \
    pg_dump "$CONN" --no-owner --no-privileges --clean --if-exists "${SCHEMA_ARGS[@]}" \
    | gzip -9 > "$OUT"
  rc=${PIPESTATUS[0]}
fi
set -e

if [[ $rc -ne 0 || ! -s "$OUT" ]]; then
  rm -f "$OUT"
  loud_fail "pg_dump fehlgeschlagen (rc=$rc). Nichts hochgeladen." 2
fi

# Plausibilitaet: ein gueltiger Dump nennt PostgreSQL und enthaelt CREATE TABLE
if ! gzip -dc "$OUT" | head -40 | grep -q "PostgreSQL database dump"; then
  loud_fail "Dump sieht unplausibel aus (kein pg_dump-Header): $OUT" 2
fi
SIZE="$(stat -c%s "$OUT")"
TABLES="$(gzip -dc "$OUT" | grep -c '^CREATE TABLE' || true)"
log "Dump fertig: $(printf '%.1f' "$(echo "$SIZE/1048576" | bc -l)") MB · $TABLES CREATE TABLE"

# --- 4) Offsite-Upload ------------------------------------------------------
REMOTE_KEY="db/$(basename "$OUT")"
if ! node scripts/r2-backup.mjs upload "$OUT" "$REMOTE_KEY"; then
  loud_fail "Offsite-Upload fehlgeschlagen ($REMOTE_KEY). Lokale Kopie bleibt: $OUT" 3
fi
log "Offsite ok: $REMOTE_KEY"

# --- 5) Retention -----------------------------------------------------------
find "$OUT_DIR" -name 'audiomonastry_db_*.sql.gz' -mtime "+$KEEP_LOCAL" -delete 2>/dev/null || true

if [[ "$KEEP_REMOTE" =~ ^[0-9]+$ && "$KEEP_REMOTE" -gt 0 ]]; then
  mapfile -t REMOTE_KEYS < <(node scripts/r2-backup.mjs list db/ | awk '/^  db\/audiomonastry_db_.*\.sql\.gz/ {print $1}' | sort)
  TOTAL="${#REMOTE_KEYS[@]}"
  if (( TOTAL > KEEP_REMOTE )); then
    for k in "${REMOTE_KEYS[@]:0:$((TOTAL - KEEP_REMOTE))}"; do
      node scripts/r2-backup.mjs delete "$k" >/dev/null && log "Remote-Retention: entfernt $k"
    done
  fi
  log "Remote-Dumps: $TOTAL (behalten werden $KEEP_REMOTE)"
fi

log "FERTIG."
