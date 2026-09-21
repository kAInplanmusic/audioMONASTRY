#!/usr/bin/env bash
# =============================================================================
# audioMONASTRY · VISUAL-P1-007 – VORSTAGING eines RunPod-NETWORK-VOLUMES
# =============================================================================
# WARUM: Im Abschnittsbetrieb („1000, dann wieder 1000, …") startet alle paar
# Stunden ein neuer Pod. Ohne Volumen zahlt JEDER Abschnitt den Kaltstart neu:
# Container-Image-Pull 15-25 min (gemessen 2026-09-11) plus Download der
# Basisgewichte (~24 GB). Das ist der teure Teil, nicht der Datensatz
# (54 MB aus R2 ≈ Sekunden). Ein Network Volume (0,05 USD/GB/Monat, an EIN
# Rechenzentrum gebunden) hält Gewichte, Datensatz und Trainer-Checkout
# dauerhaft: der Start eines Abschnitts sinkt auf wenige Minuten.
#
# DIESES SKRIPT FÜLLT DAS VOLUMEN EINMALIG – auf einem CPU-Pod, NICHT auf einer
# GPU. Ein CPU-Pod kostet einen Bruchteil; das Herunterladen braucht keine GPU.
# Der Betreiber startet diesen Pod (dieses Repo legt keinen Pod an und gibt kein
# Geld aus) und lässt darin genau ein Kommando laufen.
#
# Idempotenz: jeder Schritt prüft ERST, ob sein Ergebnis schon (vollständig) auf
# dem Volumen liegt, und wird sonst übersprungen. Der Nachweis steht als Zeile
# im Log UND als Marker unter $VORSTAGE_DIR/*.json auf dem Volumen:
#
#     [vorstaging] uebersprungen: Gewichte (24.1 GB im Volume, Marker …)
#
# Aufruf im CPU-Pod (Volume ist nach $LORA_VOLUME gemountet):
#     bash /workspace/lora/vorstaging.sh --volume /workspace \
#          --model black-forest-labs/FLUX.1-dev \
#          --dataset-url "$LORA_DATASET_URL" --dataset-key lora/dataset.tar.gz \
#          --ai-toolkit-repo https://github.com/ostris/ai-toolkit
#
# Ohne Netz prüfbar: `--dry-run` sagt nur, was getan WÜRDE (kein Download, kein
# Klon). `--json` gibt den Bericht maschinenlesbar aus.
#
# Exit-Codes: 0 = Volumen ist vorstaged (auch wenn alles übersprungen wurde) ·
#             2 = Aufruf-/Konfigurationsfehler · 3 = ein Schritt ist
#             fehlgeschlagen · 4 = Volumen nicht schreibbar / zu wenig Platz
#
# EHRLICHKEIT: Tokens (HF_TOKEN für gated Gewichte, presigned Dataset-URLs)
# werden NIE ausgegeben und NICHT in die Marker geschrieben – eine presigned URL
# ist ein Bearer-Token. Die Wiedererkennung des Datensatzes läuft über
# --dataset-key (stabile Kennung), nicht über die signierte URL.
# =============================================================================
set -u -o pipefail

LORA_VOLUME="${LORA_VOLUME:-/workspace}"
MODEL="${LORA_BASE_MODEL:-}"
DATASET_URL="${LORA_DATASET_URL:-}"
DATASET_KEY="${LORA_DATASET_KEY:-}"
AI_TOOLKIT_REPO="${LORA_AI_TOOLKIT_REPO:-https://github.com/ostris/ai-toolkit}"
AI_TOOLKIT_DIR=""
WEIGHTS_DIR=""
DATASET_DIR=""
HF_CMD="${LORA_HF_DOWNLOAD_CMD:-huggingface-cli download}"
MIN_FREE_GB="${LORA_VORSTAGE_MIN_FREE_GB:-40}"
DRY_RUN=0
JSON_OUT=0
SKIP_WEIGHTS=0
SKIP_DATASET=0
SKIP_TOOLKIT=0

usage() {
  sed -n '2,50p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --volume)        LORA_VOLUME="${2:?--volume braucht einen Pfad}"; shift 2 ;;
    --model)         MODEL="${2:?--model braucht eine HF-Kennung}"; shift 2 ;;
    --dataset-url)   DATASET_URL="${2:?}"; shift 2 ;;
    --dataset-key)   DATASET_KEY="${2:?}"; shift 2 ;;
    --ai-toolkit-repo) AI_TOOLKIT_REPO="${2:?}"; shift 2 ;;
    --weights-dir)   WEIGHTS_DIR="${2:?}"; shift 2 ;;
    --dataset-dir)   DATASET_DIR="${2:?}"; shift 2 ;;
    --ai-toolkit-dir) AI_TOOLKIT_DIR="${2:?}"; shift 2 ;;
    --hf-command)    HF_CMD="${2:?}"; shift 2 ;;
    --min-free-gb)   MIN_FREE_GB="${2:?}"; shift 2 ;;
    --skip-weights)  SKIP_WEIGHTS=1; shift ;;
    --skip-dataset)  SKIP_DATASET=1; shift ;;
    --skip-toolkit)  SKIP_TOOLKIT=1; shift ;;
    --dry-run)       DRY_RUN=1; shift ;;
    --json)          JSON_OUT=1; shift ;;
    -h|--help)       usage; exit 0 ;;
    *) echo "FEHLER: unbekannte Option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

VORSTAGE_DIR="$LORA_VOLUME/vorstaging"
[ -n "$WEIGHTS_DIR" ] || WEIGHTS_DIR="$LORA_VOLUME/hf-cache"
[ -n "$DATASET_DIR" ] || DATASET_DIR="$LORA_VOLUME/lora-dataset"
[ -n "$AI_TOOLKIT_DIR" ] || AI_TOOLKIT_DIR="$LORA_VOLUME/ai-toolkit"

log()  { printf '[vorstaging] %s\n' "$*"; }
warn() { printf '[vorstaging] WARNUNG: %s\n' "$*" >&2; }
die()  { printf '[vorstaging] FEHLER: %s\n' "$*" >&2; exit "${EXIT_CODE:-2}"; }

# --- Vorbedingungen: Volumen da, schreibbar, genug Platz --------------------
if [ ! -d "$LORA_VOLUME" ]; then
  die "Volumen-Pfad $LORA_VOLUME existiert nicht – ist das Network Volume gemountet?"
fi
if ! mkdir -p "$VORSTAGE_DIR" 2>/dev/null || ! : > "$VORSTAGE_DIR/.write-test" 2>/dev/null; then
  EXIT_CODE=4 die "Volumen $LORA_VOLUME ist nicht schreibbar (Marker/Report koennen nicht abgelegt werden)"
fi
rm -f "$VORSTAGE_DIR/.write-test"

free_gb() {
  # Freier Platz in GB auf dem Volumen (leer, wenn nicht messbar)
  df -Pk "$LORA_VOLUME" 2>/dev/null | awk 'NR==2 {printf "%d", $4/1024/1024}'
}
FREE_GB="$(free_gb)"
if [ -n "$FREE_GB" ] && [ "$FREE_GB" -lt "$MIN_FREE_GB" ]; then
  EXIT_CODE=4 die "nur ${FREE_GB} GB frei auf $LORA_VOLUME, gebraucht werden ~${MIN_FREE_GB} GB (Gewichte ~24 GB + Datensatz + Checkpoints). Volumengroesse erhoehen (runpodctl network-volume create --size <GB>) oder aufraeumen."
fi

if [ -z "$MODEL" ] && [ "$SKIP_WEIGHTS" = "0" ] && [ "$DRY_RUN" = "1" ]; then
  warn "--model fehlt: der Gewichts-Schritt kann nicht geprueft werden (nur im Trockenlauf erlaubt)"
fi

REPORT="$VORSTAGE_DIR/report.json"
MARKER_WEIGHTS="$VORSTAGE_DIR/weights.json"
MARKER_DATASET="$VORSTAGE_DIR/dataset.json"
MARKER_TOOLKIT="$VORSTAGE_DIR/ai-toolkit.json"
STEPS_LOG="$VORSTAGE_DIR/steps.jsonl"

record() {
  # $1 = Schritt, $2 = Aktion (skipped|downloaded|adopted|planned|failed), $3 = Detail
  printf '{"ts":"%s","step":"%s","action":"%s","detail":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" "${3//\"/\'}" | tee -a "$STEPS_LOG" >/dev/null
}

json_field() {
  # $1 = Datei, $2 = Feldname -> Wert (leer, wenn Datei/Feld fehlt)
  [ -f "$1" ] || return 0
  python3 - "$1" "$2" <<'PY' 2>/dev/null || true
import json, sys
try:
    data = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    sys.exit(0)
value = data.get(sys.argv[2])
print("" if value is None else value)
PY
}

bytes_of_dir() {
  [ -d "$1" ] || { printf '0'; return; }
  du -sb "$1" 2>/dev/null | cut -f1
}

model_slug() { printf 'models--%s' "$(printf '%s' "$1" | tr '/' '-')"; }

steps=()
FAILED=0

# --- Schritt 1: Basisgewichte (per hf_transfer, ins HF_HOME des Volumens) ----
if [ "$SKIP_WEIGHTS" = "1" ]; then
  log "Gewichte: ausdruecklich uebersprungen (--skip-weights)"
else
  HUB_DIR="$WEIGHTS_DIR/hub/$(model_slug "${MODEL:-<kein-model>}")"
  MARKER_BYTES="$(json_field "$MARKER_WEIGHTS" bytes)"
  CURRENT_BYTES="$(bytes_of_dir "$HUB_DIR")"
  SKIP=0
  REASON=""
  if [ -z "$MODEL" ]; then
    REASON="kein --model angegeben"
  elif [ ! -f "$MARKER_WEIGHTS" ]; then
    REASON="kein Marker auf dem Volumen"
  elif [ -z "$MARKER_BYTES" ]; then
    REASON="Marker ohne Groesse (unvollstaendig)"
  elif [ "$(json_field "$MARKER_WEIGHTS" model)" != "$MODEL" ]; then
    REASON="Marker gehoert zu einem anderen Modell ($(json_field "$MARKER_WEIGHTS" model))"
  elif [ ! -d "$HUB_DIR" ]; then
    REASON="Modell-Verzeichnis fehlt: $HUB_DIR"
  elif [ "${CURRENT_BYTES:-0}" -lt $(( MARKER_BYTES * 90 / 100 )) ]; then
    REASON="nur ${CURRENT_BYTES} von ${MARKER_BYTES} Bytes vorhanden (<90 %) – gilt als unvollstaendig"
  else
    SKIP=1
  fi

  if [ "$SKIP" = "1" ]; then
    log "uebersprungen: Gewichte ($MODEL liegt mit ${CURRENT_BYTES} Bytes in $WEIGHTS_DIR, Marker von $(json_field "$MARKER_WEIGHTS" ts))"
    record "weights" "skipped" "$MODEL ${CURRENT_BYTES} Bytes"
    steps+=("weights: skipped")
  elif [ "$DRY_RUN" = "1" ]; then
    log "wuerde laden: Gewichte $MODEL nach $WEIGHTS_DIR (Grund: $REASON) – ~24 GB, braucht Netz"
    record "weights" "planned" "$REASON"
    steps+=("weights: planned")
  else
    log "lade Gewichte: $MODEL nach $WEIGHTS_DIR (Grund: $REASON)"
    mkdir -p "$WEIGHTS_DIR" || die "HF_HOME nicht anlegbar: $WEIGHTS_DIR"
    # hf_transfer ist der schnelle Rust-Downloader; ohne ihn laedt huggingface-cli
    # langsamer, aber korrekt. Der Schalter wird als Env gesetzt, nicht geraten.
    read -r -a HF_ARGS <<< "$HF_CMD"
    if HF_HOME="$WEIGHTS_DIR" HF_HUB_ENABLE_HF_TRANSFER="${HF_HUB_ENABLE_HF_TRANSFER:-1}" \
       "${HF_ARGS[@]}" "$MODEL" ; then
      NEW_BYTES="$(bytes_of_dir "$HUB_DIR")"
      if [ "${NEW_BYTES:-0}" -lt 1000000 ]; then
        record "weights" "failed" "nach dem Download nur ${NEW_BYTES} Bytes"
        FAILED=1
        EXIT_CODE=3 die "Gewichte-Download lieferte nur ${NEW_BYTES} Bytes – Volumen/Token pruefen (HF_TOKEN fuer gated Modelle)"
      fi
      python3 - "$MARKER_WEIGHTS" "$MODEL" "$HUB_DIR" "$NEW_BYTES" <<'PY'
import json, sys
path, model, hub, size = sys.argv[1:5]
from datetime import datetime, timezone
json.dump({"schema": "visual-lora-vorstaging/1", "step": "weights", "model": model,
           "hub_dir": hub, "bytes": int(size), "hf_transfer": True,
           "ts": datetime.now(timezone.utc).isoformat()},
          open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PY
      log "Gewichte bereit: $NEW_BYTES Bytes in $HUB_DIR (Marker: $MARKER_WEIGHTS)"
      record "weights" "downloaded" "$MODEL $NEW_BYTES Bytes"
      steps+=("weights: downloaded")
    else
      record "weights" "failed" "$MODEL"
      FAILED=1
      EXIT_CODE=3 die "Gewichte-Download fehlgeschlagen: $MODEL (HF_TOKEN gesetzt? gated Modell?)"
    fi
  fi
fi

# --- Schritt 2: Datensatz ----------------------------------------------------
if [ "$SKIP_DATASET" = "1" ]; then
  log "Datensatz: ausdruecklich uebersprungen (--skip-dataset)"
else
  MARKER_KEY="$(json_field "$MARKER_DATASET" key)"
  MARKER_COUNT="$(json_field "$MARKER_DATASET" image_count)"
  ACTUAL_COUNT="$(find "$DATASET_DIR" -type f \( -name '*.png' -o -name '*.jpg' -o -name '*.jpeg' -o -name '*.webp' \) 2>/dev/null | wc -l | tr -d ' ')"
  SKIP=0
  REASON=""
  if [ ! -f "$MARKER_DATASET" ]; then
    REASON="kein Marker auf dem Volumen"
  elif [ -z "$MARKER_COUNT" ] || [ "$MARKER_COUNT" -le 0 ]; then
    REASON="Marker meldet 0 Bilder"
  elif [ ! -d "$DATASET_DIR" ] || [ "$ACTUAL_COUNT" -le 0 ]; then
    REASON="keine Bilder unter $DATASET_DIR"
  elif [ -n "$DATASET_KEY" ] && [ "$MARKER_KEY" != "$DATASET_KEY" ]; then
    REASON="Marker gehoert zu einem anderen Datensatz (key=$MARKER_KEY)"
  else
    SKIP=1
  fi

  if [ "$SKIP" = "1" ]; then
    log "uebersprungen: Datensatz (${ACTUAL_COUNT} Bilder in $DATASET_DIR, Marker von $(json_field "$MARKER_DATASET" ts)${DATASET_KEY:+, key=$DATASET_KEY})"
    record "dataset" "skipped" "$ACTUAL_COUNT Bilder"
    steps+=("dataset: skipped")
  elif [ -z "$DATASET_URL" ]; then
    log "weder Datensatz noch URL: $DATASET_DIR bleibt leer (Grund: $REASON) – spaeter mit --dataset-url nachholen"
    record "dataset" "planned" "$REASON"
    steps+=("dataset: offen")
  elif [ "$DRY_RUN" = "1" ]; then
    log "wuerde laden: Datensatz von der uebergebenen URL nach $DATASET_DIR (Grund: $REASON)"
    record "dataset" "planned" "$REASON"
    steps+=("dataset: planned")
  else
    log "lade Datensatz nach $DATASET_DIR (Grund: $REASON)"
    mkdir -p "$DATASET_DIR" || die "Datensatz-Verzeichnis nicht anlegbar: $DATASET_DIR"
    ARCHIVE="$VORSTAGE_DIR/dataset.download"
    if ! curl -fsSL --retry 3 --retry-delay 5 -o "$ARCHIVE" "$DATASET_URL"; then
      record "dataset" "failed" "Download fehlgeschlagen"
      FAILED=1
      EXIT_CODE=3 die "Datensatz-Download fehlgeschlagen (URL wird aus Sicherheitsgruenden nicht ausgegeben)"
    fi
    case "$DATASET_URL" in
      *.tar.gz|*.tgz) tar -xzf "$ARCHIVE" -C "$DATASET_DIR" || die "Entpacken fehlgeschlagen (tar.gz)" ;;
      *.zip)          unzip -o -q "$ARCHIVE" -d "$DATASET_DIR" || die "Entpacken fehlgeschlagen (zip)" ;;
      *.tar)          tar -xf "$ARCHIVE" -C "$DATASET_DIR" || die "Entpacken fehlgeschlagen (tar)" ;;
      *)              mv "$ARCHIVE" "$DATASET_DIR/dataset.tar.gz" ;;
    esac
    rm -f "$ARCHIVE"
    NEW_COUNT="$(find "$DATASET_DIR" -type f \( -name '*.png' -o -name '*.jpg' -o -name '*.jpeg' -o -name '*.webp' \) 2>/dev/null | wc -l | tr -d ' ')"
    if [ "${NEW_COUNT:-0}" -le 0 ]; then
      record "dataset" "failed" "0 Bilder nach dem Entpacken"
      FAILED=1
      EXIT_CODE=3 die "Datensatz enthaelt keine Bilder ($DATASET_DIR) – falsches Archiv?"
    fi
    python3 - "$MARKER_DATASET" "$DATASET_DIR" "$NEW_COUNT" "$DATASET_KEY" <<'PY'
import json, sys
path, directory, count, key = sys.argv[1:5]
from datetime import datetime, timezone
# Die URL wird bewusst NICHT abgelegt (presigned URL = Bearer-Token).
json.dump({"schema": "visual-lora-vorstaging/1", "step": "dataset", "dir": directory,
           "key": key or None, "image_count": int(count),
           "ts": datetime.now(timezone.utc).isoformat()},
          open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PY
    log "Datensatz bereit: $NEW_COUNT Bilder in $DATASET_DIR (Marker: $MARKER_DATASET)"
    record "dataset" "downloaded" "$NEW_COUNT Bilder"
    steps+=("dataset: downloaded")
  fi
fi

# --- Schritt 3: Trainer-Checkout (ai-toolkit) --------------------------------
if [ "$SKIP_TOOLKIT" = "1" ]; then
  log "Trainer-Checkout: ausdruecklich uebersprungen (--skip-toolkit)"
elif [ -d "$AI_TOOLKIT_DIR/.git" ]; then
  HEAD_REV="$(git -C "$AI_TOOLKIT_DIR" rev-parse HEAD 2>/dev/null || echo "")"
  MARKER_REV="$(json_field "$MARKER_TOOLKIT" commit)"
  if [ -n "$HEAD_REV" ] && [ "$MARKER_REV" = "$HEAD_REV" ]; then
    log "uebersprungen: Trainer-Checkout ($AI_TOOLKIT_DIR auf Commit ${HEAD_REV:0:12}, Marker von $(json_field "$MARKER_TOOLKIT" ts))"
    record "toolkit" "skipped" "$HEAD_REV"
    steps+=("toolkit: skipped")
  else
    # Verzeichnis ist schon ein Repo (z. B. von Hand geklont): uebernehmen statt
    # loeschen – und den Zustand schriftlich festhalten.
    python3 - "$MARKER_TOOLKIT" "$AI_TOOLKIT_DIR" "$HEAD_REV" "$AI_TOOLKIT_REPO" <<'PY'
import json, sys
path, directory, commit, repo = sys.argv[1:5]
from datetime import datetime, timezone
json.dump({"schema": "visual-lora-vorstaging/1", "step": "ai-toolkit", "dir": directory,
           "repo": repo, "commit": commit or None, "adopted": True,
           "ts": datetime.now(timezone.utc).isoformat()},
          open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PY
    log "uebernommen: Trainer-Checkout $AI_TOOLKIT_DIR existiert (Commit ${HEAD_REV:0:12}) – Marker neu geschrieben"
    record "toolkit" "adopted" "$HEAD_REV"
    steps+=("toolkit: adopted")
  fi
elif [ "$DRY_RUN" = "1" ]; then
  log "wuerde klonen: $AI_TOOLKIT_REPO nach $AI_TOOLKIT_DIR"
  record "toolkit" "planned" "$AI_TOOLKIT_REPO"
  steps+=("toolkit: planned")
else
  log "klone Trainer: $AI_TOOLKIT_REPO nach $AI_TOOLKIT_DIR"
  if ! git clone --depth 1 "$AI_TOOLKIT_REPO" "$AI_TOOLKIT_DIR"; then
    record "toolkit" "failed" "Klon fehlgeschlagen"
    FAILED=1
    EXIT_CODE=3 die "Trainer-Checkout fehlgeschlagen: $AI_TOOLKIT_REPO"
  fi
  HEAD_REV="$(git -C "$AI_TOOLKIT_DIR" rev-parse HEAD 2>/dev/null || echo "")"
  python3 - "$MARKER_TOOLKIT" "$AI_TOOLKIT_DIR" "$HEAD_REV" "$AI_TOOLKIT_REPO" <<'PY'
import json, sys
path, directory, commit, repo = sys.argv[1:5]
from datetime import datetime, timezone
json.dump({"schema": "visual-lora-vorstaging/1", "step": "ai-toolkit", "dir": directory,
           "repo": repo, "commit": commit or None,
           "ts": datetime.now(timezone.utc).isoformat()},
          open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PY
  log "Trainer bereit: $AI_TOOLKIT_DIR (Commit ${HEAD_REV:0:12})"
  record "toolkit" "downloaded" "$HEAD_REV"
  steps+=("toolkit: downloaded")
fi

# --- Bericht ----------------------------------------------------------------
TOTAL_BYTES="$(( $(bytes_of_dir "$WEIGHTS_DIR") + $(bytes_of_dir "$DATASET_DIR") + $(bytes_of_dir "$AI_TOOLKIT_DIR") ))"
python3 - "$REPORT" "$LORA_VOLUME" "$WEIGHTS_DIR" "$DATASET_DIR" "$AI_TOOLKIT_DIR" "$TOTAL_BYTES" \
        "$DRY_RUN" "$FREE_GB" <<'PY'
import json, sys
from datetime import datetime, timezone
path, volume, weights, dataset, toolkit, total, dry, free = sys.argv[1:9]
json.dump({
    "schema": "visual-lora-vorstaging/1",
    "ts": datetime.now(timezone.utc).isoformat(),
    "volume": volume,
    "dry_run": dry == "1",
    "free_gb_before": int(free) if free else None,
    "paths": {"weights": weights, "dataset": dataset, "ai_toolkit": toolkit},
    "bytes_total": int(total),
    "note": "Idempotent: ein erneuter Lauf ueberspringt, was schon vollstaendig vorliegt. "
            "Marker je Schritt liegen neben diesem Bericht (*.json).",
}, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PY

log "Volumen $LORA_VOLUME: ${TOTAL_BYTES} Bytes vorstaged (Bericht: $REPORT)"
for entry in "${steps[@]}"; do
  log "  - $entry"
done
if [ "$DRY_RUN" = "1" ]; then
  log "TROCKENLAUF: nichts geladen, nichts geklont."
fi
if [ "$JSON_OUT" = "1" ] && [ -f "$REPORT" ]; then
  cat "$REPORT"
fi
if [ "$FAILED" = "1" ]; then
  exit 3
fi
exit 0
