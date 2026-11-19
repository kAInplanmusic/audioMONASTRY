#!/usr/bin/env bash
# audioMONASTRY · gesamte Vast-Flotte (8 Rollen) starten, Kaltstart-Zeit messen, Bericht ins Repo, Flotte IMMER wieder entfernen.
# Aufruf auf einem Rechner mit FREIEM Netz (nicht in der Cloud-Sandbox, die TLS zu Pod-IPs blockt):
#   bash scripts/fleet-up-measure.sh            # fragt Schluessel unsichtbar ab, zeigt die Kosten, fragt "ja"
#   KEEP=1 bash scripts/fleet-up-measure.sh     # Flotte am Ende NICHT entfernen (App soll laufen)
# Setzt voraus: Python 3, Zugriff auf api/console.vast.ai, ghcr.io, R2, huggingface.co. Schluessel bleiben nur im Speicher dieser Shell.
# Das Vast-Konto braucht Guthaben (Preflight prueft das; Richtwert: mindestens 10 EUR, Empfehlung 15 EUR).
set -uo pipefail
cd "$(dirname "$0")/.."

ask() {                     # ask NAME "Frage" [secret]
  local name="$1" prompt="$2" secret="${3:-}"
  if [ -n "${!name:-}" ]; then return; fi
  if [ -n "$secret" ]; then read -rsp "$prompt (Eingabe unsichtbar): " "$name"; echo; else read -rp "$prompt: " "$name"; fi
  export "$name"
}

echo "== Zugangsdaten (nur in dieser Shell) =="
ask VAST_API_KEY "Vast-API-Schluessel" secret
ask GHCR_USERNAME "GitHub-Benutzername (Besitzer der Images)"
ask GHCR_PASSWORD "GitHub-Token klassisch (nur read:packages)" secret
ask R2_ACCOUNT_ID "R2 Account-ID"
ask R2_ACCESS_KEY_ID "R2 Access-Key-ID"
ask R2_SECRET_ACCESS_KEY "R2 Secret-Access-Key" secret
ask HF_TOKEN "Hugging-Face-Token (nur Lesen, fuer die Transfer-Inventur)" secret
export R2_ENDPOINT="${R2_ENDPOINT:-https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com}"
export CFS3_ACCESS_KEY="$R2_ACCESS_KEY_ID" CFS3_SECRET_KEY="$R2_SECRET_ACCESS_KEY" CFS3_ENDPOINT="$R2_ENDPOINT" CFS3_BUCKET="${CFS3_BUCKET:-audiomonastrysamples}"
export AI_POD_TOKEN="${AI_POD_TOKEN:-$(python3 -c 'import secrets;print(secrets.token_urlsafe(48))')}"
export VAST_STATE_DIR="${VAST_STATE_DIR:-$HOME/vast-fleet}"
export VAST_PLAN_OFFER_LIMIT="${VAST_PLAN_OFFER_LIMIT:-100}"
mkdir -p "$VAST_STATE_DIR" && chmod 700 "$VAST_STATE_DIR"
(umask 077; printf %s "$AI_POD_TOKEN" > "$VAST_STATE_DIR/pod-token")

cleanup() {
  if [ "${KEEP:-0}" = "1" ] && [ "${UP_RC:-1}" = "0" ]; then
    echo; echo "== KEEP=1: Flotte bleibt an. Spaeter entfernen mit: VAST_STATE_DIR=$VAST_STATE_DIR python3 scripts/vast-pods.py down --yes =="; return
  fi
  echo; echo "== Aufraeumen: Flotte entfernen =="
  python3 scripts/vast-pods.py down --yes || echo "WARNUNG: down meldete einen Fehler - in der Vast-Konsole unter Instances pruefen und von Hand loeschen!"
  python3 scripts/vast-pods.py status || true
  unset GHCR_PASSWORD R2_SECRET_ACCESS_KEY CFS3_SECRET_KEY AI_POD_TOKEN VAST_API_KEY HF_TOKEN
}
trap cleanup EXIT

echo "== Transfer-Inventur erneuern (nur Metadaten, laedt nichts herunter) =="
python3 scripts/vast-transfer-inventory.py --output deploy/vast/transfer-inventory.json || { echo "Inventur fehlgeschlagen"; exit 1; }

PLAN=vast-plan.json
for attempt in 1 2 3 4 5 6; do
  echo "== Plan, Versuch $attempt (nur lesend) =="
  if python3 scripts/vast-fleet-plan.py --output "$PLAN" --region global \
       --transfer-inventory deploy/vast/transfer-inventory.json --image-sizes deploy/vast/image-sizes.json >/dev/null 2>"$VAST_STATE_DIR/plan.err"; then break; fi
  echo "Plan abgelehnt: $(tail -1 "$VAST_STATE_DIR/plan.err" | cut -c1-200)"
  [ "$attempt" = 6 ] && { echo "Kein passender Plan. Abbruch, nichts gemietet."; exit 1; }
  sleep 30
done
echo "== Vorpruefung (mietet nichts, prueft u. a. das Guthaben) =="
python3 scripts/vast-pods.py preflight --plan "$PLAN" || exit 1

echo
echo "Jetzt wird die Flotte GEMIETET: Richtwert 6-9 EUR/h inkl. Zweit-Hosts (bis 11 EUR/h), Messung ca. 20-30 Minuten, Obergrenze laut Preflight oben."
read -rp 'Zum Starten "ja" eingeben: ' answer
[ "$answer" = "ja" ] || { echo "Abgebrochen, nichts gemietet."; UP_RC=1; exit 0; }

python3 scripts/vast-observe.py --out "$VAST_STATE_DIR/observe" --stop-file "$VAST_STATE_DIR/observe.stop" --logs-every 100000 >"$VAST_STATE_DIR/observe.log" 2>&1 &
OBSERVER=$!
# Zweit-Host je Rolle (bis 11 EUR/h, nur fuer Zweit-Hosts), Ersatz-Miete nach 6 min ohne gestarteten Container, Executor-Gate parallel (Messmodus)
VAST_HEDGE_ROLES=all VAST_HEDGE_CEILING_EUR_PER_HOUR=11 VAST_LATE_HEDGE_SECONDS=360 VAST_EXECUTOR_GATE=parallel \
  python3 scripts/vast-pods.py up --yes --plan "$PLAN" --images deploy/vast/images.json; UP_RC=$?
touch "$VAST_STATE_DIR/observe.stop"; wait "$OBSERVER" 2>/dev/null

if [ -f "$VAST_STATE_DIR/cold-start-report.json" ]; then
  echo "== Kaltstart-Bericht =="; python3 -c "import json,sys;d=json.load(open('$VAST_STATE_DIR/cold-start-report.json'));print(json.dumps({k:d[k] for k in ('outcome','targetMet','elapsedMinutes','rolesOverTarget')},ensure_ascii=False)); [print('  ',r,v['readyMinutes'],'min') for r,v in d['roles'].items()]; print(d.get('notice',''))"
  python3 scripts/cold-start-report.py "$VAST_STATE_DIR/cold-start-report.json" && echo "Eintrag in docs/COLD_START_LOG.md (bitte committen)"
fi
[ -f "$VAST_STATE_DIR/host-observations.jsonl" ] && echo "Host-Messwerte: $VAST_STATE_DIR/host-observations.jsonl (keine Zugangsdaten darin)"
if [ "$UP_RC" -ne 0 ]; then echo "up fehlgeschlagen (rc=$UP_RC). Zeitverlauf/Logs: $VAST_STATE_DIR/observe"; exit 1; fi
echo "Fertig. Bei KEEP=1 uebernimmt die App die Pods ueber: python3 scripts/vast-promote-runtime.py (siehe docs/GOLDEN_MASTER_STARTUP_PLAN.md, Abschnitt 'Nächster Lauf')."
