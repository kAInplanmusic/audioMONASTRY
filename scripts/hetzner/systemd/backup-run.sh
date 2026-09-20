#!/usr/bin/env bash
# ============================================================================
# audioMONASTRY · Backup-Lauf auf einem Flotten-Knoten (INFRA-HETZNER-008)
# ----------------------------------------------------------------------------
# Wird vom systemd-Timer `audiomonastry-backup.timer` gestartet (installed von
# scripts/hetzner/install-backup-timer.sh) und ruft scripts/backup.sh im
# App-Verzeichnis auf: lokales tar.gz in $BACKUP_DIR (Default
# /var/backups/audiomonastry, Rotation dort 14 Tage) plus – wenn moeglich – die
# Off-Site-Kopie ueber scripts/r2-backup.mjs.
#
# Off-Site ist BEST EFFORT, aber NIE ein stiller No-Op: fehlen Zugangsdaten
# (BACKUP_S3_*/HOS_S3_*/CFS3_*/CFR2_*) oder die Node-Abhaengigkeit
# (@aws-sdk/client-s3 - node_modules wird bewusst nicht auf die Knoten
# rsynct), dann SAGT der Lauf das und faehrt das lokale Backup trotzdem.
# Wer Off-Site erzwingen will: REQUIRE_OFFSITE=1 -> der Lauf endet dann mit
# Fehler (Exit 3), systemd zeigt ihn als failed (kein stiller Verzicht).
#
# Konfiguration (env oder Unit):
#   APP_DIR          Repo-/App-Verzeichnis auf dem Knoten (Default /opt/audiomonastry)
#   BACKUP_DIR       Ziel der Archive (Default /var/backups/audiomonastry)
#   BACKUP_OFFSITE   1 = Off-Site versuchen (Default), 0 = nur lokal
#   REQUIRE_OFFSITE  1 = Off-Site ist Pflicht (Default 0)
# ============================================================================
set -uo pipefail

APP_DIR="${APP_DIR:-/opt/audiomonastry}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/audiomonastry}"
OFFSITE="${BACKUP_OFFSITE:-1}"
REQUIRE_OFFSITE="${REQUIRE_OFFSITE:-0}"

ts() { date -u +%FT%TZ; }
log() { echo "[backup] $(ts) $*"; }

if [[ ! -d "$APP_DIR" ]]; then
  log "FEHLER: $APP_DIR existiert nicht - kein Backup moeglich."
  exit 1
fi
cd "$APP_DIR" || { log "FEHLER: cd $APP_DIR fehlgeschlagen."; exit 1; }

# Secrets der Rolle app liegen in der Knoten-.env (der Portal-Worker schreibt sie
# rollen-skopiert, inkl. der R2-Zugangsdaten). Fehlt sie, laeuft nur das lokale
# Backup - das wird gemeldet, nicht verschwiegen.
if [[ -f .env ]]; then
  # Die Knoten-.env ist eine kontrollierte Datei des Portal-Workers (KEY=VALUE).
  set -a
  . ./.env
  set +a
else
  log "Hinweis: keine $APP_DIR/.env gefunden - Off-Site ohne Zugangsdaten nicht moeglich."
fi

mkdir -p "$BACKUP_DIR"

offsite_ready=0
offsite_reason=""
if [[ "$OFFSITE" == "1" ]]; then
  if [[ -z "${BACKUP_S3_ACCESS_KEY:-}${HOS_S3_ACCESS_KEY:-}${CFS3_ACCESS_KEY:-}${CFR2_ACCESS_KEY_ID:-}" ]]; then
    offsite_reason="keine Backup-S3-Zugangsdaten (BACKUP_S3_*/HOS_S3_*/CFS3_*/CFR2_*) in $APP_DIR/.env oder der Unit-Umgebung"
  elif ! command -v node >/dev/null 2>&1; then
    offsite_reason="node fehlt auf diesem Knoten (Off-Site laeuft ueber scripts/r2-backup.mjs)"
  elif ! node -e "require.resolve('@aws-sdk/client-s3')" >/dev/null 2>&1; then
    offsite_reason="@aws-sdk/client-s3 fehlt in $APP_DIR (npm ci noetig) - off-site sonst vom Build-Rechner fahren"
  else
    offsite_ready=1
  fi
  [[ "$offsite_ready" == "1" ]] || log "OFFSITE UEBERSPRUNGEN: $offsite_reason."
fi

# Lokales Backup laeuft IMMER (Daten zuerst) - die Off-Site-Pflicht prueft erst
# danach aus, damit ein REQUIRE_OFFSITE-Fehler nicht auch noch das lokale
# Backup verhindert.
if [[ "$offsite_ready" == "1" ]]; then
  BACKUP_DIR="$BACKUP_DIR" bash scripts/backup.sh --offsite
else
  BACKUP_DIR="$BACKUP_DIR" bash scripts/backup.sh
fi
rc=$?

log "Lauf beendet (backup.sh rc=$rc, off-site=$offsite_ready, off-site angefordert=$OFFSITE, Ziel=$BACKUP_DIR)."
if [[ "$OFFSITE" == "1" && "$offsite_ready" != "1" && "$REQUIRE_OFFSITE" == "1" ]]; then
  log "REQUIRE_OFFSITE=1, aber Off-Site war nicht moeglich -> Fehler-Exit 3 (systemd zeigt den Lauf als failed)."
  exit 3
fi
exit "$rc"
