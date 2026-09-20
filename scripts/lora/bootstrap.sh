#!/usr/bin/env bash
# =============================================================================
# audioMONASTRY · VISUAL-P1-007 – In-Pod-Runner für das Stil-LoRA-Training
# =============================================================================
# Läuft IM RunPod-Pod (nicht auf dem Entwicklerrechner). Er liest den Auftrag,
# den `scripts/runpod-lora-train.py` in die Pod-Umgebung gelegt hat, holt den
# Datensatz, startet das Training, legt das Ergebnis ab und schreibt bei jedem
# Schritt eine Zeile nach $LORA_WORK/STATUS (JSONL) – daraus liest der Betreiber
# nach dem Lauf ab, was passiert ist.
#
# Aufruf im Pod (Beispiel, so auch als --docker-args möglich):
#     LORA_WORK=/workspace/lora bash /workspace/lora/bootstrap.sh
#
# Der Auftrag kommt aus dem Env `LORA_JOB_SPEC_B64` (base64-kodiertes JSON, vom
# Trainingsskript gesetzt) ODER aus der Datei `$LORA_WORK/job.json`. Fehlt beides,
# bricht das Skript ab – es wird nichts geraten.
#
# Schritte
#   1) STATUS vorbereiten, Auftrag lesen                     (kein GPU-Bedarf)
#   2) Datensatz bereitstellen: URL laden + entpacken ODER schon im Volume
#   3) Training starten (Kommando aus dem Auftrag)
#   4) Ergebnis prüfen (LoRA-Datei vorhanden, nicht leer)
#   5) Ergebnis hochladen, wenn eine Upload-URL im Auftrag steht
#   6) STATUS=DONE
#
# Exit-Codes: 0 = Training + Ergebniskontrolle ok · 2 = Auftrag fehlt/unklar ·
#             3 = Datensatz fehlt · 4 = Training fehlgeschlagen ·
#             5 = Ergebnisdatei fehlt/leer
#
# EHRLICHKEIT: Der Schritt "Training" ruft genau das Kommando aus dem Auftrag
# auf. Welches Trainer-Image und welches Kommando richtig sind, entscheidet der
# Betreiber (siehe docs/VISUAL_LORA_TRAINING.md) – dieses Skript erfindet keine
# Trainer-Syntax und lädt keine Gewichte heimlich nach.
# =============================================================================
set -u -o pipefail

LORA_WORK="${LORA_WORK:-/workspace/lora}"
STATUS_FILE="$LORA_WORK/STATUS"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

mkdir -p "$LORA_WORK" 2>/dev/null || true

log() {
  # Eine JSONL-Zeile nach STATUS; Zeitstempel in UTC. `status` ist bewusst
  # einfach gehalten, damit man es mit grep/tail lesen kann.
  local step="$1"; shift
  local message="$*"
  printf '{"ts":"%s","step":"%s","message":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$step" "${message//\"/\'}" | tee -a "$STATUS_FILE"
}

fail() {
  local code="$1"; shift
  log "ERROR" "$*"
  echo "FEHLER: $*" >&2
  exit "$code"
}

# --- 1) Auftrag lesen --------------------------------------------------------
SPEC_JSON=""
if [ -n "${LORA_JOB_SPEC_B64:-}" ]; then
  SPEC_JSON="$(printf '%s' "$LORA_JOB_SPEC_B64" | base64 -d 2>/dev/null)" || SPEC_JSON=""
elif [ -f "$LORA_WORK/job.json" ]; then
  SPEC_JSON="$(cat "$LORA_WORK/job.json")"
fi
[ -n "$SPEC_JSON" ] || fail 2 "kein Auftrag: LORA_JOB_SPEC_B64 oder $LORA_WORK/job.json fehlt"

read_spec() {
  # $1 = Punkt-Pfad, z. B. train.command
  printf '%s' "$SPEC_JSON" | python3 -c '
import json,sys
path = sys.argv[1].split(".")
try:
    node = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for key in path:
    if not isinstance(node, dict) or key not in node:
        sys.exit(0)
    node = node[key]
print("" if node is None else node)
' "$1"
}

TRAIN_COMMAND="$(read_spec train.command)"
DATASET_URL="$(read_spec dataset.url)"
DATASET_DIR="$(read_spec dataset.dir)"
[ -n "$DATASET_DIR" ] || DATASET_DIR="$LORA_WORK/dataset"
OUTPUT_DIR="$(read_spec train.output_dir)"
[ -n "$OUTPUT_DIR" ] || OUTPUT_DIR="$LORA_WORK/out"
EXPECTED_GLOB="$(read_spec train.expected_glob)"
[ -n "$EXPECTED_GLOB" ] || EXPECTED_GLOB="*.safetensors"
UPLOAD_URL="$(read_spec result.upload_url)"
MAX_MINUTES="$(read_spec limits.max_runtime_minutes)"
[ -n "$MAX_MINUTES" ] || MAX_MINUTES="90"

log "START" "Auftrag gelesen (Arbeitsverzeichnis $LORA_WORK, Obergrenze ${MAX_MINUTES} min)"

if [ "$DRY_RUN" = "1" ]; then
  log "DRY-RUN" "Dataset: ${DATASET_URL:-<keine URL>} -> $DATASET_DIR | Training: ${TRAIN_COMMAND:-<kein Kommando>} | Ausgabe: $OUTPUT_DIR/$EXPECTED_GLOB"
  echo "[bootstrap] --dry-run: nichts geladen, nichts trainiert."
  exit 0
fi

# --- 2) Datensatz bereitstellen ---------------------------------------------
if [ -n "$DATASET_URL" ]; then
  mkdir -p "$DATASET_DIR" || fail 3 "Zielverzeichnis nicht anlegbar: $DATASET_DIR"
  ARCHIVE="$LORA_WORK/dataset.download"
  log "DATASET" "lade $DATASET_URL"
  if ! curl -fsSL --retry 3 --retry-delay 5 -o "$ARCHIVE" "$DATASET_URL"; then
    fail 3 "Datensatz-Download fehlgeschlagen: $DATASET_URL"
  fi
  case "$DATASET_URL" in
    *.tar.gz|*.tgz) tar -xzf "$ARCHIVE" -C "$DATASET_DIR" || fail 3 "Entpacken fehlgeschlagen (tar.gz)" ;;
    *.zip)          unzip -o -q "$ARCHIVE" -d "$DATASET_DIR" || fail 3 "Entpacken fehlgeschlagen (zip)" ;;
    *.tar)          tar -xf "$ARCHIVE" -C "$DATASET_DIR" || fail 3 "Entpacken fehlgeschlagen (tar)" ;;
    *)              mv "$ARCHIVE" "$DATASET_DIR/$(basename "$DATASET_URL")" ;;
  esac
  log "DATASET" "entpackt nach $DATASET_DIR"
else
  log "DATASET" "keine URL im Auftrag – nutze bereits vorhandenen Pfad $DATASET_DIR"
fi

IMAGE_COUNT="$(find "$DATASET_DIR" -type f \( -name '*.png' -o -name '*.jpg' -o -name '*.jpeg' -o -name '*.webp' \) 2>/dev/null | wc -l | tr -d ' ')"
[ "$IMAGE_COUNT" -gt 0 ] || fail 3 "keine Bilder unter $DATASET_DIR – ohne Bilder wird nicht trainiert (kein stiller Erfolg)"
log "DATASET" "$IMAGE_COUNT Bilder gefunden"

[ -n "$TRAIN_COMMAND" ] || fail 2 "kein train.command im Auftrag (LORA_TRAIN_COMMAND / --train-command setzen)"
mkdir -p "$OUTPUT_DIR" || fail 4 "Ausgabeverzeichnis nicht anlegbar: $OUTPUT_DIR"

# --- 3) Training -------------------------------------------------------------
TRAIN_LOG="$LORA_WORK/train.log"
log "TRAIN" "starte: $TRAIN_COMMAND"
START_EPOCH="$(date +%s)"
# `timeout` verhindert einen endlos laufenden Job: spätestens nach der
# vereinbarten Obergrenze (Default 90 min, minus 5 Minuten Puffer für den
# Ergebnis-Upload) bricht der Trainer ab. Das Kontrollskript terminiert den Pod
# ohnehin hart – das hier schützt zusätzlich die Pod-Laufzeit selbst.
TIMEOUT_SECONDS=$(( (${MAX_MINUTES%%.*} - 5) * 60 ))
[ "$TIMEOUT_SECONDS" -gt 60 ] || TIMEOUT_SECONDS=60
set +e
LORA_DATASET_DIR="$DATASET_DIR" LORA_OUTPUT_DIR="$OUTPUT_DIR" \
  timeout --signal=TERM "$TIMEOUT_SECONDS" bash -lc "$TRAIN_COMMAND" 2>&1 | tee "$TRAIN_LOG"
TRAIN_RC="${PIPESTATUS[0]}"
set -e
DURATION=$(( $(date +%s) - START_EPOCH ))
log "TRAIN" "beendet nach ${DURATION}s, Exit $TRAIN_RC"
[ "$TRAIN_RC" = "0" ] || fail 4 "Training mit Exit $TRAIN_RC abgebrochen (Log: $TRAIN_LOG)"

# --- 4) Ergebnis prüfen ------------------------------------------------------
# shellcheck disable=SC2086
RESULT_FILE="$(find "$OUTPUT_DIR" -maxdepth 2 -type f -name "$EXPECTED_GLOB" -size +1k 2>/dev/null | sort | head -n 1)"
[ -n "$RESULT_FILE" ] || fail 5 "keine Ergebnisdatei ($EXPECTED_GLOB, >1k) unter $OUTPUT_DIR"
log "RESULT" "Ergebnis: $RESULT_FILE ($(stat -c%s "$RESULT_FILE" 2>/dev/null || echo '?') Bytes)"
LOG_PEEK="$(tail -n 3 "$TRAIN_LOG" 2>/dev/null | tr '\n' '|')"
log "RESULT" "Trainer-Ende: $LOG_PEEK"

# --- 5) Upload (optional) ----------------------------------------------------
if [ -n "$UPLOAD_URL" ]; then
  log "UPLOAD" "lade Ergebnis hoch"
  if curl -fsSL --retry 3 --retry-delay 5 -X PUT -T "$RESULT_FILE" "$UPLOAD_URL"; then
    log "UPLOAD" "Upload ok"
  else
    # Kein DONE: der Betreiber sieht im STATUS, dass das Artefakt nur lokal liegt.
    fail 5 "Upload fehlgeschlagen – Ergebnis liegt nur im Pod/Volume: $RESULT_FILE"
  fi
else
  log "UPLOAD" "keine Upload-URL im Auftrag – Ergebnis bleibt im Volume ($RESULT_FILE)"
fi

log "DONE" "Training abgeschlossen, Ergebnis geprüft"
echo "[bootstrap] fertig: $RESULT_FILE"
