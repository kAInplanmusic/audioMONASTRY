#!/usr/bin/env bash
# =============================================================================
# configure-floating-ip.sh – Hetzner Floating-IP im OS konfigurieren
# -----------------------------------------------------------------------------
# WICHTIG: Hetzner Cloud Floating-IPs werden OHNE NAT geroutet. Der Server
# erhaelt die Pakete mit der Floating-IP als Zieladresse und muss sie deshalb
# selbst auf eth0 konfigurieren – sonst antwortet er nicht (Ping/SSH/HTTP
# timeouten, obwohl die IP zugewiesen ist).
#
# Aufruf:
#   bash scripts/hetzner/configure-floating-ip.sh 159.69.102.29
# =============================================================================
set -euo pipefail

IP="${1:?Floating-IP als Argument angeben (z. B. 159.69.102.29)}"

if ip -4 addr show dev eth0 | grep -q "${IP}/32"; then
  echo "[floating-ip] ${IP} ist bereits auf eth0 konfiguriert."
else
  ip addr add "${IP}/32" dev eth0
  echo "[floating-ip] ${IP}/32 auf eth0 hinzugefuegt."
fi

# Persistenz ueber Reboots (systemd-oneshot; vermeidet netplan-Merge-Probleme).
UNIT="/etc/systemd/system/samplemonk-floating-ip.service"
cat > "$UNIT" <<EOF
[Unit]
Description=sampleMONK Hetzner Floating IP (${IP})
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/bin/sh -c 'ip addr add ${IP}/32 dev eth0 2>/dev/null || true'
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable samplemonk-floating-ip.service >/dev/null 2>&1 || true
systemctl start samplemonk-floating-ip.service >/dev/null 2>&1 || true

echo "[floating-ip] systemd-Unit installiert: samplemonk-floating-ip.service"
