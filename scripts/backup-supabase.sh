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
  # DSN in Einzelteile zerlegen (per Python, damit Sonderzeichen in Passwoertern
  # korrekt entschluesselt werden) – das Passwort wird danach NUR ueber
  # PGPASSWORD uebergeben und erscheint nie in der Prozessliste/`ps`/`docker inspect`.
  read -r DB_USER DB_PASSWORD DB_HOST DB_PORT DB_NAME < <(python3 - "$SUPABASE_DB_URL" <<'PY'
import sys, urllib.parse as up
u = up.urlsplit(sys.argv[1])
print(u.username or "postgres", up.unquote(u.password or ""), u.hostname or "",
      u.port or 5432, (u.path or "/postgres").lstrip("/"))
PY
)
  DB_USER="${DB_USER:-$DB_USER_OVERRIDE}"
  DB_PASSWORD="${DB_PASSWORD:?DSN ohne Passwort}"
  DB_HOST="${DB_HOST:-db.pwtwtqbcynsjtkxlkrwh.supabase.co}"
  DB_NAME="${DB_NAME:-postgres}"
elif [[ -n "${SUPABASE_DB_PASSWORD:-}" ]]; then
  DB_PASSWORD="$SUPABASE_DB_PASSWORD"
else
  loud_fail "Kein DB-Secret. Bitte in ~/.config/monk/keys.env hinterlegen: SUPABASE_DB_URL=postgresql://postgres:PASSWORT@$DB_HOST:$DB_PORT/$DB_NAME (Datei chmod 600)."
fi

export PGPASSWORD="$DB_PASSWORD"

# Passwort nie auf der Kommandozeile zeigen: DSN an pg_dump uebergeben, aber
# in Logs ausschliesslich maskiert ausgeben.
MASKED="postgresql://${DB_USER}:***@${DB_HOST}:${DB_PORT}/${DB_NAME}"
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
ERRLOG="$(mktemp)"
IMG_CACHE="$HOME/.cache/monk/supabase-dump-image"
run_docker_dump() {  # $1 = Image
  docker run --rm --network=host -e PGPASSWORD -e PGCONNECT_TIMEOUT=20 "$1" \
    pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
    --no-owner --no-privileges --clean --if-exists "${SCHEMA_ARGS[@]}"
}

if [[ "$DRIVER" == "local" ]]; then
  pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
    --no-owner --no-privileges --clean --if-exists "${SCHEMA_ARGS[@]}" \
    | gzip -9 > "$OUT"
  rc=${PIPESTATUS[0]}
else
  # Image passend zur Server-Major-Version. Reihenfolge: gecachtes Image ->
  # EXPLIZIT gesetztes Image -> postgres:17-alpine. Bei Versions-Mismatch wird
  # die Server-Major-Version aus der Fehlermeldung gelesen und EINMAL korrekt
  # nachgezogen (pg_dump verweigert bei aelterer Client-Version den Dienst).
  IMG="${SUPABASE_DUMP_IMAGE:-}"
  if [[ -z "$IMG" && -f "$IMG_CACHE" ]]; then IMG="$(cat "$IMG_CACHE")"; fi
  [[ -n "$IMG" ]] || IMG="postgres:17-alpine"

  run_docker_dump "$IMG" 2>"$ERRLOG" | gzip -9 > "$OUT"
  rc=${PIPESTATUS[0]}

  if [[ $rc -ne 0 ]] && grep -q 'server version' "$ERRLOG"; then
    MAJOR="$(grep -oE 'server version: [0-9]+' "$ERRLOG" | head -1 | grep -oE '[0-9]+')"
    if [[ -n "$MAJOR" ]]; then
      NEWIMG="postgres:${MAJOR}-alpine"
      log "Versions-Mismatch mit $IMG -> Retry mit $NEWIMG (Server-Major $MAJOR)"
      run_docker_dump "$NEWIMG" 2>"$ERRLOG" | gzip -9 > "$OUT"
      rc=${PIPESTATUS[0]}
      if [[ $rc -eq 0 ]]; then
        mkdir -p "$(dirname "$IMG_CACHE")"; echo "$NEWIMG" > "$IMG_CACHE"
        log "Dump-Image gecacht: $NEWIMG"
      fi
    fi
  fi
  [[ $rc -eq 0 ]] || { echo "--- pg_dump-Fehlerausgabe ---" >&2; cat "$ERRLOG" >&2; }
fi
rm -f "$ERRLOG"
set -e

if [[ $rc -ne 0 || ! -s "$OUT" ]]; then
  rm -f "$OUT"
  loud_fail "pg_dump fehlgeschlagen (rc=$rc). Nichts hochgeladen." 2
fi

# Plausibilitaet: ein gueltiger Dump nennt PostgreSQL und enthaelt CREATE TABLE.
# ACHTUNG: kein `| head` direkt in der Bedingung — mit `set -o pipefail` wertet
# SIGPIPE von head (gzip wird frueh geschlossen) die Pipeline faelschlich als Fehler.
HEAD40="$(gzip -dc "$OUT" 2>/dev/null | head -40 || true)"
if ! printf '%s' "$HEAD40" | grep -q "PostgreSQL database dump"; then
  loud_fail "Dump sieht unplausibel aus (kein pg_dump-Header): $OUT" 2
fi
SIZE="$(stat -c%s "$OUT")"
TABLES="$(gzip -dc "$OUT" | grep -c '^CREATE TABLE' || true)"
SIZE_MB="$(awk -v s="$SIZE" 'BEGIN{printf "%.2f", s/1048576}')"
log "Dump fertig: ${SIZE_MB} MB · $TABLES CREATE TABLE"

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
