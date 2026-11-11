#!/usr/bin/env bash
# Unified provider-aware deployment: Vast GPUs and the existing Hetzner core.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
if [[ -f .env.deploy ]]; then set -a; source .env.deploy; set +a; fi
no_core=0
no_gpu=0
dry=0
for arg in "$@"; do
  case "$arg" in
    --no-hetzner) no_core=1 ;;
    --no-pods) no_gpu=1 ;;
    --dry-run) dry=1 ;;
    *) echo "Unknown option: $arg"; exit 2 ;;
  esac
done
if [[ "$no_core" == 1 && "$no_gpu" == 1 ]]; then exit 2; fi
if [[ "$dry" == 1 ]]; then exec python3 scripts/gpu-pods.py plan; fi
if [[ "$no_core" == 1 ]]; then exec python3 scripts/gpu-pods.py up --yes; fi
args=(--yes)
if [[ "$no_gpu" == 1 ]]; then args+=(--no-pods); fi
exec python3 scripts/fleet-start.py "${args[@]}"
