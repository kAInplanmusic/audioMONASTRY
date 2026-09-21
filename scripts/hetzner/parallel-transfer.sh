#!/usr/bin/env bash
# ============================================================================
# parallel-transfer.sh – Baum/Image-Tar in Teilen zum Knoten (zstd + R2 + aria2c)
# ----------------------------------------------------------------------------
# WARUM (gemessen 2026-09-21): EIN TCP-Strom Betreiber -> Hetzner macht ~1 MB/s
# (200 MB in 3:14). 3,7 GB Medien dauern so ~60 min - pro Knoten, bei jeder
# Lieferung. Das riecht nach einem Limit PRO VERBINDUNG, nicht nach Serverlast.
# Dieser Weg nutzt zwei Hebel:
#   (a) MEHRERE Verbindungen: `aria2c -x16 -s16` zieht das Archiv mit 16
#       parallelen Range-Requests (R2/S3 beantwortet Range-Requests).
#   (b) ZWISCHENSPEICHER: Das Archiv liegt einmal in Cloudflare R2 (bereits
#       bezahlt; Egress kostenfrei) - jeder weitere Knoten zieht es mit
#       Knoten-Bandbreite, der Betreiber-Host schiebt es NICHT erneut hoch.
#
# Was dieses Skript tut:
#   1. Baum (oder vorhandenen Image-Tar) DETERMINISTISCH mit zstd packen
#      (tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner) -
#      gleicher Inhalt => gleicher SHA256 => gleicher Objekt-Schluessel =>
#      kein zweiter Upload.
#   2. In R2 legen (presigniertes PUT, SigV4 aus lib/r2-sigv4.sh). Existiert der
#      Schluessel schon, entfaellt der Upload (`--force-upload` erzwingt ihn).
#   3. Presignierte GET-URL erzeugen (TTL, Default 12 h). Der KNOTEN bekommt
#      NUR diese URL - nie CFS3_ACCESS_KEY/CFS3_SECRET_KEY. Sie reist per
#      stdin in eine 0600-Datei (nicht in argv/`ps`) und wird dort geloescht.
#   4. Knoten ziehen + PRUEFEN + auspacken: lib/r2-node-fetch.sh laeuft dort,
#      zieht mit `aria2c -x16 -s16` (Rueckfall: curl), prueft SHA256 VOR dem
#      Auspacken und meldet Rate + Dateizahlen.
#
# Aufruf:
#   bash scripts/hetzner/parallel-transfer.sh <ip> --src <verzeichnis> --dest <ziel>
#   bash scripts/hetzner/parallel-transfer.sh <ip> --tar <datei.tar> --dest <ziel>
#   bash scripts/hetzner/parallel-transfer.sh --src <verzeichnis> --pack-only
#   bash scripts/hetzner/parallel-transfer.sh <ip> --src <v> --dest <z> --print-config
#
# Optionen:
#   --print-config        Trockenlauf: Konfiguration zeigen, KEIN Netz, kein
#                         Schreiben (funktioniert auch OHNE R2-Schluessel)
#   --pack-only           nur lokal packen (kein Netz), Kennzahlen ausgeben und
#                         das Archiv behalten (Pfad: PARALLEL_TRANSFER_ARCHIVE)
#   --source-url <url>    KEIN R2: eine bereits vorhandene URL benutzen (verlangt
#                         --sha256; fuer Wiederholungen und Tests)
#   --sha256 <hex>        erwarteter Archiv-Hash (bei --source-url Pflicht)
#   --files <n>           erwartete Dateizahl (Kontrolle auf dem Knoten)
#   --bytes <n>           Archivgroesse in Bytes (Platzpruefung auf dem Knoten)
#   --name <label>        Objektname (Default: Verzeichnis-/Tar-Basisname)
#   --zstd-level <n>      zstd-Level (Default 6; hohes Level aendert den Hash)
#   --url-ttl <sekunden>  Gueltigkeit der GET-URL (Default 43200 = 12 h)
#   --keep-archive        lokales UND Knoten-Archiv behalten
#   --install-missing     fehlendes aria2c/zstd auf dem Knoten nachinstallieren
#   --force-upload        auch hochladen, wenn das Objekt schon in R2 liegt
#
# Voraussetzungen:
#   Betreiber-Host: bash, tar, zstd, openssl, curl, ssh  (aria2c NICHT noetig)
#   Knoten (Ubuntu): tar, sha256sum, curl ODER curl+aria2; fuer den Split-Weg
#                    `aria2c` und zum Auspacken `zstd`
#                    -> beide stehen seit 2026-09-21 in der PROVISIONIERUNG
#                       (scripts/hetzner/cloud-init.yaml: packages aria2 + zstd),
#                       sind auf einem frischen Knoten also bereits vorhanden.
#                       apt-Kommando nur noch fuer Knoten aus einem Rollen-
#                       SNAPSHOT (kein cloud-init beim Boot):
#                       apt-get install -y --no-install-recommends aria2 zstd
#                    (fehlen sie, faellt der Lauf laut auf EINEN Strom zurueck;
#                     mit --install-missing wird auf dem Knoten nachinstalliert)
#   R2: CFS3_ACCESS_KEY/CFS3_SECRET_KEY/CFS3_ENDPOINT/CFS3_BUCKET (+CFR2_ACCOUNT_ID)
#       in der Umgebung oder in <repo>/.env (R2_ENV_FILE ueberschreibt den Pfad).
# ============================================================================
set -euo pipefail

# LC_ALL=C: awk/date formatieren sonst je nach Rechner-Locale mit KOMMA
# ("0,1") - der Wert wird weiterverarbeitet und als Maschinenzeile
# ausgegeben (TRANSFER_RATE_MBPS=...). Gemessen: unter de_DE lieferte
# `awk 'BEGIN{printf "%.1f", 0.05}'` "0,1", und `awk -v s="0,1"` machte
# daraus bei der Rueckrechnung des Faktors "inf". Ausgabe bleibt Deutsch,
# nur die Zahlformatierung ist fest.
export LC_ALL=C

HERE_SRC="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE_SRC/../.." && pwd)"
cd "$REPO"

# shellcheck source=scripts/hetzner/lib/r2-sigv4.sh
# shellcheck disable=SC1091
source "$HERE_SRC/lib/r2-sigv4.sh"

IP=""
SRC=""
TAR=""
DEST=""
NAME=""
SHA_ARG=""
FILES_ARG=0
BYTES_ARG=0
SOURCE_URL=""
PRINT_CONFIG=0
PACK_ONLY=0
KEEP_ARCHIVE=0
INSTALL_MISSING=0
FORCE_UPLOAD=0
ZSTD_LEVEL="${PARALLEL_TRANSFER_ZSTD_LEVEL:-6}"
URL_TTL="${PARALLEL_TRANSFER_URL_TTL:-43200}"
ARIA2_CONNECTIONS="${PARALLEL_TRANSFER_CONNECTIONS:-16}"
KEY_PREFIX="${PARALLEL_TRANSFER_PREFIX:-transfer}"
# Gemessener Referenzwert EINES TCP-Stroms (2026-09-21: 200 MB in 3:14). Nur
# Vergleichswert - kein Messwert dieses Laufs.
REFERENCE_MBPS="${PARALLEL_TRANSFER_REFERENCE_MBPS:-1.0}"

# Werte im selben Durchlauf konsumieren (Lehre aus dem kaputten --role-Parser in
# migrate-project-name.sh: zwei getrennte Schleifen verlieren das Argument).
while [[ $# -gt 0 ]]; do
  case "$1" in
    --src) SRC="${2:-}"; shift 2 ;;
    --tar) TAR="${2:-}"; shift 2 ;;
    --dest) DEST="${2:-}"; shift 2 ;;
    --name) NAME="${2:-}"; shift 2 ;;
    --sha256) SHA_ARG="${2:-}"; shift 2 ;;
    --files) FILES_ARG="${2:-0}"; shift 2 ;;
    --bytes) BYTES_ARG="${2:-0}"; shift 2 ;;
    --source-url) SOURCE_URL="${2:-}"; shift 2 ;;
    --zstd-level) ZSTD_LEVEL="${2:-6}"; shift 2 ;;
    --url-ttl) URL_TTL="${2:-43200}"; shift 2 ;;
    --print-config) PRINT_CONFIG=1; shift ;;
    --pack-only) PACK_ONLY=1; KEEP_ARCHIVE=1; shift ;;
    --keep-archive) KEEP_ARCHIVE=1; shift ;;
    --install-missing) INSTALL_MISSING=1; shift ;;
    --force-upload) FORCE_UPLOAD=1; shift ;;
    --help|-h) sed -n '2,61p' "$0"; exit 0 ;;
    -*) echo "Unbekannte Option: $1" >&2; exit 1 ;;
    *) IP="$1"; shift ;;
  esac
done

SSH_KEY="${DEPLOY_SSH_KEY:-$HOME/.ssh/id_ed25519}"
SSH_OPTS=(-i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -o BatchMode=yes)
REMOTE_TMP="${TRANSFER_TMP:-/var/tmp/audiomonastry-transfer}"

LOCAL_TMP="$(mktemp -d "${TMPDIR:-/tmp}/am-parallel-transfer.XXXXXX")"
cleanup() {
  if [[ "$KEEP_ARCHIVE" == "1" && -n "${ARCHIVE:-}" && -f "${ARCHIVE:-/nonexistent}" ]]; then
    echo "Archiv behalten: $ARCHIVE"
    return 0
  fi
  rm -rf "$LOCAL_TMP"
}
trap cleanup EXIT

# R2-Konfiguration laden (kein Netz, gibt keine Werte aus).
R2_CONFIG_OK=0
if r2_load_config; then R2_CONFIG_OK=1; fi

if [[ "$PRINT_CONFIG" == "1" ]]; then
  # Trockenlauf: keine Werkzeugpruefung, kein Netz, keine Datei.
  HAVE_LOCAL_ARIA2="fehlt (ok - der Split laeuft auf dem Knoten)"
  command -v aria2c >/dev/null 2>&1 && HAVE_LOCAL_ARIA2="vorhanden"
  SRC_SIZE="fehlt"
  if [[ -n "$SRC" && -e "$SRC" ]]; then SRC_SIZE="$(du -sh "$SRC" 2>/dev/null | cut -f1)"; fi
  if [[ -n "$TAR" && -f "$TAR" ]]; then SRC_SIZE="$(du -h "$TAR" | cut -f1)"; fi
  LABEL="${NAME:-$([[ -n "$SRC" ]] && basename "${SRC%/}" || basename "${TAR:-quelle}")}"
  echo "parallel-transfer.sh - effektive Konfiguration (kein Netz, kein Schreiben, kein Auspacken)"
  printf '  Ziel-Knoten:          %s\n' "${IP:-<keiner>}"
  printf '  Quelle:               %s (%s)\n' "${SRC:-${TAR:-<keine>}}" "$SRC_SIZE"
  printf '  Ziel auf dem Knoten:  %s\n' "${DEST:-<keines>}"
  printf '  Objekt-Schluessel:    %s/%s/<sha256-des-archivs>.tar.zst (Hash entsteht beim Packen)\n' "$KEY_PREFIX" "$LABEL"
  printf '  Packen:               tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner | zstd -T0 -%s (deterministisch)\n' "$ZSTD_LEVEL"
  printf '  R2-Endpoint/Bucket:   %s / %s (Region %s)\n' "${R2_HOST:-<kein Endpoint>}" "${R2_BUCKET:-<kein Bucket>}" "${R2_REGION:-auto}"
  printf '  R2-Schluessel:        %s\n' "$([[ "$R2_CONFIG_OK" == "1" ]] && r2_key_fingerprint || echo 'FEHLEN (nur fuer den echten Lauf noetig)')"
  printf '  R2-Env-Datei:         %s\n' "${R2_ENV_FILE_EFFECTIVE:-<keine>}"
  printf '  GET-URL-Gueltigkeit:  %ss\n' "$URL_TTL"
  printf '  Knoten-Temp:          %s\n' "$REMOTE_TMP"
  printf '  Knoten-Ziehen:        aria2c -x%s -s%s (Rueckfall: curl -fL, EIN Strom)\n' "$ARIA2_CONNECTIONS" "$ARIA2_CONNECTIONS"
  printf '  aria2c auf DIESEM Host: %s\n' "$HAVE_LOCAL_ARIA2"
  printf '  Knoten-Voraussetzung: aria2c + zstd -> apt-get install -y --no-install-recommends aria2 zstd\n'
  # Belegbarer Ursprung der Werkzeuge: sie stehen seit 2026-09-21 in der
  # Provisionierung (scripts/hetzner/cloud-init.yaml, packages: aria2 + zstd).
  # Der Aufruf unten bleibt nur fuer Knoten aus einem Rollen-SNAPSHOT noetig -
  # ein Snapshot bootet ohne cloud-init.
  printf '                        Quelle: scripts/hetzner/cloud-init.yaml (packages: aria2, zstd) ->\n'
  printf '                        auf einem frischen/provisionierten Knoten bereits vorhanden\n'
  printf '  Nachinstallieren:     %s\n' "$([[ "$INSTALL_MISSING" == "1" ]] && echo 'ja (--install-missing)' || echo 'nein (dann Rueckfall auf curl)')"
  printf '  R2-Weg benutzt:       %s\n' "$([[ -n "$SOURCE_URL" ]] && echo "nein (--source-url)" || echo 'ja')"
  printf '  lokal behalten:       %s\n' "$([[ "$KEEP_ARCHIVE" == "1" ]] && echo ja || echo 'nein (Temp wird geraeumt)')"
  echo
  echo "Erwartungswert (gemessener Referenzwert 2026-09-21): EIN Strom ~${REFERENCE_MBPS} MB/s."
  echo "Mit ${ARIA2_CONNECTIONS} Verbindungen ist die Rate ein VIELFACHES davon, sofern das Limit pro"
  echo "Verbindung greift. Die echte Zahl misst der Lauf auf dem Knoten und gibt sie aus."
  echo "Der zweite Knoten zieht dasselbe Archiv aus R2, ohne erneuten Upload vom Betreiber-Host."
  exit 0
fi

# --- Eingaben pruefen -------------------------------------------------------
if [[ -n "$SRC" && -n "$TAR" ]]; then
  echo "❌ --src und --tar schliessen sich aus (entweder Baum oder vorhandener Tar)." >&2; exit 1
fi
if [[ -z "$SRC" && -z "$TAR" ]]; then
  echo "❌ Quelle fehlt: --src <verzeichnis> oder --tar <datei.tar>" >&2; exit 1
fi
if [[ -n "$SRC" && ! -e "$SRC" ]]; then
  echo "❌ Quelle fehlt lokal: $SRC" >&2; exit 2
fi
if [[ -n "$TAR" && ! -f "$TAR" ]]; then
  echo "❌ Tar fehlt lokal: $TAR" >&2; exit 2
fi
[[ -n "$DEST" || "$PACK_ONLY" == "1" ]] || { echo "❌ --dest <ziel auf dem knoten> fehlt" >&2; exit 1; }
if [[ -n "$SOURCE_URL" && -z "$SHA_ARG" ]]; then
  echo "❌ --source-url verlangt --sha256 <hex> (ohne Hash wird nicht ausgepackt)." >&2; exit 1
fi
if [[ "$PACK_ONLY" != "1" && -z "$SOURCE_URL" && -z "$IP" ]]; then
  echo "❌ Knoten-IP fehlt. Aufruf: bash scripts/hetzner/parallel-transfer.sh <ip> --src <dir> --dest <ziel>" >&2
  exit 1
fi

for tool in tar zstd openssl curl ssh; do
  command -v "$tool" >/dev/null 2>&1 || { echo "❌ '$tool' fehlt auf dem Betreiber-Host." >&2; exit 2; }
done

# R2-Schluessel VOR dem Packen pruefen: erst ein 3,7-GB-Archiv bauen und dann
# feststellen, dass der Endpoint fehlt, kostet nur Zeit (gemessen: zstd ueber
# 3,7 GB dauert Minuten). --pack-only braucht keine Schluessel.
if [[ "$PACK_ONLY" != "1" && -z "$SOURCE_URL" && "$R2_CONFIG_OK" != "1" ]]; then
  echo "❌ R2-Zugangsdaten fehlen (CFS3_ACCESS_KEY/CFS3_SECRET_KEY/CFS3_ENDPOINT/CFS3_BUCKET," >&2
  echo "   Umgebung oder <repo>/.env via R2_ENV_FILE). Werte werden NIE ausgegeben." >&2
  exit 2
fi

[[ -n "$NAME" ]] || NAME="$([[ -n "$SRC" ]] && basename "${SRC%/}" || basename "$TAR")"
NAME="${NAME%.tar.zst}"; NAME="${NAME%.tar}"

# --- 1. Deterministisch packen ---------------------------------------------
ARCHIVE="$LOCAL_TMP/$NAME.tar.zst"
# Dateizahlen werden am Wurzelordner des Archivs gezaehlt: beim Baum ist das der
# Basisname im Zielverzeichnis, bei einem fertigen Tar ist der Inhalt unbekannt -
# dann zaehlt das Zielverzeichnis selbst (und die Pruefung entfaellt ohne --files).
COUNT_DIR="$DEST"
if [[ -n "$SRC" ]]; then COUNT_DIR="$DEST/$NAME"; fi
FILES="$FILES_ARG"
BYTES="$BYTES_ARG"
PACK_SECONDS="0"

if [[ -n "$SOURCE_URL" ]]; then
  echo "=== --source-url: Packen und R2 entfallen (Archiv kommt aus der URL) ==="
else
  PACK_START="$(date +%s.%N)"
  if [[ -n "$SRC" ]]; then
    SRC_DIR="$(cd "$SRC" && pwd)"
    PARENT="$(dirname "$SRC_DIR")"
    BASE="$(basename "$SRC_DIR")"
    [[ "$FILES" -gt 0 ]] || FILES="$(find "$SRC_DIR" -type f | wc -l | tr -d ' ')"
    echo "=== Packen: $SRC_DIR -> $ARCHIVE (zstd -$ZSTD_LEVEL, deterministisch) ==="
    tar -cf - --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner --format=gnu \
      -C "$PARENT" "$BASE" | zstd -q -T0 -"$ZSTD_LEVEL" -o "$ARCHIVE"
  else
    if [[ "$TAR" == *.zst ]]; then
      echo "=== Archiv schon komprimiert: $TAR ==="
      cp "$TAR" "$ARCHIVE"
    else
      echo "=== Packen: $TAR -> $ARCHIVE (zstd -$ZSTD_LEVEL) ==="
      zstd -q -T0 -"$ZSTD_LEVEL" -o "$ARCHIVE" < "$TAR"
    fi
  fi
  PACK_END="$(date +%s.%N)"
  PACK_SECONDS="$(awk -v a="$PACK_START" -v b="$PACK_END" 'BEGIN { printf "%.1f", b - a }')"
  SHA256="$(sha256sum "$ARCHIVE" | awk '{print $1}')"
  SIZE="$(wc -c < "$ARCHIVE" | tr -d ' ')"
  [[ "$BYTES" -gt 0 ]] || BYTES="$SIZE"
  echo "Archiv: $SIZE Bytes in ${PACK_SECONDS}s gepackt, SHA256=$SHA256, Dateien=$FILES"
fi

if [[ -n "$SHA_ARG" ]]; then
  if [[ -n "${SHA256:-}" && "${SHA_ARG,,}" != "${SHA256,,}" ]]; then
    echo "❌ --sha256 passt nicht zum gepackten Archiv - das waere ein stiller Datenverlust." >&2
    exit 2
  fi
  SHA256="$SHA_ARG"
fi
[[ -n "${SHA256:-}" ]] || { echo "❌ Kein SHA256 verfuegbar (bei --source-url: --sha256 <hex>)." >&2; exit 2; }

if [[ "$PACK_ONLY" == "1" ]]; then
  echo "PARALLEL_TRANSFER_ARCHIVE=$ARCHIVE"
  echo "PARALLEL_TRANSFER_SHA256=$SHA256"
  echo "PARALLEL_TRANSFER_FILES=$FILES"
  echo "PARALLEL_TRANSFER_BYTES=${BYTES:-0}"
  echo "PARALLEL_TRANSFER_KEY=$KEY_PREFIX/$NAME/$SHA256.tar.zst"
  echo "PARALLEL_TRANSFER_SECONDS=$PACK_SECONDS"
  echo "(kein Netz: --pack-only packt nur; das Archiv bleibt liegen)"
  exit 0
fi

# --- 2./3. R2-Zwischenspeicher + presignierte URL --------------------------
KEY="$KEY_PREFIX/$NAME/$SHA256.tar.zst"
if [[ -n "$SOURCE_URL" ]]; then
  URL="$SOURCE_URL"
  echo "=== --source-url: $URL ==="
else
  echo "=== R2-Zwischenspeicher: Bucket ${R2_BUCKET} / ${KEY} (Schluessel-Fingerprint $(r2_key_fingerprint)) ==="
  if [[ "$FORCE_UPLOAD" != "1" ]] && r2_object_exists "$KEY"; then
    echo "schon vorhanden - KEIN erneuter Upload vom Betreiber-Host."
  else
    UP_START="$(date +%s.%N)"
    r2_upload_file "$ARCHIVE" "$KEY"
    UP_END="$(date +%s.%N)"
    UP_SECONDS="$(awk -v a="$UP_START" -v b="$UP_END" 'BEGIN { printf "%.1f", b - a }')"
    UP_RATE="$(awk -v b="$SIZE" -v s="$UP_SECONDS" 'BEGIN { if (s > 0) printf "%.2f", b / s / 1048576; else print "0.00" }')"
    echo "hochgeladen: $SIZE Bytes in ${UP_SECONDS}s -> ${UP_RATE} MB/s (EIN Upload, danach fuer alle Knoten)"
  fi
  URL="$(r2_presign GET "$KEY" "$URL_TTL")"
  echo "presignierte GET-URL erzeugt (TTL ${URL_TTL}s): sie wird NICHT ausgegeben und nur per stdin auf den Knoten gebracht."
fi

# --- 4. Knoten ziehen + pruefen + auspacken --------------------------------
# Secret-Kanal: die signierte URL geht per stdin in eine 0600-Datei; alle
# NICHT-geheimen Parameter stehen in der Kommandozeile (dort sind sie sichtbar
# und die Test-Attrappe kann Knotenpfade umschreiben).
ENV_FILE="$LOCAL_TMP/transfer.env"
printf 'URL=%s\nSHA256=%s\n' "$URL" "$SHA256" > "$ENV_FILE"
chmod 600 "$ENV_FILE"

REMOTE_ARCHIVE="$REMOTE_TMP/$NAME.tar.zst"
echo "=== Knoten $IP: ziehen (aria2c -x$ARIA2_CONNECTIONS -s$ARIA2_CONNECTIONS) + SHA256 pruefen + auspacken ==="
ssh "${SSH_OPTS[@]}" "root@$IP" "mkdir -p '$REMOTE_TMP' '$DEST' && chmod 700 '$REMOTE_TMP'"
ssh "${SSH_OPTS[@]}" "root@$IP" "umask 077; cat > '$REMOTE_TMP/transfer.env'" < "$ENV_FILE"
ssh "${SSH_OPTS[@]}" "root@$IP" "umask 077; cat > '$REMOTE_TMP/r2-node-fetch.sh'" < "$HERE_SRC/lib/r2-node-fetch.sh"

REMOTE_ENV="TRANSFER_ENV_FILE=$(printf '%q' "$REMOTE_TMP/transfer.env")"
REMOTE_ENV+=" LABEL=$(printf '%q' "$NAME")"
REMOTE_ENV+=" ARCHIVE=$(printf '%q' "$REMOTE_ARCHIVE")"
REMOTE_ENV+=" DEST=$(printf '%q' "$DEST")"
REMOTE_ENV+=" COUNT_DIR=$(printf '%q' "$COUNT_DIR")"
REMOTE_ENV+=" FILES=$(printf '%q' "$([[ "$FILES" -gt 0 ]] && echo "$FILES" || echo 0)")"
REMOTE_ENV+=" BYTES=$(printf '%q' "${BYTES:-0}")"
REMOTE_ENV+=" KEEP_ARCHIVE=$(printf '%q' "$([[ "$KEEP_ARCHIVE" == "1" ]] && echo 1 || echo 0)")"
REMOTE_ENV+=" INSTALL_MISSING=$(printf '%q' "$INSTALL_MISSING")"
REMOTE_ENV+=" ARIA2_CONNECTIONS=$(printf '%q' "$ARIA2_CONNECTIONS")"

set +e
OUT="$(ssh "${SSH_OPTS[@]}" "root@$IP" "$REMOTE_ENV bash '$REMOTE_TMP/r2-node-fetch.sh'")"
RC=$?
set -e
printf '%s\n' "$OUT"
if [[ $RC -ne 0 ]]; then
  echo "❌ Knoten-Schritt fehlgeschlagen (Exit $RC) - siehe Ausgabe oben." >&2
  exit "$RC"
fi

GET_FIELD() { printf '%s\n' "$OUT" | sed -n "s/^$1=//p" | tail -1; }
RATE="$(GET_FIELD TRANSFER_RATE_MBPS)"
DL_SECONDS="$(GET_FIELD TRANSFER_SECONDS)"
METHOD="$(GET_FIELD TRANSFER_METHOD)"
NODE_FILES="$(GET_FIELD TRANSFER_FILES)"
EXTRACT_SECONDS="$(GET_FIELD TRANSFER_EXTRACT_SECONDS)"
SIZE_NODE="$(GET_FIELD TRANSFER_BYTES)"

echo
echo "=== Ergebnis ($NAME) ==="
printf '  Methode:               %s (Vorgabe: %s Verbindungen)\n' "${METHOD:-unbekannt}" "$ARIA2_CONNECTIONS"
printf '  Archiv:                %s Bytes auf dem Knoten geprueft, %s Dateien gepackt\n' "${SIZE_NODE:-?}" "$FILES"
printf '  Rate auf dem Knoten:   %s MB/s in %ss\n' "${RATE:-?}" "${DL_SECONDS:-?}"
printf '  Referenz EIN Strom:    %s MB/s (gemessen 2026-09-21: 200 MB in 3:14)\n' "$REFERENCE_MBPS"
if [[ -n "${RATE:-}" ]]; then
  awk -v neu="$RATE" -v alt="$REFERENCE_MBPS" 'BEGIN {
    if (alt + 0 > 0) printf "  Faktor:                %.2fx gegenueber EINEM Strom\n", neu / alt
  }'
  awk -v b="${SIZE:-0}" -v alt="$REFERENCE_MBPS" 'BEGIN {
    if (alt + 0 > 0 && b + 0 > 0) printf "  EIN Strom braeuchte:   ~%.1f min fuer dieses Archiv (Erwartungswert)\n", b / 1048576 / alt / 60
  }'
fi
printf '  Auspacken:             %ss\n' "${EXTRACT_SECONDS:-?}"
printf '  Dateizahlen:           erwartet %s, auf dem Knoten %s\n' "$FILES" "${NODE_FILES:-?}"
echo
echo "Naechster Schritt: Rollen-Stack mit dem Medien-Overlay wie gewohnt neu starten"
echo "  bash scripts/hetzner/deliver-media.sh <ip> && (docker compose -f docker-compose.hetzner.yml -f docker-compose.media.yml up -d --no-build audiomonastry)"
