#!/usr/bin/env bash
# =============================================================================
# lib/rtc-fleet.sh – Bausteine der SFU-/TURN-Verdrahtung (F6)
# -----------------------------------------------------------------------------
# Quelle (source) in Skripten, die auf dem KNOTEN laufen:
#
#   source "$(dirname "$0")/lib/rtc-fleet.sh"
#
# Warum eine Bibliothek: die drei Aussagen aus F6 -
#   (1) ENABLE_SFU=1 auf dem SFU-Knoten,
#   (2) SFU_ANNOUNCED_IP = OEFFENTLICHE IP zur Laufzeit,
#   (3) TURN-Strecke (coturn + kurzlebige Credentials in der App-.env)
# - wurden vorher an drei Stellen unabhaengig voneinander geraten. Hier stehen
# sie genau einmal, mit Tests (tests/test_hetzner_scripts.py).
#
# Die IP-Ermittlung ist bewusst mehrstufig und NIE hart kodiert:
#   1. ausdrueckliche Umgebungsvariable (Betreiberentscheidung),
#   2. /etc/audiomonastry-node.conf (vom Cloud-Init beim Boot geschrieben),
#   3. Hetzner-Cloud-Metadata (nur im Cloud-Netz erreichbar),
#   4. Aussenprobe ueber api.ipify.org.
# Eine PRIVATE Adresse wird nie akzeptiert: `hostname -I | awk '{print $1}'`
# liefert auf einem Knoten mit Hetzner-Privatnetz die 10.x-Adresse - genau
# damit war der SFU-Medienpfad von aussen unerreichbar (F6).
# =============================================================================

# --- Werte, die Code und Firewall/Doku gemeinsam benutzen --------------------
# Aenderung hier NUR zusammen mit provision.py, dem Portal-Worker und der
# Port-Tabelle in docs/HETZNER_DEPLOY.md (tests/test_hetzner_scripts.py prueft
# alle vier Stellen gegeneinander).
RTC_TURN_PORT="${RTC_TURN_PORT:-3478}"
RTC_TURN_MIN_PORT="${RTC_TURN_MIN_PORT:-49152}"
RTC_TURN_MAX_PORT="${RTC_TURN_MAX_PORT:-49201}"
NODE_IP_CONF="${NODE_IP_CONF:-/etc/audiomonastry-node.conf}"

# 1, wenn der Wert eine oeffentliche IPv4 ist (keine RFC1918/Loopback/Link-Local).
rtc_is_public_ipv4() {
  python3 - "$1" <<'PY' 2>/dev/null
import ipaddress, sys
try:
    addr = ipaddress.IPv4Address(sys.argv[1].strip())
except Exception:
    sys.exit(1)
ok = addr.is_global and not addr.is_private
print("ja" if ok else "nein")
PY
}

# Liest NODE_PUBLIC_IP aus der Cloud-Init-Datei (leer, wenn nicht vorhanden).
rtc_ip_from_node_conf() {
  local file="${1:-$NODE_IP_CONF}"
  [[ -f "$file" ]] || return 0
  sed -n 's/^[[:space:]]*NODE_PUBLIC_IP=//p' "$file" | head -1 | tr -d '"[:space:]'
}

# Ermittelt die oeffentliche IPv4. Reihenfolge und Begruendung:
#   1. ausdrueckliche Umgebungsvariable (Betreiberentscheidung),
#   2. Hetzner-Cloud-Metadata (lebt vom Ist-Zustand des Knotens),
#   3. /etc/audiomonastry-node.conf (Cloud-Init-Wert vom Boot - Fallback, wenn
#      die Metadata nicht erreichbar ist),
#   4. Aussenprobe ueber api.ipify.org.
# Gibt bei Misserfolg NICHTS aus (Exit 0) - der Aufrufer entscheidet, ob das ein
# harter Fehler ist (kein stiller Default).
rtc_resolve_public_ipv4() {
  local explicit="${1:-}" candidate=""
  candidate="${explicit:-${SFU_ANNOUNCED_IP:-${SFU_PUBLIC_IP:-}}}"
  if [[ -n "$candidate" ]]; then
    [[ "$(rtc_is_public_ipv4 "$candidate")" == "ja" ]] && { printf '%s\n' "$candidate"; return 0; }
    echo "  Hinweis: '$candidate' ist keine oeffentliche IPv4 - wird nicht verwendet." >&2
  fi

  # Hetzner-Cloud-Metadata: public-ipv4 steht im Metadata-Dokument.
  candidate="$(curl -fsS --max-time 5 http://169.254.169.254/hetzner/v1/metadata 2>/dev/null \
    | sed -n 's/^[[:space:]]*public-ipv4:[[:space:]]*//p' | head -1 | tr -d '"[:space:]' || true)"
  if [[ -n "$candidate" && "$(rtc_is_public_ipv4 "$candidate")" == "ja" ]]; then
    printf '%s\n' "$candidate"
    return 0
  fi

  candidate="$(rtc_ip_from_node_conf)"
  if [[ -n "$candidate" && "$(rtc_is_public_ipv4 "$candidate")" == "ja" ]]; then
    printf '%s\n' "$candidate"
    return 0
  fi

  candidate="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null | tr -d '[:space:]' || true)"
  if [[ -n "$candidate" && "$(rtc_is_public_ipv4 "$candidate")" == "ja" ]]; then
    printf '%s\n' "$candidate"
    return 0
  fi

  return 0
}

# Setzt/ersetzt KEY=VALUE idempotent in einer .env-Datei (GENAU eine Zeile).
# Der frueher genutzte Weg `grep -q KEY .env || echo KEY=... >> .env` laesst eine
# bereits vorhandene LEERE Zeile stehen - auf sfu-1 war genau deshalb
# SFU_ANNOUNCED_IP leer. Der Wert laeuft ueber ENVIRON (kein sed-Escaping).
rtc_env_upsert() {
  local file="$1" key="$2" value="$3"
  [[ -n "$file" && -n "$key" ]] || { echo "rtc_env_upsert: Datei und Key sind Pflicht" >&2; return 2; }
  [[ "$key" =~ ^[A-Z0-9_]+$ ]] || { echo "rtc_env_upsert: ungueltiger Key '$key'" >&2; return 2; }
  [[ -f "$file" ]] || : > "$file"
  local tmp
  tmp="$(mktemp "${file}.XXXXXX")"
  if RTC_KEY="$key" RTC_VALUE="$value" awk '
      BEGIN { key = ENVIRON["RTC_KEY"]; val = ENVIRON["RTC_VALUE"]; written = 0 }
      $0 ~ ("^" key "=") { if (!written) { print key "=" val; written = 1 } ; next }
      { print }
      END { if (!written) print key "=" val }
    ' "$file" > "$tmp"; then
    cat "$tmp" > "$file"
    rm -f "$tmp"
    return 0
  fi
  rm -f "$tmp"
  echo "rtc_env_upsert: Schreiben fehlgeschlagen ($file)" >&2
  return 1
}

# Liest KEY aus einer .env-Datei (leer, wenn nicht vorhanden).
rtc_env_get() {
  local file="$1" key="$2"
  [[ -f "$file" ]] || return 0
  sed -n "s/^${key}=//p" "$file" | tail -1
}

# Erzeugt die coturn-Laufzeitkonfiguration aus der eingecheckten Vorlage:
# Platzhalter ersetzen, Container-Besonderheiten ergaenzen, Rechte 0640.
# `mode=container` entfernt zusaetzlich `no-loopback-peers` (in coturn >= 4.6 kein
# Konfigurationsschluessel mehr -> nur Warnung) und setzt ein pidfile in /tmp.
rtc_render_turn_conf() {
  local template="$1" out="$2" secret="$3" relay_ip="$4" realm="$5" mode="${6:-container}"
  [[ -f "$template" ]] || { echo "rtc_render_turn_conf: Vorlage fehlt: $template" >&2; return 2; }
  [[ -n "$secret" ]] || { echo "rtc_render_turn_conf: Secret fehlt" >&2; return 2; }
  [[ -n "$relay_ip" ]] || { echo "rtc_render_turn_conf: Relay-IP fehlt" >&2; return 2; }

  local dir tmp
  dir="$(dirname "$out")"
  mkdir -p "$dir"
  tmp="$(mktemp "${out}.XXXXXX")"
  local -a sed_args=(
    -e "s|^static-auth-secret=.*|static-auth-secret=${secret}|"
    -e "s|^relay-ip=.*|relay-ip=${relay_ip}|"
    -e "s|^realm=.*|realm=${realm}|"
  )
  if [[ "$mode" == "container" ]]; then
    # Live-Befund 2026-09-20: `--log-file=stdout` auf der Kommandozeile gewinnt
    # NICHT gegen den Wert aus der Konfigurationsdatei. Ohne diese Zeile schreibt
    # der read-only-Container nach /var/log/turnserver.log und beendet sich mit
    # "ERROR: Cannot open log file for writing" - also genau der stille Ausfall,
    # den das Logging sichtbar machen soll.
    sed_args+=(-e "s|^log-file=.*|log-file=stdout|")
  fi
  # shellcheck disable=SC2016  # '&' ist hier Trennzeichen fuer sed, kein Shell-Ausdruck.
  sed "${sed_args[@]}" "$template" > "$tmp" || { rm -f "$tmp"; return 1; }

  {
    echo ""
    echo "# --- Laufzeitwerte (von scripts/hetzner/wire-rtc.sh erzeugt, NICHT einchecken) ---"
    if [[ "$mode" == "container" ]]; then
      echo "pidfile=/tmp/turnserver.pid"
    fi
  } >> "$tmp"

  if [[ "$mode" == "container" ]]; then
    # coturn/coturn:4.18.0 kennt `no-loopback-peers` nicht mehr (Loopback-Peers
    # sind dort per Default gesperrt) und loggt sonst
    # "WARNING Bad configuration format: no-loopback-peers".
    grep -v '^no-loopback-peers[[:space:]]*$' "$tmp" > "${tmp}.clean" || : > "${tmp}.clean"
    mv "${tmp}.clean" "$tmp"
  fi

  # Rechte: 0640 + Gruppe 65534. Der coturn-Container laeuft als nobody:nogroup
  # (65534:65534, siehe docker-compose.turn.yml) und MUSS die Datei lesen
  # koennen - live verifiziert: mit root:root 0640 startet der Relay ohne
  # Konfiguration ("Cannot find config file ... Default settings will be used",
  # also ohne Relay-IP, ohne Secret, ohne Haertung). Weltlesbar ist sie bewusst
  # nicht: in der Datei steht das static-auth-secret.
  if [[ "$(id -u)" == "0" ]]; then
    install -m 640 -o root -g 65534 "$tmp" "$out"
  else
    # Kein root (Tests, lokale Laeufe): Gruppe kann nicht gesetzt werden.
    install -m 640 "$tmp" "$out"
  fi
  local rc=$?
  rm -f "$tmp"
  return $rc
}

# TURN-URLs einer Rolle: UDP + TCP auf demselben Port (Client probiert beide).
rtc_turn_urls() {
  local ip="$1" port="${2:-$RTC_TURN_PORT}"
  printf 'turn:%s:%s?transport=udp,turn:%s:%s?transport=tcp' "$ip" "$port" "$ip" "$port"
}

# Signalisierungs-URL der SFU. Default ist die IP ueber HTTP - das ist fuer
# lokale/HTTP-Testaufbauten richtig, aber NICHT fuer den Produktivbetrieb: eine
# HTTPS-Seite (Cloudflare) darf kein http://-Ziel oeffnen (Mixed Content, der
# Browser blockiert die Verbindung). Fuer Produktion setzt der Betreiber
# SFU_PUBLIC_URL=https://sfu.<domain> (DNS-Eintrag + Zertifikat auf dem
# SFU-Knoten). rtc_sfu_url macht den Unterschied sichtbar statt still zu sein.
rtc_sfu_url() {
  local ip="$1" explicit="${2:-}"
  if [[ -n "$explicit" ]]; then
    printf '%s' "${explicit%/}"
    return 0
  fi
  printf 'http://%s' "$ip"
}

rtc_sfu_url_warning() {
  local url="$1"
  [[ "$url" == http://* ]] || return 0
  echo "  ⚠ SFU_SIGNALING_URL=$url ist HTTP: nur fuer lokale/HTTP-Testaufbauten." >&2
  echo "    Eine HTTPS-App (Produktion) darf kein http://-Ziel verbinden (Mixed Content)." >&2
  echo "    Fuer Produktion: SFU_PUBLIC_URL=https://sfu.<domain> (DNS-Record + Zertifikat auf dem SFU-Knoten)," >&2
  echo "    siehe docs/HETZNER_DEPLOY.md Abschnitt 'SFU + TURN'." >&2
}

# Die .env-Zeilen des SFU-Knotens (selbst-referenziell: seine IP ist die
# angekuendigte IP und das Relay-Ziel).
rtc_sfu_env_lines() {
  local ip="$1" realm="${2:-anunnakitools.de}" ttl="${3:-3600}" sfu_url="${4:-}"
  cat <<EOF
ENABLE_SFU=1
SFU_LISTEN_IP=0.0.0.0
SFU_ANNOUNCED_IP=$ip
SFU_SIGNALING_PATH=/sfu-signaling
SFU_SIGNALING_URL=$(rtc_sfu_url "$ip" "$sfu_url")
TURN_REALM=$realm
TURN_URLS=$(rtc_turn_urls "$ip")
TURN_TTL_SECONDS=$ttl
EOF
}

# Die .env-Zeilen des APP-Knotens: dort laeuft KEINE SFU (ENABLE_SFU=0), aber
# /api/webrtc-config muss die erreichbare SFU-URL und die TURN-Strecke liefern.
rtc_app_env_lines() {
  local sfu_ip="$1" ttl="${2:-3600}" sfu_url="${3:-}"
  cat <<EOF
ENABLE_SFU=0
SFU_SIGNALING_PATH=/sfu-signaling
SFU_SIGNALING_URL=$(rtc_sfu_url "$sfu_ip" "$sfu_url")
TURN_URLS=$(rtc_turn_urls "$sfu_ip")
TURN_TTL_SECONDS=$ttl
EOF
}
