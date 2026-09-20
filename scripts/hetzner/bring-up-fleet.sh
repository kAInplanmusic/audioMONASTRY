#!/usr/bin/env bash
# =============================================================================
# bring-up-fleet.sh – audioMONASTRY Hetzner-Flotte KOMPLETT hochfahren
# -----------------------------------------------------------------------------
# Ein Befehl nach dem Login – macht alles:
#   1. Flotte provisionieren (5 Server, Firewalls, Floating-IP an app-1)
#   2. IPs ermitteln + auf SSH warten
#   3. app-1 deployen (Caddy + App + Signaling, HTTPS via anunnakitools.de)
#   4. sfu-1 (Mediasoup), master-1 (master-player), edge-1 (NUR Monitoring-Stack),
#      ai-1 (Ollama + Stem-AI) einrichten
#   5. Idle-Auto-Shutdown + Watchdog installieren, Backup-Timer auf app-1
#   6. Smoke-Test + Stresstest + SFU-RTP-Echtpfad-Test
#   7. Browser/URL öffnen, sobald alles bereit ist (Weiterleitung)
#
# Aufruf:
#   bash scripts/hetzner/bring-up-fleet.sh               (mit Rückfrage)
#   bash scripts/hetzner/bring-up-fleet.sh --yes         (ohne Rückfrage)
#   bash scripts/hetzner/bring-up-fleet.sh --print-config (Trockenlauf: Rollen,
#                                                         Typen, Service-Listen)
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

SSH_KEY="${DEPLOY_SSH_KEY:-$HOME/.ssh/id_ed25519}"
DOMAIN="${DEPLOY_DOMAIN:-anunnakitools.de}"
APP_URL="https://$DOMAIN"

# NOMEN-P1-001 / F10: Namen der laufenden Installation aufloesen (neu oder
# Altname) - fleet-names.sh ist die EINE Quelle (Servernamen, Container,
# Compose-Projekt, Pfade). Sourcing ist seiteneffektfrei; es steht deshalb VOR
# dem Trockenlauf, damit auch der Projektname ohne Netz belegbar ist.
source "$(dirname "$0")/fleet-names.sh"

# INFRA-HETZNER-006: edge-1 startet NUR den Monitoring-Stack - diese explizite
# Service-Liste ist Pflicht. Ohne Liste zieht die Basisdatei zusätzlich `caddy`
# (128M) + `audiomonastry` (2G) + `master-player` (1G) mit; zusammen mit dem
# Monitoring-Stack sind das 4672 MiB deklarierte Speicher-Limits auf einem cx23
# mit 4096 MiB RAM (Audit-Befund H10: Überbuchung + Rollenvermischung). Die fünf
# Dienste hier sind exakt die Services aus docker-compose.monitoring.yml
# (512+512+128+256+64 = 1472 MiB = 1,44 GiB).
# Ehrlichkeitsgrenze: das sind DEKLARIERTE Compose-Limits. Compose v2 übersetzt
# `deploy.resources.limits` beim Start in `--memory`/`--cpus` - dokumentiertes
# Verhalten, auf den Knoten aber nicht live nachgemessen (kein Knoten läuft).
MONITORING_SERVICES="node-exporter cadvisor prometheus alertmanager grafana"

# Trockenlauf (INFRA-HETZNER-006/007): Rollen, Typen und Service-Listen ausgeben -
# ohne HCLOUD_TOKEN, ohne API-Aufruf, ohne Rückfrage.
if [[ "${1:-}" == "--print-config" || "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  echo "[dry-run] Flottenstart (keine API-Aufrufe, keine Server):"
  echo "  Typen:     app=${FLEET_TYPE_APP:-cx23} sfu=${FLEET_TYPE_SFU:-cx23} ai=${FLEET_TYPE_AI:-cx23} master=${FLEET_TYPE_MASTER:-cx23} edge=${FLEET_TYPE_EDGE:-cx23}  (Override per FLEET_TYPE_<ROLLE>)"
  # F10: Projektname + Zielpfad sind Teil des Namespace; beide kommen aus
  # fleet-names.sh und werden hier ohne Knoten belegt.
  echo "  Projekt:   COMPOSE_PROJECT_NAME=$(fleet_compose_project)   (Zielpfad $FLEET_HOME, top-level 'name:' in docker-compose.hetzner.yml)"
  echo "  app-1:     deploy.sh (Caddy + App + Signaling) | Backup-Timer | Watchdog"
  echo "  sfu-1:     docker compose -f docker-compose.hetzner.yml -f docker-compose.sfu.yml up -d caddy audiomonastry | Watchdog"
  echo "  master-1:  docker compose -f docker-compose.hetzner.yml up -d master-player | Watchdog"
  echo "  edge-1:    docker compose -f docker-compose.hetzner.yml -f docker-compose.monitoring.yml up -d $MONITORING_SERVICES  (NUR Monitoring) | Watchdog"
  echo "  ai-1:      install-ai1.sh (Ollama + Stem host-nativ) | Watchdog"
  echo "  Grafana:   ssh -L 3000:127.0.0.1:3000 root@<edge-1-ip>  ->  http://127.0.0.1:3000"
  exit 0
fi

[[ -n "${HCLOUD_TOKEN:-}" ]] || { echo "HCLOUD_TOKEN fehlt (.env.deploy)" >&2; exit 1; }

if [[ "${1:-}" != "--yes" ]]; then
  echo "Achtung: Die Flotte wird provisioniert und kostet netto ca. 39 €/Monat,"
  echo "solange die Server existieren (auch ausgeschaltet!)."
  read -r -p "Jetzt hochfahren? [j/N] " ans
  [[ "$ans" == "j" || "$ans" == "J" ]] || { echo "Abgebrochen."; exit 0; }
fi

step() { echo; echo "=============================================================="; echo "▶ $1"; echo "=============================================================="; }
# Fix 2026-09-13: Die Funktion nahm nur $1 (den Host) und verwarf das Kommando
# in $2. Dadurch liefen ALLE Aufrufe (Cloud-Init-Wait, sfu/master/edge-Setup,
# Idle-Shutdown) ins Leere – und weil eine interaktive SSH-Sitzung ohne TTY mit
# Exit 0 endet, sah jede Prüfung wie "OK" aus, obwohl nichts ausgeführt wurde.
# sfu-1/master-1/edge-1 hatten deshalb keine Container, während das Skript
# "Flotte ist bereit" meldete. Jetzt werden alle Argumente weitergegeben.
ssh_host() { local host="$1"; shift; ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -o BatchMode=yes "root@$host" "$@"; }

# NOMEN-P1-001 (Quelle: fleet-names.sh, oben bereits gesourct) - die Funktionen
# fleet_name/fleet_candidates/fleet_compose_project stehen ab hier zur Verfuegung.

get_ip() {
  curl -s -H "Authorization: Bearer $HCLOUD_TOKEN" "https://api.hetzner.cloud/v1/servers?name=$(fleet_name "$1")" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); s=d['servers'][0] if d['servers'] else None; print(s['public_net']['ipv4']['ip'] if s else '')"
}

# --- 1. Provisionieren -------------------------------------------------------
step "1/7 Flotte provisionieren (Server + Firewall + Floating-IP)"
bash scripts/hetzner/provision-fleet.sh

# --- 2. IPs ermitteln ---------------------------------------------------------
step "2/7 IPs ermitteln"
APP_IP=$(get_ip audiomonastry-app-1)
SFU_IP=$(get_ip audiomonastry-sfu-1)
AI_IP=$(get_ip audiomonastry-ai-1)
MASTER_IP=$(get_ip audiomonastry-master-1)
EDGE_IP=$(get_ip audiomonastry-edge-1)
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
    if ssh_host "$ip" 'test -f /root/.audiomonastry-bootstrap-done' 2>/dev/null; then ok=1; break; fi
    sleep 5
  done
  if [[ "$ok" == "1" ]]; then echo "bereit"; else echo "TIMEOUT"; exit 1; fi
done

# --- 4. app-1 deployen --------------------------------------------------------
# INFRA-HETZNER-001: DEPLOY_SYNC_ENV bleibt hier - wie im Preflight
# (fleet-preflight.sh, apply_update) - ausdruecklich auf 0. Sonst laedt deploy.sh
# die lokale Repo-.env hoch und ueberschreibt die rollen-skopierte Knoten-.env
# (inkl. TRUST_PROXY=1, das nur die Rolle app bekommen darf) - der Flottenstart
# haette damit die Rollentrennung des Portal-Workers aufgehoben. Beide Pfade
# rufen deploy.sh also mit derselben Einstellung auf; wer bewusst synchronisieren
# will, setzt DEPLOY_SYNC_ENV=1 in der Umgebung dieses Skripts.
step "4/7 app-1 deployen (Caddy + App + Signaling, HTTPS)"
echo "  .env-Sync: DEPLOY_SYNC_ENV=${DEPLOY_SYNC_ENV:-0} (0 = Knoten-.env des Portal-Workers bleibt)"
DEPLOY_HOST="root@$APP_IP" DEPLOY_DOMAIN="$DOMAIN" DEPLOY_SSH_KEY="$SSH_KEY" \
  DEPLOY_SYNC_ENV="${DEPLOY_SYNC_ENV:-0}" DEPLOY_SMOKE=0 sg docker -c "bash deploy.sh"

# --- 5. Übrige Rollen ---------------------------------------------------------
step "5/7 sfu-1, master-1, edge-1, ai-1 einrichten"
RSYNC_E="ssh -i $SSH_KEY -o StrictHostKeyChecking=accept-new"
rsync_repo() {
  rsync -az --delete -e "$RSYNC_E" \
    --exclude node_modules --exclude dist --exclude .git --exclude coverage --exclude test-results --exclude public/data/orchestral --exclude public/music --exclude target --exclude .venv-runpod --exclude .agents --exclude logs \
    ./ "root@$1:/opt/audiomonastry/"
}
sync_env() { rsync -az -e "$RSYNC_E" .env "root@$1:/opt/audiomonastry/.env"; }

echo "  sfu-1 (Mediasoup) …"
# F10: jeder Rollen-Deploy nennt das Compose-Projekt EXPLIZIT
# (COMPOSE_PROJECT_NAME) - sonst haengt der Projektname am Verzeichnisnamen und
# ein Knoten mit anderem Pfad bekaeme ein zweites Projekt mit eigenen Volumes.
# Ein Bestands-Knoten wird vorher migriert (scripts/hetzner/migrate-project-name.sh).
rsync_repo "$SFU_IP"; sync_env "$SFU_IP"
ssh_host "$SFU_IP" "cd /opt/audiomonastry && grep -q SFU_ANNOUNCED_IP .env || echo SFU_ANNOUNCED_IP=$SFU_IP >> .env; COMPOSE_PROJECT_NAME=$FLEET_COMPOSE_PROJECT docker compose -f docker-compose.hetzner.yml -f docker-compose.sfu.yml up -d caddy audiomonastry"

echo "  master-1 (master-player) …"
rsync_repo "$MASTER_IP"; sync_env "$MASTER_IP"
ssh_host "$MASTER_IP" "cd /opt/audiomonastry && COMPOSE_PROJECT_NAME=$FLEET_COMPOSE_PROJECT docker compose -f docker-compose.hetzner.yml up -d master-player"

echo "  edge-1 (Monitoring: Prometheus/Grafana/Alertmanager – NUR der Stack) …"
rsync_repo "$EDGE_IP"; sync_env "$EDGE_IP"
# INFRA-HETZNER-006: explizite Service-Liste (siehe MONITORING_SERVICES oben).
ssh_host "$EDGE_IP" "cd /opt/audiomonastry && COMPOSE_PROJECT_NAME=$FLEET_COMPOSE_PROJECT docker compose -f docker-compose.hetzner.yml -f docker-compose.monitoring.yml up -d $MONITORING_SERVICES"
# Und die Basis-Dienste stoppen, die ein ALTES edge-Snapshot beim Boot per
# `restart: unless-stopped` wieder hochzieht (caddy/audiomonastry/master-player):
# ohne diesen Schritt waere die Limit-Rechnung nur auf frisch provisionierten
# Knoten wahr. `stop` ist idempotent, laesst die Container liegen und ist ohne
# vorhandene Container ein No-Op (Exit 0).
ssh_host "$EDGE_IP" "cd /opt/audiomonastry && COMPOSE_PROJECT_NAME=$FLEET_COMPOSE_PROJECT docker compose -f docker-compose.hetzner.yml -f docker-compose.monitoring.yml stop caddy audiomonastry master-player >/dev/null 2>&1 || true"

echo "  ai-1 (Ollama + Stem-AI) …"
bash scripts/hetzner/install-ai1.sh "root@$AI_IP"

# --- 6. Idle-Auto-Shutdown + Backup-Timer -------------------------------------
step "6/7 Idle-Auto-Shutdown installieren (spart Ressourcen; Kosten nur durch Löschen!)"
for ip in "$APP_IP" "$SFU_IP" "$AI_IP" "$MASTER_IP" "$EDGE_IP"; do
  ssh_host "$ip" 'bash /opt/audiomonastry/scripts/hetzner/install-idle-shutdown.sh' 2>/dev/null || true
done

# INFRA-HETZNER-008: Das Backup lief bisher in KEINEM Flottenskript - nur die
# Server-Snapshots beim Stop (CLI) sicherten etwas. Der Timer laeuft auf app-1
# (dort liegt der Zustand: dist/public + Knoten-.env mit den Off-Site-Keys) und
# laeuft 15 min nach jedem Flotten-Start einmal sowie danach taeglich.
# Ohne Off-Site-Zugangsdaten meldet der Lauf das laut ins Log und sichert lokal
# weiter (Details: scripts/hetzner/systemd/backup-run.sh).
echo "  Backup-Timer auf app-1 installieren …"
ssh_host "$APP_IP" 'bash /opt/audiomonastry/scripts/hetzner/install-backup-timer.sh' \
  || echo "  ⚠ Backup-Timer konnte auf app-1 nicht installiert werden (prüfen!)."

# INFRA-HETZNER-005: Der Watchdog (auto-repair.sh) existierte, wurde aber von
# keinem Flottenskript installiert - ein Timer, den nie jemand aktiviert hat.
# Er laeuft jetzt auf ALLEN Knoten: Container-Health-Restart gilt ueberall,
# die App-/Caddy-Diagnose greift nur dort, wo die Container tatsaechlich laufen
# (der Watchdog prueft das selbst und ueberspringt sonst).
echo "  Auto-Repair-Watchdog auf allen Knoten installieren …"
for ip in "$APP_IP" "$SFU_IP" "$AI_IP" "$MASTER_IP" "$EDGE_IP"; do
  ssh_host "$ip" 'bash /opt/audiomonastry/scripts/hetzner/install-auto-repair.sh' 2>/dev/null \
    || echo "  ⚠ Watchdog konnte auf $ip nicht installiert werden (prüfen!)."
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
# INFRA-HETZNER-006/007: Grafana ist nur auf 127.0.0.1 des edge-Knotens
# veroeffentlicht (keine 3000er-Firewall-Regel, kein oeffentlicher Port) -
# der Zugriff laeuft ueber einen SSH-Tunnel.
echo "   Grafana:  ssh -L 3000:127.0.0.1:3000 root@$EDGE_IP  ->  http://127.0.0.1:3000"
echo "   Ollama:   http://$AI_IP:11434 · Stem-AI: http://$AI_IP:8000"
echo "=============================================================="

if command -v xdg-open >/dev/null 2>&1 && [[ -n "${DISPLAY:-}" ]]; then
  echo "Öffne $APP_URL im Browser …"
  xdg-open "$APP_URL" >/dev/null 2>&1 || true
else
  echo "Bitte im Browser öffnen: $APP_URL"
fi
