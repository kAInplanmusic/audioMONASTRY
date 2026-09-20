#!/usr/bin/env bash
# ============================================================================
# audioMONASTRY · Flotten-Namen (NOMEN-P1-001; erweitert in F10)
# ============================================================================
# EINE Quelle fuer jeden Namen, unter dem die Flotte existieren kann: kanonisch
# ist `audiomonastry-*`, der Altbestand kann `samplemonk-*` heissen. Der
# Altpraefix steht genau EINMAL hier; jedes Skript fragt ueber die Funktionen
# nach dem Namen, den es wirklich braucht - kein zweiter Ort kennt ihn.
#
# KNOTEN (Hetzner-Server):
#   source "$(dirname "$0")/fleet-names.sh"
#   NAME=$(fleet_name audiomonastry-app-1)     # -> audiomonastry-app-1 ODER samplemonk-app-1
#   for n in $(fleet_candidates audiomonastry-app-1); do ... done
#
# COMPOSE-PROJEKT + CONTAINER (F10):
#   fleet_compose_project                       # -> audiomonastry (kanonisch)
#   fleet_name_variants audiomonastry           # -> audiomonastry, samplemonk
#   fleet_name_variants audiomonastry-caddy     # -> audiomonastry-caddy, samplemonk-caddy
#   (Skripte setzen COMPOSE_PROJECT_NAME aus fleet_compose_project; die
#    Compose-Datei traegt denselben Wert als top-level `name:` - ein Test haelt
#    beide Quellen deckungsgleich.)
#
# PFADE:
#   FLEET_HOME=/opt/audiomonastry  LEGACY_FLEET_HOME=/opt/samplemonk
#
# `fleet_candidates`/`fleet_name_variants` liefern beide Schreibweisen (neu
# zuerst) - gedacht fuer Aufraeum-, Health- und Loeschwege, die nichts
# uebersehen duerfen (eine unbemerkte Altinstallation kostet Geld und bindet
# Ports doppelt).

FLEET_PREFIX="${FLEET_PREFIX:-audiomonastry-}"
LEGACY_FLEET_PREFIX="${LEGACY_FLEET_PREFIX:-samplemonk-}"

# --- Compose-Projekt + Container (F10: Namespace-Paritaet) -------------------
# Der Docker-Compose-Projektname hing bisher am VERZEICHNISNAMEN (`cd
# /opt/audiomonastry && docker compose ...` -> Projekt `audiomonastry`). Auf
# Bestands-Knoten mit anderem Verzeichnisnamen entstand daraus ein ZWEITES
# Projekt mit eigenen Volumes (`<alt>_caddy_data`) und Containern, die niemand
# mehr reparierte. Deshalb ist der Projektname jetzt explizit: diese Zeile ist
# die Quelle fuer COMPOSE_PROJECT_NAME in den Skripten, docker-compose.hetzner.yml
# traegt denselben Wert als top-level `name:` (gilt auch fuer Handaufrufe) -
# tests/test_hetzner_scripts.py haelt beide Quellen deckungsgleich.
FLEET_COMPOSE_PROJECT="${FLEET_COMPOSE_PROJECT:-audiomonastry}"
LEGACY_COMPOSE_PROJECT="${LEGACY_COMPOSE_PROJECT:-samplemonk}"

# --- Deploy-Pfade (INFRA-HETZNER-009) ----------------------------------------
# Der Pfad ist Teil des Namespace: Compose leitet daraus (ohne `name:`) den
# Projektnamen ab. Kanonisch ist /opt/audiomonastry; der Altpfad bleibt als
# Erkennungswert fuer Bestands-Knoten erhalten (Guard in fleet-deploy-live.sh).
FLEET_HOME="${FLEET_HOME:-/opt/audiomonastry}"
LEGACY_FLEET_HOME="${LEGACY_FLEET_HOME:-/opt/samplemonk}"

# 1, wenn ein Server mit diesem Namen in Hetzner existiert.
fleet_server_count() {
  curl -s -H "Authorization: Bearer ${HCLOUD_TOKEN:-}" \
    "https://api.hetzner.cloud/v1/servers?name=$1" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('servers') or []))" 2>/dev/null \
    || echo 0
}

# Tatsaechlicher Name des Knotens (neu zuerst, dann Altname). Ist keiner
# vorhanden, kommt der kanonische Name zurueck - der Aufrufer sieht dann einen
# leeren Treffer und kann das melden (statt still nichts zu tun).
fleet_name() {
  local canonical="$1"
  local legacy="${LEGACY_FLEET_PREFIX}${canonical#"$FLEET_PREFIX"}"
  local count
  count=$(fleet_server_count "$canonical")
  if [[ "${count:-0}" -gt 0 ]]; then echo "$canonical"; return 0; fi
  count=$(fleet_server_count "$legacy")
  if [[ "${count:-0}" -gt 0 ]]; then echo "$legacy"; return 0; fi
  echo "$canonical"
}

# Beide Schreibweisen eines NAMENS (neu zuerst) - fuer Aufraeum-, Health- und
# Loeschwege. Deckt drei Formen mit EINER Umsetzung ab, damit keine zweite
# Aufloesung entsteht:
#   * Servernamen   audiomonastry-app-1  -> samplemonk-app-1
#   * Container     audiomonastry        -> samplemonk
#                   audiomonastry-caddy  -> samplemonk-caddy
# Ein Name ohne bekannten Praefix bleibt unveraendert (nichts wird geraten).
fleet_name_variants() {
  local canonical="${1:-}"
  case "$canonical" in
    "") return 0 ;;
    # Projektname - auch die blosse Form ohne Bindestrich (der Container der
    # Rolle app heisst `audiomonastry`), unabhaengig davon, ob
    # FLEET_COMPOSE_PROJECT per env ueberschrieben wurde.
    "$FLEET_COMPOSE_PROJECT" | "${FLEET_PREFIX%?}")
      printf '%s\n' "$canonical"
      printf '%s\n' "$LEGACY_COMPOSE_PROJECT"
      ;;
    "$FLEET_PREFIX"*)
      printf '%s\n' "$canonical"
      printf '%s\n' "${LEGACY_FLEET_PREFIX}${canonical#"$FLEET_PREFIX"}"
      ;;
    *)
      printf '%s\n' "$canonical"
      ;;
  esac
}

# Servernamen-Aufloesung (kompatibler Name): dieselbe Umsetzung, kein zweiter
# Pfad - hier stand vorher eine eigene Funktion.
fleet_candidates() { fleet_name_variants "$@"; }

# Kanonischer Compose-Projektname (Quelle fuer COMPOSE_PROJECT_NAME).
fleet_compose_project() { printf '%s\n' "$FLEET_COMPOSE_PROJECT"; }

# Alt-Projektname des Bestands (nur Erkennung/Migration, nie zum Anlegen).
fleet_legacy_compose_project() { printf '%s\n' "$LEGACY_COMPOSE_PROJECT"; }

# Kompatibilitaets-Heim eines Bestands-Knotens (nur noch Erkennung/Guard).
fleet_legacy_home() { printf '%s\n' "$LEGACY_FLEET_HOME"; }
