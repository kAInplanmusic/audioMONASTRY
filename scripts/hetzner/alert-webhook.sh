#!/usr/bin/env bash
# =============================================================================
# sampleMONK alert-webhook – einfacher Health->Webhook-Alarm (Discord/Slack)
# -----------------------------------------------------------------------------
# Prüft die App-Health und sendet bei Fehlern eine JSON-Meldung an einen
# Webhook (DISCORD_WEBHOOK oder SLACK_WEBHOOK). Als systemd-Timer nutzbar oder
# aus auto-repair.sh aufrufbar.
#
# Aufruf:
#   DISCORD_WEBHOOK=https://discord.com/api/webhooks/... bash scripts/hetzner/alert-webhook.sh
# =============================================================================
set -uo pipefail
WEBHOOK="${DISCORD_WEBHOOK:-${SLACK_WEBHOOK:-}}"
APP_URL="${APP_URL:-https://anunnakitools.de}"
LOG="${LOG:-/var/log/samplemonk-alert.log}"
ts() { date -u +%FT%TZ; }

[[ -n "$WEBHOOK" ]] || { echo "[alert] kein Webhook konfiguriert (DISCORD_WEBHOOK/SLACK_WEBHOOK)" >> "$LOG"; exit 0; }

if curl -fsS --max-time 8 "$APP_URL/api/health" >/dev/null 2>&1; then
  exit 0
fi

MSG="⚠️ sampleMONK App nicht erreichbar: $APP_URL ($(ts))"
echo "[alert] $MSG" >> "$LOG"
curl -s --max-time 10 -H "Content-Type: application/json" \
  -d "{\"content\":\"$MSG\"}" "$WEBHOOK" >/dev/null 2>&1 || true
