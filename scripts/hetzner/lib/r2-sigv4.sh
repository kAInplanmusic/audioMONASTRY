#!/usr/bin/env bash
# ============================================================================
# audioMONASTRY · R2/S3-SigV4 (presignierte URLs) - ohne aws-cli, ohne boto3
# ============================================================================
# WARUM: Die schweren Medienbaeume (3,7 GB) sollen nicht mehr bei jeder
# Lieferung ueber die Betreiber-Leitung (~1 MB/s, gemessen 2026-09-21) wandern,
# sondern als zstd-Archiv in R2 liegen und von dort mit mehreren Verbindungen
# gezogen werden (Egress von R2 ist kostenfrei).
#
# Vertrag:
#   * Der BETREIBER-Host haelt die Schluessel (CFS3_ACCESS_KEY/CFS3_SECRET_KEY)
#     und signiert. Der KNOTEN bekommt NUR eine kurzlebige GET-URL - keine
#     Schluessel, kein aws-cli, keine Config-Datei.
#   * Die signierte URL ist ein Bearer-Token: sie wird NIE von selbst
#     ausgegeben (kein `set -x`, keine Debug-Ausgabe) und nur per stdin auf den
#     Knoten gebracht, damit sie nicht in argv/`ps` auftaucht.
#   * Handarbeit statt SDK: das Repo hat npm/python3 + openssl, aber kein
#     aws-cli/boto3. tests/test_hetzner_scripts.py rechnet die Signatur mit
#     einer ZWEITEN, unabhaengigen Umsetzung (Python hmac/hashlib) nach -
#     eine Signatur, die nur "irgendwie" aussieht, ist damit nicht zu haben.
#
# Benutzung:  source scripts/hetzner/lib/r2-sigv4.sh
#   r2_load_config                                    # env oder .env
#   url=$(r2_presign GET "transfer/x/y.tar.zst" 43200)
#   r2_object_exists "transfer/x/y.tar.zst" && echo "liegt schon in R2"
#   r2_upload_file ./archiv.tar.zst "transfer/x/y.tar.zst"
#
# Umgebung (erste vollstaendige Quelle gewinnt):
#   CFS3_ACCESS_KEY/CFS3_SECRET_KEY/CFS3_ENDPOINT/CFS3_BUCKET (+ CFR2_ACCOUNT_ID)
#   R2_ACCESS_KEY/R2_SECRET_KEY/R2_ENDPOINT/R2_BUCKET als ausdrueckliche Overrides
#   R2_ENV_FILE  - Datei, aus der die Werte gelesen werden (Default: <repo>/.env)
# ============================================================================

# --- Konfiguration ----------------------------------------------------------
# Env-Datei: R2_ENV_FILE ausdruecklich, sonst <repo>/.env (dort liegen die
# R2-Schluessel des Betreibers). Die Datei wird nur GELESEN, nie gesourct.
_r2_default_env_file() {
  local here
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  printf '%s' "$(cd "$here/../../.." && pwd)/.env"
}

# Wert aus der Umgebung, sonst aus der Env-Datei. Der Wert wird NIE ausgegeben.
r2_env_get() {
  local name="$1" envfile="${2:-${R2_ENV_FILE:-}}"
  if [[ -n "${!name:-}" ]]; then printf '%s' "${!name}"; return 0; fi
  [[ -n "$envfile" && -f "$envfile" ]] || return 1
  # Kein `source`: die Datei kann Kommentare, Quotes und fremde Zeilen tragen -
  # gelesen wird genau die Zeile mit dem Schluesselnamen.
  local line
  line="$(grep -m1 -E "^[[:space:]]*(export[[:space:]]+)?${name}=" "$envfile" 2>/dev/null || true)"
  [[ -n "$line" ]] || return 1
  line="${line#*=}"
  line="${line%\"}"; line="${line#\"}"
  line="${line%\'}"; line="${line#\'}"
  printf '%s' "$line"
}

# Setzt R2_ACCESS_KEY/R2_SECRET_KEY/R2_ENDPOINT/R2_HOST/R2_BUCKET/R2_REGION.
# Exit 1, wenn etwas fehlt - der Aufrufer entscheidet ueber die Meldung.
r2_load_config() {
  local envfile="${R2_ENV_FILE:-$(_r2_default_env_file)}"
  R2_ENV_FILE_EFFECTIVE="$envfile"
  R2_ACCESS_KEY="${R2_ACCESS_KEY:-$(r2_env_get CFS3_ACCESS_KEY "$envfile" || true)}"
  R2_SECRET_KEY="${R2_SECRET_KEY:-$(r2_env_get CFS3_SECRET_KEY "$envfile" || true)}"
  R2_ENDPOINT="${R2_ENDPOINT:-$(r2_env_get CFS3_ENDPOINT "$envfile" || true)}"
  R2_BUCKET="${R2_BUCKET:-$(r2_env_get CFS3_BUCKET "$envfile" || true)}"
  local account="${R2_ACCOUNT_ID:-}"
  [[ -n "$account" ]] || account="$(r2_env_get CFR2_ACCOUNT_ID "$envfile" || true)"
  if [[ -z "$R2_ENDPOINT" && -n "$account" ]]; then
    R2_ENDPOINT="https://${account}.r2.cloudflarestorage.com"
  fi
  R2_ENDPOINT="${R2_ENDPOINT%/}"
  R2_HOST="${R2_ENDPOINT#*://}"
  R2_HOST="${R2_HOST%%/*}"
  # R2 verlangt region 'auto' (Hetzner-Object-Storage waere z. B. nbg1).
  R2_REGION="${R2_REGION:-auto}"
  [[ -n "$R2_ACCESS_KEY" && -n "$R2_SECRET_KEY" && -n "$R2_HOST" && -n "$R2_BUCKET" ]]
}

# Nur der Schluegel FINGERPRINT (nie der Wert) - fuer Diagnose und Logs.
r2_key_fingerprint() {
  [[ -n "${R2_ACCESS_KEY:-}" ]] || { printf 'kein-Key'; return 0; }
  printf '%s' "$R2_ACCESS_KEY" | sha256sum | cut -c1-12
}

# --- Primitive --------------------------------------------------------------
_r2_sha256_hex() { printf '%s' "$1" | openssl dgst -sha256 | awk '{print $NF}'; }
_r2_hmac_hexraw() { printf '%s' "$2" | openssl dgst -sha256 -hmac "$1" | awk '{print $NF}'; }
_r2_hmac_hexkey() { printf '%s' "$2" | openssl dgst -sha256 -mac HMAC -macopt "hexkey:$1" | awk '{print $NF}'; }

# RFC3986: alles ausser A-Za-z0-9-_.~ wird prozentkodiert. LC_ALL=C, damit die
# Schleife BYTES zaehlt (UTF-8-Dateinamen werden byteweise kodiert).
_r2_enc_component() {
  local s="$1" out="" c i
  local LC_ALL=C
  for (( i=0; i<${#s}; i++ )); do
    c="${s:i:1}"
    case "$c" in
      [A-Za-z0-9._~-]) out+="$c" ;;
      *) out+="$(printf '%%%02X' "'$c")" ;;
    esac
  done
  printf '%s' "$out"
}

# Pfad-Kodierung: '/' bleibt Pfadtrenner, jedes Segment wird kodiert.
_r2_enc_path() {
  local s="$1" out="" seg rest="$1"
  while [[ "$rest" == */* ]]; do
    seg="${rest%%/*}"; rest="${rest#*/}"
    out+="$(_r2_enc_component "$seg")/"
  done
  printf '%s%s' "$out" "$(_r2_enc_component "$rest")"
}

# --- Presign ----------------------------------------------------------------
# r2_presign <METHOD> <key> [ttl_sekunden] [amz-date]  -> URL auf stdout
# amz-date (YYYYMMDDTHHMMSSZ) oder R2_SIGNED_AT nur fuer reproduzierbare Tests.
r2_presign() {
  local method="$1" key="$2" ttl="${3:-43200}" amzdate="${4:-}"
  local datestamp scope sts canonical_uri query canonical_headers cr
  [[ -n "$amzdate" ]] || amzdate="${R2_SIGNED_AT:-$(date -u +%Y%m%dT%H%M%SZ)}"
  datestamp="${amzdate%%T*}"
  scope="${datestamp}/${R2_REGION}/s3/aws4_request"

  canonical_uri="/$(_r2_enc_component "$R2_BUCKET")/$(_r2_enc_path "$key")"
  query="X-Amz-Algorithm=AWS4-HMAC-SHA256"
  query+="&X-Amz-Credential=$(_r2_enc_component "${R2_ACCESS_KEY}/${scope}")"
  query+="&X-Amz-Date=${amzdate}"
  query+="&X-Amz-Expires=${ttl}"
  query+="&X-Amz-SignedHeaders=host"
  canonical_headers="host:${R2_HOST}"

  printf -v cr '%s\n%s\n%s\n%s\n\nhost\nUNSIGNED-PAYLOAD' \
    "$method" "$canonical_uri" "$query" "$canonical_headers"
  printf -v sts 'AWS4-HMAC-SHA256\n%s\n%s\n%s' "$amzdate" "$scope" "$(_r2_sha256_hex "$cr")"

  local k sig
  k="$(_r2_hmac_hexraw "AWS4${R2_SECRET_KEY}" "$datestamp")"
  k="$(_r2_hmac_hexkey "$k" "$R2_REGION")"
  k="$(_r2_hmac_hexkey "$k" "s3")"
  k="$(_r2_hmac_hexkey "$k" "aws4_request")"
  sig="$(_r2_hmac_hexkey "$k" "$sts")"

  printf 'https://%s%s?%s&X-Amz-Signature=%s\n' "$R2_HOST" "$canonical_uri" "$query" "$sig"
}

# HEAD auf das Objekt: 0 = existiert (200). Jeder andere Ausgang = "neu/unklar"
# (die Signatur bleibt fuer GET/HEAD identisch, UNSIGNED-PAYLOAD in beiden).
r2_object_exists() {
  local key="$1" url code
  url="$(r2_presign HEAD "$key" 300)"
  code="$(curl -s -o /dev/null -w '%{http_code}' -I --max-time 20 "$url" || true)"
  [[ "$code" == "200" ]]
}

# Upload per presigned PUT (curl liest die Datei, die URL steht in argv des
# KURZLEBIGEN curl - Schluessel selbst bleiben in der Umgebung).
r2_upload_file() {
  local file="$1" key="$2" url
  url="$(r2_presign PUT "$key" 3600)"
  curl -fsS -X PUT --max-time 3600 -H 'Content-Type: application/octet-stream' \
    --data-binary @"$file" "$url" -o /dev/null
}
