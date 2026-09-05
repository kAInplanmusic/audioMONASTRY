#!/usr/bin/env bash
# =============================================================================
# smoke-test.sh – sampleMONK Hetzner Smoke-Test
# -----------------------------------------------------------------------------
# Aufruf:
#   bash scripts/hetzner/smoke-test.sh https://samplemonk.example
#   BASE_URL=https://samplemonk.example bash scripts/hetzner/smoke-test.sh
# =============================================================================
set -euo pipefail

BASE_URL="${1:-${BASE_URL:-}}"
if [[ -z "$BASE_URL" ]]; then
  echo "Nutzung: $0 https://DEINE-DOMAIN" >&2
  exit 1
fi
BASE_URL="${BASE_URL%/}"

# Auth-Token aus .env (STUDIO_ACCESS_TOKEN), falls gesetzt – für geschützte Endpoints.
AUTH_HEADERS=()
if [[ -n "${STUDIO_ACCESS_TOKEN:-}" ]]; then
  AUTH_HEADERS=(-H "x-studio-token: $STUDIO_ACCESS_TOKEN")
fi

echo "==> GET $BASE_URL/api/health"
curl -fsS "$BASE_URL/api/health"
echo

echo "==> GET $BASE_URL/api/cloud/health"
curl -fsS "${AUTH_HEADERS[@]}" "$BASE_URL/api/cloud/health"
echo

echo "==> GET $BASE_URL/api/master/health"
curl -fsS "${AUTH_HEADERS[@]}" "$BASE_URL/api/master/health"
echo

echo "==> GET $BASE_URL/api/master/selftest (voller FFmpeg/NumPy-Selbsttest)"
curl -fsS "${AUTH_HEADERS[@]}" "$BASE_URL/api/master/selftest"
echo

echo "✅ Smoke-Test erfolgreich: $BASE_URL"
