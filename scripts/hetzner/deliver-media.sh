#!/usr/bin/env bash
# ============================================================================
# deliver-media.sh – Lizenzierte Medieninhalte auf einen Knoten bringen
# ----------------------------------------------------------------------------
# WARUM: Die schweren Inhalte liegen bewusst NICHT im Image (siehe .dockerignore:
# public/data/orchestral ~3 GB CC0-Library, public/models/htdemucs.onnx ~291 MB).
# Ohne sie laeuft die App, aber Orchester-/Instrumenten-Plugin und der lokale
# Demucs-Pfad sind leer - "produktionsreif" heisst hier: die Inhalte liegen auf
# dem Knoten und werden READ-ONLY in den Container gemountet
# (docker-compose.media.yml), statt das Image um Gigabyte aufzublaehen.
#
# Lizenzen (docs/LICENSE_EXTERNAL_RESOURCES.md):
#   * VSCO 2 Community Edition (public/data/orchestral) = CC0 -> darf gebuendelt
#     und ausgeliefert werden.
#   * public/music (Demo-Tracks) wird NICHT automatisch uebertragen: die Dateien
#     sind kommerzielle/teils problematische Fremdaufnahmen ohne dokumentierte
#     Freigabe. Nur mit --with-music und ausdruecklicher Betreiberentscheidung.
#
# Aufruf:
#   bash scripts/hetzner/deliver-media.sh <ip> [--print-config] [--with-music] [--no-start]
#
# Danach startet der Rollen-Stack mit dem Medien-Overlay:
#   docker compose -f docker-compose.hetzner.yml -f docker-compose.media.yml up -d
# ============================================================================
set -euo pipefail

HERE_SRC="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE_SRC/../.." && pwd)"
cd "$REPO"

# shellcheck source=scripts/hetzner/fleet-names.sh
# shellcheck disable=SC1091
source "$HERE_SRC/fleet-names.sh"

IP=""
PRINT_CONFIG=0
WITH_MUSIC=0
NO_START=0
for arg in "$@"; do
  case "$arg" in
    --print-config) PRINT_CONFIG=1 ;;
    --with-music) WITH_MUSIC=1 ;;
    --no-start) NO_START=1 ;;
    --help|-h) sed -n '2,26p' "$0"; exit 0 ;;
    -*) echo "Unbekannte Option: $arg" >&2; exit 1 ;;
    *) IP="$arg" ;;
  esac
done

SSH_KEY="${DEPLOY_SSH_KEY:-$HOME/.ssh/id_ed25519}"
SSH_OPTS=(-i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -o BatchMode=yes)
RSYNC_E="ssh -i $SSH_KEY -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10"
REMOTE_DIR="${FLEET_HOME:-/opt/audiomonastry}"
MEDIA_DIR="$REMOTE_DIR/media"
PROJECT="$(fleet_compose_project)"

# Quelle: welche Inhalte sind da? Fehlende werden LAUT gemeldet, nicht verschwiegen.
SRC_ORCHESTRAL="public/data/orchestral"
SRC_MODELS="public/models"
SRC_MUSIC="public/music"
SOURCES=("$SRC_ORCHESTRAL" "$SRC_MODELS")
[[ "$WITH_MUSIC" == "1" ]] && SOURCES+=("$SRC_MUSIC")

size_of() { [[ -e "$1" ]] && du -sh "$1" 2>/dev/null | cut -f1 || echo "fehlt"; }

if [[ "$PRINT_CONFIG" == "1" ]]; then
  echo "deliver-media.sh - effektive Konfiguration (kein Netz, kein Schreiben)"
  printf '  Ziel-Knoten:      %s\n' "${IP:-<keiner>}"
  printf '  Ziel-Verzeichnis: %s\n' "$MEDIA_DIR"
  printf '  Compose-Projekt:  %s (aus fleet-names.sh)\n' "$PROJECT"
  printf '  Orchestral (CC0): %s (%s) -> %s/orchestral\n' "$SRC_ORCHESTRAL" "$(size_of "$SRC_ORCHESTRAL")" "$MEDIA_DIR"
  printf '  ONNX-Modelle:     %s (%s) -> %s/models\n' "$SRC_MODELS" "$(size_of "$SRC_MODELS")" "$MEDIA_DIR"
  if [[ "$WITH_MUSIC" == "1" ]]; then
    printf '  Demo-Tracks:      %s (%s) -> %s/music  (Lizenzlage pruefen!)\n' "$SRC_MUSIC" "$(size_of "$SRC_MUSIC")" "$MEDIA_DIR"
  else
    printf '  Demo-Tracks:      NICHT Teil der Lieferung (--with-music erzwingt sie; Lizenzlage unklar)\n'
  fi
  printf '  Start danach:     %s\n' "$([[ "$NO_START" == "1" ]] && echo "uebersprungen (--no-start)" || echo "docker compose -f docker-compose.hetzner.yml -f docker-compose.media.yml up -d audiomonastry")"
  echo
  echo "Fehlende Quellen werden beim echten Lauf als Fehler gemeldet (Exit 2), weil ein"
  echo "leeres Inhaltsverzeichnis im Container wie ein kaputtes Feature aussieht."
  exit 0
fi

[[ -n "$IP" ]] || { echo "❌ Knoten-IP fehlt. Aufruf: bash scripts/hetzner/deliver-media.sh <ip> [--print-config]" >&2; exit 1; }

MISSING=()
for src in "${SOURCES[@]}"; do
  [[ -e "$src" ]] || MISSING+=("$src")
done
if (( ${#MISSING[@]} > 0 )); then
  echo "❌ Quelle(n) fehlen lokal: ${MISSING[*]}" >&2
  echo "   Orchestral nachladen:  npm run download:orchestral   (CC0, ~3 GB)" >&2
  echo "   ONNX-Modell nachladen: bash scripts/download-models.sh (htdemucs.onnx, ~291 MB)" >&2
  exit 2
fi

echo "=== Medien nach $IP:$MEDIA_DIR ==="
ssh "${SSH_OPTS[@]}" "root@$IP" "mkdir -p '$MEDIA_DIR/orchestral' '$MEDIA_DIR/models'" 

# Orchestral (CC0)
echo "--- orchestral ($(size_of "$SRC_ORCHESTRAL")) ---"
rsync -az --info=stats2 -e "$RSYNC_E" "$SRC_ORCHESTRAL/" "root@$IP:$MEDIA_DIR/orchestral/"

# Modelle (htdemucs.onnx)
echo "--- models ($(size_of "$SRC_MODELS")) ---"
rsync -az --info=stats2 -e "$RSYNC_E" "$SRC_MODELS/" "root@$IP:$MEDIA_DIR/models/"

if [[ "$WITH_MUSIC" == "1" ]]; then
  echo "--- music ($(size_of "$SRC_MUSIC")) - Lizenzlage in docs/LICENSE_EXTERNAL_RESOURCES.md pruefen ---"
  ssh "${SSH_OPTS[@]}" "root@$IP" "mkdir -p '$MEDIA_DIR/music'"
  rsync -az --info=stats2 -e "$RSYNC_E" "$SRC_MUSIC/" "root@$IP:$MEDIA_DIR/music/"
fi

echo "--- Kontrolle auf dem Knoten ---"
ssh "${SSH_OPTS[@]}" "root@$IP" "du -sh '$MEDIA_DIR'/* 2>/dev/null; ls '$MEDIA_DIR/orchestral' | head -3; ls '$MEDIA_DIR/models' | head -3"

if [[ "$NO_START" == "1" ]]; then
  echo "Start uebersprungen (--no-start). Naechster Schritt:"
  echo "  ssh root@$IP 'cd $REMOTE_DIR && COMPOSE_PROJECT_NAME=$PROJECT docker compose -f docker-compose.hetzner.yml -f docker-compose.media.yml up -d --no-build audiomonastry'"
  exit 0
fi

echo "--- App mit Medien-Overlay neu starten ---"
ssh "${SSH_OPTS[@]}" "root@$IP" "cd '$REMOTE_DIR' && COMPOSE_PROJECT_NAME=$PROJECT docker compose -f docker-compose.hetzner.yml -f docker-compose.media.yml up -d --no-build --remove-orphans audiomonastry && sleep 5 && docker ps --format '{{.Names}} {{.Status}}' | head -3 && docker exec audiomonastry sh -c 'ls /app/dist/data/orchestral | head -3; ls -lh /app/dist/models | head -3'"
