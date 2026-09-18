#!/usr/bin/env bash
# ============================================================================
# audioMONASTRY · Flotten-Namen (NOMEN-P1-001)
# ============================================================================
# Kanonisch ist `audiomonastry-*`. Eine LAUFENDE Installation kann aber noch die
# alten `samplemonk-*`-Namen tragen - die Umbenennung im Repo darf sie nicht
# unbedienbar machen (Server ansprechen, Snapshots finden, Kosten stoppen).
#
# Deshalb liegt der Altpraefix genau EINMAL hier, und die Skripte fragen ueber
# `fleet_name` nach dem Namen, unter dem der Knoten wirklich existiert:
#
#   source "$(dirname "$0")/fleet-names.sh"
#   NAME=$(fleet_name audiomonastry-app-1)     # -> audiomonastry-app-1 ODER samplemonk-app-1
#   for n in $(fleet_candidates audiomonastry-app-1); do ... done
#
# `fleet_candidates` liefert beide Schreibweisen (neu zuerst) - gedacht fuer
# Aufraeum-/Loeschwege, die nichts uebersehen duerfen.

FLEET_PREFIX="${FLEET_PREFIX:-audiomonastry-}"
LEGACY_FLEET_PREFIX="${LEGACY_FLEET_PREFIX:-samplemonk-}"

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

# Beide Schreibweisen (neu zuerst) - fuer Aufraeumwege.
fleet_candidates() {
  local canonical="$1"
  echo "$canonical"
  echo "${LEGACY_FLEET_PREFIX}${canonical#"$FLEET_PREFIX"}"
}
