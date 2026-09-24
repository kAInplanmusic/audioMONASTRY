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
# `auf()` wird weiter unten definiert - erst nach der Pruefung, ob der Zielknoten
# dieser Rechner selbst ist. Eine Definition an dieser Stelle ueberschriebe sie.

if [ -z "$APP_IP" ]; then
  echo "❌ APP_IP fehlt." >&2
  exit 2
fi

# Laeuft dieses Skript AUF dem Zielknoten selbst, ist SSH auf die eigene Adresse
# unnoetig - und je nach Einrichtung unmoeglich. GEMESSEN AM 2026-09-24: in
# diesem Fall meldete die Pruefung "Caddy-Container existiert nicht", obwohl
# Caddy lief. Ein falsch-negatives Ergebnis ist schlimmer als keine Pruefung,
# weil es Vertrauen in einen Pruefstand setzt, der nicht messen kann.
# Der Flottenstart ruft das Skript vom Steuerrechner auf (SSH noetig); im
# Gegenbeweis laeuft es auf dem Knoten (SSH schaedlich). Beides muss gehen.
EIGENE_IPS="$(hostname -I 2>/dev/null || true)"
if printf '%s' " $EIGENE_IPS " | grep -q " $APP_IP "; then
  LOKAL=1
else
  LOKAL=0
fi

if [ "$LOKAL" = "1" ]; then
  auf() { bash -c "$*"; }
else
  auf() { ssh "${SSH_OPTS[@]}" "root@$APP_IP" "$@"; }
fi

echo "▶ TLS-Terminator auf $APP_IP prüfen (Domain $DOMAIN)$([ "$LOKAL" = "1" ] && echo ' [lokal]')"

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

# --- 6. Ist die Instanz BENUTZBAR - nicht nur erreichbar? -------------------
# GEMESSEN AM 2026-09-24, und der Grund fuer diesen Schritt:
#   POST /api/session -> HTTP 503 {"code":"STUDIO_TOKEN_MISSING"}
# Die Auth ist fail-closed. Fehlt STUDIO_ACCESS_TOKEN auf dem Knoten, antwortet
# JEDE /api-Route mit 503 - nur /api/health nicht. Die Startseite lieferte
# trotzdem 200. Die Instanz sah von aussen heil aus und war unbenutzbar, und
# diese Pruefung haette es gemeldet, wenn es sie damals schon gegeben haette.
#
# 503 mit STUDIO_TOKEN_MISSING = nicht konfiguriert  -> Fehler
# 401                          = konfiguriert, Token verlangt -> RICHTIG
# 200                          = offene Route -> auch in Ordnung
PROBE="$(curl -s -m 30 "https://$DOMAIN/api/session" -X POST -H 'Content-Type: application/json' -d '{}' 2>/dev/null)"
CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 30 "https://$DOMAIN/api/session" -X POST -H 'Content-Type: application/json' -d '{}' 2>/dev/null)"
echo "  Session-Route (Benutzbarkeit): HTTP ${CODE:-000}"
case "${CODE:-000}" in
  503)
    echo "" >&2
    echo "❌ DIE INSTANZ IST ERREICHBAR, ABER NICHT BENUTZBAR (HTTP 503)." >&2
    echo "   Antwort: ${PROBE:0:120}" >&2
    echo "   Das heisst: die Auth ist fail-closed und STUDIO_ACCESS_TOKEN fehlt auf dem Knoten." >&2
    echo "   Sofort:  grep -c '^STUDIO_ACCESS_TOKEN=' $DEPLOY_DIR/.env   (auf dem Knoten)" >&2
    echo "   Dauerhaft: der Portal-Worker muss das Secret haben, sonst faellt es beim" >&2
    echo "              naechsten Neuaufbau wieder weg:" >&2
    echo "                wrangler secret put STUDIO_ACCESS_TOKEN --name audiomonastry-portal" >&2
    echo "   Ein Container-Neustart genuegt NICHT: env_file wird nur beim Erzeugen gelesen." >&2
    exit 1
    ;;
  000)
    echo "❌ Die Session-Route ist nicht abfragbar - die Erreichbarkeit oben war also nicht stabil." >&2
    exit 1
    ;;
esac
echo "  ✓ Token ist konfiguriert (401 = Token verlangt ist die richtige Antwort)"

# --- 7. Und liefert sie auch Daten, wenn man den Token hat? -----------------
# Der Scrape-Token ist ein EIGENES Secret (SCRAPE_TOKEN). Fehlt es, ist das
# Monitoring blind - auch das fiel am 2026-09-24 erst durch 503/401 in den
# Zugriffsprotokollen auf, nicht durch eine Pruefung.
if [ -n "${SCRAPE_TOKEN:-}" ]; then
  MCODE="$(curl -s -o /dev/null -w '%{http_code}' -m 30 -H "Authorization: Bearer $SCRAPE_TOKEN" "https://$DOMAIN/api/metrics?format=prometheus" 2>/dev/null)"
  echo "  Metriken mit SCRAPE_TOKEN: HTTP ${MCODE:-000}"
  if [ "${MCODE:-000}" != "200" ]; then
    echo "❌ /api/metrics liefert mit gesetztem Token kein 200 - das Monitoring bleibt blind." >&2
    exit 1
  fi
  echo "  ✓ Monitoring kann Daten holen"
else
  echo "  (SCRAPE_TOKEN nicht uebergeben - Metrik-Pruefung uebersprungen)"
fi

echo "✅ Geprueft: Caddy stabil, 443 lauscht, Ursprung 200, oeffentlich 200, Instanz benutzbar."
exit 0
