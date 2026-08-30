#!/usr/bin/env bash
# audioMONASTRY – macOS Aggregat-Gerät (Anleitung + optional SwitchAudioSource)
# Echtes Erzeugen geht am zuverlässigsten über die GUI; dieses Skript prüft
# die Geräte und druckt die exakten Schritte.
set -euo pipefail

echo "Erkannte Audio-Geräte:"
system_profiler SPAudioDataType 2>/dev/null | grep -iE "xonar|u7|asus|usb" || echo "  (keine Xonar U7 gefunden)"

cat <<'EOF'

So erzeugst du das Aggregat-Gerät:
1. "Audio-MIDI-Setup" öffnen (Spotlight: Audio-MIDI-Setup)
2. Unten links "+" → "Aggregat-Gerät erzeugen"
3. Alle ASUS Xonar U7 in der Liste anhaken
4. Reihenfolge = Kanalreihenfolge (Gerät 1 = Kanäle 1–8, Gerät 2 = 9–16, …)
5. Optional: "Driftkorrektur" beim ersten Gerät aktivieren
6. In audioMONASTRY: Settings → Ausgabe → das neue Aggregat-Gerät wählen
EOF
