#!/usr/bin/env bash
# ============================================================================
# check-media-ports.sh - sind die RTC-Medienports wirklich offen?
# ============================================================================
# WARUM (INFRA-HETZNER-015, gemessen 2026-09-24):
#
# Der SFU-Knoten lief und der Echtpfadtest meldete 92 RTP-Pakete - und TROTZDEM
# war TURN von aussen nicht erreichbar. Der Grund ist eine Falle, die man von
# innen nicht sieht:
#
#   * mediasoup laeuft als Container mit veroeffentlichten Ports. Docker setzt
#     eigene iptables-Regeln VOR ufw. Diese Ports sind deshalb auch bei
#     geschlossenem ufw erreichbar.
#   * coturn laeuft im NETZWERKMODUS HOST und bekommt diese Ausnahme NICHT.
#     Es unterliegt ufw direkt.
#
# Folge: 40000-40099 funktionierten, 3478 nicht. Ein Test, der nur den
# Medienpfad prueft, sieht das nie. Ein Test von innen auch nicht.
#
# Dieses Skript prueft deshalb beide Wege getrennt und benennt den Unterschied.
# Es ist absichtlich klein: es soll beim Flottenstart laufen und laut werden.
#
# Aufruf:  bash scripts/hetzner/check-media-ports.sh
# Rueckgabe: 0 = alle Medienports sind durch, 1 = mindestens einer ist zu.
# ============================================================================
set -uo pipefail

echo "▶ Medienports pruefen (TURN 3478, Relay 49152-49201, Medien 40000-40099)"

FEHLER=0

# --- 1. Laeuft ufw ueberhaupt? -------------------------------------------------
if ! command -v ufw >/dev/null 2>&1; then
  echo "  ⚠ ufw ist nicht installiert - die Host-Firewall ist damit nicht die Ursache."
elif ! ufw status 2>/dev/null | grep -q "Status: active"; then
  echo "  ⚠ ufw ist inaktiv. Dann blockt hier nichts - die Pruefung der Regeln entfaellt."
else
  echo "  ufw ist aktiv. Erwartete Regeln:"
  for regel in "3478/udp" "3478/tcp" "49152:49201/udp" "40000:40099/udp"; do
    if ufw status 2>/dev/null | grep -q "^${regel}[[:space:]]"; then
      echo "    ✓ ${regel}"
    else
      echo "    ❌ ${regel} FEHLT - genau so fiel TURN am 2026-09-24 aus."
      FEHLER=1
    fi
  done
fi

# --- 2. Laeuft coturn im Host-Modus? ------------------------------------------
# Nur dann greift ufw. Laeuft es mit Portfreigabe, umgeht Docker die Regel und
# eine fehlende ufw-Regel waere harmlos - das soll das Skript nicht verschweigen.
if command -v docker >/dev/null 2>&1; then
  MODUS="$(docker inspect audiomonastry-coturn --format '{{.HostConfig.NetworkMode}}' 2>/dev/null || true)"
  case "$MODUS" in
    host) echo "  coturn laeuft im Netzwerkmodus host - ufw-Regeln greifen also wirklich." ;;
    "")   echo "  ⚠ coturn laeuft hier nicht. Auf einem reinen App-Knoten ist das richtig." ;;
    *)    echo "  coturn laeuft im Modus '$MODUS' - Docker umgeht ufw dann teilweise." ;;
  esac
fi

# --- 3. Antwortet der Dienst auf einen echten STUN-Request? -------------------
# Das ist der Aussagekraeftigste Teil: eine gueltige Antwort beweist, dass der
# Weg zum Dienst steht. Ein reiner Port-Test beweist nur, dass etwas lauscht.
if command -v python3 >/dev/null 2>&1; then
  ANTWORT="$(python3 - <<'PY' 2>/dev/null
import os, socket, struct
msg = struct.pack('>HHI12s', 0x0001, 0, 0x2112A442, os.urandom(12))
try:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(5)
    s.sendto(msg, ('127.0.0.1', 3478))
    d, _ = s.recvfrom(2048)
    print('ja:%d' % len(d))
except Exception:
    print('nein')
PY
)"
  case "$ANTWORT" in
    ja:*) echo "  ✓ TURN antwortet lokal auf einen STUN-Request (${ANTWORT#ja:} Bytes)." ;;
    nein) echo "  ⚠ Keine Antwort auf einen STUN-Request - laeuft coturn?" ;;
  esac
fi

if [ "$FEHLER" -eq 0 ]; then
  echo "✅ Medienports in Ordnung."
  exit 0
fi

echo "❌ Mindestens ein Medienport ist auf dem Host gesperrt." >&2
echo "   Behebung: ufw allow 3478/udp && ufw allow 3478/tcp" >&2
echo "             ufw allow 49152:49201/udp && ufw allow 40000:40099/udp" >&2
echo "   Dauerhaft: scripts/hetzner/cloud-init.yaml (Abschnitt runcmd)." >&2
exit 1
