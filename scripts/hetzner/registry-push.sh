#!/usr/bin/env bash
# ============================================================================
# registry-push.sh – App- UND master-player-Image EINMAL nach GHCR schieben
# ----------------------------------------------------------------------------
# WARUM dieses Werkzeug existiert (gemessen 2026-09-21):
#   Die Leitung Betreiber-Rechner -> Knoten macht ~1 MB/s hoch. App-Image 1,43 GB
#   + master-player 1,22 GB bedeuten damit 25-40 min pro Knoten - und JEDER
#   weitere Knoten zahlt denselben Preis erneut. Mit einer Registry wird EINMAL
#   langsam hochgeschoben; danach zieht jeder Knoten im Rechenzentrums-Tempo
#   (siehe DEPLOY_IMAGE_SOURCE=registry in deploy.sh / fleet-deploy-live.sh).
#
# Aufruf:
#   bash scripts/hetzner/registry-push.sh                    # bauen + pushen (Tag = git-Kurzhash)
#   bash scripts/hetzner/registry-push.sh --print-config     # Trockenlauf, kein Docker, kein Netz
#   bash scripts/hetzner/registry-push.sh --tag roll-2026-09-21
#   bash scripts/hetzner/registry-push.sh --skip-build       # Images sind schon lokal (z. B. von deploy.sh)
#   bash scripts/hetzner/registry-push.sh --also-version     # zusaetzlich :v<package.json-Version>
#   bash scripts/hetzner/registry-push.sh --force            # Tag existiert trotzdem neu pushen
#
# Regeln (Tests in tests/test_hetzner_scripts.py):
#   * Der Tag kommt aus `git rev-parse --short HEAD`, ersatzweise aus der
#     package.json-Version; --tag/REGISTRY_TAG ueberschreibt bewusst.
#   * Zugangsdaten kommen aus der Env-Datei (Default <repo>/.env, GHCR_USERNAME +
#     GHCR_TOKEN, ersatzweise GHCR_PASSWORD) oder aus der Umgebung. Der WERT wird
#     NIE ausgegeben und NIE als Argument uebergeben - nur durch eine Pipe in
#     `docker login --password-stdin`.
#   * Idempotenz: existiert der Tag bereits in der Registry (`docker manifest
#     inspect`), wird NICHT erneut gepusht. `--force` erzwingt es.
#   * Es wird nichts geloescht und nichts auf einem Knoten angefasst: dieses
#     Skript kennt keine Flotte, nur die eigene Registry.
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# shellcheck source=scripts/hetzner/lib/registry.sh
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/registry.sh"

PRINT_CONFIG=0
SKIP_BUILD="${REGISTRY_SKIP_BUILD:-0}"
ALSO_VERSION=0
FORCE="${REGISTRY_FORCE_PUSH:-0}"
TAG_ARG=""

while [[ $# -gt 0 ]]; do
  case "${1:-}" in
    --tag) TAG_ARG="${2:-}"; shift 2 ;;
    --tag=*) TAG_ARG="${1#*=}"; shift ;;
    --print-config) PRINT_CONFIG=1; shift ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --also-version) ALSO_VERSION=1; shift ;;
    --force) FORCE=1; shift ;;
    --help|-h) sed -n '2,30p' "$0"; exit 0 ;;
    -*) echo "Unbekannte Option: $1" >&2; exit 2 ;;
    *) TAG_ARG="$1"; shift ;;
  esac
done

REGISTRY="$(registry_host)"
# Owner: REGISTRY_OWNER > git-Remote. Ohne Owner kein Push - nicht raten.
OWNER="$(registry_owner "$REPO_ROOT")"
if [[ -z "$OWNER" ]]; then
  echo "❌ Kein Registry-Owner ermittelbar (kein git-Remote 'origin' und kein REGISTRY_OWNER gesetzt)." >&2
  echo "   Beispiel: REGISTRY_OWNER=<konto> bash $0 --print-config" >&2
  exit 1
fi
TAG="${TAG_ARG:-${REGISTRY_TAG:-$(registry_default_tag "$REPO_ROOT")}}"
VERSION="$(registry_version "$REPO_ROOT")"

LOCAL_APP="$(registry_local_app)"
LOCAL_MASTER="$(registry_local_master)"
APP_REF="$(registry_image "$OWNER" "$(registry_app_name)" "$TAG")"
MASTER_REF="$(registry_image "$OWNER" "$(registry_master_name)" "$TAG")"

#: Env-Datei mit den Zugangsdaten (Wert wird nie ausgegeben; 'none' = aus).
REGISTRY_ENV_FILE="${REGISTRY_ENV_FILE:-$REPO_ROOT/.env}"
#: Build-Stempel wie in deploy.sh - ohne sie stuende "unknown" in /api/health
#: und die Commit-Paritaet (PROD-P1-F4) waere fuer das Image nicht pruefbar.
BUILD_VERSION="${DEPLOY_VERSION:-$VERSION}"
BUILD_COMMIT="${DEPLOY_COMMIT:-$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)}"
BUILD_TIME="${BUILD_TIME:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"

DOCKER_BIN="${REGISTRY_DOCKER:-docker}"

if [[ "$PRINT_CONFIG" == "1" ]]; then
  echo "registry-push.sh - effektive Konfiguration (kein Docker, kein Netz, kein Push)"
  printf '  Registry=%s\n' "$REGISTRY"
  printf '  Owner=%s   (REGISTRY_OWNER, sonst git-Remote 'origin')\n' "$OWNER"
  printf '  Tag=%s   (--tag/REGISTRY_TAG, sonst git-Kurzhash, sonst package.json-Version)\n' "$TAG"
  printf '  App-Image lokal=%s  ->  %s\n' "$LOCAL_APP" "$APP_REF"
  printf '  Master-Image lokal=%s  ->  %s\n' "$LOCAL_MASTER" "$MASTER_REF"
  printf '  Build-Stempel: version=%s commit=%s buildTime=%s\n' "$BUILD_VERSION" "$BUILD_COMMIT" "$BUILD_TIME"
  printf '  Env-Datei=%s (%s)\n' "$REGISTRY_ENV_FILE" "$([[ -f "$REGISTRY_ENV_FILE" ]] && echo vorhanden || echo fehlt)"
  # Nur ein BOOLEAN: ob Zugangsdaten vorliegen - nie der Wert.
  printf '  GHCR-Zugangsdaten=%s (Wert wird nie ausgegeben, Login nur per --password-stdin)\n' \
    "$(registry_credentials_state "$REPO_ROOT" "$REGISTRY_ENV_FILE")"
  printf '  Build ueberspringen=%s   Erzwingen=%s   zusaetzlich :v<version>=%s\n' \
    "$SKIP_BUILD" "$FORCE" "$ALSO_VERSION"
  printf '  Docker=%s   (REGISTRY_DOCKER)\n' "$DOCKER_BIN"
  echo
  echo "Nach dem Push zieht der Knoten (KEIN docker save):"
  printf '  DEPLOY_IMAGE_SOURCE=registry DEPLOY_REGISTRY_IMAGE=%s \\\n' "$APP_REF"
  printf '    DEPLOY_REGISTRY_IMAGE_MASTER=%s bash deploy.sh\n' "$MASTER_REF"
  printf '  Live-Beweis-Weg: DEPLOY_IMAGE_SOURCE=registry DEPLOY_REGISTRY_IMAGE=%s \\\n' "$APP_REF"
  printf '    bash scripts/hetzner/fleet-deploy-live.sh <ip>\n'
  exit 0
fi

command -v "$DOCKER_BIN" >/dev/null 2>&1 || {
  echo "❌ docker nicht gefunden ($DOCKER_BIN) - der Push braucht einen lokalen Docker." >&2
  exit 1
}

echo "=== [1/5] GHCR-Login ($REGISTRY) ==="
if ! registry_load_credentials "$REPO_ROOT" "$REGISTRY_ENV_FILE"; then
  echo "❌ Keine GHCR-Zugangsdaten gefunden (GHCR_USERNAME + GHCR_TOKEN/GHCR_PASSWORD)." >&2
  echo "   Quelle: Umgebung oder $REGISTRY_ENV_FILE (REGISTRY_ENV_FILE). Werte nie ausgeben." >&2
  exit 1
fi
echo "   Benutzer: $REGISTRY_USER (Token wird nie ausgegeben)"
printf '%s' "$REGISTRY_PASS" | "$DOCKER_BIN" login "$REGISTRY" -u "$REGISTRY_USER" --password-stdin >/dev/null

echo "=== [2/5] Images bauen (Tag $TAG) ==="
if [[ "$SKIP_BUILD" == "1" ]]; then
  # Fuer den Fall, dass deploy.sh die Images gerade gebaut hat: ein zweiter
  # Build kostet ~25 min und bringt dasselbe Ergebnis.
  echo "   uebersprungen (--skip-build/REGISTRY_SKIP_BUILD=1): es wird getaggt, was lokal liegt."
else
  "$DOCKER_BIN" build -f "$REPO_ROOT/Dockerfile.hetzner" \
    --build-arg "BUILD_VERSION=$BUILD_VERSION" \
    --build-arg "BUILD_COMMIT=$BUILD_COMMIT" \
    --build-arg "BUILD_TIME=$BUILD_TIME" \
    -t "$LOCAL_APP" "$REPO_ROOT"
  "$DOCKER_BIN" build -f "$REPO_ROOT/services/master-player/Dockerfile" \
    --build-arg "BUILD_VERSION=$BUILD_VERSION" \
    --build-arg "BUILD_COMMIT=$BUILD_COMMIT" \
    --build-arg "BUILD_TIME=$BUILD_TIME" \
    -t "$LOCAL_MASTER" "$REPO_ROOT/services/master-player"
fi

echo "=== [3/5] Auf die Registry-Namen taggen ==="
TAGS_APP=("$APP_REF")
TAGS_MASTER=("$MASTER_REF")
if [[ "$ALSO_VERSION" == "1" && -n "$VERSION" ]]; then
  # Zweiter Tag (Release-Version) zeigt auf dasselbe Image - praktisch fuer
  # "welcher Stand laeuft" im Knoten-Image-Bestand.
  TAGS_APP+=("$(registry_image "$OWNER" "$(registry_app_name)" "v$VERSION")")
  TAGS_MASTER+=("$(registry_image "$OWNER" "$(registry_master_name)" "v$VERSION")")
fi
for ref in "${TAGS_APP[@]}"; do "$DOCKER_BIN" tag "$LOCAL_APP" "$ref"; done
for ref in "${TAGS_MASTER[@]}"; do "$DOCKER_BIN" tag "$LOCAL_MASTER" "$ref"; done
printf '   %s -> %s\n' "$LOCAL_APP" "${TAGS_APP[*]}"
printf '   %s -> %s\n' "$LOCAL_MASTER" "${TAGS_MASTER[*]}"

# Idempotenz: liegt der Tag schon in der Registry, ist der Push erledigt. Der
# Manifest-Abruf braucht den Login von oben (privates Paket) und scheitert bei
# "nicht vorhanden" mit Exit != 0 - das ist hier die ERWARTETE Antwort.
registry_tag_exists() {
  "$DOCKER_BIN" manifest inspect "$1" >/dev/null 2>&1
}

echo "=== [4/5] Push (idempotent: gleicher Tag = kein zweiter Push) ==="
PUSHED=0
SKIPPED=0
for ref in "${TAGS_APP[@]}" "${TAGS_MASTER[@]}"; do
  if [[ "$FORCE" != "1" ]] && registry_tag_exists "$ref"; then
    echo "   uebersprungen (Tag existiert schon): $ref"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi
  "$DOCKER_BIN" push "$ref"
  PUSHED=$((PUSHED + 1))
done

echo "=== [5/5] Ergebnis ==="
printf '  gepusht: %s   uebersprungen: %s\n' "$PUSHED" "$SKIPPED"
printf '  App:    %s\n' "$APP_REF"
printf '  Master: %s\n' "$MASTER_REF"
echo
echo "Naechster Schritt (der Knoten ZIEHT, kein docker save):"
echo "  DEPLOY_IMAGE_SOURCE=registry DEPLOY_REGISTRY_IMAGE=$APP_REF \\"
echo "    DEPLOY_REGISTRY_IMAGE_MASTER=$MASTER_REF bash deploy.sh"
echo "  (Live-Beweis-Weg: ... DEPLOY_IMAGE_SOURCE=registry bash scripts/hetzner/fleet-deploy-live.sh <ip>)"
