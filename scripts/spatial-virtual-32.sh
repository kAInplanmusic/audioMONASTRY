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
    # PipeWire Pulse compatibility documents AUX0..AUX15 only. Do not
    # invent AUX16..AUX31. 32-channel layouts require native PipeWire
    # negotiation and a verified SPA channel-position map.
    echo "32-channel Pulse null-sink map is not portable (AUX0..AUX15 only)." >&2
    echo "Use the native PipeWire 32-channel bridge after capability validation." >&2
    exit 3
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
