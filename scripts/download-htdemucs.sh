#!/usr/bin/env bash
# ============================================================================
# download-htdemucs.sh – Kompatibilitaets-Alias auf die EINE Modellquelle
# ----------------------------------------------------------------------------
# Vorher stand hier ein eigener Download mit
#   * falscher Quelle (ein GitHub-Raw-Pfad im Repository facebookresearch/htdemucs -
#     dort liegt kein ONNX-Modell) und
#   * falschem Ziel (public/models/htdemucs/htdemucs.onnx),
# waehrend der Client `/models/htdemucs.onnx` laedt (src/ai/localDemucs.ts) und
# `scripts/download-models.sh` genau dorthin schreibt. Zwei Skripte, zwei
# Wahrheiten: das Modell landete entweder gar nicht oder an einem Pfad, den
# niemand liest.
#
# Deshalb gibt es nur noch EINE Umsetzung: scripts/download-models.sh
# (Quelle: https://huggingface.co/smank/htdemucs-onnx, ~291 MB, HTTP 200 geprueft).
# ============================================================================
set -euo pipefail

HERE_SRC="$(cd "$(dirname "$0")" && pwd)"
CANONICAL="$HERE_SRC/download-models.sh"

[[ -f "$CANONICAL" ]] || { echo "❌ fehlt: $CANONICAL" >&2; exit 1; }
echo "Hinweis: download-htdemucs.sh ist ein Alias auf scripts/download-models.sh (EINE Quelle, Ziel public/models/htdemucs.onnx)."
exec bash "$CANONICAL" "$@"
