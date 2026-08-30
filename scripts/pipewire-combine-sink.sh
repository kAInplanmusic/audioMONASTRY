#!/usr/bin/env bash
# audioMONASTRY – PipeWire/PulseAudio Combine-Sink für N× ASUS Xonar U7
# Erzeugt EIN virtuelles Gerät "xonar_aggregate" mit 8/16/24/32 Kanälen.
set -euo pipefail

SINKS=$(pactl list short sinks 2>/dev/null | awk '{print $2}' | grep -iE 'xonar|u7|usb' || true)
if [[ -z "$SINKS" ]]; then
  echo "Keine Xonar-U7-Sinks gefunden. Verfügbare Sinks:"
  pactl list short sinks 2>/dev/null || true
  exit 1
fi

COUNT=$(echo "$SINKS" | wc -l)
echo "Gefundene U7-Sinks ($COUNT):"
echo "$SINKS" | nl

SLAVES=$(echo "$SINKS" | sed 's/^/slaves=/' | tr '\n' ',' | sed 's/,$//')

# Bestehendes Aggregat zuerst entfernen (idempotent).
pactl unload-module module-combine-sink 2>/dev/null || true

MODULE=$(pactl load-module module-combine-sink \
  sink_name=xonar_aggregate \
  sink_properties=device.description=audioMONASTRY_Xonar_Aggregate \
  $SLAVES)

echo "Combine-Sink erstellt (Modul $MODULE) – Gerätename: xonar_aggregate"
echo "Kanäle: $((COUNT * 8)) (je U7: FL FR C LFE RL RR SL SR)"
echo "In der App: Settings → Ausgabe → 'xonar_aggregate' wählen."
