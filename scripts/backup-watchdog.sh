#!/usr/bin/env bash
# audioMONASTRY – Backup-Waechter
# =============================================================================
# WARUM: Ein Backup, das still ausfaellt, ist gefaehrlicher als keines. Im Audit
#   stand nur EIN App-Backup vom 14.09. im Bucket und niemand hat es gemerkt.
#
# WAS: prueft die Frische der Bestaende im Offsite-Bucket:
#   db/       Supabase-Dumps       (Schwelle: DB_MAX_AGE_H, Default 48 h)  -> rot
#   backups/  App-Bundle-Archive   (Schwelle: APP_MAX_AGE_H, Default 336 h) -> Warnung
# Exit: 0 = alles frisch · 1 = DB-Dump zu alt/fehlt · 2 = Waechter selbst defekt
# Aufruf: bash scripts/backup-watchdog.sh [--json]
# =============================================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

DB_MAX_AGE_H="${DB_MAX_AGE_H:-48}"
APP_MAX_AGE_H="${APP_MAX_AGE_H:-336}"
JSON=0
[[ "${1:-}" == "--json" ]] && JSON=1

log() { [[ "$JSON" == "1" ]] || echo "[watchdog $(date -Is)] $*"; }

command -v node >/dev/null 2>&1 || { echo "[watchdog FEHLER] node fehlt" >&2; exit 2; }

newest_age_h() {  # $1 = prefix  -> gibt Alter in Stunden aus ("-1" wenn leer)
  node scripts/r2-backup.mjs list "$1" 2>/dev/null \
    | awk -v p="$1" '$1 ~ "^"p {print $1, $NF}' \
    | sort -k2 \
    | tail -1 \
    | awk '{print $2}' \
    | while read -r ts; do
        [[ -z "$ts" ]] && { echo -1; exit; }
        epoch=$(date -d "$ts" +%s 2>/dev/null || echo 0)
        [[ "$epoch" == "0" ]] && { echo -1; exit; }
        echo $(( ( $(date +%s) - epoch ) / 3600 ))
      done
}

# Alter aus der Zusammenfassungszeile ziehen ist unzuverlaessig -> direkt rechnen.
age_of_prefix() {
  local prefix="$1" line latest
  latest="$(node scripts/r2-backup.mjs list "$prefix" 2>/dev/null | awk -v p="$prefix" '$1 ~ "^"p {print $NF}' | sort | tail -1)"
  if [[ -z "$latest" ]]; then echo -1; return; fi
  local epoch
  epoch="$(date -d "$latest" +%s 2>/dev/null || echo 0)"
  [[ "$epoch" == "0" ]] && { echo -1; return; }
  echo $(( ( $(date +%s) - epoch ) / 3600 ))
}

DB_AGE="$(age_of_prefix 'db/')"
APP_AGE="$(age_of_prefix 'backups/')"

DB_STATE="ok"; APP_STATE="ok"
(( DB_AGE < 0 )) && DB_STATE="fehlt"
(( DB_AGE >= 0 && DB_AGE > DB_MAX_AGE_H )) && DB_STATE="zu alt"
(( APP_AGE < 0 )) && APP_STATE="fehlt"
(( APP_AGE >= 0 && APP_AGE > APP_MAX_AGE_H )) && APP_STATE="zu alt"

fmt() { (( $1 < 0 )) && echo "—" || echo "${1} h"; }

if [[ "$JSON" == "1" ]]; then
  printf '{"db":{"age_h":%s,"max_h":%s,"state":"%s"},"app":{"age_h":%s,"max_h":%s,"state":"%s"}}\n' \
    "$DB_AGE" "$DB_MAX_AGE_H" "$DB_STATE" "$APP_AGE" "$APP_MAX_AGE_H" "$APP_STATE"
else
  log "Supabase-Dump (db/):      Alter $(fmt "$DB_AGE")  [Schwelle ${DB_MAX_AGE_H} h]  -> $DB_STATE"
  log "App-Bundle (backups/):     Alter $(fmt "$APP_AGE") [Schwelle ${APP_MAX_AGE_H} h] -> $APP_STATE"
fi

if (( DB_AGE < 0 )) || (( DB_AGE > DB_MAX_AGE_H )); then
  echo "[watchdog ALARM] Kein frischer Supabase-Dump (Alter: $(fmt "$DB_AGE"), erlaubt ${DB_MAX_AGE_H} h). Pruefen: systemctl --user status audiomonastry-dbbackup.timer ; journalctl --user -u audiomonastry-dbbackup -n 50" >&2
  exit 1
fi

if (( APP_AGE < 0 )) || (( APP_AGE > APP_MAX_AGE_H )); then
  echo "[watchdog WARNUNG] App-Bundle-Backup alt/fehlend (Alter: $(fmt "$APP_AGE"), erlaubt ${APP_MAX_AGE_H} h). Erwartet: Flotte laeuft mit install-backup-timer.sh auf app-1 (aktuell keine Flotte -> erwartet)." >&2
fi

exit 0
