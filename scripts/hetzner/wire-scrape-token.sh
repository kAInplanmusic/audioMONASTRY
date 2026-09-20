#!/usr/bin/env bash
# ============================================================================
# wire-scrape-token.sh – SCRAPE_TOKEN setzen/uebertragen und Scrape verdrahten
# ----------------------------------------------------------------------------
# WARUM: /api/metrics ist ohne SCRAPE_TOKEN fail-closed (401). Der Prometheus-Job
# `audiomonastry` fragte zusaetzlich die Produktions-Domain ab und war bei
# gestoerter Cloudflare-Kette blind (live 2026-09-20: health=down, HTTP 521).
# Dieses Skript setzt den Token auf beiden Seiten und prueft den Scrape ECHT.
#
# Aufruf (auf dem jeweiligen Knoten, im Repo-Verzeichnis):
#   bash scripts/hetzner/wire-scrape-token.sh app                 # Token erzeugen/halten + App neu starten
#   bash scripts/hetzner/wire-scrape-token.sh app --print-config  # Trockenlauf
#   bash scripts/hetzner/wire-scrape-token.sh edge                # Token aus stdin uebernehmen + Monitoring neu
#
# Uebertragung app -> edge (Wert nie in Argument oder Ausgabe):
#   ssh root@<app-ip> "grep '^SCRAPE_TOKEN=' /opt/audiomonastry/.env" \
#     | ssh root@<edge-ip> 'bash /opt/audiomonastry/scripts/hetzner/wire-scrape-token.sh edge'
#
# Der Wert wird NIE ausgegeben. `edge` ersetzt den Token nur, wenn stdin eine
# gueltige SCRAPE_TOKEN-Zeile liefert (sonst Exit 1, nichts geaendert).
# ============================================================================
set -euo pipefail

HERE_SRC="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE_SRC/../.." && pwd)"
cd "$REPO"

# shellcheck source=scripts/hetzner/fleet-names.sh
# shellcheck disable=SC1091
source "$HERE_SRC/fleet-names.sh"

ROLLE="${1:-}"
shift || true
PRINT_CONFIG=0
for arg in "$@"; do
  case "$arg" in
    --print-config) PRINT_CONFIG=1 ;;
    --help|-h) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "Unbekannte Option: $arg" >&2; exit 1 ;;
  esac
done

APP_IP="${APP_IP:-142.132.229.71}"
PROJECT="$(fleet_compose_project)"
ENV_FILE="${ENV_FILE:-$REPO/.env}"

if [[ "$PRINT_CONFIG" == "1" ]]; then
  echo "wire-scrape-token.sh - effektive Konfiguration (kein Netz, kein Schreiben)"
  printf '  Rolle:            %s\n' "${ROLLE:-<fehlt>}"
  printf '  .env:             %s (%s)\n' "$ENV_FILE" "$([[ -f "$ENV_FILE" ]] && echo vorhanden || echo fehlt)"
  printf '  Compose-Projekt:  %s\n' "$PROJECT"
  printf '  Token vorhanden:  %s (Wert wird nie ausgegeben)\n' "$(grep -q '^SCRAPE_TOKEN=' "$ENV_FILE" 2>/dev/null && echo ja || echo nein)"
  printf '  Scrape-Ziel:      http://%s:8080/api/metrics (Firewall nur fuer den Monitoring-Knoten)\n' "$APP_IP"
  echo
  echo "Rollen:"
  echo "  app   erzeugt/behaelt den Token und startet die App neu (Kontrolle: 200 mit Token, 401 ohne)"
  echo "  edge  uebernimmt die SCRAPE_TOKEN-Zeile von stdin und startet das Monitoring neu"
  exit 0
fi

upsert() { # key, value
  local key="$1" value="$2"
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
    echo "  ${key} aktualisiert"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
    echo "  ${key} ergaenzt"
  fi
}

case "$ROLLE" in
  app)
    if grep -q '^SCRAPE_TOKEN=' "$ENV_FILE" 2>/dev/null; then
      echo "SCRAPE_TOKEN war schon gesetzt (Wert nicht ausgegeben)"
    else
      printf 'SCRAPE_TOKEN=%s\n' "$(openssl rand -hex 32)" >> "$ENV_FILE"
      echo "SCRAPE_TOKEN neu erzeugt"
    fi
    chmod 600 "$ENV_FILE"
    COMPOSE_PROJECT_NAME="$PROJECT" docker compose -f docker-compose.hetzner.yml -f docker-compose.media.yml up -d --no-build --force-recreate audiomonastry >/dev/null
    sleep 8
    echo "--- Kontrolle im Container ---"
    docker exec audiomonastry node -e '
      (async () => {
        const t = process.env.SCRAPE_TOKEN || "";
        if (!t) { console.log("SCRAPE_TOKEN fehlt in der Container-Umgebung"); return; }
        const r = await fetch("http://127.0.0.1:8080/api/metrics?format=json", { headers: { Authorization: "Bearer " + t } });
        const body = await r.text();
        let keys = [];
        try { keys = Object.keys(JSON.parse(body)); } catch {}
        console.log("metrics mit Token: HTTP " + r.status + " | Schluessel: " + keys.slice(0, 8).join(","));
      })();
    '
    docker exec audiomonastry node -e 'fetch("http://127.0.0.1:8080/api/metrics?format=json").then(r=>console.log("ohne Token: HTTP " + r.status));'
    ;;
  edge)
    line="$(cat)"
    key="${line%%=*}"
    if [[ "$key" != "SCRAPE_TOKEN" || -z "${line#SCRAPE_TOKEN=}" ]]; then
      echo "❌ stdin lieferte keine gueltige SCRAPE_TOKEN-Zeile (Schluessel: ${key:-leer}) - nichts geaendert." >&2
      exit 1
    fi
    upsert SCRAPE_TOKEN "${line#SCRAPE_TOKEN=}"
    chmod 600 "$ENV_FILE"
    upsert APP_TARGET "${APP_IP}:8080"
    upsert APP_SCHEME "http"
    COMPOSE_PROJECT_NAME="$PROJECT" docker compose -f docker-compose.hetzner.yml -f docker-compose.monitoring.yml up -d --force-recreate prometheus alertmanager >/dev/null
    sleep 18
    echo "--- Prometheus-Targets ---"
    docker exec audiomonastry-prometheus sh -c 'wget -qO- "http://127.0.0.1:9090/api/v1/targets?state=active"' 2>/dev/null > /tmp/wire-scrape-targets.json
    python3 - <<'PY'
import json
try:
    data = json.load(open("/tmp/wire-scrape-targets.json"))
except Exception as e:
    print("Targets nicht lesbar:", e)
    raise SystemExit
rows = data.get("data", {}).get("activeTargets", [])
if not rows:
    print("keine aktiven Targets")
for t in rows:
    print("  job={:<14s} health={:<8s} {:<52s} {}".format(
        t.get("labels", {}).get("job", "?"), t.get("health", "?"),
        (t.get("scrapeUrl") or "")[:52], (t.get("lastError") or "")[:60]))
PY
    ;;
  *)
    echo "❌ Rolle fehlt (app|edge). Aufruf: bash scripts/hetzner/wire-scrape-token.sh <app|edge> [--print-config]" >&2
    exit 1
    ;;
esac
