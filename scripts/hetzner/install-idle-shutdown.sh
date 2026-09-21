#!/usr/bin/env bash
# =============================================================================
# audioMONASTRY Hetzner Idle-Auto-Shutdown installer (PROD-P3-F9 / F9).
#
# Installiert auf einem Flotten-Knoten:
#   /usr/local/bin/audiomonastry-idle-check.sh                  (der Check)
#   /etc/systemd/system/audiomonastry-idle-shutdown.service|.timer
#   /etc/audiomonastry/idle-check.env                           (Modus 0600)
# und aktiviert den Timer (5 min nach Boot, danach alle CHECK_INTERVAL Minuten).
#
# Aufruf:
#   sudo bash scripts/hetzner/install-idle-shutdown.sh
#   sudo bash scripts/hetzner/install-idle-shutdown.sh --print-units    # Trockenlauf
#   IDLE_MINUTES=60 CHECK_INTERVAL=5 sudo -E bash scripts/hetzner/install-idle-shutdown.sh
#
# Idempotent: ein zweiter Lauf ist erlaubt (Flottenstart, Reboot, Portal-Wake).
# Ein vorhandenes /etc/audiomonastry/idle-check.env mit Token bleibt unangetastet;
# der Token wird nie ueberschrieben und nie ausgegeben. Der Installer STOPPT
# NICHTS: keine Dienst-Stopps, kein Loeschen, kein Herunterfahren - er installiert
# nur (daemon-reload + enable --now des eigenen Timers).
#
# WARUM die Units im REPO liegen (scripts/hetzner/systemd/) und hier nur kopiert
# werden: dieselbe Lehre wie bei install-auto-repair.sh (INFRA-HETZNER-005) und
# install-backup-timer.sh - ein Installer, der seine Units per Heredoc selbst
# schreibt, laeuft gegen die Repo-Fassung auseinander, und der Unit-Inhalt ist
# ohne root nicht pruefbar. `--print-units` gibt die Repo-Fassung aus, damit
# `systemd-analyze verify` offline moeglich ist.
#
# F9-Kontext (docs/FIXPLAN_2026-09-20_externer_apptest.md, F9): Der Timer feuerte
# frueher gegen ein Primaersignal, das strukturell immer 0 war (Caddy antwortet
# auf Klartext-http mit 308, /api/online verlangt in Produktion einen Token ->
# 401; beides endete in der 0 des awk-END-Blocks). Jetzt fragt der Check
# `GET /api/idle-signal` DIREKT auf dem App-Port (Default 127.0.0.1:8080): die
# App liefert die Entscheidung plus die Log-Zeile, der Check nur seine
# Host-Fakten. Die Regeln stehen rein und getestet in server/idleSignal.ts.
#
# Unvollstaendiger Zustand: ohne Token ist der Check strukturell blind
# (401 -> SIGNAL=unavailable -> er kann nie ausloesen). Der Installer bricht
# dann mit Exit 2 und Klartext ab, BEVOR Einheiten installiert/aktiviert werden.
# Wer den blinden, fail-safe Check bewusst will: IDLE_ALLOW_TOKEN_LESS=1.
#
# Env (alles optional, Defaults in Klammern):
#   IDLE_MINUTES (30)        Schwelle in Minuten -> `thresholdSec` an die App
#   CHECK_INTERVAL (5)       Pruefintervall des Timers in Minuten
#   IDLE_CHECK_URL (http://127.0.0.1:8080/api/idle-signal)
#                            Ziel des Checks - bewusst der App-Port, nicht Caddy
#   ENV_DIR (/etc/audiomonastry), TOKEN_ENV_FILE (<ENV_DIR>/idle-check.env)
#   APP_ENV_FILE (/opt/audiomonastry/.env)   Quelle des uebernommenen Tokens
#   LOG (/var/log/audiomonastry-idle-shutdown.log)
# Nur fuer Tests/Overrides: IDLE_BIN_DIR (<-/usr/local/bin),
#   IDLE_UNIT_DIR (<-/etc/systemd/system).
# =============================================================================
set -euo pipefail

HERE_SRC="$(cd "$(dirname "$0")" && pwd)"
SERVICE=audiomonastry-idle-shutdown
IDLE_MINUTES="${IDLE_MINUTES:-30}"
CHECK_INTERVAL="${CHECK_INTERVAL:-5}"
LOG="${LOG:-/var/log/audiomonastry-idle-shutdown.log}"
ENV_DIR="${ENV_DIR:-/etc/audiomonastry}"
TOKEN_ENV_FILE="${TOKEN_ENV_FILE:-${ENV_DIR}/idle-check.env}"
APP_ENV_FILE="${APP_ENV_FILE:-/opt/audiomonastry/.env}"
IDLE_CHECK_URL="${IDLE_CHECK_URL:-http://127.0.0.1:8080/api/idle-signal}"
IDLE_ALLOW_TOKEN_LESS="${IDLE_ALLOW_TOKEN_LESS:-0}"
BIN_DIR="${IDLE_BIN_DIR:-/usr/local/bin}"
UNIT_DIR="${IDLE_UNIT_DIR:-/etc/systemd/system}"

CHECK_SRC="$HERE_SRC/systemd/idle-check.sh"
SERVICE_SRC="$HERE_SRC/systemd/${SERVICE}.service"
TIMER_SRC="$HERE_SRC/systemd/${SERVICE}.timer"

for arg in "$@"; do
  case "$arg" in
    --print-units) PRINT_UNITS=1 ;;
    -h|--help)
      awk 'NR>1 && /^set -euo pipefail$/{exit} NR>1{sub(/^# ?/, ""); print}' "$0"
      exit 0
      ;;
    *) echo "[warn] unbekanntes Argument '$arg' (ignoriert)" >&2 ;;
  esac
done
PRINT_UNITS="${PRINT_UNITS:-0}"

# --- Quelle lesen (ein Wert je Name; der Wert wird nie ausgegeben) -----------
read_env_value() {  # $1 = Name, $2 = Env-Datei
  local file="$2" value=""
  [[ -f "$file" ]] || return 0
  value=$(grep -E "^[[:space:]]*(export[[:space:]]+)?$1=" "$file" 2>/dev/null | head -1 | cut -d= -f2- || true)
  value=$(printf '%s' "$value" | tr -d '"'"'"'\r' | sed 's/[[:space:]]*#.*$//' | tr -d '[:space:]')
  printf '%s' "$value"
}

token_present_in() {  # $1 = Env-Datei
  [[ -n "$(read_env_value SCRAPE_TOKEN "$1")" || -n "$(read_env_value STUDIO_ACCESS_TOKEN "$1")" ]]
}

# Vorlage/Gleichstand der Env-Datei: EINE Quelle fuer Schreiben und Ausgeben,
# damit Trockenlauf und Installation nicht auseinanderlaufen. Token-Werte werden
# NIE ausgegeben (im Trockenlauf steht an der Stelle ein Marker).
render_env_file() {  # $1 = SCRAPE-Wert, $2 = STUDIO-Wert, $3 = Herkunft|leer
  local scrape="$1" studio="$2" origin="$3"
  cat << 'HEADER'
# audioMONASTRY Idle-Check: Zugang fuer den systemd-Timer.
# Angelegt von scripts/hetzner/install-idle-shutdown.sh (Modus 0600).
# Der Timer ist ein Maschinen-Client ohne Browser/Cookie und braucht
# deshalb einen Token (x-scrape-token, Fallback Studio-Token).
# Ohne Token bleibt der Check fail-safe: er faehrt NICHT herunter.
#
# Ziel bewusst DIREKT der App-Port - Port 80 ist Caddy und antwortet
# Klartext-http mit 308 (genau die Ursache des F9-Befunds).
HEADER
  if [[ -n "$scrape" ]]; then
    printf 'SCRAPE_TOKEN=%s\n' "$scrape"
    [[ -n "$origin" ]] && printf '# SCRAPE_TOKEN oben wurde aus %s uebernommen.\n' "$origin"
  fi
  if [[ -n "$studio" ]]; then
    printf 'STUDIO_ACCESS_TOKEN=%s\n' "$studio"
    [[ -n "$origin" ]] && printf '# STUDIO_ACCESS_TOKEN oben wurde aus %s uebernommen.\n' "$origin"
  fi
  printf 'IDLE_CHECK_URL=%s\n' "$IDLE_CHECK_URL"
}

print_units() {
  echo "# >>> ${UNIT_DIR}/${SERVICE}.service"
  cat "$SERVICE_SRC"
  echo "---8<---"
  echo "# >>> ${UNIT_DIR}/${SERVICE}.timer"
  cat "$TIMER_SRC"
  echo "---8<---"
  echo "# >>> ${TOKEN_ENV_FILE} (Modus 0600 - Token-Werte werden nicht ausgegeben)"
  render_env_file "<gesetzt - Wert steht in ${TOKEN_ENV_FILE}>" "" ""
}

# --- 1. Quellen pruefen (fail-early, Klartext) -------------------------------
for f in "$CHECK_SRC" "$SERVICE_SRC" "$TIMER_SRC"; do
  if [[ ! -f "$f" ]]; then
    echo "[fail] Quelle fehlt: $f" >&2
    echo "[fail] Der Installer kopiert Check + Units aus dem REPO (scripts/hetzner/systemd/)." >&2
    echo "[fail] Repo-Stand pruefen (git pull) - es wurde NICHTS installiert und nichts gestoppt." >&2
    exit 1
  fi
done

if [[ "$PRINT_UNITS" == "1" ]]; then
  print_units
  exit 0
fi

# --- 2. Zugang pruefen, BEVOR etwas installiert wird -------------------------
# Ein Timer ohne Token ist strukturell blind: er bekommt 401, wertet das als
# `SIGNAL=unavailable` und faehrt nie herunter. Genau diese Klasse von Befund
# (Signal, das nie ausloesen kann) ist F9 - deshalb hier ein lauter Abbruch
# statt eines dekorativen Timers.
SCRAPE_TOKEN=""
STUDIO_TOKEN=""
TOKEN_SOURCE=""
if token_present_in "$TOKEN_ENV_FILE"; then
  TOKEN_SOURCE="$TOKEN_ENV_FILE"
else
  SCRAPE_TOKEN="$(read_env_value SCRAPE_TOKEN "$APP_ENV_FILE")"
  STUDIO_TOKEN="$(read_env_value STUDIO_ACCESS_TOKEN "$APP_ENV_FILE")"
  if [[ -n "$SCRAPE_TOKEN" || -n "$STUDIO_TOKEN" ]]; then
    TOKEN_SOURCE="$APP_ENV_FILE"
  fi
fi

if [[ -z "$TOKEN_SOURCE" && "$IDLE_ALLOW_TOKEN_LESS" != "1" ]]; then
  echo "[fail] Kein Token gefunden: weder in $TOKEN_ENV_FILE noch in $APP_ENV_FILE" >&2
  echo "[fail] Ohne Token antwortet /api/idle-signal mit 401 -> SIGNAL=unavailable -> der Timer kann strukturell nie ausloesen (er laeuft, entscheidet aber nichts)." >&2
  echo "[fail] Remediation: SCRAPE_TOKEN (oder STUDIO_ACCESS_TOKEN) in $APP_ENV_FILE eintragen und den Installer erneut ausfuehren." >&2
  echo "[fail] Wer den blinden, fail-safe Check bewusst will: IDLE_ALLOW_TOKEN_LESS=1 setzen." >&2
  echo "[fail] Es wurde NICHTS installiert und nichts gestoppt." >&2
  exit 2
fi

# --- 3. Installieren ---------------------------------------------------------
install -d -m 0755 "$ENV_DIR" "$BIN_DIR" "$UNIT_DIR"
install -m 0755 "$CHECK_SRC" "$BIN_DIR/audiomonastry-idle-check.sh"
install -m 0644 "$SERVICE_SRC" "$UNIT_DIR/${SERVICE}.service"
install -m 0644 "$TIMER_SRC" "$UNIT_DIR/${SERVICE}.timer"

# Parameter nur dann in die KOPIEN schreiben, wenn sie vom Repo-Default abweichen
# (die Repo-Dateien selbst bleiben unangetastet - sonst driften sie).
if [[ "$IDLE_MINUTES" != "30" ]]; then
  sed -i "s|^Environment=IDLE_MINUTES=.*|Environment=IDLE_MINUTES=${IDLE_MINUTES}|" "$UNIT_DIR/${SERVICE}.service"
fi
if [[ "$LOG" != "/var/log/audiomonastry-idle-shutdown.log" ]]; then
  sed -i "s|^Environment=LOG=.*|Environment=LOG=${LOG}|" "$UNIT_DIR/${SERVICE}.service"
  sed -i "s|append:/var/log/audiomonastry-idle-shutdown.log|append:${LOG}|g" "$UNIT_DIR/${SERVICE}.service"
fi
if [[ "$TOKEN_ENV_FILE" != "/etc/audiomonastry/idle-check.env" ]]; then
  sed -i "s|^EnvironmentFile=-.*|EnvironmentFile=-${TOKEN_ENV_FILE}|" "$UNIT_DIR/${SERVICE}.service"
  # Auch das Ziel IM LAUF muss mitziehen: der Check liest IDLE_CHECK_ENV_FILE
  # (Default /etc/audiomonastry/idle-check.env). Ohne diese Zeile zeigte die Unit
  # auf die neue Datei, der Lauf laese aber die alte - ein Token, der nie ankommt
  # (fail-safe, aber blind).
  sed -i "/^ExecStart=/i Environment=IDLE_CHECK_ENV_FILE=${TOKEN_ENV_FILE}" "$UNIT_DIR/${SERVICE}.service"
fi
if [[ "$CHECK_INTERVAL" != "5" ]]; then
  sed -i "s|^OnUnitActiveSec=.*|OnUnitActiveSec=${CHECK_INTERVAL}min|" "$UNIT_DIR/${SERVICE}.timer"
fi

# --- 4. Env-Datei des Timers (Modus 0600) -----------------------------------
if [[ "$TOKEN_SOURCE" == "$TOKEN_ENV_FILE" ]]; then
  echo "[info] ${TOKEN_ENV_FILE} hat einen Token - bleibt unveraendert (idempotent, nichts wird ueberschrieben)."
else
  umask 077
  render_env_file "$SCRAPE_TOKEN" "$STUDIO_TOKEN" "$TOKEN_SOURCE" > "$TOKEN_ENV_FILE"
  chmod 0600 "$TOKEN_ENV_FILE"
  if [[ -n "$TOKEN_SOURCE" ]]; then
    echo "[info] ${TOKEN_ENV_FILE} wurde mit dem Token aus ${TOKEN_SOURCE} angelegt (Modus 0600, Wert wird nicht ausgegeben)."
  else
    echo "[warn] IDLE_ALLOW_TOKEN_LESS=1: ${TOKEN_ENV_FILE} ohne Token angelegt - der Check ist blind und faehrt NIE herunter (fail-safe)." >&2
    echo "[warn] SCRAPE_TOKEN bzw. STUDIO_ACCESS_TOKEN in ${TOKEN_ENV_FILE} eintragen, sobald verfuegbar." >&2
  fi
fi

touch "$LOG" 2>/dev/null \
  || echo "[warn] Logdatei $LOG konnte nicht angelegt werden (Rechte?) - systemd legt sie beim ersten Lauf an." >&2

# --- 5. Aktivieren (nur der eigene Timer) -----------------------------------
systemctl daemon-reload
systemctl enable --now "${SERVICE}.timer"

# --- 6. Nachweis statt Zusage -----------------------------------------------
echo "[done] Idle-Shutdown-Timer aktiv: ${SERVICE}.timer (idle=${IDLE_MINUTES} min, Pruefung alle ${CHECK_INTERVAL} min, Log: ${LOG})"
echo "[info] Timer-Zustand: $(systemctl is-active "${SERVICE}.timer" 2>/dev/null || echo unbekannt)"
systemctl list-timers "${SERVICE}.timer" --no-pager 2>/dev/null || true
echo "[info] Trockenlauf (schreibt nur ins Log): IDLE_MINUTES=0.05 bash ${BIN_DIR}/audiomonastry-idle-check.sh --dry-run"
echo "[info] Host-Fakten ohne Entscheidung:     bash ${BIN_DIR}/audiomonastry-idle-check.sh --print-facts"
echo "[info] Installer-Verhalten: nur installieren (daemon-reload + enable --now) - keine Dienst-Stopps, kein Loeschen, kein Herunterfahren."
if ! command -v curl >/dev/null 2>&1; then
  echo "[warn] curl fehlt - der Idle-Check kann kein Signal holen (fail-safe, kein Shutdown)." >&2
fi
