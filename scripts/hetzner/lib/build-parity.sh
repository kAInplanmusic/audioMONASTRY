#!/usr/bin/env bash
# =============================================================================
# scripts/hetzner/lib/build-parity.sh - Commit-Paritaet (PROD-P1-F4)
# -----------------------------------------------------------------------------
# Warum diese Datei existiert:
#
# /api/health nannte bis 2026-09-20 nur `{"status":"ok","version":"1.210.001"}`.
# Die Version aendert sich nicht mit jedem Commit - auf app-1 lief deshalb ein
# Image vom 18.09. unbemerkt weiter, waehrend das Repo auf `ae5e749` (20.09.)
# stand; der Session-Clock-Sync der Flotte ging nie an.
#
# Diese Bibliothek ist die EINE Shell-Umsetzung des Vergleichs (Spiegel von
# `compareCommits` in `server/buildInfo.ts` und `commitParity()` im
# Portal-Worker). Sie wird GESOURCET, nicht ausgefuehrt:
#   * deploy.sh                          - nach dem Deploy (Health-Commit vs. Repo)
#   * scripts/hetzner/fleet-preflight.sh - vor/nach dem Wake
#   * tests/test_hetzner_scripts.py      - ueber echte bash-Aufrufe gegen einen
#                                          lokalen HTTP-Stub (kein Netzzugriff)
#
# Regeln (identisch in allen drei Umsetzungen):
#   * Kurzer SHA trifft langen SHA (Prefix-Vergleich), kein Zeichenraten.
#   * "nicht pruefbar" (kein Commit gesetzt/gemeldet) ist KEINE Abweichung, wird
#     aber genauso laut gemeldet - sonst waere eine alte Flotte still "ok".
#   * Exit 1 NUR bei nachgewiesener Abweichung: 0 = ok oder nicht pruefbar.
# =============================================================================

# normalize_commit <wert> -> Vergleichsform ("" = nicht verwertbar)
normalize_commit() {
  local raw="${1:-}"
  raw="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  case "$raw" in
    '' | unknown | dev | none | null) printf ''; return 0 ;;
  esac
  printf '%.40s' "$raw"
}

# json_field <json> <feld> -> Wert auf stdout ("" = nicht lesbar/fehlend)
# Liest die /api/health-Antwort ohne zusaetzliche Abhaengigkeit (node ist fuer
# den Build ohnehin Pflicht). Fehlt node, bleibt die Ausgabe leer - der Aufrufer
# meldet das dann als "nicht pruefbar" statt zu raten.
json_field() {
  local body="${1:-}" field="${2:-}"
  command -v node >/dev/null 2>&1 || return 0
  printf '%s' "$body" | BUILD_PARITY_FIELD="$field" node -e '
    let s = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { s += c; });
    process.stdin.on("end", () => {
      try {
        const value = JSON.parse(s)[process.env.BUILD_PARITY_FIELD];
        process.stdout.write(value === undefined || value === null ? "" : String(value));
      } catch {
        process.stdout.write("");
      }
    });' 2>/dev/null || true
}

# build_parity_report <erwartet> <gemeldet> [quelle]
#   stdout: eine Zeile, beginnend mit "OK ", "UNKNOWN " oder "STALE " -
#           maschinenlesbar und fuer den Betreiber direkt lesbar.
#   exit:   0 = ok oder nicht pruefbar, 1 = nachgewiesene Abweichung
build_parity_report() {
  local expected="${1:-}" actual="${2:-}" source="${3:-health}" want have
  want="$(normalize_commit "$expected")"
  have="$(normalize_commit "$actual")"

  if [[ -z "$want" ]]; then
    printf 'UNKNOWN Kein erwarteter Commit gesetzt - Paritaet nicht pruefbar (%s).\n' "$source"
    return 0
  fi
  if [[ -z "$have" ]]; then
    printf 'UNKNOWN Flotte meldet keinen Commit (%s) - erwartet %s, nicht pruefbar.\n' "$source" "$want"
    return 0
  fi
  if [[ "$have" == "$want" || "$have" == "$want"* || "$want" == "$have"* ]]; then
    printf 'OK Commit-Paritaet ok (%s).\n' "$want"
    return 0
  fi
  printf 'STALE Flotte laeuft Stand %s, Repo ist %s.\n' "$have" "$want"
  return 1
}

# health_commit <base_url> -> Commit aus /api/health ("" = nicht erreichbar/leer)
health_commit() {
  local base_url="${1:-}" body
  command -v curl >/dev/null 2>&1 || return 0
  body="$(curl -fsS --max-time 10 "$base_url/api/health" 2>/dev/null || true)"
  [[ -n "$body" ]] || return 0
  json_field "$body" commit
}

# verify_build_parity <base_url> <erwarteter_commit> [label]
#   Holt /api/health, vergleicht `commit` mit dem erwarteten Stand und meldet
#   das Ergebnis laut.
#   exit 0 = Paritaet ok ODER nicht pruefbar, 1 = nachgewiesene Abweichung.
#   Nicht pruefbar ist bewusst KEIN Fehler: die app-Firewall oeffnet 80/443 nur
#   fuer Cloudflare, ein direkter IP-Zugriff scheitert also regelmaessig.
verify_build_parity() {
  local base_url="${1:-}" expected="${2:-}" label="${3:-app-1}"
  local body commit version build_time verdict
  if ! command -v curl >/dev/null 2>&1; then
    echo "⚠️  curl fehlt lokal - Commit-Paritaet nicht geprueft."
    return 0
  fi
  body="$(curl -fsS --max-time 10 "$base_url/api/health" 2>/dev/null || true)"
  if [[ -z "$body" ]]; then
    echo "⚠️  Commit-Paritaet nicht pruefbar: $base_url/api/health nicht erreichbar."
    echo "    (Direkter IP-Zugriff scheitert an der Cloudflare-only-Firewall - ueber die Portal-Domain oder per SSH pruefen.)"
    return 0
  fi
  commit="$(json_field "$body" commit)"
  version="$(json_field "$body" version)"
  build_time="$(json_field "$body" buildTime)"
  if verdict="$(build_parity_report "$expected" "$commit" "$label")"; then
    case "${verdict%% *}" in
      OK)
        echo "✅ ${verdict#* } (version=$version, buildTime=$build_time)"
        ;;
      *)
        echo "⚠️  ${verdict#* }"
        echo "    $label meldet version=$version buildTime=$build_time - vor F4 gebaute Images tragen keinen Commit."
        ;;
    esac
    return 0
  fi
  echo "❌ ${verdict#* } (version=$version, buildTime=$build_time)" >&2
  return 1
}

# parity_gate <base_url> <erwarteter_commit> <label> <allow_stale 0|1>
#   Die ENTSCHEIDUNG des Gates - genau diese Funktion ruft deploy.sh auf:
#     0 = Paritaet ok, "nicht pruefbar" oder bewusst erlaubte Abweichung
#     1 = belegte Abweichung ohne Freigabe (Aufrufer bricht damit ab)
#   Ohne Freigabe gibt es KEIN "ready" bei belegter Abweichung; mit Freigabe
#   bleibt die Meldung sichtbar (laut, nur nicht blockierend).
parity_gate() {
  local base_url="${1:-}" expected="${2:-}" label="${3:-app-1}" allow_stale="${4:-0}"
  if verify_build_parity "$base_url" "$expected" "$label"; then
    return 0
  fi
  if [[ "$allow_stale" == "1" ]]; then
    echo "⚠️  ALLOW_STALE=1: der abweichende Stand wird BEWUSST akzeptiert (Grund in den Bericht)."
    return 0
  fi
  return 1
}
