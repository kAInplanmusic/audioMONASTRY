#!/usr/bin/env bash
# audioMONASTRY auto-repair installer (systemd-Timer, alle 2 Minuten).
# Usage: sudo bash scripts/hetzner/install-auto-repair.sh
set -euo pipefail

CHECK_INTERVAL="${CHECK_INTERVAL:-2}"
SERVICE=audiomonastry-auto-repair
LOG=/var/log/audiomonastry-auto-repair.log
HERE_SRC="$(dirname "$0")/auto-repair.sh"

install -m 0755 "$HERE_SRC" /usr/local/bin/audiomonastry-auto-repair.sh

cat > "/etc/systemd/system/${SERVICE}.service" << UNIT
[Unit]
Description=audioMONASTRY auto repair watchdog
After=docker.service network.target

[Service]
Type=oneshot
Environment=LOG=${LOG}
ExecStart=/usr/local/bin/audiomonastry-auto-repair.sh
StandardOutput=append:${LOG}
StandardError=append:${LOG}
UNIT

cat > "/etc/systemd/system/${SERVICE}.timer" << TIMER
[Unit]
Description=audioMONASTRY auto repair every ${CHECK_INTERVAL} minutes

[Timer]
OnBootSec=3min
OnUnitActiveSec=${CHECK_INTERVAL}min
Unit=${SERVICE}.service

[Install]
WantedBy=timers.target
TIMER

systemctl daemon-reload
systemctl enable --now "${SERVICE}.timer"
echo "[done] auto-repair active (every ${CHECK_INTERVAL} min, log: ${LOG})"
