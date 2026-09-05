#!/usr/bin/env bash
# Background-Coder Pipeline stoppen
set -u
REPO="/home/patrick/audioMONASTRY"
PIDFILE="$REPO/.background-coder.pid"
if [ -f "$PIDFILE" ]; then
  PID="$(cat "$PIDFILE")"
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null
    sleep 1
    kill -0 "$PID" 2>/dev/null && kill -9 "$PID" 2>/dev/null
    echo "Background-Coder gestoppt (PID $PID)."
  else
    echo "Kein laufender Prozess (PID $PID ist beendet)."
  fi
  rm -f "$PIDFILE"
else
  echo "Keine PID-Datei gefunden – Background-Coder läuft nicht."
fi
