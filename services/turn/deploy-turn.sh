#!/usr/bin/env bash
# =============================================================================
# deploy-turn.sh – coturn (TURN/STUN-Relay) produktionsfest installieren
# -----------------------------------------------------------------------------
# Laeuft auf dem SFU-Knoten (Rolle sfu). Bewusst NICHT Teil von
# bring-up-fleet.sh: TURN ist ein eigener Dienst mit eigenem Secret.
#
# Pflicht-Env:
#   TURN_STATIC_AUTH_SECRET   Secret fuer das coturn-REST-Verfahren. DERSELBE
#                             Wert muss in der App-.env stehen, sonst passen die
#                             kurzlebigen Credentials nicht zusammen.
# Optional:
#   TURN_RELAY_IP             oeffentliche IP des Knotens; ohne Angabe wird sie
#                             per HTTP ermittelt
#   TURN_REALM                Default: anunnakitools.de
#
# Aufruf (auf sfu-1):
#   sudo TURN_STATIC_AUTH_SECRET="$(openssl rand -hex 32)" bash services/turn/deploy-turn.sh
#
# Firewall-Voraussetzung (Hetzner-Cloud-Firewall samplemonk-sfu, 2026-09-13
# gesetzt und verifiziert): udp/3478, tcp/3478, udp/49152-65535 oeffentlich.
#
# WICHTIG (2026-09-13 gefixt): Das Skript generiert KEIN Secret mehr selbst.
# Vorher entstand bei fehlendem Secret still ein zufaelliges – das rotiert den
# Relay unbemerkt und bricht jede laufende Konfiguration (dieselbe Klasse
# "stiller Fehlschlag" wie beim MOS-Generator).
# =============================================================================
set -euo pipefail

SERVICE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF_TEMPLATE="$SERVICE_DIR/turnserver.conf"
TARGET_CONF="/etc/turnserver.conf"
LISTEN_PORT=3478

if [ "$(id -u)" -ne 0 ]; then
  echo "FEHLER: bitte mit sudo/root ausfuehren (schreibt /etc/turnserver.conf)." >&2
  exit 1
fi

if [ -z "${TURN_STATIC_AUTH_SECRET:-}" ]; then
  echo "FEHLER: TURN_STATIC_AUTH_SECRET ist nicht gesetzt." >&2
  echo "  Secret erzeugen:   openssl rand -hex 32" >&2
  echo "  Denselben Wert in der App-.env als TURN_STATIC_AUTH_SECRET setzen und" >&2
  echo "  den Knoten in TURN_URLS eintragen." >&2
  exit 2
fi

TURN_RELAY_IP="${TURN_RELAY_IP:-}"
if [ -z "$TURN_RELAY_IP" ]; then
  TURN_RELAY_IP="$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || true)"
fi
if [ -z "$TURN_RELAY_IP" ]; then
  echo "FEHLER: oeffentliche IP nicht ermittelbar – TURN_RELAY_IP explizit setzen." >&2
  exit 2
fi

TURN_REALM="${TURN_REALM:-anunnakitools.de}"

echo "=== coturn installieren ==="
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq coturn

echo "=== Konfiguration schreiben (realm=$TURN_REALM relay-ip=$TURN_RELAY_IP) ==="
TMP_CONF="$(mktemp)"
sed -e "s|^static-auth-secret=.*|static-auth-secret=${TURN_STATIC_AUTH_SECRET}|" \
    -e "s|^relay-ip=.*|relay-ip=${TURN_RELAY_IP}|" \
    -e "s|^realm=.*|realm=${TURN_REALM}|" \
    "$CONF_TEMPLATE" > "$TMP_CONF"
install -m 640 "$TMP_CONF" "$TARGET_CONF"
rm -f "$TMP_CONF"

# Debian/Ubuntu: ohne TURNSERVER_ENABLED=1 startet der Dienst nicht. Ohne diese
# Zeile ist der restart "erfolgreich", aber es lauscht nichts – eine klassische
# stille Fehlerquelle.
echo "=== Dienst aktivieren ==="
cat > /etc/default/coturn <<'EOF'
# Von audioMONASTRY/services/turn/deploy-turn.sh gesetzt.
TURNSERVER_ENABLED=1
EOF

systemctl enable coturn >/dev/null 2>&1 || true
systemctl restart coturn

echo "=== Verifikation (lauscht wirklich etwas?) ==="
listening() {
  { ss -lun 2>/dev/null; ss -ltn 2>/dev/null; } | grep -q ":${LISTEN_PORT}[[:space:]]"
}
for _ in $(seq 1 10); do
  if listening; then break; fi
  sleep 1
done

if ! listening; then
  echo "FEHLER: coturn lauscht nicht auf ${LISTEN_PORT}." >&2
  systemctl status coturn --no-pager -l 2>&1 | tail -20 >&2 || true
  journalctl -u coturn --no-pager -n 30 >&2 || true
  exit 3
fi

echo "OK: coturn lauscht auf ${LISTEN_PORT} (relay-ip ${TURN_RELAY_IP})."
echo "App-Seite (in der App-.env auf app-1):"
echo "  TURN_URLS=turn:${TURN_RELAY_IP}:${LISTEN_PORT}?transport=udp,turn:${TURN_RELAY_IP}:${LISTEN_PORT}?transport=tcp"
echo "  TURN_STATIC_AUTH_SECRET=<dasselbe Secret>"
