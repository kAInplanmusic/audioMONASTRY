#!/usr/bin/env bash
# audioMONASTRY Backup-Timer installer (INFRA-HETZNER-008).
# ============================================================================
# Installiert auf einem Flotten-Knoten (app-1):
#   /usr/local/bin/audiomonastry-backup.sh                     (Wrapper)
#   /etc/systemd/system/audiomonastry-backup.service|.timer    (Unit + Timer)
# und aktiviert den Timer (15 min nach Boot, danach alle 24 h).
#
# Aufruf:  sudo bash scripts/hetzner/install-backup-timer.sh
#   (aus dem Repo-Verzeichnis, i. d. R. /opt/audiomonastry)
#
# Der Lauf selbst liegt in scripts/hetzner/systemd/backup-run.sh - dort steht
# auch, wie sich Off-Site ohne Zugangsdaten verhaelt (laute Meldung, kein stiller
# No-Op; REQUIRE_OFFSITE=1 macht es zur Pflicht).
# ============================================================================
set -euo pipefail

HERE_SRC="$(cd "$(dirname "$0")" && pwd)"
SERVICE=audiomonastry-backup
LOG=/var/log/audiomonastry-backup.log

for f in systemd/backup-run.sh systemd/${SERVICE}.service systemd/${SERVICE}.timer; do
  [[ -f "$HERE_SRC/$f" ]] || { echo "❌ fehlt: $HERE_SRC/$f" >&2; exit 1; }
done

install -m 0755 "$HERE_SRC/systemd/backup-run.sh" /usr/local/bin/audiomonastry-backup.sh
install -m 0644 "$HERE_SRC/systemd/${SERVICE}.service" "/etc/systemd/system/${SERVICE}.service"
install -m 0644 "$HERE_SRC/systemd/${SERVICE}.timer" "/etc/systemd/system/${SERVICE}.timer"
touch "$LOG"

systemctl daemon-reload
systemctl enable --now "${SERVICE}.timer"

echo "[done] Backup-Timer aktiv ($(systemctl is-active "${SERVICE}.timer"), Log: $LOG)"
systemctl list-timers "${SERVICE}.timer" --no-pager || true
