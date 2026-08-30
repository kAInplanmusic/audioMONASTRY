#!/usr/bin/env bash
# =============================================================================
# vm-startup.sh  –  sampleMONK GCE VM Startup Script
# =============================================================================
# This script is automatically executed on every GCE VM boot via the GCP
# project-level startup-script metadata key (terraform/modules/core/vm_startup.tf).
#
# What it does:
#   1. Installs a systemd timer that checks every 5 minutes whether the VM
#      has been idle for ≥ 30 minutes (no active SSH sessions, CPU < 5 %).
#   2. When idle threshold is reached the VM shuts itself down cleanly.
#   3. Logs all activity to /var/log/samplemonk-idle-shutdown.log
# =============================================================================
set -euo pipefail

LOG=/var/log/samplemonk-idle-shutdown.log
IDLE_MINUTES=30
CHECK_INTERVAL=5   # minutes between idle checks

echo "[startup] $(date -u +%FT%TZ)  sampleMONK startup script running" >> "$LOG"

# ---------------------------------------------------------------------------
# 1. Write the idle-check helper script
# ---------------------------------------------------------------------------
cat > /usr/local/bin/samplemonk-idle-check.sh << 'IDLE_EOF'
#!/usr/bin/env bash
# Checks whether the VM is idle and shuts it down if it has been idle
# for IDLE_MINUTES consecutive checks.
LOG=/var/log/samplemonk-idle-shutdown.log
STATE_FILE=/run/samplemonk-idle-count
IDLE_MINUTES=30
CHECK_INTERVAL=5
IDLE_CYCLES=$(( IDLE_MINUTES / CHECK_INTERVAL ))

ts() { date -u +%FT%TZ; }

# --- Active SSH sessions? ---
SSH_SESSIONS=$(who | grep -c pts/ 2>/dev/null || true)

# --- CPU usage over last minute (integer %) ---
CPU_IDLE=$(top -bn1 | grep "Cpu(s)" | awk '{print $8}' | cut -d'.' -f1 || echo 0)
CPU_USED=$(( 100 - CPU_IDLE ))

echo "[idle-check] $(ts)  SSH=$SSH_SESSIONS  CPU_USED=${CPU_USED}%" >> "$LOG"

if [[ "$SSH_SESSIONS" -gt 0 || "$CPU_USED" -gt 5 ]]; then
  # VM is active – reset counter
  echo "0" > "$STATE_FILE"
  echo "[idle-check] $(ts)  Active – counter reset." >> "$LOG"
  exit 0
fi

# Increment idle counter
CURRENT=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
NEXT=$(( CURRENT + 1 ))
echo "$NEXT" > "$STATE_FILE"
echo "[idle-check] $(ts)  Idle cycle $NEXT / $IDLE_CYCLES" >> "$LOG"

if [[ "$NEXT" -ge "$IDLE_CYCLES" ]]; then
  echo "[idle-check] $(ts)  *** Idle threshold reached – shutting down VM ***" >> "$LOG"
  shutdown -h now "sampleMONK: auto-shutdown after ${IDLE_MINUTES} min idle"
fi
IDLE_EOF

chmod +x /usr/local/bin/samplemonk-idle-check.sh

# ---------------------------------------------------------------------------
# 2. Create systemd service unit
# ---------------------------------------------------------------------------
cat > /etc/systemd/system/samplemonk-idle-check.service << EOF
[Unit]
Description=sampleMONK idle VM shutdown check
After=network.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/samplemonk-idle-check.sh
StandardOutput=append:${LOG}
StandardError=append:${LOG}
EOF

# ---------------------------------------------------------------------------
# 3. Create systemd timer unit (runs every CHECK_INTERVAL minutes)
# ---------------------------------------------------------------------------
cat > /etc/systemd/system/samplemonk-idle-check.timer << EOF
[Unit]
Description=sampleMONK idle check every ${CHECK_INTERVAL} minutes
After=network.target

[Timer]
OnBootSec=5min
OnUnitActiveSec=${CHECK_INTERVAL}min
Unit=samplemonk-idle-check.service

[Install]
WantedBy=timers.target
EOF

# ---------------------------------------------------------------------------
# 4. Enable & start the timer
# ---------------------------------------------------------------------------
systemctl daemon-reload
systemctl enable --now samplemonk-idle-check.timer

echo "[startup] $(date -u +%FT%TZ)  Auto-shutdown timer active (idle=${IDLE_MINUTES} min, check every ${CHECK_INTERVAL} min)" >> "$LOG"
