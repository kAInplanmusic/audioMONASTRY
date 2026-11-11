#!/usr/bin/env bash
# Eight-role Vast deployment. Models and checkpoints come from the shared SSOT.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
if [[ -f .env.deploy ]]; then set -a; source .env.deploy; set +a; fi
if [[ "$#" == 0 ]]; then exec python3 scripts/gpu-pods.py up --yes; fi
exec python3 scripts/gpu-pods.py "$@"
