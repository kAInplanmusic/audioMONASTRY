#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Wache fuer den Vorrats-Lauf (batch-bilder.py --gruppe --limit 0).
#
# Warum
# -----
# Der Lauf erzeugt 2080 Bilder und braucht dafuer rund 11 Stunden. Er laeuft
# mit setsid+nohup und ueberlebt damit das Schliessen des Terminals — aber
# nicht jeden Absturz: ein Netzfehler, ein Neustart der Maschine oder ein
# Endpoint, der die Sitzung verliert, beendet den Prozess, und dann steht der
# ganze Lauf still, ohne dass es jemand merkt.
#
# Was sie tut
# -----------
# Alle 60 s nachsehen. Fehlt der Prozess und ist noch nicht alles da, wird
# derselbe Aufruf neu gestartet. Das ist gefahrlos, weil batch-bilder.py
# bereits erzeugte Bestellungen ueberspringt — erst ueber den Dateinamen
# (stabile sha1-Kennung), dann ueber manifest.jsonl. Ein Neustart kostet
# deshalb nur die noch fehlenden Bilder, keine Wiederholung.
#
# Bremse
# ------
# Bringt ein Neustart nichts, wird nach OHNE_FORTSCHRITT_MAX Minuten ohne
# neues Bild abgebrochen statt endlos weiter zu starten. Sonst wuerde aus
# einem kaputten Endpoint eine Dauerschleife mit bezahlten Kaltstarts.
#
# Aufruf / Bedienung
# ------------------
#   ./vorrat-wache.sh                 # im Hintergrund starten (siehe unten)
#   pkill -f vorrat-wache.sh          # Wache anhalten
#   pkill -f batch-bilder.py          # nur den Lauf anhalten
#   ls bilder-vorrat/*.png | wc -l    # Fortschritt
#   tail -f vorrat-wache.log          # was die Wache tut
#
# Von Hand starten (so wurde sie gestartet):
#   cd ~/lora-themen-2026-09-27
#   setsid nohup ./vorrat-wache.sh >> vorrat-wache.log 2>&1 < /dev/null &
# ---------------------------------------------------------------------------
set -uo pipefail
cd "$(dirname "$0")" || exit 1

ZIEL="bilder-vorrat"
GESAMT=2080
ENDPOINT="wzh9hcbitjnn95"
ENV_DATEI="/home/patrick/AnunnakiTools Projekte/laufende Projekte/audioMONASTRY/.env"
OHNE_FORTSCHRITT_MAX="${OHNE_FORTSCHRITT_MAX:-45}"   # Minuten ohne neues Bild

# Nur eine Wache. flock haelt auch einen versehentlichen Doppelstart sauber.
exec 9>vorrat-wache.lock
flock -n 9 || { echo "[wache] es wacht bereits eine - nichts zu tun"; exit 0; }

RUNPOD_API_KEY=$(grep -E '^RP_API_KEY=' "$ENV_DATEI" | head -1 | cut -d= -f2- | tr -d '"')
export RUNPOD_API_KEY
if [ -z "$RUNPOD_API_KEY" ]; then
    echo "[wache] kein Schluessel in $ENV_DATEI - Abbruch"
    exit 1
fi

stand() { ls "$ZIEL"/*.png 2>/dev/null | wc -l; }

letzter=$(stand)
ohne=0
echo "[wache] $(date '+%F %T') Start, Stand $letzter/$GESAMT"

while :; do
    # 9>&- : die Sperre nicht an das sleep vererben. Sonst haelt ein uebrig
    # gebliebenes sleep die Sperre weiter, wenn die Wache endet, und keine
    # neue Wache kommt mehr hoch. Gemessen: nach dem Beenden der Wache hielt
    # ein verwaistes "sleep 60" (PPID 1) die Sperre und blockierte den Neustart.
    sleep 60 9>&-
    jetzt=$(stand)

    if [ "$jetzt" -gt "$letzter" ]; then
        ohne=0
        letzter=$jetzt
    else
        ohne=$((ohne + 1))
    fi

    if [ "$jetzt" -ge "$GESAMT" ]; then
        echo "[wache] $(date '+%F %T') fertig: $jetzt/$GESAMT Bilder"
        break
    fi

    # Auf "^...python3 -u batch-bilder.py" bestehen, nicht auf "batch-bilder.py":
    # ein lockeres Muster findet JEDEN Prozess, in dessen Kommandozeile der Text
    # vorkommt — auch die abgesetzte Start-Huelle, die noch offen herumliegt.
    # Dann haelt die Wache den Lauf fuer lebendig, obwohl er tot ist, und
    # startet nie neu. Gemessen: der Wrapper von 1245949 lebte 13 Minuten
    # laenger als noetig und matchte das lockere Muster.
    if ! pgrep -f "^([^ ]*/)?python3[0-9.]* -u batch-bilder\.py" >/dev/null; then
        if [ "$ohne" -ge "$OHNE_FORTSCHRITT_MAX" ]; then
            echo "[wache] $(date '+%F %T') HALT: Lauf steht und seit $ohne Minuten"
            echo "[wache] kein neues Bild (Stand $jetzt/$GESAMT). Kein weiterer"
            echo "[wache] Startversuch - hier muss ein Mensch nachsehen."
            break
        fi
        echo "[wache] $(date '+%F %T') Lauf weg bei $jetzt/$GESAMT - Neustart"
        # 9>&- auch hier: erbte der neue Lauf die Sperre, blockierte er jede
        # spaetere Wache — auch nachdem diese laengst beendet ist.
        setsid nohup python3 -u batch-bilder.py --gruppe --limit 0 --out "$ZIEL" \
            --endpoint "$ENDPOINT" >> vorrat.log 2>&1 9>&- < /dev/null &
        sleep 20 9>&-
    fi
done
