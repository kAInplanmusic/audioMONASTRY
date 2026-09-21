#!/usr/bin/env bash
# ============================================================================
# audioMONASTRY · Knoten-Seite des parallelen Transfers (r2-node-fetch.sh)
# ============================================================================
# LAEUFT AUF DEM KNOTEN. Bekommt KEINE R2-Zugangsschluessel - nur eine
# presignierte, kurzlebige GET-URL. Die Parameter stehen in einer 0600-Datei
# (TRANSFER_ENV_FILE), die der Betreiber-Host per stdin geschrieben hat und die
# dieses Skript am Ende LOESCHT (trap, auch im Fehlerfall: die URL ist ein
# Bearer-Token).
#
# Ablauf (die Reihenfolge ist der Vertrag):
#   1. Voraussetzungen pruefen (aria2c? zstd? curl? Platz?) - laut melden.
#   2. Ziehen: `aria2c -x16 -s16` (16 Verbindungen) oder - als Rueckfall -
#      `curl -fL`. Die Methode steht in der Ausgabe.
#   3. SHA256 des Archivs PRUEFEN. Bei Abweichung: Archiv entfernen, NICHTS
#      auspacken, Exit 3 - ein halb ausgepacktes Medienverzeichnis sieht im
#      Container wie ein funktionierendes Feature aus.
#   4. Auspacken nach DEST, Dateizahlen/Byte vergleichen (Exit 4 bei
#      Abweichung), Rate + Dauer der beiden Phasen ausgeben.
#
# Parameter (Reihenfolge: Umgebungsvariable -> Parameterdatei -> Default):
#   GEHEIM, nur in der Parameterdatei (0600):
#     URL=<presignierte GET-URL>   SHA256=<hex>
#   UNKRITISCH, als Umgebungswert auf der Kommandozeile (Datei als Rueckfall):
#     LABEL=<name>  ARCHIVE=<datei auf dem knoten>  DEST=<zielverzeichnis>
#     COUNT_DIR=<verzeichnis fuer die dateizahl>  FILES=<erwartete dateizahl>
#     BYTES=<archivgroesse>  KEEP_ARCHIVE=0|1  INSTALL_MISSING=0|1
#     ARIA2_CONNECTIONS=16
#
# Lokal nachweisbar (tests/test_hetzner_scripts.py faehrt dieses Skript mit
# einem Fake-ssh LOKAL gegen eine lokale HTTP-Quelle).
# ============================================================================
set -euo pipefail

# Zahlformatierung fest auf Punkt (siehe parallel-transfer.sh): die Zeilen
# TRANSFER_RATE_MBPS/TRANSFER_SECONDS werden von der Betreiber-Seite gelesen.
export LC_ALL=C

ENV_FILE="${TRANSFER_ENV_FILE:-}"
if [[ -z "$ENV_FILE" || ! -f "$ENV_FILE" ]]; then
  echo "FEHLER: TRANSFER_ENV_FILE fehlt oder ist nicht lesbar: '${ENV_FILE:-<leer>}'" >&2
  exit 2
fi

# Parameter lesen - kein `source`: die Datei enthaelt eine URL mit & und =.
_env() {
  local key="$1" line
  line="$(grep -m1 -E "^${key}=" "$ENV_FILE" 2>/dev/null || true)"
  printf '%s' "${line#*=}"
}

# Reihenfolge: Umgebungswert (kommt bei echten Laeufen in der ssh-Kommandozeile
# mit) -> Parameterdatei -> Default. Die DATEI traegt nur die zwei geheimen
# Werte; alles andere steht bewusst sichtbar in der Kommandozeile.
_param() {
  local key="$1" def="${2:-}" value="${!1:-}"
  [[ -n "$value" ]] || value="$(_env "$key")"
  [[ -n "$value" ]] || value="$def"
  printf '%s' "$value"
}

URL="$(_env URL)"          # geheim: nur in der Datei (nie in argv/`ps`)
SHA256="$(_env SHA256)"    # Archiv-Hash, kein Geheimnis
ARCHIVE="$(_param ARCHIVE)"
DEST="$(_param DEST)"
COUNT_DIR="$(_param COUNT_DIR "$DEST")"
LABEL="$(_param LABEL "$(basename "${ARCHIVE:-archiv}")")"
FILES="$(_param FILES 0)"
BYTES="$(_param BYTES 0)"
KEEP_ARCHIVE="$(_param KEEP_ARCHIVE 0)"
INSTALL_MISSING="$(_param INSTALL_MISSING 0)"
ARIA2_CONNECTIONS="$(_param ARIA2_CONNECTIONS 16)"

# Die URL lebt nur in dieser Variablen - Datei sofort weg (auch bei Abbruch).
trap 'rm -f "$ENV_FILE"' EXIT

for pflicht in URL SHA256 DEST ARCHIVE; do
  if [[ -z "${!pflicht:-}" ]]; then
    echo "FEHLER: Parameter $pflicht fehlt in der Parameterdatei" >&2
    exit 2
  fi
done

mkdir -p "$(dirname "$ARCHIVE")" "$DEST"

# --- 1. Voraussetzungen ------------------------------------------------------
ARIA2="$(command -v aria2c || true)"
CURL="$(command -v curl || true)"
if [[ -z "$ARIA2" && "$INSTALL_MISSING" == "1" ]]; then
  echo "[node] aria2c fehlt - installiere (apt: aria2 zstd, ausdruecklich angefordert)"
  DEBIAN_FRONTEND=noninteractive apt-get update -qq || true
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends aria2 zstd || true
  ARIA2="$(command -v aria2c || true)"
fi
if [[ -n "$ARIA2" ]]; then
  METHOD="aria2c -x${ARIA2_CONNECTIONS} -s${ARIA2_CONNECTIONS}"
else
  METHOD="curl (Einzelstrom)"
  echo "[node] HINWEIS: aria2c fehlt - es wird EINZELSTROM gezogen (kein 16-fach-Split)." >&2
  echo "[node] Nachinstallieren auf dem Knoten: apt-get install -y --no-install-recommends aria2 zstd" >&2
  echo "[node] oder diesen Lauf mit --install-missing starten." >&2
  [[ -n "$CURL" ]] || { echo "FEHLER: weder aria2c noch curl vorhanden - apt-get install -y aria2 zstd curl" >&2; exit 6; }
fi

# Platz: Archiv + entpackte Fassung (+ Reserve) muessen in das Ziel-Dateisystem
# passen, sonst bricht das Auspacken mitten im Medienbaum ab.
if [[ "${BYTES:-0}" -gt 0 ]]; then
  AVAIL_KIB="$(df -Pk "$(dirname "$ARCHIVE")" | awk 'NR==2 {print $4}')"
  NEED_KIB="$(( BYTES / 1024 * 24 / 10 + 65536 ))"
  if [[ "${AVAIL_KIB:-0}" -lt "$NEED_KIB" ]]; then
    echo "FEHLER: zu wenig Platz unter $(dirname "$ARCHIVE"): ${AVAIL_KIB} KiB frei, ~${NEED_KIB} KiB noetig (Archiv + entpackt)" >&2
    exit 7
  fi
fi

echo "[node] $LABEL - $METHOD -> $DEST"

# --- 2. Ziehen ---------------------------------------------------------------
START="$(date +%s.%N)"
if [[ -n "$ARIA2" ]]; then
  # -x/-s = Verbindungen je Server / Splits (der Kern dieses Skripts), -k1M =
  # Mindest-Splitgroesse, -j1 = eine Datei. R2 beantwortet Range-Requests;
  # fehlt das, faellt aria2c von selbst auf eine Verbindung zurueck.
  "$ARIA2" -x"$ARIA2_CONNECTIONS" -s"$ARIA2_CONNECTIONS" -k1M -j1 \
    --file-allocation=none --allow-overwrite=true --auto-file-renaming=false \
    --max-tries=3 --retry-wait=2 --connect-timeout=20 --timeout=60 \
    --console-log-level=warn --summary-interval=5 \
    -d "$(dirname "$ARCHIVE")" -o "$(basename "$ARCHIVE")" "$URL"
else
  "$CURL" -fL --retry 3 --retry-delay 2 --progress-bar -o "$ARCHIVE.part" "$URL"
  mv "$ARCHIVE.part" "$ARCHIVE"
fi
END="$(date +%s.%N)"
SECONDS_DL="$(awk -v a="$START" -v b="$END" 'BEGIN { printf "%.3f", b - a }')"
SIZE="$(wc -c < "$ARCHIVE" | tr -d ' ')"
RATE="$(awk -v b="$SIZE" -v s="$SECONDS_DL" 'BEGIN { if (s > 0) printf "%.2f", b / s / 1048576; else print "0.00" }')"
echo "[node] gezogen: $SIZE Bytes in ${SECONDS_DL}s -> ${RATE} MB/s ($METHOD)"

# --- 3. Integritaet VOR dem Auspacken ---------------------------------------
ACTUAL="$(sha256sum "$ARCHIVE" | awk '{print $1}')"
if [[ "${ACTUAL,,}" != "${SHA256,,}" ]]; then
  echo "TRANSFER_SHA256_OK=0"
  echo "TRANSFER_METHOD=$METHOD"
  echo "TRANSFER_BYTES=$SIZE"
  echo "TRANSFER_SECONDS=$SECONDS_DL"
  echo "TRANSFER_RATE_MBPS=$RATE"
  echo "FEHLER: SHA256 stimmt nicht - erwartet $SHA256, gemessen $ACTUAL" >&2
  echo "FEHLER: das Archiv wird NICHT ausgepackt (kein halber Medienbaum)." >&2
  rm -f "$ARCHIVE"
  echo "TRANSFER_RESULT=sha256-mismatch"
  exit 3
fi
echo "TRANSFER_SHA256_OK=1"
echo "[node] SHA256 geprueft: ${ACTUAL}"

# --- 4. Auspacken ------------------------------------------------------------
ZSTD="$(command -v zstd || true)"
if [[ -z "$ZSTD" ]] && ! tar --zstd -tf "$ARCHIVE" >/dev/null 2>&1; then
  echo "FEHLER: weder zstd noch 'tar --zstd' vorhanden - apt-get install -y zstd" >&2
  exit 5
fi
EXTRACT_START="$(date +%s.%N)"
if [[ -n "$ZSTD" ]]; then
  "$ZSTD" -d -c "$ARCHIVE" | tar -xf - -C "$DEST" --no-same-owner
else
  tar --zstd -xf "$ARCHIVE" -C "$DEST" --no-same-owner
fi
EXTRACT_END="$(date +%s.%N)"
EXTRACT_SECONDS="$(awk -v a="$EXTRACT_START" -v b="$EXTRACT_END" 'BEGIN { printf "%.3f", b - a }')"
[[ "$KEEP_ARCHIVE" == "1" ]] || rm -f "$ARCHIVE"

GOT_FILES=0
GOT_BYTES=0
if [[ -d "$COUNT_DIR" ]]; then
  GOT_FILES="$(find "$COUNT_DIR" -type f 2>/dev/null | wc -l | tr -d ' ')"
  GOT_BYTES="$(du -sb "$COUNT_DIR" 2>/dev/null | cut -f1)"
  GOT_BYTES="${GOT_BYTES:-0}"
fi

echo "TRANSFER_METHOD=$METHOD"
echo "TRANSFER_BYTES=$SIZE"
echo "TRANSFER_SECONDS=$SECONDS_DL"
echo "TRANSFER_RATE_MBPS=$RATE"
echo "TRANSFER_EXTRACT_SECONDS=$EXTRACT_SECONDS"
echo "TRANSFER_FILES=$GOT_FILES"
echo "[node] entpackt in ${EXTRACT_SECONDS}s; $COUNT_DIR: $GOT_FILES Dateien, $GOT_BYTES Bytes"

if [[ "${FILES:-0}" -gt 0 && "${FILES:-0}" -ne "$GOT_FILES" ]]; then
  echo "FEHLER: Dateizahl stimmt nicht - gepackt $FILES, auf dem Knoten $GOT_FILES in $COUNT_DIR" >&2
  echo "TRANSFER_RESULT=file-count-mismatch"
  exit 4
fi
echo "TRANSFER_RESULT=ok"
