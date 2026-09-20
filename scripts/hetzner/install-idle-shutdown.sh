#!/usr/bin/env bash
# =============================================================================
# audioMONASTRY Hetzner Idle-Auto-Shutdown installer.
#
# Usage:
#   sudo bash scripts/hetzner/install-idle-shutdown.sh
#   sudo bash scripts/hetzner/install-idle-shutdown.sh --print-units   # Trockenlauf
#
# F9-Fix (docs/FIXPLAN_2026-09-20_externer_apptest.md, F9)
# -------------------------------------------------------
# Der Timer feuerte gegen ein Primaersignal, das strukturell immer 0 war (Caddy
# antwortet auf Klartext-http mit 308, /api/online verlangt in Produktion einen
# Token -> 401; beides endete in der 0 des awk-END-Blocks). Version 1 dieses
# Installers gab dem Timer keinerlei Zugang zur App - er konnte also gar nicht
# anders als "0 Nutzer" messen.
#
# Deshalb:
#   * Der Timer fragt jetzt `GET /api/idle-signal` DIREKT auf dem App-Port
#     (Default 127.0.0.1:8080) - nicht ueber Caddy/Port 80.
#   * Zugang per x-scrape-token (Fallback Studio-Token) aus
#     /etc/audiomonastry/idle-check.env (Modus 0600, wird hier angelegt; ein
#     vorhandener Token wird aus der App-.env uebernommen - der Wert selbst wird
#     nie ausgegeben).
#   * `--print-units` gibt beide Unit-Dateien aus, ohne etwas zu installieren -
#     damit ist der Unit-Inhalt offline pruefbar (`systemd-analyze verify`).
# =============================================================================
set -euo pipefail

IDLE_MINUTES="${IDLE_MINUTES:-30}"
CHECK_INTERVAL="${CHECK_INTERVAL:-5}"
SERVICE=audiomonastry-idle-shutdown
LOG=/var/log/audiomonastry-idle-shutdown.log
HERE_SRC="$(dirname "$0")/systemd/idle-check.sh"
ENV_DIR=/etc/audiomonastry
TOKEN_ENV_FILE="${TOKEN_ENV_FILE:-${ENV_DIR}/idle-check.env}"
APP_ENV_FILE="${APP_ENV_FILE:-/opt/audiomonastry/.env}"
PRINT_UNITS=0

for arg in "$@"; do
  case "$arg" in
    --print-units) PRINT_UNITS=1 ;;
    -h|--help) sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "[warn] unbekanntes Argument '$arg' (ignoriert)" >&2 ;;
  esac
done

service_unit() {
  cat << UNIT
[Unit]
Description=audioMONASTRY idle shutdown check
After=network.target

[Service]
Type=oneshot
Environment=IDLE_MINUTES=${IDLE_MINUTES}
Environment=CHECK_INTERVAL=${CHECK_INTERVAL}
Environment=LOG=${LOG}
# F9: Zugang des Maschinen-Clients (x-scrape-token) + Ziel-URL. Optionales
# Praefix '-': fehlt die Datei, laeuft der Check fail-safe (kein Shutdown).
EnvironmentFile=-${TOKEN_ENV_FILE}
ExecStart=/usr/local/bin/audiomonastry-idle-check.sh
StandardOutput=append:${LOG}
StandardError=append:${LOG}
UNIT
}

timer_unit() {
  cat << TIMER
[Unit]
Description=audioMONASTRY idle check every ${CHECK_INTERVAL} minutes
After=network.target

[Timer]
OnBootSec=5min
OnUnitActiveSec=${CHECK_INTERVAL}min
Unit=${SERVICE}.service

[Install]
WantedBy=timers.target
TIMER
}

if [[ "$PRINT_UNITS" == "1" ]]; then
  service_unit
  echo "---8<---"
  timer_unit
  exit 0
fi

if [[ ! -f "$HERE_SRC" ]]; then
  echo "[fail] Quelle fehlt: $HERE_SRC" >&2
  exit 1
fi

install -m 0755 "$HERE_SRC" /usr/local/bin/audiomonastry-idle-check.sh

# --- Zugang des Timers (Modus 0600) ------------------------------------------
install -d -m 0755 "$ENV_DIR"
if [[ ! -f "$TOKEN_ENV_FILE" ]]; then
  studio_token=""
  scrape_token=""
  if [[ -f "$APP_ENV_FILE" ]]; then
    studio_token=$(sed -n 's/^STUDIO_ACCESS_TOKEN=//p' "$APP_ENV_FILE" | head -1 | tr -d '"' | tr -d "'")
    scrape_token=$(sed -n 's/^SCRAPE_TOKEN=//p' "$APP_ENV_FILE" | head -1 | tr -d '"' | tr -d "'")
  fi
  umask 077
  {
    echo "# audioMONASTRY Idle-Check: Zugang fuer den systemd-Timer."
    echo "# Angelegt von scripts/hetzner/install-idle-shutdown.sh (Modus 0600)."
    echo "# Der Timer ist ein Maschinen-Client ohne Browser/Cookie und braucht"
    echo "# deshalb einen Token (x-scrape-token, Fallback Studio-Token)."
    echo "# Ohne Token bleibt der Check fail-safe: er faehrt NICHT herunter."
    echo "#"
    echo "# Ziel bewusst DIREKT der App-Port - Port 80 ist Caddy und antwortet"
    echo "# Klartext-http mit 308 (genau die Ursache des F9-Befunds)."
    if [[ -n "$scrape_token" ]]; then
      echo "SCRAPE_TOKEN=${scrape_token}"
      echo "# SCRAPE_TOKEN oben wurde aus ${APP_ENV_FILE} uebernommen."
    fi
    if [[ -n "$studio_token" ]]; then
      echo "STUDIO_ACCESS_TOKEN=${studio_token}"
      echo "# STUDIO_ACCESS_TOKEN oben wurde aus ${APP_ENV_FILE} uebernommen."
    fi
    echo "IDLE_CHECK_URL=http://127.0.0.1:8080/api/idle-signal"
  } > "$TOKEN_ENV_FILE"
  chmod 0600 "$TOKEN_ENV_FILE"
  if [[ -z "$scrape_token" && -z "$studio_token" ]]; then
    echo "[warn] Kein Token in ${APP_ENV_FILE} gefunden - der Idle-Check laeuft fail-safe (kein Shutdown)." >&2
    echo "[warn] SCRAPE_TOKEN bzw. STUDIO_ACCESS_TOKEN in ${TOKEN_ENV_FILE} eintragen." >&2
  fi
fi

# --- Units -------------------------------------------------------------------
service_unit > "/etc/systemd/system/${SERVICE}.service"
timer_unit > "/etc/systemd/system/${SERVICE}.timer"

systemctl daemon-reload
systemctl enable --now "${SERVICE}.timer"

# --- Nachweis statt Zusage ---------------------------------------------------
echo "[done] idle shutdown active (idle=${IDLE_MINUTES} min, check every ${CHECK_INTERVAL} min)"
echo "[info] Trockenlauf (schreibt nur ins Log): bash /usr/local/bin/audiomonastry-idle-check.sh --dry-run"
echo "[info] Host-Fakten ohne Entscheidung:     bash /usr/local/bin/audiomonastry-idle-check.sh --print-facts"
if ! command -v curl >/dev/null 2>&1; then
  echo "[warn] curl fehlt - der Idle-Check kann kein Signal holen (fail-safe, kein Shutdown)." >&2
fi
