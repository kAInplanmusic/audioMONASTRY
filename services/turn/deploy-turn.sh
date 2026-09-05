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

# Statische Client-Credentials (lt-cred-mech) – passend zu VITE_TURN_USERNAME/VITE_TURN_CREDENTIAL.
TURN_USER="${TURN_USER:-monk}"
TURN_PASS="${TURN_PASS:-monkmonastery}"
STATIC_USER_LINE="user=${TURN_USER}:${TURN_PASS}"

echo "Configuring coturn (Secret + User werden eingesetzt)..."
TMP_CONF="$(mktemp)"
sed -e "s|^static-auth-secret=.*|static-auth-secret=${TURN_SECRET}|" \
    -e "s|^__TURN_STATIC_USER_LINE__.*|${STATIC_USER_LINE}|" \
    "$CONF_TEMPLATE" > "$TMP_CONF"
sudo install -m 640 "$TMP_CONF" "$TARGET_CONF"
rm -f "$TMP_CONF"

echo "Starting and enabling coturn service..."
sudo systemctl enable coturn
sudo systemctl restart coturn

echo "TURN server deployed successfully."
echo "Client-Seite: VITE_TURN_* Env-Variablen passend zum Secret setzen."
