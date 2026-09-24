#!/usr/bin/env bash
# ============================================================================
# TLS-Terminator sicherstellen und pruefen (PROD-P0-F1, 2026-09-24)
# ============================================================================
# WARUM ES DIESES SKRIPT GIBT - es ist die Lehre aus einem teuren Fehler:
#
# Der Flottenstart meldete stundenlang "✅ audioMONASTRY-Flotte ist bereit",
# waehrend auf app-1 Caddy in einer Absturzschleife lag:
#     Error: loading certificates: open /etc/caddy/certs/origin.crt: no such file
# Nichts hoerte auf 80/443, Cloudflare antwortete mit 521/522/525 - und die
# Instanz war oeffentlich unerreichbar, obwohl die App-Container gesund waren
# (Up 3 hours, healthy, Port 8080). Alle Pruefungen des Starts schauten auf die
# App. Der TLS-Terminator kam in keiner vor.
#
# Ein gruener Flottenstart ohne diese Pruefung ist kein Beleg. Dieses Skript
# schliesst die Luecke: es PRUEFT den Terminator und es STELLT ihn her, wenn das
# Image fehlt (sonst steht ein frisch provisionierter Knoten wieder ohne das
# Cloudflare-DNS-Plugin da).
#
# WAS GEPRUEFT WIRD (jede Zeile ist ein Messwert, keine Zusage):
#   1. Image da? Sonst bauen.
#   2. Caddy-Container laeuft - ausdruecklich NICHT "Restarting". Eine
#      Absturzschleife sieht in `docker ps` aus wie Betrieb, ist aber keine.
#   3. Lauscht etwas auf 443?
#   4. Antwortet der Ursprung lokal mit HTTPS und HTTP 200? (Zertifikat!)
#   5. Antwortet die OEFFENTLICHE Domain mit HTTP 200? Erst das ist die Aussage,
#      die den Betrachter interessiert.
#
# RUECKGABE: 0 = Terminator geprueft und gesund, 1 = nicht gesund, 2 = nicht pruefbar
# Aufruf: APP_IP=<ip> DOMAIN=<domain> bash scripts/hetzner/ensure-tls-terminator.sh
# ============================================================================
set -uo pipefail

APP_IP="${APP_IP:-}"
DOMAIN="${DOMAIN:-anunnakitools.de}"
ORIGIN_HOST="${ORIGIN_HOST:-origin.$DOMAIN}"
IMAGE="${CADDY_IMAGE:-audiomonastry-caddy-dns:2.9}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/audiomonastry}"
NUR_PRUEFEN="${NUR_PRUEFEN:-0}"

SSH_OPTS=(-o StrictHostKeyChecking=no -o ConnectTimeout=12 -o BatchMode=yes)
auf() { ssh "${SSH_OPTS[@]}" "root@$APP_IP" "$@"; }

if [ -z "$APP_IP" ]; then
  echo "❌ APP_IP fehlt." >&2
  exit 2
fi

echo "▶ TLS-Terminator auf $APP_IP prüfen (Domain $DOMAIN)"

# --- 1. Image vorhanden? Sonst bauen. ---------------------------------------
if [ "$NUR_PRUEFEN" != "1" ]; then
  if auf "docker image inspect $IMAGE >/dev/null 2>&1"; then
    echo "  ✓ Image $IMAGE vorhanden"
  else
    echo "  → Image $IMAGE fehlt - wird gebaut (Caddy mit Cloudflare-DNS-Plugin)"
    auf "mkdir -p $DEPLOY_DIR-caddybuild && cat > $DEPLOY_DIR-caddybuild/Dockerfile <<'DOCKER'
FROM caddy:2.9-builder AS builder
RUN xcaddy build --with github.com/caddy-dns/cloudflare
FROM caddy:2.9-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
DOCKER
cd $DEPLOY_DIR-caddybuild && docker build -t $IMAGE . 2>&1 | tail -3" || {
      echo "❌ Image-Bau fehlgeschlagen." >&2; exit 1
    }
    auf "docker run --rm $IMAGE caddy list-modules 2>/dev/null | grep -q dns.providers.cloudflare" || {
      echo "❌ Das gebaute Image hat das Cloudflare-DNS-Plugin NICHT." >&2; exit 1
    }
    echo "  ✓ Image gebaut, Plugin nachgewiesen"
  fi
else
  echo "  (NUR_PRUEFEN=1 - kein Bau)"
fi

# --- 2. Caddy laeuft - und zwar wirklich, nicht in der Schleife. ------------
STATUS="$(auf 'docker ps --format "{{.Names}} {{.Status}}" | grep caddy' 2>/dev/null)"
if [ -z "$STATUS" ]; then
  echo "❌ Caddy-Container existiert nicht auf $APP_IP." >&2
  exit 1
fi
echo "  Caddy: $STATUS"
case "$STATUS" in
  *Restarting*|*"Exited"*|*"Up 0 seconds"*)
    echo "❌ Caddy ist NICHT stabil (Absturzschleife). Letzte Zeilen:" >&2
    auf "docker logs --tail 12 audiomonastry-caddy 2>&1 | tail -3 | cut -c1-160" | sed 's/^/    /' >&2
    exit 1
    ;;
esac

# --- 3./4. Lauscht 443, und antwortet der Ursprung mit Zertifikat? ----------
if ! auf "timeout 8 bash -c 'cat < /dev/null > /dev/tcp/127.0.0.1/443'" 2>/dev/null; then
  echo "❌ Auf $APP_IP lauscht nichts auf Port 443." >&2
  exit 1
fi
echo "  ✓ Port 443 lauscht"

LOKAL="$(auf "curl -s -o /dev/null -w '%{http_code}' -m 20 --resolve $ORIGIN_HOST:443:127.0.0.1 https://$ORIGIN_HOST/api/health" 2>/dev/null)"
echo "  Ursprung lokal (SNI $ORIGIN_HOST): HTTP ${LOKAL:-000}"
if [ "${LOKAL:-000}" != "200" ]; then
  echo "❌ Der Ursprung antwortet nicht mit 200 - das Zertifikat fehlt oder passt nicht." >&2
  auf "docker logs --tail 20 audiomonastry-caddy 2>&1 | grep -iE 'certificate|error|dns' | tail -3 | cut -c1-160" | sed 's/^/    /' >&2
  exit 1
fi

# --- 5. DIE Aussage, die zaehlt: oeffentlich erreichbar? --------------------
OEFFENTLICH="$(curl -s -o /dev/null -w '%{http_code}' -m 30 "https://$DOMAIN/api/health?cb=$RANDOM" 2>/dev/null)"
echo "  Öffentlich https://$DOMAIN/api/health: HTTP ${OEFFENTLICH:-000}"
if [ "${OEFFENTLICH:-000}" != "200" ]; then
  echo "" >&2
  echo "❌ DIE INSTANZ IST NICHT ÖFFENTLICH ERREICHBAR (HTTP ${OEFFENTLICH:-000})." >&2
  echo "   Der Knoten selbst ist in Ordnung - die Ursache liegt davor. Reihenfolge zum Pruefen:" >&2
  echo "     1. DNS: zeigt $ORIGIN_HOST auf $APP_IP?  (scripts/hetzner/cf-dns-ensure.py)" >&2
  echo "     2. Worker-Route: ist die Hauptdomain eine Worker-Custom-Domain? Dann schickt der" >&2
  echo "        Worker SNI der Hauptdomain - die muss im TLS-Block der Caddyfile stehen." >&2
  echo "     3. Cloudflare-Status: 521 = Ursprung antwortet nicht, 525 = TLS-Handshake," >&2
  echo "        522 = Cloudflare erreicht den Ursprung nicht (DNS/Firewall)." >&2
  exit 1
fi

echo "✅ TLS-Terminator geprueft: Caddy stabil, 443 lauscht, Ursprung 200, öffentlich 200."
exit 0
