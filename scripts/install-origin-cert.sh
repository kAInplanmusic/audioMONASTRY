#!/usr/bin/env bash
# ============================================================================
# Origin-Zertifikat einbauen (PROD-P0-F1)
# ============================================================================
# WARUM DAS GEBRAUCHT WIRD (gemessen 2026-09-24):
#   Caddy auf app-1 lief in einer Absturzschleife:
#     Error: loading certificates: open /etc/caddy/certs/origin.crt: no such file or directory
#   Ohne Caddy hoert nichts auf 80/443, Cloudflare antwortet mit 521. Die App
#   selbst war die ganze Zeit healthy auf 8080.
#
# WARUM KEIN SELBSTSIGNIERTES ZERTIFIKAT GENUEGT:
#   Der SSL-Modus der Zone ist "strict" (gemessen). Cloudflare prueft das
#   Zertifikat des Ursprungs also wirklich. Es muss ein Cloudflare-Origin-CA-
#   Zertifikat sein. Ein selbstsigniertes wuerde 526 ergeben, und den Modus auf
#   "full" herunterzusetzen waere eine Verschlechterung der Sicherheit - die
#   entscheidet der Betreiber, nicht dieses Skript.
#
# WARUM KEIN LET'S ENCRYPT:
#   app-1 faehrt Origin-TLS HINTER der Worker-Route. http-01 und tls-alpn-01
#   laufen dort in eine Retry-Schleife (so steht es in deploy.sh), und die
#   Hetzner-Firewall laesst ausserdem nur Cloudflare herein.
#
# WAS DIESES SKRIPT TUT
#   Es nimmt Zertifikat und Schluessel (aus Datei oder base64), legt sie als
#   certs/origin.crt|key ab (0600) und bringt sie auf den Knoten. Danach wird
#   geprueft, ob Caddy hochkommt und die Domain antwortet.
#
# AUFRUF
#   # Variante A: Dateien
#   CERT_DATEI=/pfad/origin.crt KEY_DATEI=/pfad/origin.key bash scripts/install-origin-cert.sh
#
#   # Variante B: base64 in der Umgebung (so erwartet es deploy.sh)
#   ORIGIN_CERT="$(base64 -w0 origin.crt)" ORIGIN_KEY="$(base64 -w0 origin.key)" \
#     bash scripts/install-origin-cert.sh
#
#   APP_IP=<ip>   Zielknoten (Vorgabe: aus der Hetzner-API geholt)
#   NUR_LOKAL=1   nur certs/ fuellen, nicht auf den Knoten bringen
# ============================================================================
set -uo pipefail

SKRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SKRIPT_DIR/.." && pwd)"
cd "$REPO" || { echo "Repo nicht gefunden"; exit 1; }

CERT="${CERT_DATEI:-}"
KEY="${KEY_DATEI:-}"

# base64 aus der Umgebung entgegennehmen (Variante B).
if [ -z "$CERT" ] && [ -n "${ORIGIN_CERT:-}" ]; then
  printf '%s' "$ORIGIN_CERT" | base64 -d > /tmp/origin-einbau.crt 2>/dev/null || {
    printf '%s' "$ORIGIN_CERT" > /tmp/origin-einbau.crt   # schon Klartext
  }
  CERT=/tmp/origin-einbau.crt
fi
if [ -z "$KEY" ] && [ -n "${ORIGIN_KEY:-}" ]; then
  printf '%s' "$ORIGIN_KEY" | base64 -d > /tmp/origin-einbau.key 2>/dev/null || {
    printf '%s' "$ORIGIN_KEY" > /tmp/origin-einbau.key
  }
  KEY=/tmp/origin-einbau.key
fi

if [ -z "$CERT" ] || [ -z "$KEY" ]; then
  cat <<'HILFE'
Kein Zertifikat uebergeben.

So kommt man an ein Cloudflare-Origin-Zertifikat:
  Cloudflare-Konsole -> SSL/TLS -> Origin Server -> Create Certificate
    Hostnamen: origin.anunnakitools.de, anunnakitools.de, *.anunnakitools.de
    Gueltigkeit: 15 Jahre
  Danach Zertifikat UND privaten Schluessel hier uebergeben.

Mit einem API-Token, das die Berechtigung "Origin CA" hat, geht es auch per
Schnittstelle - dabei bleibt der private Schluessel lokal (CSR liegt bereit):
  CSR=/tmp/origin.csr   (Schluessel: certs/origin.key, bereits erzeugt)
HILFE
  exit 2
fi

# --- 1. Pruefen: passt der Schluessel zum Zertifikat? ------------------------
CERTSHA="$(openssl x509 -in "$CERT" -noout -pubkey 2>/dev/null | openssl dgst -sha256 | awk '{print $2}')"
KEYSHA="$(openssl pkey -in "$KEY" -pubout 2>/dev/null | openssl dgst -sha256 | awk '{print $2}')"
if [ -z "$CERTSHA" ] || [ -z "$KEYSHA" ]; then
  echo "FEHLER: Zertifikat oder Schluessel ist nicht lesbar (PEM erwartet)."
  exit 1
fi
if [ "$CERTSHA" != "$KEYSHA" ]; then
  # Das ist der haeufigste Fehler beim Einbau - deshalb wird er VOR dem
  # Ausrollen geprueft und nicht erst am Absturz von Caddy.
  echo "FEHLER: Der Schluessel passt NICHT zum Zertifikat."
  echo "  Zertifikat: $CERTSHA"
  echo "  Schluessel: $KEYSHA"
  exit 1
fi
echo "✅ Schluessel passt zum Zertifikat ($CERTSHA)"

# --- 2. Gueltigkeit und Namen zeigen ----------------------------------------
echo "--- Zertifikat ---"
openssl x509 -in "$CERT" -noout -subject -issuer -dates 2>/dev/null | sed 's/^/  /'
openssl x509 -in "$CERT" -noout -ext subjectAltName 2>/dev/null | tail -1 | sed 's/^/  Namen:/'
if ! openssl x509 -in "$CERT" -noout -issuer 2>/dev/null | grep -qi "cloudflare"; then
  echo "  ⚠ Aussteller ist nicht Cloudflare - bei SSL-Modus 'strict' wird das abgelehnt."
fi

# --- 3. Lokal ablegen -------------------------------------------------------
mkdir -p certs && chmod 700 certs
cp "$CERT" certs/origin.crt
cp "$KEY"  certs/origin.key
chmod 600 certs/origin.crt certs/origin.key
echo "✅ certs/origin.crt + certs/origin.key gesetzt (0600)"

# --- 4. base64 fuer deploy.sh bereitstellen ---------------------------------
{
  echo ""
  echo "# Origin-Zertifikat (PROD-P0-F1) - base64 fuer deploy.sh."
  echo "# Ein Deploy setzt daraus certs/origin.crt|key auf dem Knoten."
  echo "ORIGIN_CERT=$(base64 -w0 < certs/origin.crt)"
  echo "ORIGIN_KEY=$(base64 -w0 < certs/origin.key)"
} >> .env
chmod 600 .env
echo "✅ ORIGIN_CERT/ORIGIN_KEY in .env ergaenzt"

[ "${NUR_LOKAL:-0}" = "1" ] && { echo "NUR_LOKAL=1 - Ende."; exit 0; }

# --- 5. Auf den Knoten bringen und Caddy neu starten ------------------------
if [ -z "${APP_IP:-}" ]; then
  HC="$(grep -m1 '^HCLOUD_TOKEN=' .env | cut -d= -f2- | tr -d '"')"
  APP_IP="$(curl -s -m 20 "https://api.hetzner.cloud/v1/servers" -H "Authorization: Bearer $HC" \
    | jq -r '.servers[] | select(.name|test("app-1")) | .public_net.ipv4.ip' | head -1)"
fi
if [ -z "$APP_IP" ]; then
  echo "❌ Keine app-1 gefunden - APP_IP bitte setzen."; exit 1
fi
echo "--- Zielknoten: $APP_IP ---"

# Das Verzeichnis certs/ ist vom rsync ausgeschlossen (deploy.sh schuetzt es).
# Deshalb wird direkt kopiert.
ssh -o StrictHostKeyChecking=no -o ConnectTimeout=12 "root@$APP_IP" \
  'mkdir -p /opt/audioMONASTRY/certs && chmod 700 /opt/audioMONASTRY/certs' || {
  echo "❌ SSH auf $APP_IP fehlgeschlagen."; exit 1
}
scp -o StrictHostKeyChecking=no -q certs/origin.crt certs/origin.key "root@$APP_IP:/opt/audioMONASTRY/certs/" || {
  echo "❌ Kopieren fehlgeschlagen."; exit 1
}
ssh -o StrictHostKeyChecking=no "root@$APP_IP" \
  'chmod 600 /opt/audioMONASTRY/certs/origin.crt /opt/audioMONASTRY/certs/origin.key && chown root:root /opt/audioMONASTRY/certs/* && cd /opt/audioMONASTRY && docker compose restart caddy 2>&1 | tail -2' || {
  echo "❌ Neustart von Caddy fehlgeschlagen."; exit 1
}

# --- 6. Pruefen, ob Caddy wirklich hochkommt --------------------------------
echo "--- Warte auf Caddy (max 60s) ---"
for i in $(seq 1 12); do
  zustand="$(ssh -o StrictHostKeyChecking=no "root@$APP_IP" \
    'docker ps --format "{{.Names}} {{.Status}}" | grep caddy' 2>/dev/null)"
  echo "  $zustand"
  case "$zustand" in
    *"Up "*) echo "✅ Caddy laeuft"; break ;;
  esac
  [ "$i" = "12" ] && { echo "❌ Caddy kommt nicht hoch. Protokoll:"; ssh -o StrictHostKeyChecking=no "root@$APP_IP" 'docker logs --tail 12 audiomonastry-caddy 2>&1' | sed 's/^/    /'; exit 1; }
  sleep 5
done

echo "--- Gegenprobe von aussen ---"
CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 30 https://anunnakitools.de/api/health)"
echo "  https://anunnakitools.de/api/health -> HTTP $CODE"
if [ "$CODE" = "200" ]; then
  echo "✅ Erledigt. Die Instanz ist oeffentlich erreichbar."
else
  echo "⚠ Noch nicht 200. DNS braucht ggf. noch TTL; sonst Protokoll oben pruefen."
fi
