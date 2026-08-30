#!/usr/bin/env bash
# sampleMONK Hetzner Auto-Shutdown installer.
# Usage: sudo bash scripts/hetzner/install-idle-shutdown.sh
set -euo pipefail

IDLE_MINUTES="${IDLE_MINUTES:-30}"
CHECK_INTERVAL="${CHECK_INTERVAL:-5}"
SERVICE=samplemonk-idle-shutdown
LOG=/var/log/samplemonk-idle-shutdown.log
HERE_SRC="$(dirname "$0")/systemd/idle-check.sh"

install -m 0755 "$HERE_SRC" /usr/local/bin/samplemonk-idle-check.sh

# --- service unit ---
cat > /etc/systemd/system/${SERVICE}.service << UNIT
[Unit]
Description=sampleMONK idle shutdown check
After=network.target

[Service]
Type=oneshot
Environment=IDLE_MINUTES=${IDLE_MINUTES}
Environment=CHECK_INTERVAL=${CHECK_INTERVAL}
Environment=LOG=${LOG}
ExecStart=/usr/local/bin/samplemonk-idle-check.sh
StandardOutput=append:${LOG}
StandardError=append:${LOG}
UNIT

# --- timer unit ---
cat > /etc/systemd/system/${SERVICE}.timer << TIMER
[Unit]
Description=sampleMONK idle check every ${CHECK_INTERVAL} minutes
After=network.target

[Timer]
OnBootSec=5min
OnUnitActiveSec=${CHECK_INTERVAL}min
Unit=${SERVICE}.service

[Install]
WantedBy=timers.target
TIMER

systemctl daemon-reload
systemctl enable --now ${SERVICE}.timer
echo "[done] idle shutdown active (idle=${IDLE_MINUTES} min, check every ${CHECK_INTERVAL} min)"
