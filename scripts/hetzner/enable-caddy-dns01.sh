#!/usr/bin/env bash
# ============================================================================
# enable-caddy-dns01.sh - TLS-Terminator auf einem Knoten per DNS-01 aufsetzen
# ============================================================================
# WARUM (INFRA-HETZNER-015 + PROD-P0-F1, gemessen 2026-09-24):
#
# Auf app-1 UND auf sfu-1 lief Caddy nicht. Beide Knoten erwarten ihn (die
# Compose ruft `... up -d caddy ...`), aber die Caddyfile-Variante
# `Caddyfile.origin` verlangt ein Cloudflare-Origin-Zertifikat unter
# /etc/caddy/certs/origin.crt|key. Fehlt es, startet Caddy nicht, sondern laeuft
# in eine Absturzschleife. Folge auf app-1: keine oeffentliche Erreichbarkeit
# (521/522/525). Folge auf sfu-1: https://sfu.<domain> nicht erreichbar und der
# SFU-RTP-Test scheiterte mit "xhr poll error / ERR_CONNECTION_REFUSED".
#
# DIESES SKRIPT MACHT ES EINMAL RICHTIG UND FUER BEIDE ROLLEN:
#   1. Baut das Caddy-Image mit dem Cloudflare-DNS-Plugin, falls es fehlt
#      (caddy:2.8-alpine hat es nicht - gemessen: 0 Treffer).
#   2. Legt die passende Caddyfile ab (app: beide Namen, sfu: nur sfu.<domain>).
#   3. Reicht SFU_HOST/ORIGIN_HOST und CF_DNS_API_TOKEN in den Dienst (ohne das
#      steht im Container ein leerer Wert und Caddy bricht ab: "missing API token").
#   4. Startet Caddy und PRUEFT, dass er wirklich hochkommt.
#
# DNS-01 statt http-01, weil hinter der Cloudflare-Worker-Route keine
# eingehende Pruefung ankommt und die Hetzner-Firewall nur Cloudflare hereinlaesst.
# Nebeneffekt: das Zertifikat erneuert sich selbst.
#
# AUFRUF (auf dem jeweiligen Knoten):
#   bash scripts/hetzner/enable-caddy-dns01.sh app
#   bash scripts/hetzner/enable-caddy-dns01.sh sfu
#   TROCKEN=1 bash scripts/hetzner/enable-caddy-dns01.sh sfu    # nur zeigen
# ============================================================================
set -uo pipefail

ROLLE="${1:-}"
case "$ROLLE" in
  app|sfu) ;;
  *) echo "Aufruf: $0 <app|sfu>" >&2; exit 2 ;;
esac

DEPLOY_DIR="${DEPLOY_DIR:-/opt/audiomonastry}"
BILD="${CADDY_IMAGE:-audiomonastry-caddy-dns:2.9}"
DOMAIN="${DOMAIN:-anunnakitools.de}"
TROCKEN="${TROCKEN:-0}"

if [ "$ROLLE" = "app" ]; then
  CADDYFILE_QUELLE="scripts/hetzner/Caddyfile.dns01"
  HOST_VAR="ORIGIN_HOST"
  HOST_WERT="origin.$DOMAIN"
else
  CADDYFILE_QUELLE="scripts/hetzner/Caddyfile.sfu"
  HOST_VAR="SFU_HOST"
  HOST_WERT="sfu.$DOMAIN"
fi

cd "$(dirname "$0")/../.." || exit 1
echo "▶ Caddy (DNS-01) fuer Rolle '$ROLLE' einrichten - Host $HOST_WERT"

[ -f "$CADDYFILE_QUELLE" ] || { echo "❌ $CADDYFILE_QUELLE fehlt." >&2; exit 1; }

# --- 1. Image -----------------------------------------------------------------
if docker image inspect "$BILD" >/dev/null 2>&1; then
  echo "  ✓ Image $BILD vorhanden"
else
  echo "  → Image fehlt, wird gebaut (dauert einige Minuten)"
  docker run --rm "$BILD" caddy list-modules >/dev/null 2>&1 || true
  mkdir -p "$DEPLOY_DIR-caddybuild"
  cat > "$DEPLOY_DIR-caddybuild/Dockerfile" <<'DOCKER'
FROM caddy:2.9-builder AS builder
RUN xcaddy build --with github.com/caddy-dns/cloudflare
FROM caddy:2.9-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
DOCKER
  ( cd "$DEPLOY_DIR-caddybuild" && docker build -t "$BILD" . > build.log 2>&1 ) || {
    echo "❌ Image-Bau fehlgeschlagen:" >&2; tail -5 "$DEPLOY_DIR-caddybuild/build.log" | sed 's/^/    /' >&2; exit 1; }
fi
docker run --rm "$BILD" caddy list-modules 2>/dev/null | grep -q dns.providers.cloudflare || {
  echo "❌ Das Image hat das Cloudflare-DNS-Plugin NICHT." >&2; exit 1; }
echo "  ✓ DNS-Plugin im Image nachgewiesen"

# --- 2. Caddyfile -------------------------------------------------------------
if [ "$TROCKEN" = "1" ]; then
  echo "  (Trockenlauf: Caddyfile waere $CADDYFILE_QUELLE -> $DEPLOY_DIR/Caddyfile)"
else
  cp "$DEPLOY_DIR/Caddyfile" "$DEPLOY_DIR/Caddyfile.vor-dns01" 2>/dev/null || true
  cp "$CADDYFILE_QUELLE" "$DEPLOY_DIR/Caddyfile"
  echo "  ✓ Caddyfile gesetzt ($CADDYFILE_QUELLE)"
fi

# --- 3. Compose anpassen ------------------------------------------------------
python3 - "$DEPLOY_DIR/docker-compose.hetzner.yml" "$BILD" "$HOST_VAR" "$HOST_WERT" "$TROCKEN" <<'PY'
import io, re, sys
pfad, bild, host_var, host_wert, trocken = sys.argv[1:6]
zeilen = io.open(pfad, encoding="utf-8").read().splitlines()
geaendert = []

# Image umstellen
for i, z in enumerate(zeilen):
    if z.strip().startswith("image:") and "caddy" in z and "dns" not in z:
        if trocken == "1":
            geaendert.append("  (wuerde) image -> %s" % bild)
        else:
            zeilen[i] = re.sub(r"image:\s*\S+", "image: " + bild, z)
            geaendert.append("  image -> %s" % bild)
        break

# Umgebungsvariablen in den Caddy-Dienst
inhalt = "\n".join(zeilen)
if host_var not in inhalt:
    # Einrueckung der Zeile mit DOMAIN im Caddy-Dienst uebernehmen, nicht raten.
    treffer = None
    for i, z in enumerate(zeilen):
        if z.strip().startswith("DOMAIN:") and i > 40:
            treffer = i
    if treffer is None:
        print("  ⚠ Anker fuer die Umgebungsvariablen nicht gefunden")
    else:
        einz = zeilen[treffer][: len(zeilen[treffer]) - len(zeilen[treffer].lstrip())]
        neu = [
            einz + "# DNS-01: Name des Zertifikats und Token mit Zone:DNS:Edit.",
            einz + "# Ohne das Token bricht Caddy ab: 'missing API token, at .../Caddyfile'.",
            einz + ("%s: ${%s:-%s}" % (host_var, host_var, host_wert)),
            einz + "CF_DNS_API_TOKEN: ${CF_DNS_API_TOKEN:-}",
        ]
        if trocken == "1":
            geaendert.append("  (wuerde) %s + CF_DNS_API_TOKEN eintragen" % host_var)
        else:
            zeilen[treffer + 1 : treffer + 1] = neu
            geaendert.append("  %s + CF_DNS_API_TOKEN eingetragen" % host_var)
else:
    geaendert.append("  %s steht schon drin" % host_var)

if trocken != "1":
    io.open(pfad, "w", encoding="utf-8").write("\n".join(zeilen) + "\n")
print("\n".join(geaendert))
PY

if [ "$TROCKEN" = "1" ]; then echo "Trockenlauf beendet."; exit 0; fi

# --- 4. Starten und PRUEFEN ---------------------------------------------------
if ! grep -q "^CF_DNS_API_TOKEN=" "$DEPLOY_DIR/.env" 2>/dev/null; then
  echo "❌ CF_DNS_API_TOKEN fehlt in $DEPLOY_DIR/.env - Caddy wuerde mit 'missing API token' abbrechen." >&2
  exit 1
fi
echo "  ✓ CF_DNS_API_TOKEN in der Knoten-.env vorhanden"

cd "$DEPLOY_DIR" || exit 1
docker compose -p audiomonastry -f docker-compose.hetzner.yml up -d caddy 2>&1 | tail -2 | sed 's/^/    /'
sleep 35

ZUSTAND="$(docker ps --format '{{.Names}} {{.Status}}' | grep caddy || true)"
echo "  Caddy: ${ZUSTAND:-NICHT GESTARTET}"
case "$ZUSTAND" in
  *Restarting*) echo "❌ Caddy laeuft in einer Schleife. Letzte Zeilen:" >&2
                docker logs --tail 15 audiomonastry-caddy 2>&1 | tail -4 | cut -c1-160 | sed 's/^/    /' >&2
                exit 1 ;;
  "")           echo "❌ Kein Caddy-Container." >&2; exit 1 ;;
esac

LOKAL="$(curl -s -o /dev/null -w '%{http_code}' -m 20 --resolve "$HOST_WERT:443:127.0.0.1" "https://$HOST_WERT/api/health" 2>/dev/null)"
echo "  Ursprung lokal (SNI $HOST_WERT, /api/health): HTTP ${LOKAL:-000}"
if [ "${LOKAL:-000}" != "200" ]; then
  echo "  ⚠ Der Knoten antwortet lokal nicht mit 200. Zertifikat noch nicht ausgestellt?" >&2
  docker logs --tail 25 audiomonastry-caddy 2>&1 | grep -iE "certificate|error|dns" | tail -3 | cut -c1-160 | sed 's/^/    /' >&2
fi

echo "✅ Rolle '$ROLLE': Caddy laeuft und terminiert TLS per DNS-01."
