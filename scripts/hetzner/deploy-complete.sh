#!/usr/bin/env bash
# Compatibility entrypoint: all GPU operations use the active Vast provider.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"
if [[ -f .env.deploy ]]; then set -a; source .env.deploy; set +a; fi
args=()
paid=1
for arg in "$@"; do
  case "$arg" in
    --dry-run) paid=0 ;;
    --yes) ;;
    *) args+=("$arg") ;;
  esac
done
if [[ "$paid" == 1 ]]; then args+=(--yes); fi
exec python3 "$REPO_ROOT/scripts/fleet-start.py" "${args[@]}"
