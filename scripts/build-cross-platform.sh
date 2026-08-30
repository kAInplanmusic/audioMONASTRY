#!/usr/bin/env bash
# audioMONASTRY – 8.1.3 Cross-Platform-Build (Browser + Desktop + Embedded)
# Eine Codebasis, drei Zielplattformen (Vite/Electron/native Stubs).
set -euo pipefail

TARGET="${1:-browser}"

case "$TARGET" in
  browser)
    npm run build
    ;;
  desktop)
    npm run build
    echo "[desktop] Electron/Tauri-Wrapper: src/core/native/NativeAudioBackend.ts nutzen"
    ;;
  embedded)
    npm run build
    echo "[embedded] Edge-Knoten: docs/EDGE_NODE_SPEC.md + src/core/edge/* verwenden"
    ;;
  *)
    echo "Usage: $0 {browser|desktop|embedded}"
    exit 1
    ;;
esac
