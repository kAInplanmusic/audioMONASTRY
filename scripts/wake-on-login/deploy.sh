#!/usr/bin/env bash
# =============================================================================
# wake-on-login/deploy.sh – Cloudflare-Worker für Wake-on-Login deployen
# -----------------------------------------------------------------------------
# Lädt HCLOUD_TOKEN + Cloudflare-Token aus .env/.env.deploy, injiziert sie in
# den Worker (Repo enthält nur Platzhalter!) und deployed ihn kostenlos auf
# Cloudflare Workers (immer erreichbar, auch wenn alle Hetzner-Server aus sind).
#
# Ergebnis:
#   Login-URL: https://audiomonastry-wake.<subdomain>.workers.dev
#   Passwort:  wird generiert (WAKE_PASSWORD) bzw. aus .env gelesen
#
# Aufruf:
#   bash scripts/wake-on-login/deploy.sh
#   WAKE_PASSWORD=mein-geheim bash scripts/wake-on-login/deploy.sh
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/../.."

set -a
[[ -f .env ]] && . ./.env
[[ -f .env.deploy ]] && . ./.env.deploy
set +a

CF_TOKEN="${CFR2_API_TOKEN:-${CF_TOKEN:-}}"
ACCOUNT_ID="${CFR2_ACCOUNT_ID:-${ACCOUNT_ID:-}}"
HETZNER_TOKEN="${HCLOUD_TOKEN:-}"
SCRIPT_NAME="${WAKE_SCRIPT_NAME:-audiomonastry-wake}"
APP_URL="${WAKE_APP_URL:-https://anunnakitools.de}"

[[ -n "$CF_TOKEN" ]] || { echo "CFR2_API_TOKEN fehlt" >&2; exit 1; }
[[ -n "$ACCOUNT_ID" ]] || { echo "CFR2_ACCOUNT_ID fehlt" >&2; exit 1; }
[[ -n "$HETZNER_TOKEN" ]] || { echo "HCLOUD_TOKEN fehlt" >&2; exit 1; }

# --- Passwort generieren/persistieren ---
if [[ -z "${WAKE_PASSWORD:-}" ]] && [[ -f .env ]] && grep -q '^WAKE_PASSWORD=' .env; then
  WAKE_PASSWORD=$(grep '^WAKE_PASSWORD=' .env | cut -d= -f2)
fi
if [[ -z "${WAKE_PASSWORD:-}" ]]; then
  WAKE_PASSWORD=$(openssl rand -base64 15 | tr -d '/+=' | cut -c1-16)
  echo "" >> .env
  echo "# Wake-on-Login Passwort (scripts/wake-on-login/deploy.sh)" >> .env
  echo "WAKE_PASSWORD=$WAKE_PASSWORD" >> .env
fi

PASSWORD_SHA256=$(printf '%s' "$WAKE_PASSWORD" | sha256sum | cut -d' ' -f1)

# --- Worker bauen (Secrets nur in die Temp-Datei) ---
TMP_WORKER=$(mktemp /tmp/audiomonastry-wake.XXXXXX.js)
sed -e "s|__HETZNER_TOKEN__|$HETZNER_TOKEN|" \
    -e "s|__PASSWORD_SHA256__|$PASSWORD_SHA256|" \
    -e "s|https://anunnakitools.de|$APP_URL|g" \
    scripts/wake-on-login/worker.js > "$TMP_WORKER"

CF_API="https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID"

echo "=== Deploy Worker '$SCRIPT_NAME' ==="
curl -fsS -X PUT "$CF_API/workers/scripts/$SCRIPT_NAME" \
  -H "Authorization: Bearer $CF_TOKEN" \
  -F 'metadata={"main_module":"worker.js","bindings":[]};type=application/json' \
  -F "worker.js=@$TMP_WORKER;type=application/javascript+module;filename=worker.js" \
  -o /tmp/wake-deploy.json
python3 -c "import json; d=json.load(open('/tmp/wake-deploy.json')); print('upload:', d.get('success'))"
rm -f "$TMP_WORKER"

# --- workers.dev-Subdomain sicherstellen ---
echo "=== workers.dev-Subdomain ==="
SUB=$(curl -fsS -H "Authorization: Bearer $CF_TOKEN" "$CF_API/workers/subdomain" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('result',{}).get('subdomain','') or '')")
if [[ -z "$SUB" ]]; then
  SUB="audiomonastry-wake-$(openssl rand -hex 3)"
  curl -fsS -X PUT "$CF_API/workers/subdomain" \
    -H "Authorization: Bearer $CF_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"subdomain\":\"$SUB\"}" -o /tmp/wake-sub.json
  python3 -c "import json; d=json.load(open('/tmp/wake-sub.json')); print('subdomain set:', d.get('result',{}).get('subdomain'))"
fi

# --- workers.dev-Route für dieses Skript aktivieren ---
curl -fsS -X POST "$CF_API/workers/scripts/$SCRIPT_NAME/subdomain" \
  -H "Authorization: Bearer $CF_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled":true}' -o /tmp/wake-route.json || true

LOGIN_URL="https://$SCRIPT_NAME.$SUB.workers.dev"
echo ""
echo "=============================================================="
echo "✅ Wake-on-Login deployed!"
echo "=============================================================="
echo "  Login-URL:  $LOGIN_URL"
echo "  Passwort:   $WAKE_PASSWORD"
echo ""
echo "  Ablauf: Login -> Hetzner-Flotte startet -> Health-Poll -> App"
echo "  Passwort ändern: WAKE_PASSWORD=neu bash scripts/wake-on-login/deploy.sh"
echo "=============================================================="
