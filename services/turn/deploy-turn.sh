#!/usr/bin/env bash
# deploy-turn.sh - Automated TURN server setup (coturn)
set -euo pipefail

SERVICE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF_TEMPLATE="$SERVICE_DIR/turnserver.conf"
TARGET_CONF="/etc/turnserver.conf"

echo "Installing coturn..."
sudo apt-get update && sudo apt-get install -y coturn

# Secret: aus Env übernehmen oder frisch generieren (Rotation bei Deploy ohne Env)
if [ -z "${TURN_STATIC_AUTH_SECRET:-}" ]; then
  echo "Hinweis: TURN_STATIC_AUTH_SECRET nicht gesetzt - generiere frisches Secret."
  TURN_SECRET="$(openssl rand -hex 32)"
else
  TURN_SECRET="$TURN_STATIC_AUTH_SECRET"
fi

echo "Configuring coturn (Secret wird eingesetzt)..."
TMP_CONF="$(mktemp)"
sed "s|^static-auth-secret=.*|static-auth-secret=${TURN_SECRET}|" "$CONF_TEMPLATE" > "$TMP_CONF"
sudo install -m 640 "$TMP_CONF" "$TARGET_CONF"
rm -f "$TMP_CONF"

echo "Starting and enabling coturn service..."
sudo systemctl enable coturn
sudo systemctl restart coturn

echo "TURN server deployed successfully."
echo "Client-Seite: VITE_TURN_* Env-Variablen passend zum Secret setzen."
