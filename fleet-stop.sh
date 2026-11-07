#!/bin/bash
# audioMONASTRY Fleet Stop - Absolute Entry Point
# Can be run by user or agent from anywhere

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

echo "=== audioMONASTRY Fleet Stop ==="
echo "Running from: $(pwd)"
echo "Timestamp: $(date)"
echo ""

# Run using Python fleet manager (has direct API calls)
python3 scripts/fleet_manager.py stop "$@"