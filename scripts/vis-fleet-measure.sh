#!/usr/bin/env bash
# audioMONASTRY · vis-Image auf der Flotte messen: ein Befehl, Geheimnisse nur im Speicher dieser Shell.
# Start:  bash scripts/vis-fleet-measure.sh
# Fragt Token/Schluessel unsichtbar ab (nichts landet in einer Datei oder im Verlauf), erzeugt den Plan, prueft, fragt VOR dem Kauf
# nach "ja", startet die Flotte, misst den vis-Pod und entfernt die Flotte IMMER wieder (auch bei Fehler oder Strg+C).
set -uo pipefail
cd "$(dirname "$0")/.."

ask() {                     # ask NAME "Frage" [secret]
  local name="$1" prompt="$2" secret="${3:-}"
  if [ -n "${!name:-}" ]; then return; fi
  if [ -n "$secret" ]; then read -rsp "$prompt (Eingabe unsichtbar): " "$name"; echo; else read -rp "$prompt: " "$name"; fi
  export "$name"
}

echo "== Zugangsdaten (bleiben nur in dieser Shell) =="
ask VAST_API_KEY "Vast-API-Schluessel" secret
ask GHCR_USERNAME "GitHub-Benutzername (Besitzer der Images)"
ask GHCR_PASSWORD "GitHub-Token (nur read:packages)" secret
ask R2_ACCOUNT_ID "R2 Account-ID"
ask R2_ACCESS_KEY_ID "R2 Access-Key-ID"
ask R2_SECRET_ACCESS_KEY "R2 Secret-Access-Key" secret
export R2_ENDPOINT="${R2_ENDPOINT:-https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com}"
export AI_POD_TOKEN="${AI_POD_TOKEN:-$(python3 -c 'import secrets;print(secrets.token_urlsafe(48))')}"
export VAST_STATE_DIR="${VAST_STATE_DIR:-$HOME/vast-fleet}"
export VAST_PLAN_OFFER_LIMIT="${VAST_PLAN_OFFER_LIMIT:-40}"
mkdir -p "$VAST_STATE_DIR" && chmod 700 "$VAST_STATE_DIR"

cleanup() {
  echo; echo "== Aufraeumen: Flotte entfernen =="
  python3 scripts/vast-pods.py down --yes || echo "WARNUNG: down meldete einen Fehler - in der Vast-Konsole unter Instances pruefen und von Hand loeschen!"
  python3 scripts/vast-pods.py status || true
  unset GHCR_PASSWORD R2_SECRET_ACCESS_KEY AI_POD_TOKEN VAST_API_KEY
}
trap cleanup EXIT

echo "== Plan (nur lesend) =="
python3 scripts/vast-fleet-plan.py --output vast-plan.json --region global \
  --transfer-inventory deploy/vast/transfer-inventory.json --image-sizes deploy/vast/image-sizes.json >/dev/null || exit 1
echo "== Vorpruefung (mietet nichts) =="
python3 scripts/vast-pods.py preflight --plan vast-plan.json || exit 1

echo
echo "Jetzt wird die Flotte GEMIETET: geschaetzt 6,00 EUR/h (Obergrenze 8 EUR/h), Kaltstart bis ca. 1,02 EUR, Testfenster 28 Min,"
echo "hoechstens ca. 3,82 EUR. Am Ende wird alles wieder entfernt."
read -rp 'Zum Starten "ja" eingeben: ' answer
[ "$answer" = "ja" ] || { echo "Abgebrochen, nichts gemietet."; exit 0; }

echo "== Flotte starten (mit Beobachtung: $VAST_STATE_DIR/observe) =="
python3 scripts/vast-observe.py --out "$VAST_STATE_DIR/observe" --stop-file "$VAST_STATE_DIR/observe.stop" &
OBSERVER=$!
python3 scripts/vast-pods.py up --yes --plan vast-plan.json --images deploy/vast/images.json; UP_RC=$?
touch "$VAST_STATE_DIR/observe.stop"; wait "$OBSERVER" 2>/dev/null
[ "$UP_RC" -eq 0 ] || { echo "up fehlgeschlagen (rc=$UP_RC). Zeitverlauf und Pod-Logs: $VAST_STATE_DIR/observe (keine Zugangsdaten darin)"; exit 1; }
echo "== vis messen =="
python3 scripts/vis-pod-measure.py --state-dir "$VAST_STATE_DIR" --seconds 20
echo
echo "Fertig. Ergebnis: $VAST_STATE_DIR/vis-pod-measure.json  (keine Zugangsdaten darin; diese Datei darfst du mir schicken)"
