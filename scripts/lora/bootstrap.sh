#!/usr/bin/env bash
# =============================================================================
# audioMONASTRY · VISUAL-P1-007 – In-Pod-Runner für das Stil-LoRA-Training
# =============================================================================
# Läuft IM RunPod-Pod (nicht auf dem Entwicklerrechner). Er liest den Auftrag,
# den `scripts/runpod-lora-train.py` in die Pod-Umgebung gelegt hat, holt den
# Datensatz, startet das Training EINES ABSCHNITTS, legt das Ergebnis ab und
# schreibt bei jedem Schritt eine Zeile nach $LORA_WORK/STATUS (JSONL) – daraus
# liest der Betreiber nach dem Lauf ab, was passiert ist.
#
# Aufruf im Pod (Beispiel, so auch als --docker-args möglich):
#     LORA_WORK=/workspace/lora bash /workspace/lora/bootstrap.sh
#
# Der Auftrag kommt aus dem Env `LORA_JOB_SPEC_B64` (base64-kodiertes JSON, vom
# Trainingsskript gesetzt) ODER aus der Datei `$LORA_WORK/job.json`. Fehlt beides,
# bricht das Skript ab – es wird nichts geraten.
#
# ABSCHNITTSBETRIEB (Entscheidung des Betreibers 2026-09-22)
# ----------------------------------------------------------
# Das Training läuft nicht in einem langen Lauf, sondern in Abschnitten. Dieser
# Runner fährt GENAU EINEN Abschnitt und sichert ihn so ab, dass der nächste
# fortsetzen kann:
#
#   1) Checkpoint finden, aus dem fortgesetzt wird (`train.resume_from`):
#        * "auto"/leer  -> neuester Checkpoint in `train.checkpoint_dir` (Volume)
#        * http(s)-URL  -> herunterladen (der VORIGE Abschnitt hat ihn hochgeladen)
#        * Pfad         -> genau dieser Pfad
#      Startet der Abschnitt bei Schritt > 0 und es gibt keinen Checkpoint, bricht
#      das Skript LAUT ab (Exit 2): sonst würde der Abschnitt von vorn trainieren
#      und der ganze Aufwand wäre bezahlt ohne Fortschritt.
#   2) Datensatz: liegt er schon im Volume (Network Volume, siehe
#      scripts/lora/vorstaging.sh), wird der Download ÜBERSPRUNGEN und das im
#      STATUS belegt ("uebersprungen: Datensatz …"). Nur wenn nichts da ist oder
#      `dataset.reuse_existing` false ist, wird geladen.
#   3) Training bis `train.max_steps` (Ende des Abschnitts); der Trainer bekommt
#      die nötigen Angaben als Env (LORA_RESUME_FROM, LORA_MAX_STEPS,
#      LORA_SAVE_EVERY_STEPS, LORA_CHECKPOINT_DIR, LORA_SEGMENT_*,
#      LORA_PROGRESS_FILE, LORA_PROGRESS_URL) – Trainersyntax erfindet dieses
#      Skript weiterhin nicht.
#   4) Checkpoint prüfen (muss in DIESEM Abschnitt entstanden sein) und hochladen.
#   5) Fortschrittsmarker `state=SEGMENT_DONE` schreiben und hochladen – ERST
#      NACH dem Checkpoint-Upload. Der Starter terminiert den Pod, sobald er
#      diesen Zustand sieht; zu früh gesetzt wäre der Abschnitt verloren.
#   6) Ergebnis/LoRA prüfen. In einem ZWISCHENabschnitt ist das Ergebnis der
#      Checkpoint; das LoRA wird erst im letzten Abschnitt verlangt und hochgeladen.
#
# Schritte
#   1) STATUS vorbereiten, Auftrag lesen                     (kein GPU-Bedarf)
#   2) Checkpoint für den Resume bestimmen                  (kein GPU-Bedarf)
#   3) Datensatz bereitstellen: schon im Volume ODER URL laden
#   4) Training starten (Kommando aus dem Auftrag) bis max_steps
#   5) Checkpoint prüfen + hochladen, SEGMENT_DONE-Marker schreiben
#   6) Ergebnis prüfen (LoRA-Datei vorhanden, nicht leer)
#   7) Ergebnis hochladen, wenn eine Upload-URL im Auftrag steht
#   8) STATUS=DONE
#
# Exit-Codes: 0 = Training + Ergebniskontrolle ok · 2 = Auftrag fehlt/unklar
#             (auch: kein Resume-Checkpoint) · 3 = Datensatz fehlt ·
#             4 = Training fehlgeschlagen · 5 = Ergebnisdatei oder Checkpoint
#             fehlt/leer oder Upload fehlgeschlagen
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

upload_file() {
  # $1 = URL (http(s) per PUT, file:// per Kopie), $2 = Pfad der Datei
  local url="$1" path="$2"
  case "$url" in
    file://*) cp -- "$path" "${url#file://}" ;;
    *) curl -fsSL --retry 3 --retry-delay 5 -X PUT -T "$path" "$url" ;;
  esac
}

count_images() {
  # $1 = Verzeichnis; zaehlt Bilddateien (0, wenn es das Verzeichnis nicht gibt)
  find "${1:-/nonexistent}" -type f \( -name '*.png' -o -name '*.jpg' -o -name '*.jpeg' -o -name '*.webp' \) 2>/dev/null | wc -l | tr -d ' '
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
DATASET_REUSE="$(read_spec dataset.reuse_existing)"
OUTPUT_DIR="$(read_spec train.output_dir)"
[ -n "$OUTPUT_DIR" ] || OUTPUT_DIR="$LORA_WORK/out"
EXPECTED_GLOB="$(read_spec train.expected_glob)"
[ -n "$EXPECTED_GLOB" ] || EXPECTED_GLOB="*.safetensors"
UPLOAD_URL="$(read_spec result.upload_url)"
MAX_MINUTES="$(read_spec limits.max_runtime_minutes)"
[ -n "$MAX_MINUTES" ] || MAX_MINUTES="90"

# Abschnitt, Checkpoints, Fortschritt, Vorstaging (alle optional - ohne sie
# verhält sich dieses Skript wie die Ein-Lauf-Variante: ein Training, ein LoRA,
# kein Marker).
MAX_STEPS="$(read_spec train.max_steps)"
RESUME_FROM="$(read_spec train.resume_from)"
SAVE_EVERY="$(read_spec train.save_every_steps)"
CKPT_DIR="$(read_spec train.checkpoint_dir)"
CKPT_UPLOAD_URL="$(read_spec train.checkpoint_upload_url)"
SEG_INDEX="$(read_spec train.segment.index)"
SEG_START="$(read_spec train.segment.start_step)"
SEG_END="$(read_spec train.segment.end_step)"
SEG_IS_LAST="$(read_spec train.segment.is_last)"
TOTAL_STEPS="$(read_spec train.segment.total_steps)"
PROGRESS_URL="$(read_spec progress.upload_url)"
PROGRESS_FILE="$(read_spec progress.file)"
[ -n "$PROGRESS_FILE" ] || PROGRESS_FILE="$LORA_WORK/progress.jsonl"
HF_HOME_DIR="$(read_spec train.hf_home)"
BASE_MODEL="$(read_spec train.base_model)"

# Der Marker-Schreiber wird mit dem Auftrag ins Volume gelegt; fehlt er, schreibt
# dieses Skript eine schmalere Zeile selbst (kein stiller Ausfall).
PROGRESS_CLI="$LORA_WORK/lora-progress.py"
[ -f "$PROGRESS_CLI" ] || PROGRESS_CLI="$(cd "$(dirname "$0")" && pwd)/lora-progress.py"

progress_marker() {
  # $1 = Schritt, $2 = Zustand, $3 = Loss ("-" = keiner), $4 = Checkpoint, $5 = Checkpoint-URL
  local step="$1" state="$2" loss="${3:--}" ckpt="${4:-}" ckpt_url="${5:-}"
  if [ -f "$PROGRESS_CLI" ] && command -v python3 >/dev/null 2>&1; then
    local args=(--step "$step" --state "$state" --file "$PROGRESS_FILE" --quiet)
    [ -n "$SEG_INDEX" ] && args+=(--segment-index "$SEG_INDEX" --segment-start "${SEG_START:-0}" --segment-end "${SEG_END:-0}")
    [ -n "$TOTAL_STEPS" ] && args+=(--total-steps "$TOTAL_STEPS")
    [ "$loss" != "-" ] && args+=(--loss "$loss")
    [ -n "$ckpt" ] && args+=(--checkpoint "$ckpt")
    [ -n "$ckpt_url" ] && args+=(--checkpoint-url "$ckpt_url")
    [ -n "$PROGRESS_URL" ] && args+=(--url "$PROGRESS_URL")
    python3 "$PROGRESS_CLI" "${args[@]}" || return 1
    return 0
  fi
  # Fallback: dieselbe JSONL-Zeile, aber ohne Loss/Checkpoint-Felder.
  local extra=""
  [ -n "$ckpt_url" ] && extra=",\"checkpoint_url\":\"$ckpt_url\""
  printf '{"schema":"visual-lora-progress/1","ts":"%s","step":%s,"state":"%s"%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$step" "$state" "$extra" >> "$PROGRESS_FILE" || return 1
  if [ -n "$PROGRESS_URL" ]; then
    upload_file "$PROGRESS_URL" "$PROGRESS_FILE" || return 1
  fi
  return 0
}

if [ -n "$SEG_END" ]; then
  log "START" "Auftrag gelesen (Arbeitsverzeichnis $LORA_WORK, Obergrenze ${MAX_MINUTES} min, Abschnitt ${SEG_INDEX:-1}: Schritte ${SEG_START:-0}-$SEG_END)"
else
  log "START" "Auftrag gelesen (Arbeitsverzeichnis $LORA_WORK, Obergrenze ${MAX_MINUTES} min, kein Abschnittsraster)"
fi

# --- 2) Resume-Checkpoint bestimmen ------------------------------------------
RESUME_PATH=""
case "$RESUME_FROM" in
  ""|auto|latest|neuester|marker)
    if [ -n "$CKPT_DIR" ] && [ -d "$CKPT_DIR" ]; then
      RESUME_PATH="$(find "$CKPT_DIR" -maxdepth 2 -type f \( -name '*.safetensors' -o -name '*.ckpt' -o -name '*.pt' \) -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -n 1 | cut -d' ' -f2-)"
    fi
    [ -n "$RESUME_PATH" ] && log "RESUME" "auto: neuester Checkpoint im Volume: $RESUME_PATH"
    ;;
  http://*|https://*)
    [ -n "$CKPT_DIR" ] || fail 2 "Checkpoint-URL im Auftrag, aber kein train.checkpoint_dir zum Ablegen"
    mkdir -p "$CKPT_DIR" || fail 2 "Checkpoint-Verzeichnis nicht anlegbar: $CKPT_DIR"
    RESUME_PATH="$CKPT_DIR/resume-step${SEG_START:-0}.safetensors"
    log "RESUME" "lade Checkpoint-URL herunter"
    curl -fsSL --retry 3 --retry-delay 5 -o "$RESUME_PATH" "$RESUME_FROM" \
      || fail 2 "Resume-Checkpoint nicht ladbar (URL im Auftrag): $RESUME_FROM"
    [ -s "$RESUME_PATH" ] || fail 2 "Resume-Checkpoint ist leer: $RESUME_PATH"
    ;;
  *)
    RESUME_PATH="$RESUME_FROM"
    ;;
esac
if [ -n "$RESUME_PATH" ] && [ ! -s "$RESUME_PATH" ]; then
  fail 2 "Resume-Checkpoint nicht gefunden oder leer: $RESUME_PATH"
fi
if [ "${SEG_START:-0}" -gt 0 ] && [ -z "$RESUME_PATH" ]; then
  fail 2 "Abschnitt ${SEG_INDEX:-?} soll bei Schritt $SEG_START fortsetzen, aber es wurde kein Checkpoint gefunden (train.checkpoint_dir='${CKPT_DIR:-<leer>}'). Ohne ihn wuerde der Abschnitt von vorn trainieren - das waere bezahlte Arbeit ohne Fortschritt."
fi

# --- 2b) Vorstaging pruefen (Gewichte im Volume? sonst teurer Download) ------
if [ -n "$BASE_MODEL" ] && [ -n "$HF_HOME_DIR" ]; then
  MODEL_SLUG="models--$(printf '%s' "$BASE_MODEL" | tr '/' '-')"
  if [ -d "$HF_HOME_DIR/hub/$MODEL_SLUG" ]; then
    log "WEIGHTS" "uebersprungen: Gewichte ($BASE_MODEL liegt schon in $HF_HOME_DIR – kein ~24-GB-Download im GPU-Pod)"
  else
    log "WARNUNG" "Gewichte NICHT vorstaged ($HF_HOME_DIR/hub/$MODEL_SLUG fehlt): der GPU-Pod laedt die Basisgewichte jetzt selbst. Nachholen mit scripts/lora/vorstaging.sh auf einem CPU-Pod."
  fi
fi

if [ "$DRY_RUN" = "1" ]; then
  progress_marker "${SEG_START:-0}" "DRY-RUN" "-" "" "" >/dev/null 2>&1 || true
  log "DRY-RUN" "Dataset: ${DATASET_URL:-<keine URL>} -> $DATASET_DIR | Training: ${TRAIN_COMMAND:-<kein Kommando>} bis Schritt ${MAX_STEPS:-<offen>} | Ausgabe: $OUTPUT_DIR/$EXPECTED_GLOB | Resume: ${RESUME_PATH:-<frisch>} | Checkpoints: ${CKPT_DIR:-<keine>}${SAVE_EVERY:+ alle $SAVE_EVERY Schritte}"
  echo "[bootstrap] --dry-run: nichts geladen, nichts trainiert."
  exit 0
fi

# --- 3) Datensatz bereitstellen ---------------------------------------------
DATASET_IMAGES="$(count_images "$DATASET_DIR")"
if [ -n "$DATASET_URL" ] && [ "$DATASET_REUSE" != "False" ] && [ "$DATASET_IMAGES" -gt 0 ]; then
  # Idempotenz: der Datensatz liegt schon im (Network-)Volume - der Download
  # waere bezahlte Wartezeit. Der Nachweis steht als Zeile im STATUS.
  log "DATASET" "uebersprungen: Datensatz ($DATASET_IMAGES Bilder liegen schon in $DATASET_DIR, Volume) – kein Download von $DATASET_URL"
elif [ -n "$DATASET_URL" ]; then
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

IMAGE_COUNT="$(count_images "$DATASET_DIR")"
[ "$IMAGE_COUNT" -gt 0 ] || fail 3 "keine Bilder unter $DATASET_DIR – ohne Bilder wird nicht trainiert (kein stiller Erfolg)"
log "DATASET" "$IMAGE_COUNT Bilder gefunden"

[ -n "$TRAIN_COMMAND" ] || fail 2 "kein train.command im Auftrag (LORA_TRAIN_COMMAND / --train-command setzen)"
mkdir -p "$OUTPUT_DIR" || fail 4 "Ausgabeverzeichnis nicht anlegbar: $OUTPUT_DIR"
if [ -n "$CKPT_DIR" ]; then
  mkdir -p "$CKPT_DIR" || fail 4 "Checkpoint-Verzeichnis nicht anlegbar: $CKPT_DIR"
fi

# --- 4) Training -------------------------------------------------------------
# Die Angaben des Abschnitts gehen als Env an den Trainer: er entscheidet, wie
# er sie in seine eigene Syntax uebersetzt (dieses Skript erfindet keine).
export LORA_RESUME_FROM="${RESUME_PATH:-}"
export LORA_MAX_STEPS="${MAX_STEPS:-}"
export LORA_TOTAL_STEPS="${TOTAL_STEPS:-}"
export LORA_SAVE_EVERY_STEPS="${SAVE_EVERY:-}"
export LORA_CHECKPOINT_DIR="${CKPT_DIR:-}"
export LORA_SEGMENT_INDEX="${SEG_INDEX:-}"
export LORA_SEGMENT_START="${SEG_START:-}"
export LORA_SEGMENT_END="${SEG_END:-}"
export LORA_DATASET_DIR="$DATASET_DIR"
export LORA_OUTPUT_DIR="$OUTPUT_DIR"
export LORA_PROGRESS_FILE="$PROGRESS_FILE"
export LORA_PROGRESS_URL="${PROGRESS_URL:-}"

progress_marker "${SEG_START:-0}" "RUNNING" "-" "" "" \
  || log "WARNUNG" "Fortschrittsmarker (Start) nicht geschrieben"

TRAIN_LOG="$LORA_WORK/train.log"
log "TRAIN" "starte: $TRAIN_COMMAND (bis Schritt ${MAX_STEPS:-<offen>}, Resume: ${RESUME_PATH:-<frisch>})"
START_EPOCH="$(date +%s)"
STAMP_FILE="$LORA_WORK/.segment-start"
: > "$STAMP_FILE"
# `timeout` verhindert einen endlos laufenden Job: spätestens nach der
# vereinbarten Obergrenze (Default 90 min, minus 5 Minuten Puffer für den
# Checkpoint- und Ergebnis-Upload) bricht der Trainer ab. Das Kontrollskript
# terminiert den Pod ohnehin hart – das hier schützt zusätzlich die Pod-Laufzeit.
TIMEOUT_SECONDS=$(( (${MAX_MINUTES%%.*} - 5) * 60 ))
[ "$TIMEOUT_SECONDS" -gt 60 ] || TIMEOUT_SECONDS=60
set +e
timeout --signal=TERM "$TIMEOUT_SECONDS" bash -lc "$TRAIN_COMMAND" 2>&1 | tee "$TRAIN_LOG"
TRAIN_RC="${PIPESTATUS[0]}"
set -e
DURATION=$(( $(date +%s) - START_EPOCH ))
log "TRAIN" "beendet nach ${DURATION}s, Exit $TRAIN_RC"
[ "$TRAIN_RC" = "0" ] || fail 4 "Training mit Exit $TRAIN_RC abgebrochen (Log: $TRAIN_LOG)"

# --- 5) Checkpoint prüfen + hochladen, Abschnitt als fertig markieren --------
CKPT_FILE=""
if [ -n "$CKPT_DIR" ]; then
  CKPT_FILE="$(find "$CKPT_DIR" -maxdepth 2 -type f \( -name '*.safetensors' -o -name '*.ckpt' -o -name '*.pt' \) -newer "$STAMP_FILE" -size +1k 2>/dev/null | sort | tail -n 1)"
  if [ -z "$CKPT_FILE" ]; then
    # Kein NEUER Checkpoint: warnen, nicht luegen - und den neuesten vorhandenen
    # als Resume-Grundlage nennen (sonst waere der naechste Abschnitt blind).
    CKPT_FILE="$(find "$CKPT_DIR" -maxdepth 2 -type f \( -name '*.safetensors' -o -name '*.ckpt' -o -name '*.pt' \) -size +1k 2>/dev/null | sort | tail -n 1)"
    log "WARNUNG" "in DIESEM Abschnitt wurde kein neuer Checkpoint geschrieben (save_every_steps=${SAVE_EVERY:-<leer>}?) - nutze den vorhandenen: ${CKPT_FILE:-<keiner>}"
  fi
  [ -n "$CKPT_FILE" ] || fail 5 "kein Checkpoint unter $CKPT_DIR – der naechste Abschnitt koennte nicht fortsetzen (save_every_steps=${SAVE_EVERY:-<leer>})"
  log "CHECKPOINT" "Checkpoint: $CKPT_FILE ($(stat -c%s "$CKPT_FILE" 2>/dev/null || echo '?') Bytes)"
  if [ -n "$CKPT_UPLOAD_URL" ]; then
    if ! upload_file "$CKPT_UPLOAD_URL" "$CKPT_FILE"; then
      fail 5 "Checkpoint-Upload fehlgeschlagen – der Abschnitt waere nur lokal gesichert: $CKPT_FILE"
    fi
    log "CHECKPOINT" "Checkpoint hochgeladen (R2)"
  else
    log "CHECKPOINT" "keine Upload-URL im Auftrag – Checkpoint bleibt im Volume"
  fi
fi

if [ -n "$SEG_END" ]; then
  # ERST nach dem Checkpoint-Upload: der Starter terminiert den Pod, sobald er
  # diesen Zustand liest.
  progress_marker "$SEG_END" "SEGMENT_DONE" "-" "${CKPT_FILE:-}" "${CKPT_UPLOAD_URL:-}" \
    || fail 5 "Fortschrittsmarker mit SEGMENT_DONE nicht geschrieben/hochgeladen – der Starter kann den Abschnittsabschluss nicht erkennen"
  log "SEGMENT" "Abschnitt ${SEG_INDEX:-?} erreicht Schritt $SEG_END – Marker SEGMENT_DONE gesetzt"
fi

# --- 6) Ergebnis prüfen ------------------------------------------------------
RESULT_FILE=""
if [ "$SEG_IS_LAST" = "False" ]; then
  # Zwischenabschnitt: das Ergebnis ist der Checkpoint, das LoRA entsteht erst am
  # Ende. Ein fehlendes LoRA ist hier KEIN Fehler (aber auch kein stiller Erfolg:
  # ohne Checkpoint oben bricht der Lauf ab).
  log "RESULT" "Zwischenabschnitt: Ergebnis ist der Checkpoint ${CKPT_FILE:-<keiner>} (LoRA erst im letzten Abschnitt)"
else
  if [ -n "$CKPT_DIR" ]; then
    RESULT_FILE="$(find "$OUTPUT_DIR" -maxdepth 2 -type f -name "$EXPECTED_GLOB" -size +1k -not -path "$CKPT_DIR/*" 2>/dev/null | sort | head -n 1)"
  else
    RESULT_FILE="$(find "$OUTPUT_DIR" -maxdepth 2 -type f -name "$EXPECTED_GLOB" -size +1k 2>/dev/null | sort | head -n 1)"
  fi
  [ -n "$RESULT_FILE" ] || fail 5 "keine Ergebnisdatei ($EXPECTED_GLOB, >1k) unter $OUTPUT_DIR"
  log "RESULT" "Ergebnis: $RESULT_FILE ($(stat -c%s "$RESULT_FILE" 2>/dev/null || echo '?') Bytes)"
  LOG_PEEK="$(tail -n 3 "$TRAIN_LOG" 2>/dev/null | tr '\n' '|')"
  log "RESULT" "Trainer-Ende: $LOG_PEEK"

  # --- 7) Upload (optional) --------------------------------------------------
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
fi

log "DONE" "Training abgeschlossen, Ergebnis geprüft"
echo "[bootstrap] fertig: ${CKPT_FILE:-${RESULT_FILE:-$OUTPUT_DIR}}"
