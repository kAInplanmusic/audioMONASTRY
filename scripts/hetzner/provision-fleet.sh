#!/usr/bin/env bash
# =============================================================================
# provision-fleet.sh – audioMONASTRY 5er-Hetzner-Flotte provisionieren
# -----------------------------------------------------------------------------
# Die fuenf Rollen der Konstitution (docs/INFRA_KONSTITUTION.md §1.2).
# Default-Typ ist ueberall cx23 (2 vCPU / 4 GB / 40 GB) und je Rolle per
# FLEET_TYPE_<ROLLE> ueberschreibbar (Hetzner-Knappheit beim Reservieren):
#
#   app-1     cx23   Rolle app     + Floating IP (DNS)
#   sfu-1     cx23   Rolle sfu     (RTP-Ports 40000-40099 offen)
#   ai-1      cx23   Rolle ai      (host-nativ: Ollama + Stem-CPU-Fallback)
#   master-1  cx23   Rolle master  (master-player/FFmpeg)
#   edge-1    cx23   Rolle edge    (NUR Monitoring-Stack, Staging/Smoke)
#
# Dieselben Overrides liest der Portal-Worker (services/portal-worker/src/index.js,
# fleetServerType) - dort als Worker-Variablen gesetzt, hier aus .env.deploy bzw.
# der Umgebung. Die Rollen-/Typ-Tabelle in docs/SERVER_FLEET.md nennt beide
# Fallbacks; tests/test_hetzner_scripts.py haelt Code und Doku zusammen.
#
# Alle Einheiten: stündlich abgerechnet, Auto-Shutdown installierbar.
# Voraussetzung: HCLOUD_TOKEN in .env.deploy (oder Umgebung).
#
# Aufruf:
#   bash scripts/hetzner/provision-fleet.sh
#   bash scripts/hetzner/provision-fleet.sh --print-config   (Trockenlauf: Rollen + Typen)
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/../.."

# .env.deploy laden, falls vorhanden
if [[ -f .env.deploy ]]; then
  set -a; . ./.env.deploy; set +a
fi

# Servertypen konfigurierbar (Hetzner-Knappheit: cx33/cx43/cx53 oft nicht verfügbar;
# Fallback cx23 überall, cpx22 für SFU/AI falls mehr Leistung nötig).
# Der Default ist NICHT beliebig: cx23 hat 4 GB RAM und traegt die deklarierten
# Limits der Rollen (app: 2,0 GiB App + 0,125 GiB Caddy, master: 1 GiB,
# edge: 1,44 GiB Monitoring) - groessere Typen also nur bewusst und per
# FLEET_TYPE_<ROLLE> (INFRA-HETZNER-006/007). Dieselben Variablennamen liest der
# Portal-Worker (services/portal-worker/src/index.js, fleetServerType).
# F10: Namespace (Compose-Projekt, Zielpfad) kommt aus der EINEN Quelle
# scripts/hetzner/fleet-names.sh - auch die neu angelegten Knoten tragen ihn.
# shellcheck source=scripts/hetzner/fleet-names.sh
# shellcheck disable=SC1091
source scripts/hetzner/fleet-names.sh
TYPE_APP="${FLEET_TYPE_APP:-cx23}"
TYPE_SFU="${FLEET_TYPE_SFU:-cx23}"
TYPE_AI="${FLEET_TYPE_AI:-cx23}"
TYPE_MASTER="${FLEET_TYPE_MASTER:-cx23}"
TYPE_EDGE="${FLEET_TYPE_EDGE:-cx23}"

# Trockenlauf (INFRA-HETZNER-007): Rollen + effektive Typen ausgeben - ohne
# HCLOUD_TOKEN und ohne API-Aufrufe. Das ist der Beleg-Pfad fuer den Abgleich
# Code <-> docs/SERVER_FLEET.md (tests/test_hetzner_scripts.py prueft dasselbe).
if [[ "${1:-}" == "--print-config" || "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  echo "[dry-run] Flotte (keine API-Aufrufe, keine Server):"
  # F10: der Namespace, den die angelegten Knoten tragen (Projektname des
  # Compose-Stacks + Zielpfad) - derselbe Wert wie das top-level `name:` in
  # docker-compose.hetzner.yml und COMPOSE_PROJECT_NAME in den Deploy-Skripten.
  echo "  Projekt:   COMPOSE_PROJECT_NAME=$(fleet_compose_project)   (Zielpfad $FLEET_HOME)"
  printf '  %-28s %-12s %-7s %s\n' \
    audiomonastry-app-1    "$TYPE_APP"    app    "firewall=audiomonastry-app, floating-ip=none (DNS nutzt die primaere IPv4)" \
    audiomonastry-sfu-1    "$TYPE_SFU"    sfu    "firewall=audiomonastry-sfu, floating-ip=none (RTP 40000-40099)" \
    audiomonastry-ai-1     "$TYPE_AI"     ai     "firewall=audiomonastry-ai, floating-ip=none (host-nativ)" \
    audiomonastry-master-1 "$TYPE_MASTER" master "firewall=audiomonastry-master, floating-ip=none" \
    audiomonastry-edge-1   "$TYPE_EDGE"   edge   "firewall=audiomonastry-edge, floating-ip=none (nur Monitoring)"
  echo "[dry-run] Override je Rolle: FLEET_TYPE_APP/SFU/AI/MASTER/EDGE (Default cx23)"
  exit 0
fi

[[ -n "${HCLOUD_TOKEN:-}" ]] || { echo "HCLOUD_TOKEN fehlt (.env.deploy)" >&2; exit 1; }

PY=python3
PROV=scripts/hetzner/provision.py
LOG_DIR=/tmp/audiomonastry-fleet
mkdir -p "$LOG_DIR"

provision_one() {
  local name="$1" type="$2" role="$3" fw="$4" fip="$5"
  echo "=== Provisioniere $name ($type, role=$role, firewall=$fw, floating-ip=$fip) ==="
  SERVER_NAME="$name" SERVER_TYPE="$type" ROLE="$role" FIREWALL_NAME="$fw" FLOATING_IP_NAME="$fip" \
    "$PY" "$PROV" >"$LOG_DIR/$name.log" 2>&1 || {
      echo "❌ $name fehlgeschlagen – siehe $LOG_DIR/$name.log"
      return 1
    }
  echo "✅ $name fertig: $(grep 'Feste IP:' "$LOG_DIR/$name.log" | sed 's/^ *//' || true)"
}

# Rollen + Typen: genau die Zeilen, die --print-config ohne API ausgibt.

# KEINE Floating IP fuer die App-Rolle (2026-09-21 gemessen, 3,00 EUR/Monat gespart):
#   * der DNS-Pfad nutzt die PRIMAERE IPv4 (`app.public_net.ipv4.ip`, portal-worker),
#   * der Portal-Worker LOESCHT Floating IPs beim Flotten-Abbau selbst,
#   * `configure-floating-ip.sh` (OS-Konfiguration, ohne NAT noetig) wird von keinem
#     Deploy-Pfad aufgerufen - die IP war also zugewiesen, aber nirgends nutzbar.
# Wer sie bewusst will: FLOATING_IP_NAME=<name> und den provision.py-Aufruf anpassen.
provision_one audiomonastry-app-1    "$TYPE_APP" app    audiomonastry-app    none
provision_one audiomonastry-sfu-1    "$TYPE_SFU" sfu    audiomonastry-sfu    none
provision_one audiomonastry-ai-1     "$TYPE_AI"  ai     audiomonastry-ai     none
provision_one audiomonastry-master-1 "$TYPE_MASTER" master audiomonastry-master none
# INFRA-HETZNER-007: edge-1 laeuft als Rolle `edge` (wie im Portal-Worker und in
# der Konstitution) - vorher stand hier die Rolle `app`, obwohl der Knoten nur den
# Monitoring-Stack traegt. Kein zusaetzlicher Firewall-Port: Grafana ist auf dem
# Knoten nur auf 127.0.0.1 veroeffentlicht (docker-compose.monitoring.yml),
# der Zugriff laeuft per SSH-Tunnel.
provision_one audiomonastry-edge-1   "$TYPE_EDGE" edge  audiomonastry-edge   none

echo ""
echo "=============================================================="
echo "Flotte provisioniert. Deploy-Befehle:"
echo "=============================================================="
echo "  app-1:    DEPLOY_HOST=root@<app-1-ip>    DEPLOY_DOMAIN=anunnakitools.de DEPLOY_SYNC_ENV=1 bash deploy.sh"
echo "            (DEPLOY_SYNC_ENV=1 nur fuer einen FRISCHEN Knoten ohne Portal - sonst"
echo "             wuerde die rollen-skopierte Knoten-.env des Portal-Workers ersetzt, s. deploy.sh)"
echo "  sfu-1:    DEPLOY_HOST=root@<sfu-1-ip>    DEPLOY_DOMAIN= bash deploy.sh  + docker-compose.sfu.yml"
echo "  ai-1:     SSH ai-1  -> Ollama + Stem-AI (siehe docs/SERVER_FLEET.md)"
echo "  master-1: SSH master-1 -> docker compose -f docker-compose.hetzner.yml up -d master-player"
echo "  edge-1:   SSH edge-1 -> Monitoring-Stack (nur der Stack) + Smoke-Tests"
echo "            Grafana per Tunnel: ssh -L 3000:127.0.0.1:3000 root@<edge-1-ip> -> http://127.0.0.1:3000"
echo "  Auto-Shutdown: ssh root@<ip> 'bash /opt/audiomonastry/scripts/hetzner/install-idle-shutdown.sh'"
echo "  Backup-Timer:  ssh root@<app-1-ip> 'bash /opt/audiomonastry/scripts/hetzner/install-backup-timer.sh'"
echo "                 (in der Flotte macht das bring-up-fleet.sh Schritt 8 automatisch)"
