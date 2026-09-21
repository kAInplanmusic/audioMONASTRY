#!/usr/bin/env bash
# ============================================================================
# download-models.sh – die EINE Modellquelle (HTDemucs v4 ONNX)
# ----------------------------------------------------------------------------
# Warum genau EIN Skript: `scripts/download-htdemucs.sh` zeigte frueher auf einen
# GitHub-Raw-Pfad (dort liegt kein ONNX) und schrieb nach
# public/models/htdemucs/htdemucs.onnx, waehrend der Client
# `/models/htdemucs.onnx` laedt (src/ai/localDemucs.ts). Zwei Umsetzungen, zwei
# Ziele - das Modell landete entweder gar nicht oder an einem Pfad, den niemand
# liest. `download-htdemucs.sh` ist deshalb nur noch ein Alias auf dieses Skript.
#
# Hash-Pruefung (Security-TODO aus docs/ONNX_MODELS.md, nachgezogen 2026-09-21):
# Ein 291-MB-Blob aus dem Netz wird NICHT ungeprueft in den Produktionspfad
# gelegt. Der erwartete SHA-256 ist der LFS-OID der Quelle (HuggingFace liefert
# ihn ueber /api/models/<repo>/tree/main?expand=true) - heute identisch mit dem
# ausgelieferten Artefakt (app-1 bekommt dieselbe Datei per Medien-Overlay).
# Weicht der Download ab, bricht der Lauf ab und die Datei wird verworfen; die
# Pin-Zeile wird dann bewusst und mit Begruendung aktualisiert, nicht still.
#
# Aufruf:
#   bash scripts/download-models.sh                 # vorhandene Datei pruefen/ggf. laden
#   bash scripts/download-models.sh --verify-only   # nur pruefen (kein Netz)
#   bash scripts/download-models.sh --print-config  # Trockenlauf (kein Netz, keine Werte)
#   TARGET=/pfad/htdemucs.onnx bash scripts/download-models.sh
# ============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${TARGET:-$REPO_ROOT/public/models/htdemucs.onnx}"
URL="https://huggingface.co/smank/htdemucs-onnx/resolve/main/htdemucs.onnx"

# Quelle smank/htdemucs-onnx, Datei htdemucs.onnx: LFS-OID (= SHA-256) und Groesse.
MODEL_SHA256="d2b401f322558cd57d67a752ed7be3fa55178a0626011eda8ac7bb74e17280c0"
MODEL_SIZE="304321552"   # 290 MiB

# --verify-only prueft NUR eine vorhandene Datei (kein Netz) - gedacht fuer Preflight/
# Deploy ("liegt das gepruefte Modell wirklich da?") und fuer Tests.
VERIFY_ONLY=0
if [[ "${1:-}" == "--verify-only" ]]; then
  VERIFY_ONLY=1
fi

if [[ "${1:-}" == "--print-config" ]]; then
  echo "download-models.sh - effektive Konfiguration (kein Netz, kein Schreiben)"
  printf '  Ziel:        %s\n' "$TARGET"
  printf '  Quelle:      %s\n' "$URL"
  printf '  SHA-256:     %s\n' "$MODEL_SHA256"
  printf '  Groesse:     %s Bytes\n' "$MODEL_SIZE"
  if [[ -f "$TARGET" ]]; then
    printf '  Datei da:    ja (%s Bytes)\n' "$(stat -c %s "$TARGET")"
  else
    printf '  Datei da:    nein\n'
  fi
  exit 0
fi

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

verify() { # $1 = Datei
  local actual_size actual_sha
  actual_size="$(stat -c %s "$1" 2>/dev/null || stat -f %z "$1")"
  if [[ "$actual_size" != "$MODEL_SIZE" ]]; then
    echo "❌ Groesse stimmt nicht: $actual_size statt $MODEL_SIZE Bytes ($1)" >&2
    return 1
  fi
  actual_sha="$(sha256_of "$1")"
  if [[ "$actual_sha" != "$MODEL_SHA256" ]]; then
    echo "❌ SHA-256 stimmt nicht:" >&2
    echo "   erwartet: $MODEL_SHA256" >&2
    echo "   gefunden: $actual_sha" >&2
    echo "   Die Datei wurde VERWORFEN. Hat die Quelle gewechselt? Dann die Pin-Zeile" >&2
    echo "   in scripts/download-models.sh bewusst aktualisieren (mit Begruendung)." >&2
    return 1
  fi
  return 0
}

if [[ "$VERIFY_ONLY" == "1" ]]; then
  if [[ ! -f "$TARGET" ]]; then
    echo "❌ Modell fehlt: $TARGET" >&2
    exit 1
  fi
  verify "$TARGET" || exit 1
  echo "✅ Modell vorhanden und Hash-korrekt: $TARGET ($(stat -c %s "$TARGET") Bytes)"
  exit 0
fi

mkdir -p "$(dirname "$TARGET")"

if [[ -f "$TARGET" ]] && verify "$TARGET" >/dev/null 2>&1; then
  echo "✅ Modell schon vorhanden und Hash-korrekt: $TARGET ($(stat -c %s "$TARGET") Bytes) - kein Download."
  exit 0
fi

echo "Lade htdemucs.onnx (~291 MB) nach $TARGET …"
PART="$TARGET.part"
rm -f "$PART"
curl -fL --proto '=https' --retry 3 --retry-delay 2 -o "$PART" "$URL"

verify "$PART" || { rm -f "$PART"; exit 1; }

mv "$PART" "$TARGET"
echo "✅ Modell geladen und geprueft: $TARGET ($(stat -c %s "$TARGET") Bytes, SHA-256 ok)"
