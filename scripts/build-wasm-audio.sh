#!/usr/bin/env bash
# audioMONASTRY – 8.1.2 WASM-Audio-Module bauen (Emscripten)
# Kompiliert src/audio/wasm/*.c zu dist/wasm/*.wasm:
#   * dspKernel.simd.js/.wasm – SIMD-Variante (-msimd128, schneller)
#   * dspKernel.js/.wasm      – Skalar-Fallback (maximale Kompatibilität)
# Zusätzlich wird mit wasm-opt (Binaryen) der Feature-Report geprüft.
set -euo pipefail

command -v emcc >/dev/null 2>&1 || { echo "emcc fehlt – Emscripten installieren."; exit 1; }

mkdir -p dist/wasm

COMMON_FLAGS=(
  -O3
  -s EXPORTED_FUNCTIONS='["_dsp_process","_malloc","_free"]'
  -s EXPORTED_RUNTIME_METHODS='["cwrap"]'
  -s ALLOW_MEMORY_GROWTH=1
  -s TOTAL_STACK=1048576
)

# 1) SIMD-Variante
emcc src/audio/wasm/dspKernel.c "${COMMON_FLAGS[@]}" -msimd128 \
  -o dist/wasm/dspKernel.simd.js
echo "WASM-Modul (SIMD): dist/wasm/dspKernel.simd.wasm"

# 2) Skalar-Fallback
emcc src/audio/wasm/dspKernel.c "${COMMON_FLAGS[@]}" \
  -o dist/wasm/dspKernel.js
echo "WASM-Modul (Skalar): dist/wasm/dspKernel.wasm"

# 3) Feature-Report (falls Binaryen installiert ist)
if command -v wasm-opt >/dev/null 2>&1; then
  echo "--- SIMD Feature-Report ---"
  wasm-opt --detect-features dist/wasm/dspKernel.simd.wasm || true
  echo "--- Skalar Feature-Report ---"
  wasm-opt --detect-features dist/wasm/dspKernel.wasm || true
fi
