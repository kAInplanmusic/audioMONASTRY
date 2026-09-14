#!/usr/bin/env bash
# audioMONASTRY – 7.1.4 Backup & Recovery (point-in-time)
# Sichert Sessions/Assets (dist + public/uploads) als tar.gz mit Retention.
# Mit --offsite (und gesetzten CFS3_*/CFR2_*-Keys) wird das Archiv zusaetzlich
# nach R2 hochgeladen (scripts/r2-backup.mjs, PROD-P0-002).
set -euo pipefail

OFFSITE=0
[ "${1:-}" = "--offsite" ] && OFFSITE=1

BACKUP_DIR="${BACKUP_DIR:-/var/backups/audiomonastry}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
STAMP="$(date +%Y%m%d_%H%M%S)"
OUT="$BACKUP_DIR/audiomonastry_$STAMP.tar.gz"

mkdir -p "$BACKUP_DIR"
tar -czf "$OUT" \
  -C "$(pwd)" \
  dist public 2>/dev/null || true

# Alte Backups rotieren (point-in-time bleibt RETENTION_DAYS erhalten).
find "$BACKUP_DIR" -name 'audiomonastry_*.tar.gz' -mtime "+$RETENTION_DAYS" -delete

echo "[backup] $OUT"
ls -lh "$OUT"

if [ "$OFFSITE" = 1 ]; then
  # PROD-P0-002: Off-Site-Kopie nach R2; Verifikation per HeadObject-Groesse.
  node scripts/r2-backup.mjs upload "$OUT" "backups/audiomonastry_$STAMP.tar.gz"
fi
