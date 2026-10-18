#!/usr/bin/env bash
# =============================================================================
# check-idle-shutdown.sh – ist der Idle-Auto-Stop auf DIESEM Knoten WIRKSAM?
# -----------------------------------------------------------------------------
# INFRA-HETZNER-025 (gemessen 2026-10-17): Nach dem Flotten-Rebuild fehlte auf
# app-1 die Unit audiomonastry-idle-shutdown.timer komplett ("could not be
# found"), und auf ALLEN vier Knoten standen die Schwellen in
# /opt/audiomonastry/.env auskommentiert (#IDLE_SHUTDOWN_MINUTES=15,
# #IDLE_MINUTES=30). Der Timer waere also still nie angelaufen - der Betreiber
# hat das 50 EUR gekostet. Ein Installer, der "installiert" meldet, ist kein
# Nachweis: systemd kann die Unit nicht fuehren, ein Timer kann "inactive"
# sein, und eine auskommentierte Schwelle ist ein Kommentar, kein Wert.
#
# Dieses Skript PRUEFT NUR (keine Mutation, kein Stopp, kein Shutdown):
#   1. Unit-Dateien vorhanden (Service + Timer)
#   2. Timer ist enabled UND aktiv (systemctl)
#   3. Schwellen sind AKTIV, nicht auskommentiert:
#        - IDLE_MINUTES=<n> in /etc/audiomonastry/idle-check.env (Timer-Schwelle)
#        - IDLE_SHUTDOWN_MINUTES=<n> oder IDLE_MINUTES=<n> in der Knoten-.env
#          (App-Fallback)
#   4. Die Service-Unit traegt die Schwelle nicht selbst auskommentiert.
#
# Ausgabe: [ok] je erfuellter Zusage, [ALARM] je Befund; Exit 1, wenn mindestens
# ein Befund besteht (0 = wirksam). Damit ist der Check in bring-up-fleet.sh,
# auto-repair.sh und von Hand gleich verwendbar.
#
# Aufruf:
#   bash scripts/hetzner/check-idle-shutdown.sh
#   bash scripts/hetzner/check-idle-shutdown.sh --print-config   (Trockenlauf)
#   bash scripts/hetzner/check-idle-shutdown.sh --help
#
# Nur fuer Tests/Overrides:
#   IDLE_UNIT_DIR (/etc/systemd/system), APP_ENV_FILE (/opt/audiomonastry/.env),
#   TOKEN_ENV_FILE (/etc/audiomonastry/idle-check.env),
#   IDLE_SYSTEMCTL (systemctl)
# =============================================================================
set -uo pipefail

SERVICE=audiomonastry-idle-shutdown
UNIT_DIR="${IDLE_UNIT_DIR:-/etc/systemd/system}"
APP_ENV_FILE="${APP_ENV_FILE:-/opt/audiomonastry/.env}"
TOKEN_ENV_FILE="${TOKEN_ENV_FILE:-/etc/audiomonastry/idle-check.env}"
SYSTEMCTL="${IDLE_SYSTEMCTL:-systemctl}"

FEHLER=0

ok() { printf '[ok] %s\n' "$*"; }

# Jeder Befund ist ein ALARM: Klartext, was fehlt und was das bedeutet.
alarm() {
  printf '[ALARM] %s\n' "$*" >&2
  FEHLER=$((FEHLER + 1))
}

print_config() {
  cat <<CONFIG
[check-idle-shutdown] Trockenlauf - es wird nichts ausgefuehrt und nichts geaendert.
  Dienst:            $SERVICE
  Unit-Verzeichnis:  $UNIT_DIR
  Timer-Unit:        $UNIT_DIR/$SERVICE.timer
  Service-Unit:      $UNIT_DIR/$SERVICE.service
  Knoten-.env:       $APP_ENV_FILE
  Timer-Env:         $TOKEN_ENV_FILE
  systemctl:         $SYSTEMCTL

  Geprueft wird:
    1. Unit-Dateien vorhanden
    2. systemctl is-enabled  $SERVICE.timer  == enabled
       systemctl is-active   $SERVICE.timer  == active
    3. Schwelle AKTIV (nicht auskommentiert):
         IDLE_MINUTES=<n> in $TOKEN_ENV_FILE
         IDLE_SHUTDOWN_MINUTES=<n> ODER IDLE_MINUTES=<n> in $APP_ENV_FILE
    4. Service-Unit traegt kein auskommentiertes Environment=IDLE_MINUTES=
  Exit 0 = wirksam, Exit 1 = mindestens ein Befund (ALARM).
CONFIG
}

case "${1:-}" in
  --print-config) print_config; exit 0 ;;
  -h | --help)
    awk 'NR>1 && /^set -uo pipefail$/{exit} NR>1{sub(/^# ?/, ""); print}' "$0"
    exit 0
    ;;
  "") ;;
  *) echo "[warn] unbekanntes Argument '$1' (ignoriert)" >&2 ;;
esac

# --- 1. Unit-Dateien ---------------------------------------------------------
for unit in "$SERVICE.timer" "$SERVICE.service"; do
  if [[ -f "$UNIT_DIR/$unit" ]]; then
    ok "Unit vorhanden: $UNIT_DIR/$unit"
  else
    alarm "Unit FEHLT: $UNIT_DIR/$unit - der Timer existiert auf diesem Knoten nicht (nach einem Rebuild wurde der Installer nicht ausgefuehrt)."
  fi
done

# --- 2. Timer von systemd gefuehrt -------------------------------------------
# Nur pruefen, wenn die Unit-Datei da ist: ohne Unit ist "inactive" eine
# Folge, kein zweiter Befund.
if [[ -f "$UNIT_DIR/$SERVICE.timer" ]]; then
  enabled="$("$SYSTEMCTL" is-enabled "$SERVICE.timer" 2>/dev/null | tr -d '\r' | head -1 || true)"
  if [[ "$enabled" == "enabled" ]]; then
    ok "Timer enabled (systemctl is-enabled=$enabled)"
  else
    alarm "Timer ist NICHT enabled (systemctl is-enabled: ${enabled:-<keine Antwort>}) - er startet nach dem Boot nicht."
  fi
  active="$("$SYSTEMCTL" is-active "$SERVICE.timer" 2>/dev/null | tr -d '\r' | head -1 || true)"
  if [[ "$active" == "active" ]]; then
    ok "Timer aktiv (systemctl is-active=$active)"
  else
    alarm "Timer ist NICHT aktiv (systemctl is-active: ${active:-<keine Antwort>}) - es findet keine Pruefung statt, also kein Auto-Stop."
  fi
fi

# --- 3. Schwellen AKTIV (nicht auskommentiert) -------------------------------
# Ein Wert zaehlt nur, wenn die Zeile aktiv ist UND eine positive Zahl traegt.
schwelle_aktiv() {  # $1 = Name, $2 = Datei
  [[ -f "$2" ]] || return 1
  grep -qE "^[[:space:]]*$1=[0-9]+([.][0-9]+)?[[:space:]]*$" "$2"
}

schwelle_auskommentiert() {  # $1 = Name, $2 = Datei
  [[ -f "$2" ]] || return 1
  grep -qE "^[[:space:]]*#[[:space:]]*$1=" "$2"
}

# 3a. Timer-Schwelle: ohne IDLE_MINUTES in der Timer-Env gilt der Unit-Default -
# das ist zulaessig, aber dann MUSS die Unit-Zeile aktiv sein (3c). Gemessen war
# die Schwelle in der Knoten-.env auskommentiert; hier wird beides geprueft.
if [[ -f "$TOKEN_ENV_FILE" ]]; then
  if schwelle_aktiv IDLE_MINUTES "$TOKEN_ENV_FILE"; then
    ok "Timer-Schwelle aktiv: $(grep -E '^[[:space:]]*IDLE_MINUTES=' "$TOKEN_ENV_FILE" | tail -1 | tr -d '[:space:]') in $TOKEN_ENV_FILE"
  elif schwelle_auskommentiert IDLE_MINUTES "$TOKEN_ENV_FILE"; then
    alarm "Timer-Schwelle in $TOKEN_ENV_FILE ist AUSKOMMENTIERT (#IDLE_MINUTES=...) - es gilt nur der Unit-Default."
  else
    alarm "Timer-Schwelle fehlt in $TOKEN_ENV_FILE (IDLE_MINUTES=...) - der Check nutzt den Unit-Default (Environment=IDLE_MINUTES)."
  fi
else
  alarm "Timer-Env fehlt: $TOKEN_ENV_FILE - der Check laeuft ohne Token/Schwelle (fail-safe, aber blind)."
fi

# 3b. App-Fallback (die gemessene Zeile): IDLE_SHUTDOWN_MINUTES oder IDLE_MINUTES.
if [[ -f "$APP_ENV_FILE" ]]; then
  if schwelle_aktiv IDLE_SHUTDOWN_MINUTES "$APP_ENV_FILE"; then
    ok "App-Schwelle aktiv: $(grep -E '^[[:space:]]*IDLE_SHUTDOWN_MINUTES=' "$APP_ENV_FILE" | tail -1 | tr -d '[:space:]') in $APP_ENV_FILE"
  elif schwelle_aktiv IDLE_MINUTES "$APP_ENV_FILE"; then
    ok "App-Schwelle aktiv: $(grep -E '^[[:space:]]*IDLE_MINUTES=' "$APP_ENV_FILE" | tail -1 | tr -d '[:space:]') in $APP_ENV_FILE"
  elif schwelle_auskommentiert IDLE_SHUTDOWN_MINUTES "$APP_ENV_FILE" || schwelle_auskommentiert IDLE_MINUTES "$APP_ENV_FILE"; then
    alarm "App-Schwelle in $APP_ENV_FILE ist AUSKOMMENTIERT (#IDLE_SHUTDOWN_MINUTES= / #IDLE_MINUTES=) - die App faellt auf ihren Default zurueck, die Betreiber-Schwelle ist NICHT gesetzt."
  else
    alarm "App-Schwelle fehlt in $APP_ENV_FILE (IDLE_SHUTDOWN_MINUTES=) - die App nutzt den eingebauten Default."
  fi
else
  alarm "Knoten-.env fehlt: $APP_ENV_FILE - Schwelle nicht pruefbar."
fi

# --- 4. Unit darf die Schwelle nicht selbst auskommentiert tragen ------------
if [[ -f "$UNIT_DIR/$SERVICE.service" ]]; then
  if grep -qE '^[[:space:]]*#[[:space:]]*Environment=IDLE_MINUTES=' "$UNIT_DIR/$SERVICE.service"; then
    alarm "Die Service-Unit traegt Environment=IDLE_MINUTES= AUSKOMMENTIERT - der Check wuerde mit dem Default laufen."
  elif grep -qE '^[[:space:]]*Environment=IDLE_MINUTES=[0-9]' "$UNIT_DIR/$SERVICE.service"; then
    ok "Service-Unit setzt Environment=IDLE_MINUTES aktiv"
  else
    alarm "Die Service-Unit setzt KEIN Environment=IDLE_MINUTES - die Schwelle ist nicht gesetzt."
  fi
fi

# --- Ergebnis ----------------------------------------------------------------
if [[ "$FEHLER" -gt 0 ]]; then
  printf '[ALARM] Idle-Shutdown ist auf diesem Knoten NICHT wirksam (%d Befund(e)).\n' "$FEHLER" >&2
  printf '[ALARM] Nachziehen: bash /opt/audiomonastry/scripts/hetzner/install-idle-shutdown.sh\n' >&2
  exit 1
fi
printf '[ok] Idle-Shutdown ist wirksam: Unit vorhanden, Timer aktiv, Schwellen aktiv.\n'
exit 0
