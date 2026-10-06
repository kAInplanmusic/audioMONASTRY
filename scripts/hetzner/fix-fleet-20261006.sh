#!/usr/bin/env bash
# =============================================================================
# fix-fleet-20261006.sh — Flotte erreichbar machen (3 Blocker aus dem 1. Lauf)
# -----------------------------------------------------------------------------
# BEFUNDE aus dem Flottenstart 2026-10-06 (verifiziert am Knoten, nicht am Log):
#   1. app-1:  STUDIO_ACCESS_TOKEN fehlte im Container -> API fail-closed
#              (503 STUDIO_TOKEN_MISSING). Ursache: die Remote-.env stammt aus
#              dem PORTAL-Pfad und traegt den Token nur, wenn er im
#              Portal-Secret steht; deploy.sh laeuft mit DEPLOY_SYNC_ENV=0 und
#              korrigiert das nicht.
#   2. sfu-1/media-1: 0 Images. Das caddy-DNS-Image wird NUR auf app-1 gebaut,
#              jeder Compose-Start mit `caddy` bricht dort ab
#              ('pull access denied for audiomonastry-caddy-dns').
#   3. app-1:  Caddy-Bootstrap lief in Schritt 5/9 VOR dem Image-Bau (5b/9).
#
# Dieses Skript ist IDEMPOTENT und aendert NICHTS am Repo.
# Aufruf:  bash fix-fleet-20261006.sh
# =============================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

# --- Konfiguration aus .env.deploy (TOKEN/DOMAIN/SSH-Key) ---------------------
[ -f .env.deploy ] && set -a && . ./.env.deploy && set +a
: "${HCLOUD_TOKEN:?HCLOUD_TOKEN fehlt}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
DOMAIN="${DOMAIN:-anunnakitools.de}"
export HCLOUD_TOKEN

SSH=(ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -o BatchMode=yes)

api_ip() {  # api_ip <name>
  curl -s -H "Authorization: Bearer $HCLOUD_TOKEN" \
    "https://api.hetzner.cloud/v1/servers?name=$1" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); s=d['servers'][0] if d['servers'] else None; print(s['public_net']['ipv4']['ip'] if s else '')"
}

log() { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }

APP_IP="$(api_ip audiomonastry-app-1)"
SFU_IP="$(api_ip audiomonastry-sfu-1)"
MEDIA_IP="$(api_ip audiomonastry-media-1)"
EDGE_IP="$(api_ip audiomonastry-edge-1)"
[ -n "$APP_IP" ] && [ -n "$SFU_IP" ] && [ -n "$MEDIA_IP" ] && [ -n "$EDGE_IP" ] || {
  echo "Nicht alle 4 Knoten gefunden (app=$APP_IP sfu=$SFU_IP media=$MEDIA_IP edge=$EDGE_IP)" >&2; exit 1; }
echo "app=$APP_IP sfu=$SFU_IP media=$MEDIA_IP edge=$EDGE_IP"

# --- Hilfsfunktion: baut das rollen-skopierte .env ----------------------------
# Quelle ist die lokale .env.deploy (Betreiber-Quelle). Rollen-Regeln exakt wie
# services/portal-worker/src/index.js envFile(): der Studio-Token gehoert NUR auf
# die Rolle app; SFU/EDGE bekommen DOMAIN aus der SFU-Signalisierung.
build_env() {  # build_env <role> <host> > /tmp/fleet.env
  ENV_DEPLOY="$ROOT/.env.deploy" python3 - "$1" "$2" "$DOMAIN" <<'PY'
import os, sys, pathlib
role, host, domain = sys.argv[1], sys.argv[2], sys.argv[3]
src = pathlib.Path(os.environ['ENV_DEPLOY']).read_text(encoding='utf-8', errors='replace')
env = {}
for line in src.splitlines():
    s = line.strip()
    if not s or s.startswith('#') or '=' not in s:
        continue
    k, _, v = s.partition('=')
    env[k.strip()] = v.strip().strip('"').strip("'")
out = [f"DOMAIN={domain if role == 'app' else (host if role == 'sfu' else '')}"]
if role == 'app':
    tok = env.get('STUDIO_ACCESS_TOKEN', '')
    if not tok or tok == 'change-me':
        sys.exit('STUDIO_ACCESS_TOKEN fehlt in .env.deploy - Betreiber muss ihn setzen')
    out += [f"STUDIO_ACCESS_TOKEN={tok}", "TRUST_PROXY=1",
            "VOICE_PROVIDER=replicate", "STEM_AI_PROVIDER=replicate", "ENABLE_SFU=0"]
# gemeinsame Schluessel, die die App/SFU/Media/Edge-Laufzeit braucht
COMMON = ['NODE_ENV','AI_MODE','SIGNALING_ALLOWED_ORIGINS','R2_ACCOUNT_ID','R2_ACCESS_KEY_ID',
          'R2_SECRET_ACCESS_KEY','R2_BUCKET','R2_ENDPOINT','CFS3_ACCESS_KEY','CFS3_SECRET_KEY',
          'CFS3_ENDPOINT','CFS3_BUCKET','SUPABASE_URL','SUPABASE_ANON_KEY','SUPABASE_SERVICE_KEY',
          'OPENAI_API_KEY','DEEPSEEK_API_KEY','GROQ_API_KEY','MISTRAL_API_KEY','REPLICATE_API_TOKEN',
          'HF_TOKEN','CLOUDFLARE_API_TOKEN','SESSION_SECRET','TURN_STATIC_AUTH_SECRET']
for k in COMMON:
    v = env.get(k)
    if v:
        out.append(f"{k}={v}")
sys.stdout.write('\n'.join(out) + '\n')
PY
}

# =============================================================================
log "1/4 app-1: rollen-skopierte .env schreiben (Studio-Token + TRUST_PROXY)"
# Backup der vorhandenen Remote-.env, dann ersetzen (Werte werden nie gedruckt).
"${SSH[@]}" "root@$APP_IP" 'cp -n /opt/audiomonastry/.env /opt/audiomonastry/.env.bak-prefix 2>/dev/null; true'
build_env app "$APP_IP" > /tmp/fleet-app.env 2>/tmp/fleet-app.err || { cat /tmp/fleet-app.err >&2; exit 1; }
scp -q -i "$SSH_KEY" -o BatchMode=yes /tmp/fleet-app.env "root@$APP_IP:/opt/audiomonastry/.env"
shred -u /tmp/fleet-app.env 2>/dev/null || rm -f /tmp/fleet-app.env
echo "  .env geschrieben: $(grep -c '=' /tmp/fleet-app.err >/dev/null 2>&1; "${SSH[@]}" "root@$APP_IP" 'grep -c "=" /opt/audiomonastry/.env') Zeilen"
"${SSH[@]}" "root@$APP_IP" 'awk -F= "/^STUDIO_ACCESS_TOKEN=/{print \"  Studio-Token gesetzt, Laenge:\", length(\$2)}" /opt/audiomonastry/.env'

# =============================================================================
log "2/4 caddy-DNS-Image auf ALLE Knoten bringen (xcaddy + cloudflare)"
# Auf sfu-1/media-1 bauen (dort fehlt es komplett) - identischer Dockerfile.
for spec in "sfu $SFU_IP" "media $MEDIA_IP"; do
  set -- $spec; role="$1"; ip="$2"
  echo "  --- $role ($ip) ---"
  "${SSH[@]}" "root@$ip" "cd /opt/audiomonastry 2>/dev/null || cd /opt; mkdir -p .caddybuild && cat > .caddybuild/Dockerfile <<'DOCKER'
FROM caddy:2.9-builder AS builder
RUN xcaddy build --with github.com/caddy-dns/cloudflare
FROM caddy:2.9-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
DOCKER
cd .caddybuild && docker build -t audiomonastry-caddy-dns:2.9 . 2>&1 | tail -2 && docker run --rm audiomonastry-caddy-dns:2.9 caddy list-modules 2>/dev/null | grep -q dns.providers.cloudflare && echo '  ✓ Caddy-Image mit Cloudflare-DNS bereit'" \
    || echo "  ⚠ Image-Bau auf $role fehlgeschlagen"
done

# =============================================================================
log "3/4 Compose auf sfu-1 + media-1 starten"
"${SSH[@]}" "root@$SFU_IP" "cd /opt/audiomonastry && COMPOSE_PROJECT_NAME=audiomonastry docker compose -f docker-compose.hetzner.yml -f docker-compose.sfu.yml up -d caddy audiomonastry 2>&1 | tail -5"
"${SSH[@]}" "root@$MEDIA_IP" "cd /opt/audiomonastry && COMPOSE_PROJECT_NAME=audiomonastry docker compose -f docker-compose.hetzner.yml up -d caddy audiomonastry 2>&1 | tail -5"

# =============================================================================
log "4/4 app-1 neu starten (neue .env greifen lassen) + Zertifikatspfad pruefen"
"${SSH[@]}" "root@$APP_IP" "cd /opt/audiomonastry && COMPOSE_PROJECT_NAME=audiomonastry docker compose -f docker-compose.hetzner.yml up -d caddy audiomonastry 2>&1 | tail -5"
# Origin-Zertifikat vorhanden? Sonst laeuft Caddy in eine Restart-Schleife.
"${SSH[@]}" "root@$APP_IP" 'ls -la /opt/audiomonastry/certs/ 2>/dev/null | tail -4; echo "--- Caddyfile-TLS-Modus ---"; grep -nE "tls|acme" /opt/audiomonastry/Caddyfile 2>/dev/null | head -5'

log "Warte 20 s auf Container-Start"
sleep 20
for spec in "app $APP_IP" "sfu $SFU_IP" "media $MEDIA_IP"; do
  set -- $spec; role="$1"; ip="$2"
  echo "--- $role ($ip) ---"
  "${SSH[@]}" "root@$ip" "docker ps --format '{{.Names}} {{.Status}}' | head -6"
done

log "HTTP-Pruefung (lokal auf app-1, ohne Cloudflare)"
"${SSH[@]}" "root@$APP_IP" 'curl -s -o /dev/null -w "  https://localhost/api/health -> %{http_code}\n" -k --resolve '"$DOMAIN"':443:127.0.0.1 https://'"$DOMAIN"'/api/health 2>&1; curl -s -k --resolve '"$DOMAIN"':443:127.0.0.1 https://'"$DOMAIN"'/api/health 2>&1 | head -c 300; echo'
echo
echo "Fertig. Gegenprobe von hier: curl -s https://$DOMAIN/api/health"
