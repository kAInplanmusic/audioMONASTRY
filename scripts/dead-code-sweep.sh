#!/usr/bin/env bash
# =============================================================================
# audioMONASTRY – Dead-Code-Sweep (DCT-120)
# -----------------------------------------------------------------------------
# Prüft auf TODO/FIXME/HACK, @deprecated und den entfernten PLUGIN_REGISTRY.
# Exit 0 = sauber, 1 = Fund.
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

violations=0
while IFS= read -r file; do
  if grep -nE 'TODO|FIXME|HACK|@deprecated|PLUGIN_REGISTRY' "$file" >/dev/null 2>&1; then
    echo "FUND: $file"
    grep -nE 'TODO|FIXME|HACK|@deprecated|PLUGIN_REGISTRY' "$file" | head -5
    violations=$((violations + 1))
  fi
done < <(find src server services scripts -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.mjs' \) | grep -v node_modules | sort)

if [ "$violations" -gt 0 ]; then
  echo "❌ $violations Dateien mit Dead-Code-Markern."
  exit 1
fi

echo "✅ Dead-Code-Sweep sauber: keine TODO/FIXME/HACK/@deprecated/PLUGIN_REGISTRY."
