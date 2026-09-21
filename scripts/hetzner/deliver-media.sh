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
# ZWEI UEBERTRAGUNGSWEGE (gemessen 2026-09-21: EIN ssh-Strom ~1 MB/s hoch,
# 200 MB in 3:14 - 3,7 GB also ~60 min pro Knoten und je Lieferung):
#   * Standard: rsync ueber EINEN ssh-Strom.
#   * --via-r2: jeden Baum deterministisch zstd-packen, EINMAL nach Cloudflare
#     R2 legen (Egress kostenfrei; 3,7 GB kosten ~0,06 USD/Monat Storage) und
#     jeden Knoten mit `aria2c -x16 -s16` ziehen lassen - der Betreiber-Host
#     schiebt danach nichts mehr nach. Umsetzung/Rueckfall: parallel-transfer.sh
#     + lib/r2-sigv4.sh + lib/r2-node-fetch.sh (Schluessel bleiben beim
#     Betreiber, der Knoten bekommt nur eine presignierte GET-URL mit TTL).
#     Knoten-Voraussetzung: aria2c + zstd. Beide stehen seit 2026-09-21 in der
#     Provisionierung (scripts/hetzner/cloud-init.yaml, packages: aria2, zstd) -
#     auf einem frischen Knoten greift --via-r2 deshalb SOFORT. Die Nachinstall-
#     Option bleibt fuer Knoten aus einem Rollen-SNAPSHOT (dort laeuft kein
#     cloud-init): ohne aria2c faellt der Lauf LAUT auf EINEN curl-Strom
#     zurueck. Opt-out der Nachinstallation: MEDIA_R2_NO_INSTALL=1.
#     Die Mount-/Ausschlusslogik (docker-compose.media.yml, READ-ONLY) ist in
#     beiden Wegen identisch.
#
# Aufruf:
#   bash scripts/hetzner/deliver-media.sh <ip> [--print-config] [--with-music] [--no-start] [--via-r2]
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
VIA_R2=0
for arg in "$@"; do
  case "$arg" in
    --print-config) PRINT_CONFIG=1 ;;
    --with-music) WITH_MUSIC=1 ;;
    --no-start) NO_START=1 ;;
    --via-r2) VIA_R2=1 ;;
    --help|-h) sed -n '2,39p' "$0"; exit 0 ;;
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
# Die drei Pfade sind per env ueberschreibbar (Medien auf einer anderen Platte,
# oder ein Lauf gegen kleine Baeume); die Defaults bleiben die Repo-Pfade.
SRC_ORCHESTRAL="${MEDIA_SRC_ORCHESTRAL:-public/data/orchestral}"
SRC_MODELS="${MEDIA_SRC_MODELS:-public/models}"
SRC_MUSIC="${MEDIA_SRC_MUSIC:-public/music}"
SOURCES=("$SRC_ORCHESTRAL" "$SRC_MODELS")
[[ "$WITH_MUSIC" == "1" ]] && SOURCES+=("$SRC_MUSIC")

size_of() { [[ -e "$1" ]] && du -sh "$1" 2>/dev/null | cut -f1 || echo "fehlt"; }

if [[ "$PRINT_CONFIG" == "1" ]]; then
  echo "deliver-media.sh - effektive Konfiguration (kein Netz, kein Schreiben)"
  printf '  Ziel-Knoten:      %s\n' "${IP:-<keiner>}"
  printf '  Ziel-Verzeichnis: %s\n' "$MEDIA_DIR"
  printf '  Compose-Projekt:  %s (aus fleet-names.sh)\n' "$PROJECT"
  if [[ "$VIA_R2" == "1" ]]; then
    printf '  Uebertragung:     R2-Zwischenspeicher + aria2c -x16 -s16 (parallel-transfer.sh, zstd-Archiv deterministisch)\n'
    printf '                    je Baum: EIN Upload vom Betreiber-Host, danach zieht JEDER Knoten aus R2 (Egress frei)\n'
    printf '                    Erwartungswert (Referenz Einzelstrom 2026-09-21 ~1 MB/s, 3,7 GB ~60 min): ein Vielfaches\n'
    printf '                    der Rate, wenn das Limit pro Verbindung greift - die echte Zahl misst der Lauf auf dem Knoten\n'
    printf '                    Knoten-Voraussetzung: aria2c + zstd - stehen seit 2026-09-21 in der\n'
    printf '                    Provisionierung (scripts/hetzner/cloud-init.yaml, packages: aria2, zstd);\n'
    printf '                    apt-Kommando nur noch fuer Knoten aus einem Rollen-SNAPSHOT:\n'
    printf '                    apt-get install -y --no-install-recommends aria2 zstd\n'
    printf '                    Nachinstallation auf dem Knoten: %s\n' "$([[ "${MEDIA_R2_NO_INSTALL:-0}" == "1" ]] && echo 'aus (MEDIA_R2_NO_INSTALL=1)' || echo 'ja (Rueckfall auf EINEN curl-Strom, wenn aria2c fehlt)')"
  else
    printf '  Uebertragung:     rsync ueber EINEN ssh-Strom (gemessen 2026-09-21: ~1 MB/s -> 3,7 GB in ~60 min)\n'
    printf '  Schnellerer Weg:  --via-r2 (R2-Zwischenspeicher + aria2c -x16 -s16, keine Schluessel auf dem Knoten)\n'
  fi
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

# Das Overlay MIT ausliefern: sonst scheitert der Neustart auf einem Knoten,
# dessen Repo-Stand aelter ist als dieses Skript (live passiert 2026-09-20:
# "compose file .../docker-compose.media.yml is invalid: no such file").
echo "--- Overlay + Skript auf den Knoten ---"
rsync -az -e "$RSYNC_E" docker-compose.media.yml "root@$IP:$REMOTE_DIR/docker-compose.media.yml"
rsync -az -e "$RSYNC_E" "$HERE_SRC/deliver-media.sh" "root@$IP:$REMOTE_DIR/scripts/hetzner/deliver-media.sh" 

# Gemeinsamer Helfer fuer den R2-Weg: ein Baum -> parallel-transfer.sh.
# Die Mount-/Ausschlusslogik (docker-compose.media.yml) bleibt unangetastet -
# dieser Weg aendert NUR, wie die Bytes auf den Knoten kommen. Ziel ist immer
# das MEDIA_DIR (der Archiv-Wurzelordner ist der Basisname des Baums, also
# landet orchestral/ unter media/orchestral - identisch zum rsync-Weg).
transfer_r2() {
  local src="$1" name="$2"
  local args=("$IP" --src "$src" --dest "$MEDIA_DIR" --name "$name")
  # aria2c/zstd auf dem Knoten nachinstallieren, sofern nicht abgeschaltet: ohne
  # aria2c faellt der Lauf auf EINEN curl-Strom zurueck (kein 16-fach-Split).
  [[ "${MEDIA_R2_NO_INSTALL:-0}" == "1" ]] || args+=(--install-missing)
  bash "$HERE_SRC/parallel-transfer.sh" "${args[@]}"
}

if [[ "$VIA_R2" == "1" ]]; then
  echo "--- orchestral ($(size_of "$SRC_ORCHESTRAL")) via R2 (zstd + aria2c -x16 -s16) ---"
  transfer_r2 "$SRC_ORCHESTRAL" orchestral

  echo "--- models ($(size_of "$SRC_MODELS")) via R2 ---"
  transfer_r2 "$SRC_MODELS" models

  if [[ "$WITH_MUSIC" == "1" ]]; then
    echo "--- music ($(size_of "$SRC_MUSIC")) via R2 - Lizenzlage in docs/LICENSE_EXTERNAL_RESOURCES.md pruefen ---"
    transfer_r2 "$SRC_MUSIC" music
  fi
else
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
