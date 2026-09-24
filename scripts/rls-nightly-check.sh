#!/usr/bin/env bash
# ============================================================================
# audioMONASTRY · naechtlicher RLS-Live-Abgleich (DB-P2-002)
# ============================================================================
# Entscheidung des Betreibers am 2026-09-23: "dann machen wir den nachtlauf halt
# absofort. aber bitte sinnvoll".
#
# Was hier "sinnvoll" heisst - jede Entscheidung mit Begruendung:
#
#   1. EIN Skript fuer beide Orte. Die Repo-Wurzel kommt aus der Lage der
#      eigenen Datei, nicht aus einem festen Pfad. Damit laeuft derselbe Aufruf
#      auf diesem Rechner UND spaeter auf einem Flotten-Knoten unter
#      /opt/audioMONASTRY. Vorher gab es eine Hetzner-Fassung mit festem Pfad -
#      die waere hier still ins Leere gelaufen.
#
#   2. 07:30 statt nachts. Der Alarmmanager puffert Zustellungen zwischen 22 und
#      07 Uhr (OPS-P2-002, server/quietHours.ts). Ein Befund um 03:00 wuerde also
#      erst um 07:00 gemeldet - die Pruefung waere wertlos. 07:30 liegt hinter
#      dem Fenster und vor dem Arbeitstag.
#
#   3. Persistent=true im Timer. Ist der Rechner nachts aus, holt systemd den
#      Lauf beim naechsten Start nach. Eine verpasste Nacht ist sonst eine
#      unsichtbare Luecke.
#
#   4. Verstoss und "nicht messbar" werden UNTERSCHIEDEN:
#        exit 1 -> critical: die Datenbank erlaubt mehr, als das Repo beschreibt
#        exit 2 -> warning:  gemessen werden konnte nicht (fehlende Zugangsdaten,
#                            fehlende Funktion, Netzfehler). Auch das ist eine
#                            blinde Stelle und darf nicht still bleiben.
#      Beides wird protokolliert; beides loest einen Alarm aus, wenn ein Kanal
#      konfiguriert ist.
#
#   5. Ohne Alarmkanal wird das NICHT verschwiegen. Fehlt jede Konfiguration,
#      schreibt der Lauf eine deutliche Zeile ins Protokoll und beendet sich mit
#      dem Status des Abgleichs - systemd markiert den Lauf dann als failed, und
#      "systemctl --user status audioMONASTRY-rls-check" zeigt es.
#
# RUECKGABE: 0 = Vertrag erfuellt, 1 = VERSTOSS, 2 = nicht messbar.
#
# Aufruf:    scripts/rls-nightly-check.sh
# ============================================================================
set -uo pipefail

# Repo-Wurzel aus der Lage dieser Datei (scripts/ -> eine Ebene hoch).
# Symlink aufloesen: der Aufrufweg kann ein Link ohne Leerzeichen sein
# (~/.local/bin/...), das echte Repo liegt aber unter einem Pfad MIT Leerzeichen.
SKRIPT_PFAD="$(readlink -f "${BASH_SOURCE[0]}")"
SKRIPT_DIR="$(cd "$(dirname "$SKRIPT_PFAD")" && pwd)"
REPO="${AUDIOMONASTRY_DIR:-$(cd "$SKRIPT_DIR/.." && pwd)}"
cd "$REPO" || { echo "[rls] Repo nicht gefunden: $REPO"; exit 2; }

LOG_DIR="$REPO/logs"
LOG="$LOG_DIR/rls-nightly.log"
mkdir -p "$LOG_DIR"

schreib() { printf '%s %s\n' "$(date -Is)" "$1" >>"$LOG"; }

# Protokoll kurz halten: die letzten 2000 Zeilen behalten.
if [ -f "$LOG" ] && [ "$(wc -l <"$LOG")" -gt 2000 ]; then
  tail -n 1000 "$LOG" >"$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

if [ ! -f .env ]; then
  schreib "NICHT MESSBAR: keine .env in $REPO"
  echo "[rls] Keine .env in $REPO - Abgleich nicht messbar." >&2
  exit 2
fi

# .env einlesen, ohne Werte auszugeben. Werte in Anfuehrungszeichen sind erlaubt.
set -a
# shellcheck disable=SC1091
. ./.env >/dev/null 2>&1
set +a

START="$(date -Is)"
AUSGABE="$(npm run --silent verify:rls-live 2>&1)"
CODE=$?

# Nur die Zusammenfassung ins Protokoll, nicht die ganze Ausgabe.
ZUSAMMENFASSUNG="$(printf '%s\n' "$AUSGABE" | grep -E 'anon liest|ohne RLS|Vertrag|VERSTOSS|VERLETZT|nicht messbar|UEBERSPRUNGEN|  - ' | tr '\n' ' | ')"

case "$CODE" in
  0) PRIO="ok";        TEXT="Vertrag erfuellt" ;;
  1) PRIO="critical";  TEXT="VERSTOSS: die Datenbank erlaubt mehr, als das Repo beschreibt" ;;
  *) PRIO="warning";   TEXT="NICHT MESSBAR: der Abgleich konnte nicht messen" ;;
esac

schreib "[$PRIO] $TEXT :: ${ZUSAMMENFASSUNG:-keine Ausgabe}"
echo "[rls] $TEXT"

# --- Alarmweg ---------------------------------------------------------------
# Reihenfolge: erst der eigene Webhook (mit Token), sonst die bekannten
# Chat-Webhooks. Fehlt alles, wird das ausdruecklich vermerkt - nicht verschwiegen.
GEMELDET=0
NACHRICHT="RLS-Live-Abgleich (DB-P2-002) auf $(hostname): $TEXT (exit $CODE)"

if [ "$CODE" != "0" ]; then
  if [ -n "${ALERT_WEBHOOK_URL:-}" ] && [ -n "${ALERT_WEBHOOK_TOKEN:-}" ]; then
    curl -sS -m 10 -X POST "$ALERT_WEBHOOK_URL" \
      -H "Content-Type: application/json" \
      -H "x-alert-token: $ALERT_WEBHOOK_TOKEN" \
      -d "{\"source\":\"rls-nightly\",\"severity\":\"$PRIO\",\"summary\":\"$TEXT\",\"exitCode\":$CODE,\"host\":\"$(hostname)\"}" \
      >/dev/null 2>&1 && GEMELDET=1 || schreib "WARNUNG: Webhook-Zustellung fehlgeschlagen"
  elif [ -n "${DISCORD_WEBHOOK:-}" ]; then
    curl -sS -m 10 -X POST "$DISCORD_WEBHOOK" -H 'Content-Type: application/json' \
      -d "{\"content\":\"$NACHRICHT\"}" >/dev/null 2>&1 && GEMELDET=1 || schreib "WARNUNG: Discord-Zustellung fehlgeschlagen"
  elif [ -n "${SLACK_WEBHOOK:-}" ]; then
    curl -sS -m 10 -X POST "$SLACK_WEBHOOK" -H 'Content-Type: application/json' \
      -d "{\"text\":\"$NACHRICHT\"}" >/dev/null 2>&1 && GEMELDET=1 || schreib "WARNUNG: Slack-Zustellung fehlgeschlagen"
  elif [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
    curl -sS -m 10 -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -d "chat_id=${TELEGRAM_CHAT_ID}" --data-urlencode "text=$NACHRICHT" >/dev/null 2>&1 \
      && GEMELDET=1 || schreib "WARNUNG: Telegram-Zustellung fehlgeschlagen"
  fi

  if [ "$GEMELDET" -eq 0 ]; then
    schreib "HINWEIS: kein Alarmkanal konfiguriert (ALERT_WEBHOOK_URL/-TOKEN, DISCORD_WEBHOOK, SLACK_WEBHOOK, TELEGRAM_*). Der Befund steht NUR in diesem Protokoll und im systemd-Status: systemctl --user status audioMONASTRY-rls-check"
    echo "[rls] HINWEIS: kein Alarmkanal konfiguriert - Befund nur im Protokoll ($LOG)." >&2
  fi
fi

echo "[rls] Start $START, Ende $(date -Is), Protokoll: $LOG"
exit "$CODE"
