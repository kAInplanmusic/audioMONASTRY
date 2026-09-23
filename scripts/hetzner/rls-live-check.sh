#!/usr/bin/env bash
# ============================================================================
# audioMONASTRY · naechtlicher RLS-Live-Abgleich auf dem Hetzner-Knoten
# ============================================================================
# Entscheidung des Betreibers am 2026-09-23: der RLS-Abgleich (DB-P2-002) soll
# NUR auf dem Hetzner-Knoten laufen und NICHT von selbst scharf sein
# ("nur Hetzner und auto aus").
#
# Warum Hetzner und nicht CI: die .env mit dem Dienstschluessel liegt auf dem
# Knoten ohnehin. Ein neuer Dienstschluessel in GitHub waere ein zusaetzliches
# Ziel - und der Abgleich braucht keinen.
#
# Dieser Skript ist NICHT von selbst aktiv. Einrichten (auf app-1, als root):
#
#   install -m 0755 scripts/hetzner/rls-live-check.sh /usr/local/bin/audiomonastry-rls-check
#   cat > /etc/systemd/system/audiomonastry-rls-check.service <<'UNIT'
#   [Unit]
#   Description=audioMONASTRY RLS-Live-Abgleich (DB-P2-002)
#   [Service]
#   Type=oneshot
#   WorkingDirectory=/opt/audioMONASTRY
#   ExecStart=/usr/local/bin/audiomonastry-rls-check
#   UNIT
#   cat > /etc/systemd/system/audiomonastry-rls-check.timer <<'UNIT'
#   [Unit]
#   Description=naechtlicher RLS-Live-Abgleich
#   [Timer]
#   OnCalendar=*-*-* 03:30:00
#   Persistent=true
#   [Install]
#   WantedBy=timers.target
#   UNIT
#
#   # Scharf machen (bewusst ein eigener Schritt - "auto aus"):
#   systemctl daemon-reload
#   systemctl enable --now audiomonastry-rls-check.timer
#
# Ausschalten:
#   systemctl disable --now audiomonastry-rls-check.timer
#
# RUECKGABE: 0 = Vertrag erfuellt, 1 = VERSTOSS (Exposition!), 2 = nicht messbar.
# ============================================================================
set -uo pipefail

REPO="${AUDIOMONASTRY_DIR:-/opt/audioMONASTRY}"
cd "$REPO" || { echo "Repo nicht gefunden: $REPO"; exit 2; }

if [ ! -f .env ]; then
  echo "Keine .env in $REPO - Abgleich nicht messbar."
  exit 2
fi

# .env einlesen, ohne Werte auszugeben.
set -a
# shellcheck disable=SC1091
. ./.env >/dev/null 2>&1
set +a

echo "[rls-check] $(date -Is) Projekt ${SB_URL:-<SB_URL fehlt>}"
npm run verify:rls-live
code=$?

case "$code" in
  0) echo "[rls-check] Vertrag erfuellt." ;;
  1) echo "[rls-check] VERSTOSS GEGEN DEN RLS-VERTRAG - die Datenbank erlaubt mehr, als das Repo beschreibt." ;;
  *) echo "[rls-check] Nicht messbar (fehlende Zugangsdaten oder fehlende Funktion)." ;;
esac

# Alarmweg: der bestehende Webhook, wenn konfiguriert.
if [ "$code" != "0" ] && [ -n "${ALERT_WEBHOOK_TOKEN:-}" ] && [ -n "${ALERT_WEBHOOK_URL:-}" ]; then
  curl -sS -m 10 -X POST "$ALERT_WEBHOOK_URL" \
    -H "Content-Type: application/json" \
    -H "x-alert-token: $ALERT_WEBHOOK_TOKEN" \
    -d "{\"source\":\"rls-live-check\",\"severity\":\"critical\",\"summary\":\"RLS-Vertrag verletzt oder nicht messbar\",\"exitCode\":$code}" \
    >/dev/null 2>&1 || echo "[rls-check] Webhook-Zustellung fehlgeschlagen."
fi

exit "$code"
