#!/usr/bin/env bash
# =============================================================================
# audioMONASTRY – Sample-Raten-Wechsel-Test (44.1/48/96/192 kHz) am Xonar U7
# -----------------------------------------------------------------------------
# Verifiziert das native Backend direkt an der Hardware (ALSA hw:1,0 = Xonar U7):
# Für jede Rate wird ein 1s-Playback (Stille, raw S16_LE) und ein 1s-Capture
# auf /dev/null geöffnet. Exit-Code 0 = Rate vom Gerät akzeptiert.
#
# Aufruf:  bash scripts/test-sample-rates.sh
# =============================================================================
set -uo pipefail

CARD="${U7_CARD:-1}"
DEV="${U7_DEV:-0}"
RATES=(44100 48000 96000 192000)
RESULTS=()
FAIL=0

echo "== Xonar U7 (hw:${CARD},${DEV}) Sample-Raten-Test =="
for rate in "${RATES[@]}"; do
  # Playback: 1 Sekunde Stille in raw S16_LE Stereo
  if aplay -q -D "hw:${CARD},${DEV}" -t raw -r "$rate" -f S16_LE -c 2 -d 1 /dev/zero 2>/tmp/aplay-u7.err; then
    P="PLAY OK"
  else
    P="PLAY FAIL"
    FAIL=1
  fi
  # Capture: 1 Sekunde auf /dev/null
  if arecord -q -D "hw:${CARD},${DEV}" -t raw -r "$rate" -f S16_LE -c 2 -d 1 /dev/null 2>/tmp/arecord-u7.err; then
    C="CAPTURE OK"
  else
    C="CAPTURE FAIL"
    FAIL=1
  fi
  RESULTS+=("$rate Hz: $P / $C")
  echo "  ${RESULTS[-1]}"
  if [ "$P" != "PLAY OK" ]; then echo "    $(tail -1 /tmp/aplay-u7.err)"; fi
  if [ "$C" != "CAPTURE OK" ]; then echo "    $(tail -1 /tmp/arecord-u7.err)"; fi
done

echo "== Ergebnis =="
printf '%s\n' "${RESULTS[@]}"
if [ "$FAIL" -eq 0 ]; then
  echo "PASS: Xonar U7 akzeptiert alle 4 Sample-Raten (Playback + Capture)."
else
  echo "FAIL: Mindestens eine Sample-Rate wurde nicht akzeptiert."
fi
exit "$FAIL"
