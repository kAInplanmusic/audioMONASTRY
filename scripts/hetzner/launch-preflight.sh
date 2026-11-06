#!/usr/bin/env bash
# =============================================================================
# launch-preflight.sh — alles, was VOR dem Produktionsstart geprueft werden kann,
# ohne einen Server zu starten und ohne einen Cent auszugeben.
# -----------------------------------------------------------------------------
# Aufruf:
#   bash scripts/hetzner/launch-preflight.sh            # schnelle Pruefung (~3 min)
#   bash scripts/hetzner/launch-preflight.sh --full     # zusaetzlich npm run verify
#   bash scripts/hetzner/launch-preflight.sh --build    # zusaetzlich Produktions-Build
#
# Exit 0 = gruen. Jede Stufe gibt ihren echten Exit-Code aus; es wird NICHT
# mit && verkettet, damit ein Abbruch nicht als "alles gruen" gelesen wird.
#
# Warum es dieses Skript gibt: am 2026-11-06 fiel auf, dass der Produktions-Build
# ohne .env im Kontext (seit SEC-2026-11-06-002) still ein Bundle OHNE
# Supabase-URL erzeugt haette - cloudEnabled=false, Bibliothek und Cloud-Pfade
# tot, ohne Fehlermeldung. Genau dafuer ist Stufe 5 da.
# =============================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

FULL=0; DO_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --full) FULL=1 ;;
    --build) DO_BUILD=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unbekannte Option: $arg" >&2; exit 2 ;;
  esac
done

FAILS=0; WARNS=0
ok()   { printf '  \033[32mOK\033[0m   %s\n' "$1"; }
warn() { printf '  \033[33mWARN\033[0m %s\n' "$1"; WARNS=$((WARNS+1)); }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAILS=$((FAILS+1)); }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

step "1/9  Arbeitsbaum"
if [ -n "$(git status --porcelain)" ]; then
  fail "Arbeitsbaum nicht sauber - ein Deploy aus unfertigem Stand ist kein Release"
  git status --short | head -10
else
  ok "Arbeitsbaum sauber"
fi
HEAD_SHA="$(git rev-parse --short HEAD)"
ok "HEAD $HEAD_SHA ($(git log -1 --pretty=%s | cut -c1-70))"

step "2/9  Deploy-Variablen (.env.deploy, nur Namen - keine Werte)"
if [ ! -f .env.deploy ]; then
  fail ".env.deploy fehlt (Vorlage: .env.deploy.example)"
else
  missing=""
  for k in DEPLOY_HOST DEPLOY_DOMAIN DEPLOY_SSH_KEY HCLOUD_TOKEN RUNPOD_API_KEY \
           RP_POD_IMAGE RP_REGISTRY_AUTH_ID AI_POD_TOKEN \
           CFS3_ACCESS_KEY CFS3_SECRET_KEY CFS3_BUCKET CFS3_ENDPOINT CFR2_ACCOUNT_ID \
           GHCR_USERNAME GHCR_PASSWORD; do
    case "$k" in
      DEPLOY_HOST) grep -qE "^${k}=.+" .env.deploy || { warn "DEPLOY_HOST noch leer - wird in Phase 2 gesetzt (Knoten-IP)"; continue; } ;;
      DEPLOY_SSH_KEY) grep -qE "^${k}=.+" .env.deploy || { warn "DEPLOY_SSH_KEY nicht gesetzt - deploy.sh nimmt ~/.ssh/id_ed25519"; continue; } ;;
    esac
    grep -qE "^${k}=.+" .env.deploy || missing="$missing $k"
  done
  if [ -n "$missing" ]; then fail "fehlende/leere Variablen:$missing"; else ok "alle Pflichtvariablen gesetzt"; fi
  # Token-Laenge (Konsumenten pruefen >= 32)
  tok_len=$(grep -m1 '^AI_POD_TOKEN=' .env.deploy | cut -d= -f2- | tr -d '"' | wc -c)
  if [ "$tok_len" -ge 33 ]; then ok "AI_POD_TOKEN Laenge ok (>=32)"; else fail "AI_POD_TOKEN zu kurz"; fi
fi

step "3/9  Compose-Konfiguration"
if docker compose -f docker-compose.hetzner.yml config -q 2>/dev/null; then
  svcs=$(docker compose -f docker-compose.hetzner.yml config --services 2>/dev/null | sort | tr '\n' ' ')
  ok "compose gueltig; Default-Profil: $svcs"
  case "$svcs" in
    "audiomonastry caddy master-player redis "*) ok "Default-Profil sind die vier erwarteten Dienste" ;;
    *) warn "Default-Profil weicht ab - bewusst?" ;;
  esac
else
  fail "docker compose config -f docker-compose.hetzner.yml schlaegt fehl"
fi

step "4/9  Build-Kontext enthaelt keine Secrets"
# tar kennt die "!"-Ausnahmen von .dockerignore nicht - deshalb getrennt zaehlen:
# jede .env*, die NICHT auf .example endet, ist ein Fund.
envfiles=$(tar --exclude-from=.dockerignore -cf - . 2>/dev/null | tar -tf - 2>/dev/null | grep -E '(^|/)\.env' || true)
examples=$(printf '%s\n' "$envfiles" | grep -c '\.example$' || true)
realleaks=$(printf '%s\n' "$envfiles" | grep -v '\.example$' | grep -c . || true)
if [ "${realleaks:-0}" -eq 0 ]; then
  ok "keine echte .env im Kontext ($examples Beispiel-Dateien erlaubt)"
else
  fail "$realleaks echte .env-Datei(en) im Build-Kontext - .dockerignore pruefen"
  printf '%s\n' "$envfiles" | grep -v '\.example$' | sed 's/^/       /'
fi

step "5/9  VITE-Werte kommen als Build-Arg an (der stille Killer)"
# Simuliert den Container: kein .env im Kontext, nur die Variablen, die compose
# bzw. deploy.sh als Build-Arg durchreichen. Danach muss die Supabase-URL im
# Bundle stehen, sonst ist cloudEnabled im Produkt false.
# Erster NICHT-leerer Treffer: die Knoten-Vorlage fuehrt beide Namen, einer ist
# oft leer - `grep -m1` wuerde genau den leeren erwischen.
first_set() {
  local pat="$1" line
  while IFS= read -r line; do
    local val="${line#*=}"; val="${val%\"}"; val="${val#\"}"
    [ -n "$val" ] && { printf '%s' "$val"; return 0; }
  done < <(grep -E "$pat" .env 2>/dev/null)
}
SB_URL=$(first_set '^VITE_(SB_URL|SUPABASE_URL)=')
SB_ANON=$(first_set '^VITE_(SB_ANON_PUB|SUPABASE_ANON_PUB)=')
if [ -z "$SB_URL" ] || [ -z "$SB_ANON" ]; then
  warn "keine Supabase-Werte in .env - Cloud-Pfade bleiben aus (bewusst?)"
else
  if [ "$DO_BUILD" -eq 1 ]; then
    safety="$(mktemp)"; cp .env "$safety"
    mv .env .env.preflight-hidden
    VITE_SB_URL="$SB_URL" VITE_SB_ANON_PUB="$SB_ANON" VITE_V2_AUDIO_MODE=v2 \
      npm run build >/tmp/preflight-build.log 2>&1
    rc=$?
    mv .env.preflight-hidden .env; rm -f "$safety"
    if [ $rc -ne 0 ]; then
      fail "Produktions-Build ohne .env schlaegt fehl (Log: /tmp/preflight-build.log)"
    elif grep -rq "$SB_URL" dist/assets/ 2>/dev/null; then
      ok "Bundle enthaelt die Supabase-URL (Build-Arg-Pfad funktioniert)"
    else
      fail "Bundle enthaelt die Supabase-URL NICHT - cloudEnabled waere in Produktion false"
    fi
    if node scripts/check-bundle-size.mjs >/tmp/preflight-bundle.log 2>&1; then
      ok "Bundle-Budget eingehalten ($(grep -oE 'Startlast \(eager\): [0-9]+ Dateien = [0-9.]+ MB' /tmp/preflight-bundle.log | head -1))"
    else
      fail "Bundle-Budget ueberschritten (/tmp/preflight-bundle.log)"
    fi
  else
    ok "Supabase-Werte vorhanden (Build-Pruefung mit --build aktivieren)"
  fi
fi

step "6/9  R2/Bucket-Zustand (privat + gleiche Origin)"
if [ -f .env ]; then
  python3 - <<'PY' || fail "R2-Pruefung fehlgeschlagen"
import os, sys, re
env = {}
for line in open('.env'):
    line = line.strip()
    if line and not line.startswith('#') and '=' in line:
        k, v = line.split('=', 1); env[k.strip()] = v.strip().strip('"').strip("'")
try:
    sys.path.insert(0, 'scripts')
    from s3lite import S3Target
    t = S3Target.from_r2_env(env)
    head = t.head('visuals/bank/m01a.mp4')
    print(f"  \033[32mOK\033[0m   R2 erreichbar, visuals/bank/m01a.mp4 vorhanden ({head.get('content_length','?')} B)")
except Exception as e:
    print(f"  \033[31mFAIL\033[0m R2 nicht erreichbar: {type(e).__name__}: {e}")
    sys.exit(1)
PY
else
  warn "keine .env - R2-Pruefung uebersprungen"
fi

step "7/9  RunPod: Plan und Gewichte (kostet nichts)"
if [ -f .env.deploy ]; then
  ( set -a; . ./.env.deploy; set +a
    if python3 scripts/runpod-pods.py plan >/tmp/preflight-plan.log 2>&1; then
      if grep -q 'PROBLEM:' /tmp/preflight-plan.log; then fail "plan meldet PROBLEM-Zeilen (/tmp/preflight-plan.log)"; else ok "plan ohne PROBLEM-Zeilen"; fi
    else fail "runpod-pods.py plan schlaegt fehl (/tmp/preflight-plan.log)"; fi
    if python3 scripts/runpod-pods.py weights >/tmp/preflight-weights.log 2>&1; then ok "Gewichte vollstaendig"; else fail "Gewichte unvollstaendig (/tmp/preflight-weights.log)"; fi
    if python3 scripts/runpod-pods.py status >/tmp/preflight-status.log 2>&1; then
      line=$(tail -1 /tmp/preflight-status.log)
      case "$line" in *"0 Pods"*) ok "0 Pods laufen (Kosten 0)" ;; *) warn "es laufen bereits Pods: $line" ;; esac
    fi
  )
else
  warn ".env.deploy fehlt - RunPod-Pruefung uebersprungen"
fi

step "8/9  Hetzner: keine Kosten im Hintergrund"
if [ -f .env.deploy ]; then
  ( set -a; . ./.env.deploy; set +a
    python3 - <<'PY'
import json, os, sys, urllib.request
tok = os.environ.get('HCLOUD_TOKEN') or ''
if not tok:
    print('  \033[33mWARN\033[0m kein HCLOUD_TOKEN - uebersprungen'); sys.exit(0)
def get(p):
    r = urllib.request.Request('https://api.hetzner.cloud/v1' + p, headers={'Authorization': 'Bearer ' + tok})
    return json.loads(urllib.request.urlopen(r, timeout=30).read())
srv = get('/servers')['servers']
gone = [s for s in srv if s.get('labels', {}).get('app') == 'audiomonastry']
print(f"  \033[32mOK\033[0m   {len(srv)} Server im Account, davon {len(gone)} mit app=audiomonastry")
for s in gone:
    print(f"       - {s['name']} ({s['server_type']['name']}, {s['status']}) = {s['id']}")
snaps = get('/images?type=snapshot')['images']
print(f"  \033[32mOK\033[0m   {len(snaps)} Snapshots (0,0119 EUR/GB/Monat, nur der letzte je Rolle sollte bleiben)")
PY
  )
else
  warn "kein HCLOUD_TOKEN - Hetzner-Pruefung uebersprungen"
fi

step "9/9  Image-Groesse (Upload-Zeit)"
if docker image inspect audiomonastry:hetzner >/dev/null 2>&1; then
  size=$(docker image inspect --format '{{.Size}}' audiomonastry:hetzner)
  mb=$((size/1024/1024))
  ok "Image audiomonastry:hetzner = ${mb} MB"
  # Gemessene Upload-Rate des Betreiber-Anschlusses ~1 MB/s (registry-push.sh).
  if [ "$mb" -gt 900 ]; then
    warn "${mb} MB per 'docker save | ssh' waeren ~$((mb/60)) min pro Knoten - GHCR-Weg (DEPLOY_IMAGE_SOURCE=registry) spart das"
  fi
else
  warn "kein lokales Image audiomonastry:hetzner - 'docker build' oder registry-push.sh noetig"
fi

if [ "$FULL" -eq 1 ]; then
  step "Zusatz: volle Freigabekette (npm run verify)"
  if npm run verify >/tmp/preflight-verify.log 2>&1; then ok "verify gruen"; else fail "verify rot (/tmp/preflight-verify.log)"; fi
fi

printf '\n===============================================\n'
if [ "$FAILS" -eq 0 ]; then
  printf '  PREFLIGHT GRUEN   (%d Warnungen)\n' "$WARNS"
  printf '  Naechster Schritt: docs/DEPLOY_STRATEGY.md, Phase 2\n'
  exit 0
else
  printf '  PREFLIGHT ROT     %d Fehler, %d Warnungen\n' "$FAILS" "$WARNS"
  exit 1
fi
