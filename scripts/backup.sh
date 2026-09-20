#!/usr/bin/env bash
# audioMONASTRY – Backup & Recovery (point-in-time)
# =============================================================================
# Sichert den WIEDERHERSTELLBAREN Zustand als tar.gz mit lokaler Retention:
#   - dist/    (gebautes Bundle, ohne die grossen Medienkopien dist/data|music)
#   - public/  (Assets/Manifeste und public/uploads, ohne public/data|music)
#
# Die statischen Medienbibliotheken (public/data 3 GB, public/music 382 MB)
# sind KEIN Zustand, sondern Inhalte; dist enthaelt beim Build bereits Kopien
# davon. Beides mitzuarchivieren blaehte das Backup von ~74 MB auf 5 GB auf.
# Wer sie trotzdem mitsichern will:  bash scripts/backup.sh --full
#
# Flags:
#   --offsite   laedt das Archiv zusaetzlich auf S3-kompatiblen Speicher
#               (scripts/r2-backup.mjs; BACKUP_S3_*/HOS_S3_*/CFS3_*-Keys)
#   --full      ohne Ausschluesse (kompletter dist+public-Baum)
#
# RPO/RTO: taeglicher Lauf -> RPO 24 h. Restore = tar entpacken + `npm ci` +
# `npm run build` + Dienst starten -> RTO ~10 min (ohne Build ~2 min).
# =============================================================================
set -euo pipefail

OFFSITE=0
FULL=0
for arg in "$@"; do
  case "$arg" in
    --offsite) OFFSITE=1 ;;
    --full) FULL=1 ;;
    *) echo "[backup] unbekanntes Argument: $arg" >&2; exit 2 ;;
  esac
done

BACKUP_DIR="${BACKUP_DIR:-/var/backups/audiomonastry}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
STAMP="$(date +%Y%m%d_%H%M%S)"
OUT="$BACKUP_DIR/audiomonastry_$STAMP.tar.gz"

EXCLUDES=()
if [ "$FULL" != 1 ]; then
  EXCLUDES=(
    --exclude=dist/data
    --exclude=dist/music
    --exclude=public/data
    --exclude=public/music
  )
fi

# Nur VORHANDENE Wurzelverzeichnisse archivieren (INFRA-HETZNER-008): auf einem
# Flotten-Knoten fehlt z. B. dist/ - deploy.sh schliesst es aus dem rsync aus,
# gebaut wird im Image. Das frueher hier stehende `2>/dev/null || true` haette
# das verschwiegen: tar haette ohne dist ein Archiv erzeugt und der Lauf haette
# wie ein voller Erfolg ausgesehen. Jetzt wird das Fehlen gemeldet und ein Lauf
# ohne jedes Ziel schlaegt fehl (statt eine leere Datei zu hinterlassen).
TARGETS=()
for dir in dist public; do
  if [ -d "$dir" ]; then
    TARGETS+=("$dir")
  else
    echo "[backup] Hinweis: $dir/ fehlt in $(pwd) - wird nicht archiviert." >&2
  fi
done
if [ ${#TARGETS[@]} -eq 0 ]; then
  echo "[backup] FEHLER: weder dist/ noch public/ in $(pwd) - nichts zu sichern." >&2
  exit 3
fi

mkdir -p "$BACKUP_DIR"
tar -czf "$OUT" "${EXCLUDES[@]}" -C "$(pwd)" "${TARGETS[@]}"

# Alte Backups rotieren (point-in-time bleibt RETENTION_DAYS erhalten).
find "$BACKUP_DIR" -name 'audiomonastry_*.tar.gz' -mtime "+$RETENTION_DAYS" -delete

echo "[backup] $OUT"
ls -lh "$OUT"

if [ "$OFFSITE" = 1 ]; then
  # Off-Site-Kopie; Verifikation per HeadObject (Groesse) im Uploader.
  node scripts/r2-backup.mjs upload "$OUT" "backups/audiomonastry_$STAMP.tar.gz"
fi
