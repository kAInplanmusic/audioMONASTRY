#!/usr/bin/env bash
# PROD-P1-002: Audio-Qualitaets-Gate ueber die Golden-WAVs.
# =============================================================================
# Prueft je WAV im Verzeichnis (Default: tests/fixtures/audio) per ffmpeg ebur128:
#   - integrierte Lautheit: -12.0 LUFS +/- 1.5 LU (Referenz des Golden-Masters)
#   - True Peak (TPK):     <= -1.0 dBTP
#   - Sample Peak:         <= -1.0 dBFS
# Exit 0 = alle Dateien im Toleranzfenster, sonst 1.
#
# Aufruf:  bash scripts/audio-gate.sh [verzeichnis]
# =============================================================================
set -euo pipefail

DIR="${1:-tests/fixtures/audio}"
REF_IL="-12.0"
TOL_IL="1.5"
MAX_TP="-1.0"
MAX_PK="-1.0"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "AUDIO-GATE: ffmpeg fehlt - bitte installieren (apt-get install -y ffmpeg)."
  echo "Hinweis: die GitHub-Runner bringen ffmpeg NICHT mit; der Workflow installiert es."
  exit 1
fi

shopt -s nullglob
files=("$DIR"/*.wav)
if [ "${#files[@]}" -eq 0 ]; then
  echo "AUDIO-GATE: keine WAV-Dateien in $DIR"
  exit 1
fi

fail=0
for f in "${files[@]}"; do
  out="$(ffmpeg -nostdin -i "$f" -af ebur128=peak=true -f null - 2>&1 || true)"
  il="$(printf '%s\n' "$out" | grep -oP '^\s+I:\s*\K-?[0-9.]+' | tail -1 || true)"
  pk="$(printf '%s\n' "$out" | grep -oP '^\s+Peak:\s*\K-?[0-9.]+' | tail -1 || true)"
  tp="$(printf '%s\n' "$out" | grep -oP 'TPK:\s*\K-?[0-9.]+' | tail -1 || true)"

  ok=1
  if [ -z "$il" ] || [ -z "$pk" ] || [ -z "$tp" ]; then
    echo "FAIL $f: Messung unvollstaendig (I=$il Peak=$pk TPK=$tp)"
    fail=1; ok=0
  fi
  if [ "$ok" = 1 ]; then
    awk -v il="$il" -v ref="$REF_IL" -v tol="$TOL_IL" \
      'BEGIN { exit !(il >= ref - tol && il <= ref + tol) }' || {
        echo "FAIL $f: I=$il LUFS (erwartet $REF_IL +/-$TOL_IL)"; fail=1; ok=0; }
  fi
  if [ "$ok" = 1 ]; then
    awk -v tp="$tp" -v max="$MAX_TP" 'BEGIN { exit !(tp <= max) }' || {
      echo "FAIL $f: TruePeak=$tp dBTP (Grenze $MAX_TP)"; fail=1; ok=0; }
  fi
  if [ "$ok" = 1 ]; then
    awk -v pk="$pk" -v max="$MAX_PK" 'BEGIN { exit !(pk <= max) }' || {
      echo "FAIL $f: Peak=$pk dBFS (Grenze $MAX_PK)"; fail=1; ok=0; }
  fi
  [ "$ok" = 1 ] && echo "PASS $f: I=$il LUFS, TPK=$tp dBTP, Peak=$pk dBFS"
done

if [ "$fail" -ne 0 ]; then
  echo "AUDIO-GATE: FEHLGESCHLAGEN"
  exit 1
fi
echo "AUDIO-GATE: OK (${#files[@]} Datei(en))"
