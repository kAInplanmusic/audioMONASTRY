#!/usr/bin/env bash
# =============================================================================
# install-idle-teardown.sh – sichert den automatischen 15-Minuten-Teardown ab.
#
# ZWEI unabhaengige Waechter (Betreiber 2026-11-08: "muss IMMER passieren"):
#   A) cron auf DIESEM Rechner (Brain)  -> laeuft, solange der Brain laeuft
#   B) systemd-Timer auf app-1          -> laeuft, solange die App laeuft
#
# Beide rufen scripts/fleet-idle-teardown.py --apply auf. Das Skript entscheidet
# selbst: nur bei belegter Idle (>= 15 Min) oder wenn die App laenger als die
# Karenz nicht erreichbar ist. Teardown = Snapshot je Server -> Server loeschen
# -> Pods terminieren -> 0 EUR verifizieren.
#
# Aufruf:
#   sudo bash scripts/install-idle-teardown.sh            # A + B installieren
#   bash scripts/install-idle-teardown.sh --brain-only    # nur A (kein root fuer B)
#   bash scripts/install-idle-teardown.sh --print         # nur zeigen, nichts aendern
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WATCH="$REPO_ROOT/scripts/fleet-idle-teardown.py"
CRON_FILE="/etc/cron.d/audiomonastry-idle-teardown"
LOG="/var/log/audiomonastry-idle-teardown.log"

PRINT=0
BRAIN_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --print) PRINT=1 ;;
    --brain-only) BRAIN_ONLY=1 ;;
  esac
done

[[ -f "$WATCH" ]] || { echo "FEHLT: $WATCH" >&2; exit 1; }

CRON_LINE="*/5 * * * * root cd $REPO_ROOT && /usr/bin/env python3 $WATCH --apply >> $LOG 2>&1"

echo "=== A) cron auf diesem Rechner ==="
echo "  Datei: $CRON_FILE"
echo "  Inhalt: $CRON_LINE"

if [[ $BRAIN_ONLY -eq 0 && $EUID -ne 0 ]]; then
  echo "  HINWEIS: nicht root – cron wird uebersprungen (mit sudo erneut ausfuehren)."
fi

if [[ $PRINT -eq 1 ]]; then
  echo
  echo "=== B) systemd-Timer auf app-1 (Vorschau) ==="
  echo "  audiomonastry-idle-teardown.service + .timer, alle 5 Min"
  echo "  (wird per SSH auf den app-1-Knoten kopiert und aktiviert)"
  echo
  echo "PRINT-Modus: nichts geaendert."
  exit 0
fi

if [[ $EUID -eq 0 ]]; then
  cat > "$CRON_FILE" <<CRON
# audioMONASTRY: automatischer 15-Minuten-Teardown (Kosten auf 0 EUR)
# Installiert $(date -Iseconds) von scripts/install-idle-teardown.sh
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
$CRON_LINE
CRON
  chmod 0644 "$CRON_FILE"
  touch "$LOG"
  chmod 0640 "$LOG"
  echo "  OK: cron installiert"
else
  echo "  UEBERSPRUNGEN: kein root (sudo bash $0)"
fi

# --- B) systemd-Timer auf app-1 -------------------------------------------------
if [[ $BRAIN_ONLY -eq 0 && $EUID -eq 0 ]]; then
  echo
  echo "=== B) systemd-Timer auf app-1 ==="
  # shellcheck disable=SC1091
  set -a; source "$REPO_ROOT/.env.deploy" 2>/dev/null || true; set +a
  APP_IP=$(python3 - "$HCLOUD_TOKEN" <<'PY'
import json, sys, urllib.request
tok = sys.argv[1] if len(sys.argv) > 1 else ""
req = urllib.request.Request(
    "https://api.hetzner.cloud/v1/servers?labels[app]=audiomonastry&per_page=50",
    headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json"})
req.add_header("User-Agent", "audiomonastry-installer/1.0")
try:
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.loads(r.read() or b"{}")
    for s in data.get("servers", []):
        if (s.get("labels") or {}).get("role") == "app":
            print((s.get("public_net") or {}).get("ipv4", {}).get("ip", "")); break
except Exception:
    pass
PY
)
  if [[ -z "${APP_IP:-}" ]]; then
    echo "  app-1 nicht gefunden — Timer wird uebersprungen (beim naechsten Start erneut ausfuehren)."
  else
    echo "  app-1: $APP_IP"
    UNITS=$(mktemp -d)
    cat > "$UNITS/audiomonastry-idle-teardown.service" <<'UNIT'
[Unit]
Description=audioMONASTRY Idle-Teardown (15 Min ohne Nutzung -> sichern + 0 EUR)
After=network-online.target

[Service]
Type=oneshot
WorkingDirectory=/opt/audiomonastry
ExecStart=/usr/bin/python3 /opt/audiomonastry/scripts/fleet-idle-teardown.py --apply
UNIT
    cat > "$UNITS/audiomonastry-idle-teardown.timer" <<'UNIT'
[Unit]
Description=audioMONASTRY Idle-Teardown alle 5 Minuten

[Timer]
OnBootSec=5min
OnUnitActiveSec=5min
AccuracySec=30s

[Install]
WantedBy=timers.target
UNIT
    ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 "root@$APP_IP" \
      "mkdir -p /opt/audiomonastry/scripts /etc/systemd/system" 2>&1 | sed 's/^/  /'
    scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -q \
      "$UNITS/audiomonastry-idle-teardown.service" "$UNITS/audiomonastry-idle-teardown.timer" \
      "root@$APP_IP:/etc/systemd/system/" 2>&1 | sed 's/^/  /'
    scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -q \
      "$WATCH" "$REPO_ROOT/scripts/fleet-teardown.py" "$REPO_ROOT/.env.deploy" \
      "root@$APP_IP:/opt/audiomonastry/scripts/" 2>&1 | sed 's/^/  /'
    ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
      "root@$APP_IP" \
      "mv /opt/audiomonastry/scripts/.env.deploy /opt/audiomonastry/.env.deploy 2>/dev/null; \
       chmod 600 /opt/audiomonastry/.env.deploy; \
       systemctl daemon-reload && systemctl enable --now audiomonastry-idle-teardown.timer && \
       systemctl list-timers audiomonastry-idle-teardown.timer --no-pager" 2>&1 | sed 's/^/  /'
    rm -rf "$UNITS"
  fi
fi

echo
echo "Fertig. Der Waechter prueft alle 5 Minuten; Teardown nur bei belegter Idle"
echo "oder wenn die App laenger als die Karenz nicht erreichbar ist."
echo "Log: $LOG"
