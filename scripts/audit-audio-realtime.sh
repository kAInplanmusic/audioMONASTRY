#!/usr/bin/env bash
# =============================================================================
# audioMONASTRY – Audio-Realtime-Audit (DCT-109/111)
# -----------------------------------------------------------------------------
# Prüft, dass Audio-Worklets/Callbacks KEINE verbotenen Aufrufe enthalten:
# console.log, JSON.stringify/parse, localStorage/IndexedDB, fetch, WebRTC,
# DOM-Zugriffe, Math.random (nicht-deterministisch im Audio-Thread).
# Exit 0 = sauber, 1 = Verstoß.
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

FORBIDDEN_PATTERNS=(
  'console\.log'
  'JSON\.stringify'
  'JSON\.parse'
  'localStorage'
  'indexedDB'
  'fetch\('
  'Math\.random'
  'document\.'
  'window\.'
  'RTCPeerConnection'
  # AM-E1-6: Hot-Path-Verbote im Audio-Thread
  'new Array'
  '\.push\('
  'Math\.pow'
  'Math\.log'
  'Math\.exp'
)

violations=0
while IFS= read -r file; do
  for pat in "${FORBIDDEN_PATTERNS[@]}"; do
    if grep -nE "$pat" "$file" | grep -v '//' >/dev/null 2>&1; then
      echo "VERSTOSS: $file enthält '$pat'"
      violations=$((violations + 1))
    fi
  done
done < <(find src/audio/worklets src/core/workers -type f \( -name '*.ts' -o -name '*.js' \) | sort)

if [ "$violations" -gt 0 ]; then
  echo "❌ $violations Verstöße im Audio-Realtime-Pfad."
  exit 1
fi

echo "✅ Audio-Realtime-Audit sauber: keine verbotenen Aufrufe in Worklets/Workern."
