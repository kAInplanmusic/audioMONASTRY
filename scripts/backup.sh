#!/usr/bin/env bash
# audioMONASTRY – 7.1.4 Backup & Recovery (point-in-time)
# Sichert Sessions/Assets (dist + public/uploads) als tar.gz mit Retention.
set -euo pipefail

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
