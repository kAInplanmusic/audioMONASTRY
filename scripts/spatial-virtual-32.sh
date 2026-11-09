#!/usr/bin/env bash
# Experimental user-session 32-channel PipeWire/PulseAudio null sink.
# Never modifies system-wide audio defaults. Does not prove browser 32ch.
set -euo pipefail
SINK="spatialmonk_virtual_32"
STATE="${XDG_RUNTIME_DIR:-/tmp}/spatialmonk-virtual32-module-id"
case "${1:-status}" in
  start)
    command -v pactl >/dev/null || { echo "pactl missing" >&2; exit 1; }
    if pactl list short sinks | grep -Fq "$SINK"; then
      echo "Already present: $SINK"; exit 0
    fi
    # AUX0..AUX31 is the channel map. Some PipeWire versions or
    # compatibility servers may reject 32 channels: fail explicitly.
    map=""
    for i in $(seq 0 31); do
      [[ -n "$map" ]] && map+=","
      map+="aux$i"
    done
    id="$(pactl load-module module-null-sink "sink_name=$SINK"       "sink_properties=device.description=spatialMONK_Virtual_32"       "rate=48000" "format=float32le" "channels=32" "channel_map=$map")"
    [[ "$id" =~ ^[0-9]+$ ]] || { echo "No module ID returned" >&2; exit 1; }
    printf '%s\n' "$id" > "$STATE"
    echo "Created virtual sink $SINK (module $id)."
    pactl list short sinks | grep -F "$SINK" || true
    echo "NOTE: channel routing and browser 32ch output still require validation."
    ;;
  stop)
    if [[ -f "$STATE" ]]; then
      id="$(cat "$STATE")"
      if [[ "$id" =~ ^[0-9]+$ ]]; then pactl unload-module "$id"; fi
      rm -f "$STATE"
    else
      echo "No owned module ID found; refusing to unload other modules."
    fi
    ;;
  status)
    pactl list short sinks | grep -F "$SINK" || echo "Virtual sink not active."
    ;;
  *) echo "Usage: $0 start|stop|status" >&2; exit 2 ;;
esac
