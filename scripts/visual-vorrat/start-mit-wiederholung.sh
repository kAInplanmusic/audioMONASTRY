#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Startet den v2-Anwendungspod, sobald wieder Kapazitaet da ist.
#
# Grund: am 27.09. lieferte JEDE Karte auf Community UND Secure entweder
# "There are no longer any instances available" oder einen Geister-Pod, der
# wenige Sekunden nach der Anlage wieder verschwand (kostet nichts, blockiert
# aber). Die Kapazitaet schwankt ueber Minuten, deshalb wird hier gewartet statt
# aufgegeben.
#
# Sicherheit:
#   * Jeder Versuch bekommt einen EIGENEN Namen (die Namenssperre in
#     start-pod.py verhindert sonst jeden zweiten Versuch).
#   * start-pod.py prueft neuerdings, ob der Pod WIRKLICH startet, und geht
#     erst dann weiter - der Exit-Code unterscheidet Erfolg (0) von "keine
#     Kapazitaet" (4).
#   * Der Pod selbst hat eine harte USD-Obergrenze und terminiert sich.
# ---------------------------------------------------------------------------
set -uo pipefail
cd "$(dirname "$0")" || exit 1

RUNDEN="${1:-12}"
PAUSE="${2:-240}"
THEMEN="geheimbund_moenche industrial_techno krieg_tod licht_rauch natur_echt taenzer"
BUDGET="2.5"

# (Cloud, GPU-Kette) - billig/verfuegbar zuerst, teuer als letzter Ausweg.
COMMUNITY_KETTE="NVIDIA GeForce RTX 5090,NVIDIA A100 80GB PCIe,NVIDIA A100-SXM4-80GB,NVIDIA RTX PRO 6000 Blackwell Workstation Edition,NVIDIA H100 80GB HBM3,NVIDIA L40S"
SECURE_KETTE="NVIDIA RTX PRO 4500 Blackwell,NVIDIA L40S,NVIDIA A100 80GB PCIe,NVIDIA RTX PRO 6000 Blackwell Workstation Edition"

echo "[wiederholung] Runden=$RUNDEN, Pause=${PAUSE}s, Budget=$BUDGET USD"

for runde in $(seq 1 "$RUNDEN"); do
  for cloud in COMMUNITY SECURE; do
    name="lora-v2-w${runde}$( [ "$cloud" = SECURE ] && echo s || echo c )"
    if [ "$cloud" = SECURE ]; then kette="$SECURE_KETTE"; else kette="$COMMUNITY_KETTE"; fi
    echo "[wiederholung] Runde $runde / $cloud / Name $name"
    if python3 start-pod.py --name "$name" --cloud "$cloud" \
         --anwendung "$THEMEN" --suffix lr5e5cos --gpu "$kette" \
         --steps 800 --deadline-hours 3 --max-theme-minutes 45 --max-usd "$BUDGET" \
         --run lora-themen-v2; then
      echo "[wiederholung] ERFOLG: Pod $name laeuft ($cloud)"
      exit 0
    fi
  done
  echo "[wiederholung] Runde $runde ohne Kapazitaet - ${PAUSE}s Pause"
  sleep "$PAUSE"
done

echo "[wiederholung] AUFGEGEBEN nach $RUNDEN Runden - Kapazitaet fehlt weiterhin"
exit 1
