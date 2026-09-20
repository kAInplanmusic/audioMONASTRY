#!/usr/bin/env bash
# =============================================================================
# wire-rtc.sh – SFU- und TURN-Verdrahtung eines Rollenknotens (F6)
# -----------------------------------------------------------------------------
# Laeuft AUF dem jeweiligen Knoten (app oder sfu) im Repo-Verzeichnis
# (/opt/audiomonastry) und schreibt die RTC-Zeilen in die Knoten-.env. Der Weg
# ist idempotent: mehrfaches Ausfuehren aendert nur, was sich wirklich aendert.
#
# Aufruf (Rollen-Deploy, bring-up-fleet.sh macht das automatisch):
#   bash scripts/hetzner/wire-rtc.sh sfu [--secret-stdin]
#   SFU_PUBLIC_IP=<ip-von-sfu-1> bash scripts/hetzner/wire-rtc.sh app [--secret-stdin]
#   bash scripts/hetzner/wire-rtc.sh sfu --print-config   (Trockenlauf, kein Netz/kein Schreiben)
#
# Umgebung:
#   TURN_STATIC_AUTH_SECRET   Secret des coturn-REST-Verfahrens (Pflicht; kommt
#                             aus der Betreiberumgebung, NIE aus dem Repo). Mit
#                             --secret-stdin wird es ueber stdin gelesen, damit
#                             es nicht in einer Prozessliste oder im Log landet.
#   SFU_ANNOUNCED_IP / SFU_PUBLIC_IP   oeffentliche IP (Override; sonst zur
#                             Laufzeit ermittelt: Metadata -> Cloud-Init-Datei ->
#                             Aussenprobe; siehe lib/rtc-fleet.sh).
#   SFU_PUBLIC_URL            Basis-URL der Signalisierung fuer die Clients
#                             (Default http://<oeffentliche-ip>; fuer den
#                             Produktivbetrieb https://sfu.<domain>, sonst
#                             blockiert der Browser die Verbindung als
#                             Mixed Content).
#   TURN_REALM                Default anunnakitools.de
#   ENV_FILE                  Ziel-.env (Default: .env im Repo-Verzeichnis)
#   TURN_CONF_OUT             Ziel der coturn-Laufzeitkonfiguration
#                             (Default: runtime/coturn/turnserver.conf, Rolle sfu)
#
# Was die Rollen bekommen:
#   sfu:  ENABLE_SFU=1, SFU_ANNOUNCED_IP=<oeffentliche IP>, SFU_SIGNALING_URL,
#         TURN_REALM/TURN_EXTERNAL_IP/TURN_URLS/TURN_TTL_SECONDS +
#         Laufzeitkonfiguration fuer coturn (docker-compose.turn.yml).
#   app:  ENABLE_SFU=0, SFU_SIGNALING_URL=http://<sfu-ip>, TURN_URLS (UDP+TCP),
#         TURN_TTL_SECONDS. Damit liefert /api/webrtc-config turn:-Eintraege mit
#         kurzlebigen Credentials, und der Client verbindet die SFU NICHT mehr
#         same-origin (dort liefert der App-Knoten die SPA aus - F6).
#   Das Secret selbst wird auf BEIDEN Knoten in die .env geschrieben (der
#   App-Server mintet die Credentials, coturn prueft sie).
# =============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
# shellcheck source=scripts/hetzner/lib/rtc-fleet.sh
source "$HERE/lib/rtc-fleet.sh"

ROLE="${1:-}"
shift || true
PRINT_CONFIG=0
SECRET_STDIN=0
for arg in "$@"; do
  case "$arg" in
    --print-config) PRINT_CONFIG=1 ;;
    --secret-stdin) SECRET_STDIN=1 ;;
    -h|--help) ROLE="" ;;
    *) echo "Unbekannte Option: $arg" >&2; exit 2 ;;
  esac
done

if [[ "$ROLE" != "sfu" && "$ROLE" != "app" ]]; then
  echo "Nutzung: $0 sfu|app [--print-config] [--secret-stdin]" >&2
  exit 2
fi

ENV_FILE="${ENV_FILE:-$REPO_ROOT/.env}"
TURN_REALM="${TURN_REALM:-anunnakitools.de}"
TURN_TTL_SECONDS="${TURN_TTL_SECONDS:-3600}"
TURN_CONF_OUT="${TURN_CONF_OUT:-$REPO_ROOT/runtime/coturn/turnserver.conf}"

secret_source="Umgebung (TURN_STATIC_AUTH_SECRET)"
secret="${TURN_STATIC_AUTH_SECRET:-}"
if [[ "$SECRET_STDIN" == "1" ]]; then
  secret="$(head -1)"
  secret_source="stdin (--secret-stdin)"
fi
secret="${secret//[[:space:]]/}"
if [[ -z "$secret" ]]; then
  # Dritte Quelle: der Wert, der schon auf dem Knoten liegt (z. B. vom
  # Portal-Worker in die .env geschrieben, oder aus einem frueheren Lauf).
  # Bewusst VOR dem Fehlerfall: ein erneutes Verdrahten darf das Secret NICHT
  # rotieren (rotierende Secrets brechen laufende Clients).
  secret="$(rtc_env_get "$ENV_FILE" TURN_STATIC_AUTH_SECRET)"
  secret="${secret//[[:space:]]/}"
  [[ -n "$secret" ]] && secret_source="bestehende .env ($ENV_FILE, kein Rotieren)"
fi

# Die eigene IP dieses Knotens (Rolle sfu) bzw. die IP des SFU-Knotens (Rolle app).
if [[ "$ROLE" == "app" ]]; then
  sfu_ip="${SFU_PUBLIC_IP:-${SFU_ANNOUNCED_IP:-}}"
else
  sfu_ip=""
fi

if [[ "$PRINT_CONFIG" == "1" ]]; then
  echo "wire-rtc.sh - Trockenlauf (kein Netzaufruf, kein Schreiben)"
  echo "  Rolle:            $ROLE"
  echo "  Ziel-.env:        $ENV_FILE"
  echo "  Secret:           $([[ -n "$secret" ]] && echo "gesetzt (${#secret} Zeichen, Wert wird nie ausgegeben)" || echo "FEHLT - Lauf waere ein Fehler")"
  echo "  Secret-Quelle:    $secret_source"
  echo "  Realm:            $TURN_REALM"
  echo "  SFU-Signalisierungs-URL: ${SFU_PUBLIC_URL:-http://<oeffentliche-ip>}   (SFU_PUBLIC_URL ueberschreibt)"
  echo "  TURN-Relay-Ports: ${RTC_TURN_MIN_PORT}-${RTC_TURN_MAX_PORT} (Firewall der Rolle sfu)"
  echo "  IP-Ermittlung:    Umgebungsvariablen -> Hetzner-Metadata -> ${NODE_IP_CONF} -> api.ipify.org"
  if [[ "$ROLE" == "sfu" ]]; then
    echo "  IP-Quelle:        zur Laufzeit (SFU_ANNOUNCED_IP wird NICHT hart kodiert)"
    echo "  coturn-Konfig:    $TURN_CONF_OUT (aus services/turn/turnserver.conf, Modus container)"
    echo "  .env-Zeilen:"
    rtc_sfu_env_lines "<oeffentliche-ip>" "$TURN_REALM" "$TURN_TTL_SECONDS" | sed 's/^/    /'
  else
    echo "  SFU-IP (SFU_PUBLIC_IP der Rolle sfu): ${sfu_ip:-<fehlt - Lauf waere ein Fehler>}"
    echo "  .env-Zeilen:"
    rtc_app_env_lines "${sfu_ip:-<sfu-ip>}" "$TURN_TTL_SECONDS" | sed 's/^/    /'
  fi
  echo "  TURN_STATIC_AUTH_SECRET wird in beiden Rollen in die .env geschrieben."
  exit 0
fi

if [[ -z "$secret" ]]; then
  echo "FEHLER: TURN_STATIC_AUTH_SECRET fehlt." >&2
  echo "  Secret erzeugen:  openssl rand -hex 32" >&2
  echo "  Ohne Secret koennte der Relay zwar starten, aber /api/webrtc-config" >&2
  echo "  liefert dann KEINE turn:-Eintraege - genau der Zustand aus F6." >&2
  exit 1
fi

if [[ "$ROLE" == "sfu" ]]; then
  # Ein ausdruecklich gesetzter Wert ist eine Betreiberentscheidung: ist er keine
  # oeffentliche IPv4 (z. B. die 10.x-Adresse aus `hostname -I`), bricht der Lauf
  # ab - ein stiller Wechsel auf eine andere IP waere genau die Klasse Fehler,
  # die F6 ausgeloest hat.
  if [[ -n "${SFU_ANNOUNCED_IP:-}" && "$(rtc_is_public_ipv4 "$SFU_ANNOUNCED_IP")" != "ja" ]]; then
    echo "FEHLER: SFU_ANNOUNCED_IP='$SFU_ANNOUNCED_IP' ist keine oeffentliche IPv4." >&2
    echo "  Erwartet: die OEFFENTLICHE Adresse des Knotens. Die private Addresse aus" >&2
    echo "  'hostname -I' ist der Fehler aus F6 - von aussen sind solche" >&2
    echo "  ICE-Kandidaten nicht erreichbar." >&2
    exit 1
  fi
  ip="$(rtc_resolve_public_ipv4 "${SFU_ANNOUNCED_IP:-}")"
  if [[ -z "$ip" ]]; then
    echo "FEHLER: oeffentliche IPv4 nicht ermittelbar (Rolle sfu)." >&2
    echo "  Geprueft: SFU_ANNOUNCED_IP/SFU_PUBLIC_IP, Hetzner-Metadata, ${NODE_IP_CONF}, api.ipify.org" >&2
    echo "  Ohne oeffentliche IP kündigt Mediasoup Adressen an, die von aussen nicht" >&2
    echo "  erreichbar sind (F6) - deshalb bricht der Lauf hier ab (kein Default)." >&2
    exit 1
  fi
  sfu_url="$(rtc_sfu_url "$ip" "${SFU_PUBLIC_URL:-}")"
  rtc_sfu_url_warning "$sfu_url"
  echo "=== RTC-Verdrahtung Rolle sfu (IP $ip, Signalisierung $sfu_url, Secret ${#secret} Zeichen) ==="
  while IFS= read -r line; do
    key="${line%%=*}"
    rtc_env_upsert "$ENV_FILE" "$key" "${line#*=}"
  done < <(rtc_sfu_env_lines "$ip" "$TURN_REALM" "$TURN_TTL_SECONDS" "${SFU_PUBLIC_URL:-}")
  rtc_env_upsert "$ENV_FILE" TURN_STATIC_AUTH_SECRET "$secret"

  rtc_render_turn_conf "$REPO_ROOT/services/turn/turnserver.conf" "$TURN_CONF_OUT" \
    "$secret" "$ip" "$TURN_REALM" container
  # Caddy auf dem SFU-Knoten: Site-Adresse passend zur Signalisierungs-URL.
  # Mit https://sfu.<domain> holt Caddy per ACME ein Zertifikat (Port 80/443 sind
  # offen, DNS zeigt direkt - kein Cloudflare-Proxy vor WebRTC). Ohne diesen
  # Schritt bliebe die vom App-Knoten geerbte DOMAIN stehen und Caddy liefe auf
  # dem SFU-Knoten in eine ACME-Schleife fuer die fremde Domain.
  if [[ "$sfu_url" == https://* ]]; then
    sfu_domain="${sfu_url#https://}"
    sfu_domain="${sfu_domain%%/*}"
    rtc_env_upsert "$ENV_FILE" DOMAIN "$sfu_domain"
    echo "  DOMAIN=$sfu_domain (TLS/ACME fuer den SFU-Host; DNS-Record muss existieren)"
  else
    rtc_env_upsert "$ENV_FILE" DOMAIN ""
    echo "  DOMAIN= (leer -> Caddy auf :80; reiner HTTP-Testaufbau)"
  fi
  echo "  .env aktualisiert: $ENV_FILE (ENABLE_SFU=1, SFU_ANNOUNCED_IP=$ip, TURN_*)"
  echo "  coturn-Konfiguration: $TURN_CONF_OUT (Rechte 0640, Secret nicht eingecheckt)"
  echo "  Naechster Schritt: docker compose -f docker-compose.hetzner.yml -f docker-compose.sfu.yml -f docker-compose.turn.yml up -d caddy audiomonastry coturn"
  exit 0
fi

# Rolle app
if [[ -z "$sfu_ip" ]]; then
  echo "FEHLER: SFU_PUBLIC_IP fehlt (Rolle app)." >&2
  echo "  Der App-Knoten braucht fuer TURN_URLS und SFU_SIGNALING_URL die" >&2
  echo "  oeffentliche IP des SFU-Knotens: SFU_PUBLIC_IP=<sfu-ip> bash $0 app" >&2
  exit 1
fi
if [[ "$(rtc_is_public_ipv4 "$sfu_ip")" != "ja" ]]; then
  echo "FEHLER: '$sfu_ip' ist keine oeffentliche IPv4 (Rolle app)." >&2
  exit 1
fi

app_sfu_url="$(rtc_sfu_url "$sfu_ip" "${SFU_PUBLIC_URL:-}")"
rtc_sfu_url_warning "$app_sfu_url"
echo "=== RTC-Verdrahtung Rolle app (SFU $sfu_ip, Signalisierung $app_sfu_url, Secret ${#secret} Zeichen) ==="
while IFS= read -r line; do
  key="${line%%=*}"
  rtc_env_upsert "$ENV_FILE" "$key" "${line#*=}"
done < <(rtc_app_env_lines "$sfu_ip" "$TURN_TTL_SECONDS" "${SFU_PUBLIC_URL:-}")
rtc_env_upsert "$ENV_FILE" TURN_STATIC_AUTH_SECRET "$secret"
echo "  .env aktualisiert: $ENV_FILE (ENABLE_SFU=0, SFU_SIGNALING_URL=http://$sfu_ip, TURN_URLS=$(rtc_turn_urls "$sfu_ip"))"
echo "  Naechster Schritt: docker compose -f docker-compose.hetzner.yml up -d audiomonastry"
