#!/usr/bin/env bash
# ============================================================================
# audioMONASTRY · Flotten-Namen (NOMEN-P1-001; erweitert in F10)
# ============================================================================
# EINE Quelle fuer jeden Namen, unter dem die Flotte existiert: kanonisch
# `audiomonastry-*`. Der Altbestand ist ausgemustert - Flotte 2026-09-11
# gestoppt und geloescht, Alt-Firewalls 2026-09-20 geloescht, Alt-Snapshots
# 2026-09-29 live zu 0 gezaehlt (docs/PROPOSAL_legacy-shim-removal.md, Phase 2).
# Es gibt nur noch EINE Schreibweise; jedes Skript fragt
# ueber die Funktionen nach dem Namen, den es wirklich braucht.
#
# KNOTEN (Hetzner-Server):
#   source "$(dirname "$0")/fleet-names.sh"
#   NAME=$(fleet_name audiomonastry-app-1)     # -> audiomonastry-app-1
#   for n in $(fleet_candidates audiomonastry-app-1); do ... done
#
# COMPOSE-PROJEKT + CONTAINER (F10):
#   fleet_compose_project                       # -> audiomonastry (kanonisch)
#   (Skripte setzen COMPOSE_PROJECT_NAME aus fleet_compose_project; die
#    Compose-Datei traegt denselben Wert als top-level `name:` - ein Test haelt
#    beide Quellen deckungsgleich.)
#
# PFADE:
#   FLEET_HOME=/opt/audiomonastry

FLEET_PREFIX="${FLEET_PREFIX:-audiomonastry-}"

# --- Compose-Projekt + Container (F10: Namespace-Paritaet) -------------------
# Der Docker-Compose-Projektname hing bisher am VERZEICHNISNAMEN (`cd
# /opt/audiomonastry && docker compose ...` -> Projekt `audiomonastry`). Ein
# davon abweichender Verzeichnisname erzeugt ein ZWEITES Projekt mit eigenen
# Volumes und Containern, die niemand mehr repariert. Deshalb ist der
# Projektname explizit: diese Zeile ist
# die Quelle fuer COMPOSE_PROJECT_NAME in den Skripten, docker-compose.hetzner.yml
# traegt denselben Wert als top-level `name:` (gilt auch fuer Handaufrufe) -
# tests/test_hetzner_scripts.py haelt beide Quellen deckungsgleich.
FLEET_COMPOSE_PROJECT="${FLEET_COMPOSE_PROJECT:-audiomonastry}"

# --- Deploy-Pfade (INFRA-HETZNER-009) ----------------------------------------
# Der Pfad ist Teil des Namespace: Compose leitet daraus (ohne `name:`) den
# Projektnamen ab. Kanonisch ist /opt/audiomonastry.
FLEET_HOME="${FLEET_HOME:-/opt/audiomonastry}"

# 1, wenn ein Server mit diesem Namen in Hetzner existiert.
fleet_server_count() {
  curl -s -H "Authorization: Bearer ${HCLOUD_TOKEN:-}" \
    "https://api.hetzner.cloud/v1/servers?name=$1" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('servers') or []))" 2>/dev/null \
    || echo 0
}

# Tatsaechlicher Name des Knotens: nur noch die kanonische Schreibweise. Ist
# keiner vorhanden, kommt der kanonische Name zurueck - der Aufrufer sieht dann
# einen leeren Treffer und kann das melden (statt still nichts zu tun).
fleet_name() {
  printf '%s\n' "$1"
}

# Namensaufloesung: gibt einen Namen unveraendert weiter. Seit der Ausmusterung
# des Altbestands gibt es nur noch die kanonische Schreibweise - die Funktion
# bleibt als Schnittstelle bestehen (delete-fleet.sh, lifecycle.sh,
# auto-repair.sh rufen sie weiter auf), damit die Aufrufer bei Bedarf wieder
# eine Zweit-Schreibweise an EINEM Ort ergaenzen koennten.
fleet_name_variants() {
  local canonical="${1:-}"
  [[ -n "$canonical" ]] || return 0
  printf '%s\n' "$canonical"
}

# Servernamen-Aufloesung (kompatibler Name): dieselbe Umsetzung, kein zweiter
# Pfad - hier stand vorher eine eigene Funktion.
fleet_candidates() { fleet_name_variants "$@"; }

# Kanonischer Compose-Projektname (Quelle fuer COMPOSE_PROJECT_NAME).
fleet_compose_project() { printf '%s\n' "$FLEET_COMPOSE_PROJECT"; }
