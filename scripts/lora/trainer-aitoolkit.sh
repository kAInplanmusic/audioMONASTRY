#!/usr/bin/env bash
# =============================================================================
# audioMONASTRY · VISUAL-P1-007 – Trainerkommando fuer ai-toolkit (im Pod)
# =============================================================================
# DIES IST DAS `--train-command`, das der Betreiber nicht mehr von Hand bauen
# muss: es uebersetzt die Abschnittsangaben, die `scripts/lora/bootstrap.sh`
# exportiert, in die Form, die ai-toolkit wirklich liest (Belege aus dem
# Quellcode: github.com/ostris/ai-toolkit, Commit a8dfcf7 – siehe Kopf von
# scripts/lora/aitk-segment.py).
#
# Aufruf im Auftrag (Beispiel):
#     --train-command 'bash /workspace/lora/trainer-aitoolkit.sh \
#         --aidir /workspace/ai-toolkit --config /workspace/lora/cosmic-r16.yml \
#         --name cosmic-r16'
#
# Zusammenspiel (genau die drei Punkte, die den ersten Lauf gekostet haben):
#   1. `train.steps` wird auf den ABSOLUTEN Abschnitts-Zielschritt gesetzt
#      (LORA_SEGMENT_END). Die Konfiguration selbst darf 1500 sagen – der
#      Abschnitt entscheidet.
#   2. Der Resume-Checkpoint aus LORA_RESUME_FROM wird in den `save_root`
#      (`<training-folder>/<name>`) gelegt – dort sucht ai-toolkit ihn – und
#      sein Metadaten-Schritt wird GEGEN den Abschnittsanfang geprueft. Passt er
#      nicht, bricht das Skript VOR dem Training ab (keine Doppelarbeit).
#   3. Nach dem Lauf wird der neueste Checkpoint FLACH nach
#      LORA_CHECKPOINT_DIR kopiert, weil `bootstrap.sh` dort (nicht rekursiv)
#      sucht und ihn zum S3/R2-Ziel hochlaedt.
#
# Was dieses Skript NICHT tut: Werte erfinden. Fehlt ein Pfad, ein Name oder der
# Abschnittsendpunkt, endet es mit Exit 2 und einer Liste der fehlenden Angaben.
#
# `--print` zeigt die gepatchte Konfiguration und das Trainerkommando, ohne
# etwas zu starten (Trockenlauf, ohne GPU, ohne Kosten).
#
# Exit-Codes: 0 = ok · 2 = Aufruf/Konfiguration · 3 = Datei/Metadaten fehlen ·
#             4 = Widerspruch (Schritt != Abschnittsanfang) · sonst Exit des Trainers
# =============================================================================
set -u -o pipefail

AIDIR=""
CONFIG=""
NAME=""
IMAGES_DIR="${LORA_DATASET_DIR:-}"
TRAINING_FOLDER="${LORA_OUTPUT_DIR:-}"
BASE_MODEL="${LORA_BASE_MODEL:-}"
PYTHON="${LORA_PYTHON:-python3}"
DISABLE_SAMPLING=0
PRINT_ONLY=0
EXTRA_ARGS=()
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER="$HERE/aitk-segment.py"

usage() { sed -n '2,46p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --aidir)           AIDIR="${2:?--aidir braucht einen Pfad}"; shift 2 ;;
    --config)          CONFIG="${2:?--config braucht einen Pfad}"; shift 2 ;;
    --name)            NAME="${2:?--name braucht einen Namen}"; shift 2 ;;
    --images-dir)      IMAGES_DIR="${2:?}"; shift 2 ;;
    --training-folder) TRAINING_FOLDER="${2:?}"; shift 2 ;;
    --base-model)      BASE_MODEL="${2:?}"; shift 2 ;;
    --python)          PYTHON="${2:?}"; shift 2 ;;
    --disable-sampling) DISABLE_SAMPLING=1; shift ;;
    --extra-arg)       EXTRA_ARGS+=("${2:?}"); shift 2 ;;
    --print)           PRINT_ONLY=1; shift ;;
    -h|--help)         usage; exit 0 ;;
    *) echo "FEHLER: unbekannte Option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

log() { printf '[trainer-aitk] %s\n' "$*"; }
die() { printf '[trainer-aitk] FEHLER: %s\n' "$*" >&2; exit "${EXIT_CODE:-2}"; }

# --- Abschnittsangaben aus der Env (von bootstrap.sh gesetzt) ----------------
# Ende = ABSOLUTER Zielschritt; Vorrang hat das Abschnittsende.
TARGET_STEPS="${LORA_SEGMENT_END:-${LORA_MAX_STEPS:-}}"
SEGMENT_START="${LORA_SEGMENT_START:-0}"
SAVE_EVERY="${LORA_SAVE_EVERY_STEPS:-}"
RESUME_FILE="${LORA_RESUME_FROM:-}"
CKPT_DIR="${LORA_CHECKPOINT_DIR:-}"

# --- Pflichtangaben sammeln (keine Defaults, die falsch sein koennten) -------
MISSING=()
[ -n "$AIDIR" ]           || MISSING+=("--aidir (Trainer-Checkout mit run.py)")
[ -n "$CONFIG" ]          || MISSING+=("--config (Basis-Konfiguration, z. B. cosmic-r16.yml)")
[ -n "$NAME" ]            || MISSING+=("--name (LoRA-Name; bestimmt Checkpoint-Dateinamen)")
[ -n "$TARGET_STEPS" ]    || MISSING+=("Zielschritt: LORA_SEGMENT_END oder LORA_MAX_STEPS (Abschnittsende, absolut)")
[ -n "$TRAINING_FOLDER" ] || MISSING+=("--training-folder (LORA_OUTPUT_DIR; hier landen die Checkpoints)")
[ -n "$IMAGES_DIR" ]      || MISSING+=("--images-dir (LORA_DATASET_DIR; Bilder+Captions)")
if [ "${#MISSING[@]}" -gt 0 ]; then
  echo "[trainer-aitk] FEHLER: es fehlen Angaben:" >&2
  for entry in "${MISSING[@]}"; do echo "  - $entry" >&2; done
  exit 2
fi

[ -f "$AIDIR/run.py" ] || die "kein run.py unter $AIDIR – falscher Trainer-Checkout? (der erste Lauf riet '/app' und verbrannte 90 min)"
[ -f "$CONFIG" ]       || die "Basis-Konfiguration fehlt: $CONFIG"
[ -d "$IMAGES_DIR" ]   || die "Bilderordner fehlt: $IMAGES_DIR"
[ -f "$HELPER" ]       || die "Helfer fehlt: $HELPER (muss neben diesem Skript liegen)"
case "$TARGET_STEPS" in ''|*[!0-9]*) die "Zielschritt ist keine Zahl: $TARGET_STEPS" ;; esac

# --- 1) Konfiguration patchen -----------------------------------------------
PATCHED="$TRAINING_FOLDER/segment-config.yml"
mkdir -p "$TRAINING_FOLDER" || die "Trainingsordner nicht anlegbar: $TRAINING_FOLDER"
ARGS=(patch --config "$CONFIG" --out "$PATCHED" --name "$NAME" --steps "$TARGET_STEPS"
      --images-dir "$IMAGES_DIR" --training-folder "$TRAINING_FOLDER")
[ -n "$SAVE_EVERY" ] && ARGS+=(--save-every "$SAVE_EVERY")
[ -n "$BASE_MODEL" ] && ARGS+=(--base-model "$BASE_MODEL")
[ "$DISABLE_SAMPLING" = "1" ] && ARGS+=(--disable-sampling)
"$PYTHON" "$HELPER" "${ARGS[@]}" || die "Konfiguration konnte nicht gepatcht werden"

log "Abschnitt ${LORA_SEGMENT_INDEX:-?}: Schritte ${SEGMENT_START}-${TARGET_STEPS} (Ziel absolut), save_every ${SAVE_EVERY:-<Konfiguration>}"
log "Resume: ${RESUME_FILE:-<frischer Lauf>}"

# --- 2) Resume-Checkpoint an die Stelle legen, an der ai-toolkit sucht ------
if [ -n "$RESUME_FILE" ]; then
  "$PYTHON" "$HELPER" place-resume --file "$RESUME_FILE" --training-folder "$TRAINING_FOLDER" \
      --name "$NAME" --expect-start "$SEGMENT_START" \
    || die "Resume-Checkpoint passt nicht zum Abschnitt (Exit oben) – Abbruch VOR dem Training"
fi

# --- 3) Trainer starten ------------------------------------------------------
CMD=("$PYTHON" run.py "segment-config.yml")
if [ "${#EXTRA_ARGS[@]}" -gt 0 ]; then CMD+=("${EXTRA_ARGS[@]}"); fi
log "starte: (cd $AIDIR && ${CMD[*]})"

if [ "$PRINT_ONLY" = "1" ]; then
  log "GEPATCHTE KONFIGURATION ($PATCHED):"
  sed 's/^/    /' "$PATCHED"
  log "TROCKENLAUF: nichts gestartet."
  exit 0
fi

TRAIN_RC=0
if ! ( cd "$AIDIR" && "${CMD[@]}" ); then
  TRAIN_RC=$?
  log "Trainer endete mit Exit $TRAIN_RC – Checkpoints werden trotzdem gesammelt (sie koennen gueltig sein)"
fi

# --- 4) Checkpoint flach einsammeln (Vertrag von bootstrap.sh) --------------
if [ -n "$CKPT_DIR" ]; then
  if "$PYTHON" "$HELPER" collect --training-folder "$TRAINING_FOLDER" --name "$NAME" \
        --into "$CKPT_DIR" --min-step "$SEGMENT_START"; then
    log "Checkpoint liegt jetzt in $CKPT_DIR (bootstrap.sh laedt ihn hoch)"
  else
    log "WARNUNG: kein Checkpoint eingesammelt (Schritt >= $SEGMENT_START)"
    [ "$TRAIN_RC" = "0" ] && TRAIN_RC=5
  fi
else
  log "WARNUNG: LORA_CHECKPOINT_DIR nicht gesetzt – Checkpoint bleibt in $TRAINING_FOLDER/$NAME"
fi

exit "$TRAIN_RC"
