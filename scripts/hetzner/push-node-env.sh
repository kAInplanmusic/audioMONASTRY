#!/usr/bin/env bash
# ============================================================================
# Die Knoten-.env mit den ECHTEN Werten versorgen (Supabase + R2)
# ============================================================================
# BEFUND 2026-09-24, live gemessen:
#   Die .env auf app-1 enthielt 8 PLATZHALTER und 7 leere Werte - also
#   unersetzte Vorlagenwerte mit spitzen Klammern:
#     SB_SERVICE_ROLE=<...>   SB_PUBLISHABLE=<...>   VITE_SB_ANON_PUB=<...>
#     CFR2_ACCOUNT_ID=<...>   CFS3_ACCESS_KEY=<...>  CFS3_SECRET_KEY=<...>
#   Gleichzeitig FEHLTEN die Namen, die der Server tatsaechlich liest
#   (SUPABASE_URL 11x, SUPABASE_ANON_PUB 7x, SB_URL 4x).
#   Wirkung, aus /api/metrics gelesen: r2.credentials.configured = false.
#   Ein Upload antwortete: {"error":"r2-not-configured","degraded":true}.
#   Die Persistenz der oeffentlichen Instanz war damit vollstaendig aus:
#   kein Upload nach R2, kein Schreiben nach Supabase.
#
# Dieses Skript uebertraegt die benoetigten Werte aus der lokalen .env auf den
# Knoten. Werte werden NIE ausgegeben, nur Laengen.
#
# Aufruf:  APP_IP=<ip> bash scripts/hetzner/push-node-env.sh
#          APP_IP=<ip> NUR_PRUEFEN=1 bash ...   (nur lesen, nichts schreiben)
# ============================================================================
set -uo pipefail

QUELLE="${QUELLE:-.env}"
APP_IP="${APP_IP:-}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/audiomonastry}"
NUR_PRUEFEN="${NUR_PRUEFEN:-0}"

# Die Namen, die der SERVER liest - nicht die, die zufaellig in der Vorlage
# standen. Reihenfolge egal, nur Vollstaendigkeit zaehlt.
SCHLUESSEL=(
  SB_URL SB_ANON_PUB SB_SERVICE_ROLE SB_PUBLISHABLE
  CFS3_ACCESS_KEY CFS3_SECRET_KEY CFR2_ACCOUNT_ID CFS3_BUCKET
  CFS3_ENDPOINT CFS3_PUBLIC_URL
)

# DIESELBEN WERTE UNTER ZWEI NAMEN - und genau daran scheiterte es.
# Der Server liest ueberwiegend `SUPABASE_*` (SUPABASE_URL 11x,
# SUPABASE_ANON_PUB 7x), die Vorlage schrieb aber `SB_*`. Auf dem Knoten stand
# deshalb unter `SB_*` ein Platzhalter und unter `SUPABASE_*` nichts - der
# Dienst hatte also gar keine Datenbank, obwohl die Werte lokal vorliegen.
# Die Zuordnung wird hier ausgeschrieben, damit sie nicht wieder auseinanderlaeuft.
declare -A ZWEITNAME=(
  [SB_URL]=SUPABASE_URL
  [SB_ANON_PUB]=SUPABASE_ANON_PUB
  [SB_SERVICE_ROLE]=SUPABASE_SERVICE_ROLE
)

[ -f "$QUELLE" ] || { echo "❌ $QUELLE nicht gefunden." >&2; exit 2; }
[ -n "$APP_IP" ] || { echo "❌ APP_IP fehlt." >&2; exit 2; }

SSH_OPTS=(-o StrictHostKeyChecking=no -o ConnectTimeout=12 -o BatchMode=yes)

echo "▶ Knoten-.env versorgen ($APP_IP)"

# --- 1. Was hat die Quelle? (nur Laengen) -----------------------------------
echo "--- Quelle $QUELLE ---"
ZEILEN=()
for k in "${SCHLUESSEL[@]}"; do
  v="$(grep -m1 "^${k}=" "$QUELLE" | cut -d= -f2- | tr -d '"' || true)"
  if [ -z "$v" ]; then
    printf "  %-24s fehlt in der Quelle\n" "$k"
  elif printf '%s' "$v" | grep -qE '^<.*>$'; then
    printf "  %-24s selbst ein Platzhalter - uebersprungen\n" "$k"
  else
    printf "  %-24s %s Zeichen\n" "$k" "${#v}"
    ZEILEN+=("${k}=${v}")
    # Denselben Wert zusaetzlich unter dem Namen schreiben, den der Server liest.
    if [ -n "${ZWEITNAME[$k]:-}" ]; then
      ZEILEN+=("${ZWEITNAME[$k]}=${v}")
      printf "  %-24s %s Zeichen (derselbe Wert)\n" "${ZWEITNAME[$k]}" "${#v}"
    fi
  fi
done

if [ "${#ZEILEN[@]}" = "0" ]; then
  echo "❌ Keine brauchbaren Werte in der Quelle." >&2
  exit 1
fi

# --- 2. Ist-Zustand auf dem Knoten (nur Form) -------------------------------
echo "--- Knoten vorher ---"
ssh "${SSH_OPTS[@]}" "root@$APP_IP" "bash -s" <<'FERN' 2>/dev/null | sed 's/^/  /'
for k in SUPABASE_URL SUPABASE_SERVICE_ROLE SB_SERVICE_ROLE CFS3_ACCESS_KEY CFS3_SECRET_KEY CFS3_ENDPOINT; do
  v=$(grep -m1 "^$k=" /opt/audiomonastry/.env | cut -d= -f2-)
  if [ -z "$v" ]; then printf "%-24s FEHLT\n" "$k"
  elif printf %s "$v" | grep -qE '^<.*>$'; then printf "%-24s PLATZHALTER\n" "$k"
  else printf "%-24s echte Laenge %s\n" "$k" "${#v}"; fi
done
FERN

if [ "$NUR_PRUEFEN" = "1" ]; then
  echo "NUR_PRUEFEN=1 - Ende."
  exit 0
fi

# --- 3. Uebertragen (Werte ueber stdin, nie als Argument) -------------------
echo "--- Uebertragen ---"
{
  printf '%s\n' "${ZEILEN[@]}"
} | ssh "${SSH_OPTS[@]}" "root@$APP_IP" "cd $DEPLOY_DIR && cp .env .env.vor-push-env && python3 - <<'PY'
import io, sys
werte = {}
for zeile in sys.stdin:
    zeile = zeile.strip()
    if '=' in zeile:
        k, v = zeile.split('=', 1)
        werte[k] = v
p = '.env'
zeilen = io.open(p, encoding='utf-8').read().splitlines()
gesetzt, ergaenzt = 0, 0
for k, v in werte.items():
    praefix = k + '='
    for i, z in enumerate(zeilen):
        if z.startswith(praefix):
            zeilen[i] = praefix + v; gesetzt += 1; break
        if z.startswith('#' + praefix) or z.startswith('# ' + praefix):
            zeilen[i] = praefix + v; gesetzt += 1; break
    else:
        zeilen.append(praefix + v); ergaenzt += 1
io.open(p, 'w', encoding='utf-8').write('\n'.join(zeilen) + '\n')
print('  ersetzt: %d, ergaenzt: %d' % (gesetzt, ergaenzt))
PY
chmod 600 .env
grep -cE '=<[^>]*>$' .env | sed 's/^/  Platzhalter danach: /'
grep -cE '^[A-Z_]+=$' .env | sed 's/^/  leere Werte danach: /'"

# --- 4. Container neu erzeugen (env_file wird nur dann gelesen) -------------
echo "--- Container neu erzeugen ---"
ssh "${SSH_OPTS[@]}" "root@$APP_IP" \
  "cd $DEPLOY_DIR && docker compose -p audiomonastry -f docker-compose.hetzner.yml up -d audiomonastry 2>&1 | tail -2"
sleep 35

# --- 5. Wirkung messen ------------------------------------------------------
echo "--- Wirkung ---"
SCHLUESSEL_STR="$(printf '%s ' "${SCHLUESSEL[@]}")"
ssh "${SSH_OPTS[@]}" "root@$APP_IP" "cd $DEPLOY_DIR && bash -s" <<FERN 2>/dev/null | sed 's/^/  /'
for k in SUPABASE_URL SUPABASE_SERVICE_ROLE SB_SERVICE_ROLE CFS3_ACCESS_KEY CFS3_SECRET_KEY; do
  v=\$(grep -m1 "^\$k=" .env | cut -d= -f2-)
  if [ -z "\$v" ]; then printf "%-24s FEHLT\n" "\$k"
  elif printf %s "\$v" | grep -qE '^<.*>\$'; then printf "%-24s PLATZHALTER\n" "\$k"
  else printf "%-24s echte Laenge %s\n" "\$k" "\${#v}"; fi
done
printf "im Container SUPABASE_URL: %s Zeichen\n" "\$(docker exec audiomonastry printenv SUPABASE_URL 2>/dev/null | wc -c)"
printf "im Container CFS3_ACCESS_KEY: %s Zeichen\n" "\$(docker exec audiomonastry printenv CFS3_ACCESS_KEY 2>/dev/null | wc -c)"
FERN

echo "✅ Fertig. Die Wirkung auf Upload und Datenbank wird separat gemessen."
