#!/usr/bin/env bash
# audioMONASTRY auto-repair installer (INFRA-HETZNER-005).
# ============================================================================
# Installiert auf einem Flotten-Knoten:
#   /usr/local/bin/audiomonastry-auto-repair.sh                 (Watchdog)
#   /etc/systemd/system/audiomonastry-auto-repair.service|.timer (Unit + Timer)
# und aktiviert den Timer (3 min nach Boot, danach alle CHECK_INTERVAL Minuten).
#
# Die Units liegen im REPO (scripts/hetzner/systemd/) - der Installer kopiert sie
# nur. WARUM: vorher schrieb der Installer die Units per Heredoc und lief damit
# gegen die Repo-Fassung auseinander; dasselbe Muster wie
# install-backup-timer.sh (INFRA-HETZNER-008).
#
# Aufruf:  sudo bash scripts/hetzner/install-auto-repair.sh
#   (aus dem Repo-Verzeichnis, i. d. R. /opt/audiomonastry)
#   CHECK_INTERVAL=5 sudo bash scripts/hetzner/install-auto-repair.sh  # 5 min
# ============================================================================
set -euo pipefail

HERE_SRC="$(cd "$(dirname "$0")" && pwd)"
CHECK_INTERVAL="${CHECK_INTERVAL:-2}"
SERVICE=audiomonastry-auto-repair
LOG=/var/log/audiomonastry-auto-repair.log

for f in auto-repair.sh systemd/${SERVICE}.service systemd/${SERVICE}.timer; do
  [[ -f "$HERE_SRC/$f" ]] || { echo "❌ fehlt: $HERE_SRC/$f" >&2; exit 1; }
done

install -m 0755 "$HERE_SRC/auto-repair.sh" /usr/local/bin/audiomonastry-auto-repair.sh
install -m 0644 "$HERE_SRC/systemd/${SERVICE}.service" "/etc/systemd/system/${SERVICE}.service"
install -m 0644 "$HERE_SRC/systemd/${SERVICE}.timer" "/etc/systemd/system/${SERVICE}.timer"

# Intervall nur anpassen, wenn ausdruecklich gewuenscht (Default steht im Repo).
if [[ "$CHECK_INTERVAL" != "2" ]]; then
  sed -i "s|^OnUnitActiveSec=.*|OnUnitActiveSec=${CHECK_INTERVAL}min|" "/etc/systemd/system/${SERVICE}.timer"
fi

touch "$LOG"
systemctl daemon-reload
systemctl enable --now "${SERVICE}.timer"

echo "[done] auto-repair aktiv ($(systemctl is-active "${SERVICE}.timer"), Intervall ${CHECK_INTERVAL} min, Log: $LOG)"
systemctl list-timers "${SERVICE}.timer" --no-pager || true
