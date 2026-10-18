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
# INFRA-HETZNER-026 - Token ist ein GEHEIMNIS, kein Shell-Ausdruck:
#   Gemessen 2026-10-17 auf sfu-1 stand in der Knoten-.env als
#   STUDIO_ACCESS_TOKEN ein halbiertes Kommando-Fragment
#   ('$(openssl ... | cut -c1-64)'). Der Installer uebernahm es woertlich, der
#   HTTP-Header war damit ungueltig, der Check bekam 401 -> SIGNAL=unavailable ->
#   der Timer feuerte NIE (fail-safe, aber unwirksam). Deshalb: jeder uebernommene
#   Wert muss ein Token sein (nur [A-Za-z0-9+/=_-], mindestens 32 Zeichen), sonst
#   wird er VERWORFEN, mit `openssl rand -hex 32` ein neuer erzeugt, laut gemeldet
#   und die kaputte Zeile in der Knoten-.env aktiv ersetzt. Ein Fragment bleibt
#   nie stehen - auch SESSION_SECRET nicht (dort nur, wenn es ein Fragment ist:
#   ein intaktes Secret wird NICHT rotiert, das wuerde Sessions invalidieren).
#
# INFRA-HETZNER-025 - Schwellen muessen AKTIV sein:
#   Nach dem Flotten-Rebuild standen auf allen vier Knoten
#   '#IDLE_SHUTDOWN_MINUTES=15' / '#IDLE_MINUTES=30' in der Knoten-.env - ein
#   Kommentar ist kein Wert, der Auto-Stop waere still nie angelaufen. Der
#   Installer schreibt die Schwelle deshalb aktiv (bestehende AKTIVE Werte des
#   Betreibers bleiben unangetastet), und `check-idle-shutdown.sh` prueft es nach.
#
# Idempotent: ein zweiter Lauf ist erlaubt (Flottenstart, Reboot, Portal-Wake).
# Ein vorhandenes /etc/audiomonastry/idle-check.env mit GUELTIGEM Token bleibt
# unangetastet (nur ein unbrauchbarer Wert wird ersetzt, INFRA-HETZNER-026);
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

# --- Token-Gueltigkeit (INFRA-HETZNER-026) -----------------------------------
# Ein Token besteht aus Hex/base64-Zeichen und ist mindestens 32 Zeichen lang.
# Alles andere - '$', Klammern, '|', ';', Backticks, Leerzeichen - ist ein
# Shell-Fragment, kein Geheimnis. Genau so ein Fragment stand am 2026-10-17 in
# der Knoten-.env von sfu-1 und hat den Idle-Check dauerhaft blind gemacht.
TOKEN_RE='^[A-Za-z0-9+/=_-]{32,}$'
is_valid_token() { [[ "${1:-}" =~ $TOKEN_RE ]]; }

# Strukturell erkennbarer Shell-Ausdruck (auch wenn er zufaellig lang genug ist).
ist_shell_fragment() {
  local wert="${1:-}"
  [[ "$wert" == *'$'* || "$wert" == *'('* || "$wert" == *')'* || "$wert" == *'|'* \
     || "$wert" == *'`'* || "$wert" == *';'* || "$wert" == *'&'* \
     || "$wert" == *'<'* || "$wert" == *'>'* ]]
}

# Neuer Token: 32 Byte Zufall als Hex (64 Zeichen). openssl ist auf den Knoten
# vorhanden (cloud-init); der /dev/urandom-Weg ist der Fallback fuer Minimal-Images.
neuer_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    od -An -tx1 -N32 /dev/urandom | tr -d ' \n'
  fi
}

# Ersetzt eine Zeile in einer Env-Datei AKTIV (auch eine auskommentierte) oder
# haengt sie an. Rechte/Inhaber der Datei bleiben erhalten; der Wert wird NIE
# ausgegeben. Bewusst ohne sed -i: das schreibt ueber eine Temp-Datei und laesst
# bei Abbruch eine halbe .env zurueck.
set_env_var() {  # $1 = Name, $2 = Wert, $3 = Datei
  local name="$1" wert="$2" datei="$3" tmp
  [[ -f "$datei" ]] || return 1
  tmp="$(mktemp "${datei}.XXXXXX")" || return 1
  if ! awk -v name="$name" -v wert="$wert" '
      BEGIN { gesetzt = 0 }
      {
        zeile = $0
        sub(/^[[:space:]]+/, "", zeile)
        if (substr(zeile, 1, 1) == "#") { sub(/^#[[:space:]]*/, "", zeile) }
        if (index(zeile, name "=") == 1) {
          if (!gesetzt) { printf "%s=%s\n", name, wert; gesetzt = 1 }
          next
        }
        print
      }
      END { if (!gesetzt) printf "%s=%s\n", name, wert }
    ' "$datei" > "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  chmod --reference="$datei" "$tmp" 2>/dev/null || chmod 0600 "$tmp"
  mv -f "$tmp" "$datei"
}

# Schwelle AKTIV halten (INFRA-HETZNER-025): ein AKTIVER Wert des Betreibers
# bleibt stehen (er ist die Absicht), auskommentiert/fehlend wird gesetzt.
ensure_schwelle() {  # $1 = Datei, $2 = Name, $3 = Wert
  local datei="$1" name="$2" wert="$3" aktiv
  [[ -f "$datei" ]] || { echo "[warn] $datei fehlt - Schwelle $name nicht setzbar." >&2; return 0; }
  aktiv="$(grep -E "^[[:space:]]*${name}=[0-9]+([.][0-9]+)?[[:space:]]*$" "$datei" | tail -1 | tr -d '[:space:]' || true)"
  if [[ -n "$aktiv" ]]; then
    echo "[info] Schwelle bleibt aktiv: $aktiv ($datei)"
    return 0
  fi
  if grep -qE "^[[:space:]]*#[[:space:]]*${name}=" "$datei"; then
    if set_env_var "$name" "$wert" "$datei"; then
      echo "[warn] Schwelle $name war in $datei AUSKOMMENTIERT - jetzt AKTIV mit $wert gesetzt (ein Kommentar ist kein Wert)." >&2
    else
      echo "[warn] Schwelle $name in $datei konnte nicht aktiv gesetzt werden - bitte von Hand pruefen." >&2
    fi
  else
    if set_env_var "$name" "$wert" "$datei"; then
      echo "[info] Schwelle $name=$wert in $datei ergaenzt."
    fi
  fi
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
  # INFRA-HETZNER-025: die Schwelle steht AKTIV in der Timer-Env - sie ist der
  # Wert, den der Check als thresholdSec an die App gibt.
  printf 'IDLE_MINUTES=%s\n' "$IDLE_MINUTES"
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
TOKEN_NEU=0
QUELLE_DATEI=""
if token_present_in "$TOKEN_ENV_FILE"; then
  TOKEN_SOURCE="$TOKEN_ENV_FILE"
  QUELLE_DATEI="$TOKEN_ENV_FILE"
elif token_present_in "$APP_ENV_FILE"; then
  TOKEN_SOURCE="$APP_ENV_FILE"
  QUELLE_DATEI="$APP_ENV_FILE"
fi

if [[ -n "$QUELLE_DATEI" ]]; then
  SCRAPE_TOKEN="$(read_env_value SCRAPE_TOKEN "$QUELLE_DATEI")"
  STUDIO_TOKEN="$(read_env_value STUDIO_ACCESS_TOKEN "$QUELLE_DATEI")"
fi

# INFRA-HETZNER-026: jeden Kandidaten EINZELN pruefen. Ein Fragment
# ('$(openssl', 'cut -c', '|') wird nie uebernommen - es ist kein Geheimnis,
# sondern ein halber Shell-Ausdruck, und als HTTP-Header unbrauchbar.
if [[ -n "$SCRAPE_TOKEN" ]] && ! is_valid_token "$SCRAPE_TOKEN"; then
  echo "[warn] SCRAPE_TOKEN in $QUELLE_DATEI ist KEIN gueltiger Token (Kommando-Fragment/Sonderzeichen oder kuerzer als 32 Zeichen) - der Wert wird NICHT uebernommen." >&2
  if ist_shell_fragment "$SCRAPE_TOKEN"; then
    echo "[warn] Erkannt als Shell-Fragment: SCRAPE_TOKEN=\$(...) ist ein Ausdruck, kein Wert." >&2
  fi
  SCRAPE_TOKEN=""
fi
if [[ -n "$STUDIO_TOKEN" ]] && ! is_valid_token "$STUDIO_TOKEN"; then
  echo "[warn] STUDIO_ACCESS_TOKEN in $QUELLE_DATEI ist KEIN gueltiger Token (Kommando-Fragment/Sonderzeichen oder kuerzer als 32 Zeichen) - der Wert wird NICHT uebernommen." >&2
  if ist_shell_fragment "$STUDIO_TOKEN"; then
    echo "[warn] Erkannt als Shell-Fragment: STUDIO_ACCESS_TOKEN=\$(... | cut ...) ist ein Ausdruck, kein Wert." >&2
  fi
  STUDIO_TOKEN=""
fi

# Token-Zeile vorhanden, aber unbrauchbar: NEU erzeugen (nicht still weiterreichen).
TOKEN_ANGEGLICHEN=0
if [[ -n "$QUELLE_DATEI" && -z "$SCRAPE_TOKEN" && -z "$STUDIO_TOKEN" ]]; then
  SCRAPE_TOKEN="$(neuer_token)"
  TOKEN_NEU=1
  echo "[warn] Kein brauchbarer Token in $QUELLE_DATEI - neuer Maschinen-Token mit 'openssl rand -hex 32' erzeugt (Wert wird nicht ausgegeben)." >&2
fi

# INFRA-HETZNER-026 (zweiter Fall): die Knoten-.env ist die Wahrheit fuer den
# Token, den die APP kennt. Traegt die Timer-Env einen ANDEREN gueltigen Token,
# bekommt der Check 401 und loest nie aus - dann wird die Timer-Env angeglichen,
# ohne die App neu zu starten (die App liest weiter ihre eigene .env).
if [[ "$TOKEN_SOURCE" == "$TOKEN_ENV_FILE" && "$TOKEN_NEU" == "0" ]]; then
  APP_TOKEN="$(read_env_value SCRAPE_TOKEN "$APP_ENV_FILE")"
  is_valid_token "$APP_TOKEN" || APP_TOKEN="$(read_env_value STUDIO_ACCESS_TOKEN "$APP_ENV_FILE")"
  if is_valid_token "$APP_TOKEN" && [[ "$APP_TOKEN" != "$SCRAPE_TOKEN" && "$APP_TOKEN" != "$STUDIO_TOKEN" ]]; then
    echo "[warn] ${TOKEN_ENV_FILE} trug einen ANDEREN gueltigen Token als die Knoten-.env - wird an ${APP_ENV_FILE} angeglichen (sonst beantwortet die App den Check mit 401)." >&2
    SCRAPE_TOKEN="$APP_TOKEN"
    STUDIO_TOKEN=""
    TOKEN_SOURCE="$APP_ENV_FILE"
    TOKEN_ANGEGLICHEN=1
  fi
fi
EFFEKTIVER_TOKEN="${SCRAPE_TOKEN:-$STUDIO_TOKEN}"

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
if [[ "$TOKEN_SOURCE" == "$TOKEN_ENV_FILE" && "$TOKEN_NEU" == "0" && "$TOKEN_ANGEGLICHEN" == "0" ]]; then
  echo "[info] ${TOKEN_ENV_FILE} hat einen Token - bleibt unveraendert (idempotent, nichts wird ueberschrieben)."
else
  umask 077
  render_env_file "$SCRAPE_TOKEN" "$STUDIO_TOKEN" "$TOKEN_SOURCE" > "$TOKEN_ENV_FILE"
  chmod 0600 "$TOKEN_ENV_FILE"
  if [[ "$TOKEN_NEU" == "1" ]]; then
    echo "[warn] ${TOKEN_ENV_FILE} wurde mit einem NEU erzeugten Token geschrieben - die alte Zeile war kein gueltiger Wert (Kommando-Fragment/zu kurz)." >&2
  elif [[ "$TOKEN_ANGEGLICHEN" == "1" ]]; then
    echo "[info] ${TOKEN_ENV_FILE} wurde an den Token der Knoten-.env angeglichen (Modus 0600, Wert wird nicht ausgegeben)."
  elif [[ -n "$TOKEN_SOURCE" ]]; then
    echo "[info] ${TOKEN_ENV_FILE} wurde mit dem Token aus ${TOKEN_SOURCE} angelegt (Modus 0600, Wert wird nicht ausgegeben)."
  else
    echo "[warn] IDLE_ALLOW_TOKEN_LESS=1: ${TOKEN_ENV_FILE} ohne Token angelegt - der Check ist blind und faehrt NIE herunter (fail-safe)." >&2
    echo "[warn] SCRAPE_TOKEN bzw. STUDIO_ACCESS_TOKEN in ${TOKEN_ENV_FILE} eintragen, sobald verfuegbar." >&2
  fi
fi

# --- 4b. Knoten-.env: kein Token-/Secret-Fragment stehen lassen (026) -------
# GEMESSEN 2026-10-17 (sfu-1): in der Knoten-.env stand als STUDIO_ACCESS_TOKEN
# ein halbiertes Kommando-Fragment ('$(openssl ... | cut -c1-64)'). So eine Zeile
# ist kein Geheimnis, sondern ein Ausdruck - sie darf weder uebernommen noch
# stehen gelassen werden. Ersetzt wird NUR ein ungueltiger Wert; ein gueltiger
# bleibt unangetastet (kein stilles Rotieren von Zugangsdaten).
if [[ -f "$APP_ENV_FILE" ]]; then
  for name in SCRAPE_TOKEN STUDIO_ACCESS_TOKEN; do
    alt="$(read_env_value "$name" "$APP_ENV_FILE")"
    [[ -n "$alt" ]] || continue
    if is_valid_token "$alt"; then
      continue
    fi
    [[ -n "$EFFEKTIVER_TOKEN" ]] || continue
    if set_env_var "$name" "$EFFEKTIVER_TOKEN" "$APP_ENV_FILE"; then
      echo "[warn] $name in $APP_ENV_FILE war KEIN gueltiger Token (Kommando-Fragment/zu kurz) - aktiv durch den gueltigen Maschinen-Token ersetzt (Wert wird nicht ausgegeben)." >&2
    else
      echo "[warn] $name in $APP_ENV_FILE konnte nicht ersetzt werden - bitte von Hand pruefen (Remediation: Zeile aktiv setzen)." >&2
    fi
  done
  # SESSION_SECRET wird NUR bei einem erkennbaren Shell-Fragment repariert: ein
  # intaktes Secret zu rotieren wuerde alle Studio-Sessions invalidieren.
  session_alt="$(read_env_value SESSION_SECRET "$APP_ENV_FILE")"
  if [[ -n "$session_alt" ]] && ist_shell_fragment "$session_alt"; then
    if set_env_var SESSION_SECRET "$(neuer_token)" "$APP_ENV_FILE"; then
      echo "[warn] SESSION_SECRET in $APP_ENV_FILE war ein Shell-Fragment - neuer Zufallswert (Hex, 64 Zeichen) gesetzt. Laufende Studio-Sessions werden damit ungueltig (Neuanmeldung noetig)." >&2
    else
      echo "[warn] SESSION_SECRET in $APP_ENV_FILE ist ein Shell-Fragment und konnte nicht ersetzt werden - bitte von Hand pruefen." >&2
    fi
  fi
fi

# --- 4c. Schwellen AKTIV halten (INFRA-HETZNER-025) -------------------------
# Ein Kommentar ist kein Wert: '#IDLE_SHUTDOWN_MINUTES=15' hat den Auto-Stop
# nach dem Rebuild still abgestellt. AKTIVE Betreiber-Werte bleiben stehen.
ensure_schwelle "$TOKEN_ENV_FILE" IDLE_MINUTES "$IDLE_MINUTES"
ensure_schwelle "$APP_ENV_FILE" IDLE_SHUTDOWN_MINUTES "$IDLE_MINUTES"

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
echo "[info] Wirksamkeits-Nachweis (Timer aktiv + Schwellen AKTIV): bash ${HERE_SRC}/check-idle-shutdown.sh"
echo "[info] Installer-Verhalten: nur installieren (daemon-reload + enable --now) - keine Dienst-Stopps, kein Loeschen, kein Herunterfahren."
if ! command -v curl >/dev/null 2>&1; then
  echo "[warn] curl fehlt - der Idle-Check kann kein Signal holen (fail-safe, kein Shutdown)." >&2
fi
