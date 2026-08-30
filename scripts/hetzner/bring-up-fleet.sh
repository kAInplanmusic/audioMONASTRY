#!/usr/bin/env bash
# =============================================================================
# bring-up-fleet.sh – audioMONASTRY Hetzner-Flotte KOMPLETT hochfahren
# -----------------------------------------------------------------------------
# Ein Befehl nach dem Login – macht alles:
#   1. Flotte provisionieren (5 Server, Firewalls, Floating-IP an app-1)
#   2. IPs ermitteln + auf SSH warten
#   3. app-1 deployen (Caddy + App + Signaling, HTTPS via anunnakitools.de)
#   4. sfu-1 (Mediasoup), master-1 (master-player), edge-1 (Monitoring),
#      ai-1 (Ollama + Stem-AI) einrichten
#   5. Idle-Auto-Shutdown auf allen Knoten installieren
#   6. Smoke-Test + Stresstest + SFU-RTP-Echtpfad-Test
#   7. Browser/URL öffnen, sobald alles bereit ist (Weiterleitung)
#
# Aufruf:
#   bash scripts/hetzner/bring-up-fleet.sh          (mit Rückfrage)
#   bash scripts/hetzner/bring-up-fleet.sh --yes    (ohne Rückfrage)
#
# WICHTIG (Kostenmodell):
#   Hetzner berechnet die Server ab ERSTELLUNG – auch im ausgeschalteten
#   Zustand. Die Flotte kostet netto ca. 39 €/Monat, solange die Server
#   existieren. Nach der Session: Server löschen (nicht nur stoppen), dann
#   fallen 0 € an (nur die Floating-IP bleibt mit 3 €/Monat reserviert).
#   Löschen:  bash scripts/hetzner/delete-fleet.sh
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")/../.."

# --- Konfiguration -----------------------------------------------------------
if [[ -f .env.deploy ]]; then set -a; . ./.env.deploy; set +a; fi
[[ -n "${HCLOUD_TOKEN:-}" ]] || { echo "HCLOUD_TOKEN fehlt (.env.deploy)" >&2; exit 1; }

if [[ "${1:-}" != "--yes" ]]; then
  echo "Achtung: Die Flotte wird provisioniert und kostet netto ca. 39 €/Monat,"
  echo "solange die Server existieren (auch ausgeschaltet!)."
  read -r -p "Jetzt hochfahren? [j/N] " ans
  [[ "$ans" == "j" || "$ans" == "J" ]] || { echo "Abgebrochen."; exit 0; }
fi

SSH_KEY="${DEPLOY_SSH_KEY:-$HOME/.ssh/id_ed25519}"
DOMAIN="${DEPLOY_DOMAIN:-anunnakitools.de}"
APP_URL="https://$DOMAIN"

step() { echo; echo "=============================================================="; echo "▶ $1"; echo "=============================================================="; }
ssh_host() { ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -o BatchMode=yes "root@$1"; }

get_ip() {
  curl -s -H "Authorization: Bearer $HCLOUD_TOKEN" "https://api.hetzner.cloud/v1/servers?name=$1" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); s=d['servers'][0] if d['servers'] else None; print(s['public_net']['ipv4']['ip'] if s else '')"
}

# --- 1. Provisionieren -------------------------------------------------------
step "1/7 Flotte provisionieren (Server + Firewall + Floating-IP)"
bash scripts/hetzner/provision-fleet.sh

# --- 2. IPs ermitteln ---------------------------------------------------------
step "2/7 IPs ermitteln"
APP_IP=$(get_ip samplemonk-app-1)
SFU_IP=$(get_ip samplemonk-sfu-1)
AI_IP=$(get_ip samplemonk-ai-1)
MASTER_IP=$(get_ip samplemonk-master-1)
EDGE_IP=$(get_ip samplemonk-edge-1)
[[ -n "$APP_IP" && -n "$SFU_IP" && -n "$AI_IP" && -n "$MASTER_IP" && -n "$EDGE_IP" ]] || {
  echo "❌ Nicht alle IPs gefunden. Läuft die Provisionierung? (app=$APP_IP sfu=$SFU_IP ai=$AI_IP master=$MASTER_IP edge=$EDGE_IP)" >&2
  exit 1
}
echo "app=$APP_IP sfu=$SFU_IP ai=$AI_IP master=$MASTER_IP edge=$EDGE_IP"

# --- 3. SSH-Bereitschaft ------------------------------------------------------
step "3/7 Auf Cloud-Init/SSH warten (kann 2–4 min dauern)"
for ip in "$APP_IP" "$SFU_IP" "$AI_IP" "$MASTER_IP" "$EDGE_IP"; do
  echo -n "  $ip … "
  ok=0
  for _ in $(seq 1 90); do
    if ssh_host "$ip" 'test -f /root/.samplemonk-bootstrap-done' 2>/dev/null; then ok=1; break; fi
    sleep 5
  done
  if [[ "$ok" == "1" ]]; then echo "bereit"; else echo "TIMEOUT"; exit 1; fi
done

# --- 4. app-1 deployen --------------------------------------------------------
step "4/7 app-1 deployen (Caddy + App + Signaling, HTTPS)"
DEPLOY_HOST="root@$APP_IP" DEPLOY_DOMAIN="$DOMAIN" DEPLOY_SSH_KEY="$SSH_KEY" DEPLOY_SMOKE=0 bash deploy.sh

# --- 5. Übrige Rollen ---------------------------------------------------------
step "5/7 sfu-1, master-1, edge-1, ai-1 einrichten"
RSYNC_E="ssh -i $SSH_KEY -o StrictHostKeyChecking=accept-new"
rsync_repo() {
  rsync -az --delete -e "$RSYNC_E" \
    --exclude node_modules --exclude dist --exclude .git --exclude coverage --exclude test-results \
    ./ "root@$1:/opt/samplemonk/"
}
sync_env() { rsync -az -e "$RSYNC_E" .env "root@$1:/opt/samplemonk/.env"; }

echo "  sfu-1 (Mediasoup) …"
rsync_repo "$SFU_IP"; sync_env "$SFU_IP"
ssh_host "$SFU_IP" "cd /opt/samplemonk && grep -q SFU_ANNOUNCED_IP .env || echo SFU_ANNOUNCED_IP=$SFU_IP >> .env; docker compose -f docker-compose.hetzner.yml -f docker-compose.sfu.yml up -d caddy sample-monk"

echo "  master-1 (master-player) …"
rsync_repo "$MASTER_IP"; sync_env "$MASTER_IP"
ssh_host "$MASTER_IP" "cd /opt/samplemonk && docker compose -f docker-compose.hetzner.yml up -d master-player"

echo "  edge-1 (Monitoring: Prometheus/Grafana/Alertmanager) …"
rsync_repo "$EDGE_IP"; sync_env "$EDGE_IP"
ssh_host "$EDGE_IP" "cd /opt/samplemonk && docker compose -f docker-compose.hetzner.yml -f docker-compose.monitoring.yml up -d"

echo "  ai-1 (Ollama + Stem-AI) …"
bash scripts/hetzner/install-ai1.sh "root@$AI_IP"

# --- 6. Idle-Auto-Shutdown ----------------------------------------------------
step "6/7 Idle-Auto-Shutdown installieren (spart Ressourcen; Kosten nur durch Löschen!)"
for ip in "$APP_IP" "$SFU_IP" "$AI_IP" "$MASTER_IP" "$EDGE_IP"; do
  ssh_host "$ip" 'bash /opt/samplemonk/scripts/hetzner/install-idle-shutdown.sh' 2>/dev/null || true
done

# --- 7. Tests -----------------------------------------------------------------
step "7/7 Smoke-, Stress- und SFU-RTP-Echtpfad-Tests"
echo "  Smoke-Test $APP_URL …"
bash scripts/hetzner/smoke-test.sh "$APP_URL" || echo "  ⚠ Smoke-Test fehlgeschlagen (prüfen!)"
echo "  Stresstest gegen $APP_URL …"
BASE_URL="$APP_URL" node scripts/hetzner/stress-test.mjs || echo "  ⚠ Stresstest fehlgeschlagen (prüfen!)"
echo "  SFU-RTP-Echtpfad gegen sfu-1 ($SFU_IP) …"
BASE_URL="http://$SFU_IP" node scripts/hetzner/sfu-rtp-run.mjs || echo "  ⚠ SFU-RTP-Test fehlgeschlagen (prüfen!)"

# --- Fertig -------------------------------------------------------------------
echo
echo "=============================================================="
echo "✅ audioMONASTRY-Flotte ist bereit:"
echo "   App:      $APP_URL"
echo "   SFU:      http://$SFU_IP   (RTP 40000–40099)"
echo "   Grafana:  http://$EDGE_IP:3000 (Firewall ggf. öffnen)"
echo "   Ollama:   http://$AI_IP:11434 · Stem-AI: http://$AI_IP:8000"
echo "=============================================================="

if command -v xdg-open >/dev/null 2>&1 && [[ -n "${DISPLAY:-}" ]]; then
  echo "Öffne $APP_URL im Browser …"
  xdg-open "$APP_URL" >/dev/null 2>&1 || true
else
  echo "Bitte im Browser öffnen: $APP_URL"
fi
