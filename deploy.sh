#!/usr/bin/env bash
# ============================================================================
# deploy.sh – audioMONASTRY high-end deploy auf Hetzner (Google/Firebase-frei)
# ----------------------------------------------------------------------------
# Zwei Modi:
#   docker (Default, schnell):  Image wird LOKAL gebaut, per `docker save |
#                               ssh docker load` übertragen und remote nur noch
#                               gestartet (kein zweiter Remote-Build, kein
#                               npm ci auf dem VPS). Fallback: Remote-Build.
#   node:                       rsync + `scripts/hetzner/start-prod.sh` remote.
#
# Ablauf (docker):
#   1. Docker-Images lokal bauen (audiomonastry + master-player)
#   2. Remote-Rollback-Image sichern (audiomonastry:hetzner-rollback)
#   3. Images via `docker save | ssh docker load` übertragen
#   4. Config (Compose, Services, .env) per rsync übertragen
#   5. Remote: docker compose up -d --no-build
#   6. Health-Wait + Smoke-Test + Rollback-Hinweis
#
# Voraussetzungen:
#   - Ausfuehrbar machen:  chmod +x deploy.sh
#   - Ziel definieren via env (alternativ in .env.deploy):
#        DEPLOY_HOST=1.2.3.4                 (oder root@1.2.3.4)
#        DEPLOY_DOMAIN=audiomonastry.example    (Pflicht für iOS-Mikrofon/HTTPS)
#        DEPLOY_SSH_KEY=/pfad/zum/key
#        DEPLOY_MODE=docker|node             (Voreinstellung: docker)
#        DEPLOY_REMOTE_BUILD=1               (1 = Remote-Build statt Image-Transfer)
#        DEPLOY_SYNC_ENV=1|0                 (1 = lokale .env hochladen, Default 0)
#        DEPLOY_SMOKE=1|0                    (1 = Smoke-Test nach Deploy)
#        DEPLOY_VERSION=1.210.001            (optional: Versionsstempel ueberschreiben)
#        DEPLOY_COMMIT=ae5e749               (optional: Commit-Stempel ueberschreiben,
#                                             z. B. Rollback-Drill auf einen alten Stand)
#        DEPLOY_ALLOW_STALE=1                (optional: abweichenden Stand BEWUSST erlauben)
#        DEPLOY_REMOTE_DIR=/opt/audiomonastry
#        DEPLOY_PLATFORM=linux/amd64         (optional, Cross-Build via buildx)
#        DEPLOY_PRINT_CONFIG=1               (nur Konfiguration ausgeben, dann Ende)
#        ORIGIN_CERT / ORIGIN_KEY            (base64-kodiert, Cloudflare-Origin-Paar:
#                                             wird als certs/origin.crt|key installiert)
#        DEPLOY_INSTALL_CADDYFILE=1          (ACME-Notausgang, siehe INFRA-HETZNER-002)
#
#   - Auf der Ziel-Instanz muss Docker (Compose v2) installiert sein:
#        scripts/hetzner/provision.py erledigt das automatisch per Cloud-Init.
#
# INFRA-HETZNER-001 - warum DEPLOY_SYNC_ENV per Default 0 ist:
#   Die .env auf einem Flotten-Knoten gehoert dem Portal-Worker und ist
#   ROLLEN-SKOPIERT (services/portal-worker/src/index.js, envFile(): pro Rolle
#   nur die noetigen Schluessel, TRUST_PROXY=1 z. B. ausschliesslich fuer die
#   Rolle app). Die lokale Repo-.env enthaelt dagegen ALLES (Supabase, R2,
#   Replicate, Studio-Token ...). Ein Sync hebt damit die Rollentrennung auf und
#   ersetzt Produktionswerte durch Entwicklerwerte - und zwar bei JEDEM
#   Flottenstart. Wer bewusst synchronisieren will (frischer Knoten ohne Portal),
#   setzt DEPLOY_SYNC_ENV=1: dann wird die vorhandene Remote-.env vorher nach
#   .env.bak-predeploy gesichert und das Skript sagt laut, was es ueberschreibt.
#
# INFRA-HETZNER-002 - warum der ORIGIN-PFAD der Default eines Rollen-Deploys ist:
#   app-1 faehrt Origin-TLS hinter dem Cloudflare-Portal-Worker. Caddy terminiert
#   TLS selbst mit dem Cloudflare-Origin-Zertifikat (scripts/hetzner/Caddyfile.origin,
#   tls-Direktive auf /etc/caddy/certs/origin.crt|key, Compose mountet
#   ./certs:/etc/caddy/certs:ro). Let's-Encrypt-ACME kann hinter der Worker-Route
#   NICHT validieren: http-01/tls-alpn-01 laufen dort in eine Retry-Schleife.
#   Ein Deploy bringt den Knoten deshalb in genau diesen Zustand:
#     1. rsync schliesst 'Caddyfile' weiter aus (der Worker-Pfad soll nicht
#        beilaeufig ueberschrieben werden),
#     2. stattdessen wird scripts/hetzner/Caddyfile.origin per scp nach
#        $DEPLOY_REMOTE_DIR/Caddyfile kopiert (Origin-TLS),
#     3. stehen ORIGIN_CERT/ORIGIN_KEY im env (base64), wird das Paar VOR dem
#        Caddy-Start nach certs/origin.crt|key dekodiert (600, Verzeichnis 700).
#   Fehlen die Variablen, gibt es KEINEN stillen ACME-Fallback: die Meldung nennt
#   die Betreiber-Schritte und dass Caddy ohne Zertifikat in eine Restart-Schleife
#   laeuft (details: docs/ORIGIN_TLS_DNS_RUNBOOK.md).
#   DEPLOY_INSTALL_CADDYFILE=1 bleibt der ausdrueckliche ACME-Notausgang: er laedt
#   das Repo-Caddyfile (automatisches ACME) und ersetzt damit die Origin-Variante.
#
# PROD-P1-F4 - warum der Deploy den COMMIT prueft (nicht nur die Version):
#   Am 2026-09-20 lief auf app-1 ein Image vom 18.09., waehrend das Repo auf
#   ae5e749 (20.09.) stand. /api/health nannte nur eine Version, die sich nicht
#   mit jedem Commit aendert - der Drift blieb unbemerkt. Deshalb:
#     1. Commit + Build-Zeit gehen als Build-Args ins Image (Dockerfile.hetzner,
#        AUDIOMONASTRY_COMMIT/AUDIOMONASTRY_BUILD_TIME), /api/health nennt sie.
#     2. Nach Health + Smoke vergleicht deploy.sh den gemeldeten Commit mit dem
#        Repo-Commit (scripts/hetzner/lib/build-parity.sh - dieselbe Bibliothek
#        wie fleet-preflight.sh und die Tests). Eine Abweichung beendet den
#        Deploy mit Exit 1.
#     3. "Nicht pruefbar" (Image ohne commit-Feld) blockiert NICHT, wird aber laut
#        gemeldet. Bewusst veraltet weiterfahren: DEPLOY_ALLOW_STALE=1.
#
# F10 - warum der Rollen-Deploy den Compose-PROJEKTNAMEN explizit setzt:
#   Der Projektname kam bisher aus dem Verzeichnisnamen (`cd <dir> && docker
#   compose ...`). Ein Knoten, dessen Repo in einem anders benannten Verzeichnis
#   liegt, bekam damit ein ZWEITES Projekt: eigene Volumes (`<alt>_caddy_data`),
#   eigene Container-Labels - waehrend die Container-Namen (container_name)
#   gleich blieben und der Watchdog die Altinstallation nicht mehr fand. Jetzt
#   gilt ueberall `COMPOSE_PROJECT_NAME=audiomonastry` (aus
#   scripts/hetzner/fleet-names.sh, dieselbe Quelle wie das top-level `name:` in
#   docker-compose.hetzner.yml und der Zielpfad /opt/audiomonastry). Ein zweiter
#   Deploy trifft damit immer dasselbe Projekt, dieselben Volumes und dieselben
#   Container - idempotent, ohne zweiten Stack. Migration eines Bestands-Knotens
#   (Altprojekt/Altpfad): scripts/hetzner/migrate-project-name.sh, Schritte in
#   docs/HETZNER_DEPLOY.md.
# ============================================================================
set -euo pipefail

# PROD-P1-F4: Commit-Paritaet als EINE Shell-Umsetzung. deploy.sh,
# scripts/hetzner/fleet-preflight.sh und tests/test_hetzner_scripts.py nutzen
# dieselbe Bibliothek - kein zweiter Vergleich, der etwas anderes behaupten kann.
# shellcheck source=scripts/hetzner/lib/build-parity.sh
DEPLOY_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$DEPLOY_SCRIPT_DIR/scripts/hetzner/lib/build-parity.sh"
# F10: Namen/Pfade kommen aus der EINEN Quelle (scripts/hetzner/fleet-names.sh) -
# Projektname, kanonischer Pfad und die Alt-Schreibweisen der Container sind dort
# definiert, nicht hier. Sourcing ist seiteneffektfrei (keine API-Aufrufe).
# shellcheck disable=SC1091
source "$DEPLOY_SCRIPT_DIR/scripts/hetzner/fleet-names.sh"

# --- Konfiguration (aus env, sonst Prompt) ---
DEPLOY_HOST="${DEPLOY_HOST:-}"
DEPLOY_USER="${DEPLOY_USER:-root}"
DEPLOY_SSH_KEY="${DEPLOY_SSH_KEY:-}"
DEPLOY_MODE="${DEPLOY_MODE:-docker}"
DEPLOY_REMOTE_BUILD="${DEPLOY_REMOTE_BUILD:-0}"
DEPLOY_REMOTE_DIR="${DEPLOY_REMOTE_DIR:-$FLEET_HOME}"
# F10: Der Compose-PROJEKTNAME ist nicht mehr vom Verzeichnisnamen abhaengig.
# Er kommt aus fleet-names.sh und geht als COMPOSE_PROJECT_NAME an jeden
# docker-compose-Aufruf auf dem Knoten; docker-compose.hetzner.yml traegt
# denselben Wert als top-level `name:` (Gegenprobe in den Tests). Idempotent:
# ein zweiter Deploy trifft dasselbe Projekt, dieselben Volumes, dieselben
# Container - kein zweiter Stack.
COMPOSE_PROJECT="$(fleet_compose_project)"
DEPLOY_DOMAIN="${DEPLOY_DOMAIN:-}"
# INFRA-HETZNER-001: Default 0 - die Knoten-.env gehoert dem Portal-Worker
# (rollen-skopiert, siehe Kopfkommentar). Sync nur explizit per DEPLOY_SYNC_ENV=1.
DEPLOY_SYNC_ENV="${DEPLOY_SYNC_ENV:-0}"
DEPLOY_SMOKE="${DEPLOY_SMOKE:-1}"
DEPLOY_PLATFORM="${DEPLOY_PLATFORM:-}"
# INFRA-HETZNER-002: 1 = ACME-Notausgang - das Repo-Caddyfile (automatisches ACME)
# bewusst auf den Knoten laden und damit die Origin-TLS-Variante ersetzen.
# Default 0: Origin-Pfad (Caddyfile.origin + Zertifikatspaar aus dem env).
DEPLOY_INSTALL_CADDYFILE="${DEPLOY_INSTALL_CADDYFILE:-0}"
# Effektiver Caddyfile-Modus: 'origin' (Default) oder 'acme' (Notausgang). Genau
# eine Quelle fuer Meldung, Trockenlauf und Installationsblock - so kann kein
# zweiter Pfad entstehen, der etwas anderes behauptet als er tut.
if [[ "$DEPLOY_INSTALL_CADDYFILE" == "1" ]]; then
  CADDYFILE_MODE="acme"
else
  CADDYFILE_MODE="origin"
fi
# ORIGIN_CERT/ORIGIN_KEY (base64, wie in .env.portal): hier nur ein BOOLEAN, ob
# beide gesetzt sind. Die Werte selbst werden nie ausgegeben, geloggt oder als
# Kommandozeilen-Argument uebergeben - sie laufen ausschliesslich durch Pipes.
if [[ -n "${ORIGIN_CERT:-}" && -n "${ORIGIN_KEY:-}" ]]; then
  ORIGIN_CERTS_IN_ENV="ja"
else
  ORIGIN_CERTS_IN_ENV="nein"
fi
IMAGE_APP="audiomonastry:hetzner"
IMAGE_MASTER="audiomonastry-master-player:hetzner"
COMPOSE_FILE="docker-compose.hetzner.yml"

# PROD-P1-F4: Staleness-Gate. 0 = eine Commit-Abweichung zwischen laufendem
# Container und Repo laesst den Deploy mit Exit 1 enden; 1 = der Betreiber
# erlaubt den abweichenden Stand BEWUSST (die Meldung bleibt laut).
DEPLOY_ALLOW_STALE="${DEPLOY_ALLOW_STALE:-0}"

# PROD-P1-F4: Build-Metadaten fuer die Commit-Paritaet.
#   APP_VERSION  Release-Version (PROD-P0-003, package.json; DEPLOY_VERSION ueberschreibt)
#   APP_COMMIT   kurzer Commit-SHA des Repo-Stands, der ins Image gebaut wird
#   BUILD_TIME   Build-Zeit (UTC, ISO-8601)
# Alle drei gehen als Build-Args ins Image (Dockerfile.hetzner) und kommen aus
# /api/health zurueck. Ohne Commit ist "laeuft die Flotte auf dem Repo-Stand?"
# nicht beantwortbar - genau daran blieb der Drift vom 2026-09-20 unbemerkt.
APP_VERSION="${DEPLOY_VERSION:-$(node -p "require('./package.json').version" 2>/dev/null || echo dev)}"
APP_COMMIT="${DEPLOY_COMMIT:-$(git rev-parse --short HEAD 2>/dev/null || echo unknown)}"
BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Trockenlauf fuer Nachweise (INFRA-HETZNER-001/002): gibt die effektive
# Konfiguration aus und endet VOR Build/SSH - die Default-Aufloesung ist damit
# ohne Ziel-Instanz pruefbar (und ohne versehentlichen Deploy). Weil hier auch der
# Caddyfile-Modus und die Boolean-Zusage zu den Origin-Zertifikaten stehen, laesst
# sich der Origin-Default ohne Knoten nachweisen. Es werden KEINE Werte ausgegeben.
if [[ "${DEPLOY_PRINT_CONFIG:-0}" == "1" ]]; then
  echo "deploy.sh - effektive Konfiguration (kein Build, kein SSH)"
  printf '  DEPLOY_HOST=%s\n' "${DEPLOY_HOST:-<leer>}"
  printf '  DEPLOY_MODE=%s\n' "$DEPLOY_MODE"
  printf '  DEPLOY_REMOTE_DIR=%s\n' "$DEPLOY_REMOTE_DIR"
  # F10: der effektive Compose-Projektname des Rollen-Deploys. Belegt ohne
  # Knoten, dass der Deploy nicht mehr am Verzeichnisnamen haengt.
  printf '  COMPOSE_PROJECT_NAME=%s   (aus scripts/hetzner/fleet-names.sh)\n' "$COMPOSE_PROJECT"
  printf '  DEPLOY_SYNC_ENV=%s\n' "$DEPLOY_SYNC_ENV"
  printf '  DEPLOY_INSTALL_CADDYFILE=%s\n' "$DEPLOY_INSTALL_CADDYFILE"
  printf '  CADDYFILE_MODUS=%s\n' "$CADDYFILE_MODE"
  printf '  Origin-Zertifikate im env vorhanden: %s\n' "$ORIGIN_CERTS_IN_ENV"
  printf '  DEPLOY_REMOTE_BUILD=%s\n' "$DEPLOY_REMOTE_BUILD"
  printf '  DEPLOY_SMOKE=%s\n' "$DEPLOY_SMOKE"
  printf '  DEPLOY_ALLOW_STALE=%s\n' "$DEPLOY_ALLOW_STALE"
  printf '  DEPLOY_DOMAIN=%s\n' "${DEPLOY_DOMAIN:-<leer>}"
  # PROD-P1-F4: genau die Werte, die als Build-Args ins Image gehen - damit ist
  # der Commit-Stempel ohne Build/Docker pruefbar (kein Secret enthalten).
  printf '  BUILD_VERSION=%s\n' "$APP_VERSION"
  printf '  BUILD_COMMIT=%s\n' "$APP_COMMIT"
  printf '  BUILD_TIME=%s\n' "$BUILD_TIME"
  exit 0
fi

if [[ -z "$DEPLOY_HOST" ]]; then
  echo -n "Ziel-Host (IP oder Domain, ohne user@): "
  read -r DEPLOY_HOST
fi
if [[ -z "$DEPLOY_SSH_KEY" ]]; then
  DEPLOY_SSH_KEY="$HOME/.ssh/id_ed25519"
fi
if [[ ! -f "$DEPLOY_SSH_KEY" ]]; then
  echo "SSH-Key nicht gefunden: $DEPLOY_SSH_KEY"
  echo -n "Pfad zum SSH-Key: "
  read -r DEPLOY_SSH_KEY
fi

# DEPLOY_HOST kann "1.2.3.4" oder "root@1.2.3.4" sein
if [[ "$DEPLOY_HOST" == *"@"* ]]; then
  SSH_TARGET="$DEPLOY_HOST"
else
  SSH_TARGET="$DEPLOY_USER@$DEPLOY_HOST"
fi

SSH=(ssh -i "$DEPLOY_SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)
SCP_OPTS=(-i "$DEPLOY_SSH_KEY" -o StrictHostKeyChecking=accept-new)

# PROD-P0-003 / PROD-P1-F4: Die Build-Metadaten (Version, Commit, Build-Zeit)
# stehen oben bei APP_VERSION/APP_COMMIT/BUILD_TIME und gehen hier als Build-Args
# ins Image. DEPLOY_VERSION/DEPLOY_COMMIT ueberschreiben sie bewusst (z. B. fuer
# einen Rollback-Drill auf einen aelteren Stand) - ohne die package.json oder das
# Repo anzufassen.
docker_build() {
  local dockerfile="$1" tag="$2" context="$3"
  local args=(--build-arg "BUILD_VERSION=$APP_VERSION"
              --build-arg "BUILD_COMMIT=$APP_COMMIT"
              --build-arg "BUILD_TIME=$BUILD_TIME")
  if [[ -n "$DEPLOY_PLATFORM" ]] && docker buildx version >/dev/null 2>&1; then
    docker buildx build --platform "$DEPLOY_PLATFORM" -t "$tag" -f "$dockerfile" "$context" "${args[@]}" --load
  else
    docker build -t "$tag" -f "$dockerfile" "$context" "${args[@]}"
  fi
}

wait_health() {
  local base_url="$1" attempts="${2:-30}" delay="${3:-4}"
  if ! command -v curl >/dev/null 2>&1; then
    echo "⚠️  curl fehlt lokal – Health-Wait übersprungen."
    return 0
  fi
  echo "--- Warte auf $base_url/api/health (max. $(( attempts * delay ))s) ---"
  for _ in $(seq 1 "$attempts"); do
    if curl -fsS "$base_url/api/health" >/dev/null 2>&1; then
      echo "✅ Health-Check OK: $base_url/api/health"
      return 0
    fi
    sleep "$delay"
  done
  echo "❌ Health-Check fehlgeschlagen: $base_url/api/health" >&2
  return 1
}

echo "=== [1/5] Images lokal bauen ==="
if [[ "$DEPLOY_MODE" == "docker" && "$DEPLOY_REMOTE_BUILD" != "1" ]]; then
  if ! command -v docker >/dev/null 2>&1; then
    echo "docker lokal nicht gefunden -> Fallback auf Remote-Build."
    DEPLOY_REMOTE_BUILD=1
  else
    docker_build Dockerfile.hetzner "$IMAGE_APP" .
    docker_build services/master-player/Dockerfile "$IMAGE_MASTER" services/master-player
  fi
else
  echo "Überspringe lokalen Build (Remote-Build oder node-Modus)."
fi

echo "=== [2/5] Remote-Verzeichnis vorbereiten ($SSH_TARGET:$DEPLOY_REMOTE_DIR) ==="
"${SSH[@]}" "$SSH_TARGET" "mkdir -p $DEPLOY_REMOTE_DIR"

echo "=== [3/5] Config + Build-Kontext hochladen (rsync) ==="
# INFRA-HETZNER-002: 'Caddyfile' steht bewusst NICHT in der Liste - die Datei auf
# app-1 ist die Origin-TLS-Variante des Portal-Workers (Caddyfile.origin) und darf
# von einem Deploy nicht auf die ACME-Variante zurueckgedreht werden. Ein bewusster
# Wechsel laeuft ueber DEPLOY_INSTALL_CADDYFILE=1 (siehe unten).
RSYNC_EXCLUDES=(
  --exclude '.git' --exclude 'node_modules' --exclude 'dist' --exclude 'coverage'
  --exclude 'test-results' --exclude 'deepcode' --exclude '.continue'
  --exclude '.env' --exclude '.env.deploy'
  --exclude 'Caddyfile'
  --exclude 'public/models' --exclude 'public/music'
  --exclude 'public/data/orchestral' --exclude 'services/audio-runtime/target'
  --exclude 'target' --exclude '.venv-runpod' --exclude '.agents' --exclude 'logs'
)
if command -v rsync >/dev/null 2>&1; then
  rsync -az "${RSYNC_EXCLUDES[@]}" -e "${SSH[*]}" \
    ./ "$SSH_TARGET:$DEPLOY_REMOTE_DIR/"
else
  echo "rsync fehlt? Nutze scp-Fallback ..."
  "${SSH[@]}" "$SSH_TARGET" "rm -rf $DEPLOY_REMOTE_DIR"
  # Auch hier OHNE ./Caddyfile (gleicher Grund wie im rsync-Ausschluss oben).
  scp "${SCP_OPTS[@]}" -r \
    ./src ./public ./assets ./server ./services ./scripts ./database ./docs \
    ./package.json ./package-lock.json ./Dockerfile.hetzner \
    ./docker-compose.hetzner.yml ./docker-compose.sfu.yml \
    ./docker-compose.monitoring.yml ./docker-compose.fleet-test.yml \
    ./index.html \
    ./vite.config.ts ./tsconfig.json ./build-worklets.mjs ./vitest.config.ts \
    ./.dockerignore ./.env.hetzner.example \
    "$SSH_TARGET:$DEPLOY_REMOTE_DIR/"
fi

# --- Caddyfile + Origin-Zertifikate (INFRA-HETZNER-002) ---------------------
# Origin-Pfad ist der Default: scripts/hetzner/Caddyfile.origin wird installiert
# (der rsync-Ausschluss oben haelt das Repo-Caddyfile bewusst draussen, damit der
# Worker-Pfad nicht beilaeufig ueberschrieben wird). Beides - Caddyfile UND
# Zertifikatspaar - liegt danach VOR `docker compose up -d caddy`, sonst startet
# Caddy in eine Restart-Schleife.
ORIGIN_CERT_INSTALLED="nein"
if [[ "$CADDYFILE_MODE" == "acme" ]]; then
  echo "⚠️  ACME-Notausgang (DEPLOY_INSTALL_CADDYFILE=1): das Repo-Caddyfile (ACME) ersetzt die Origin-TLS-Variante auf $SSH_TARGET"
  echo "    Hinter der Cloudflare-Worker-Route kann ACME nicht validieren (http-01/tls-alpn-01) - nur bewusst verwenden."
  scp "${SCP_OPTS[@]}" ./Caddyfile "$SSH_TARGET:$DEPLOY_REMOTE_DIR/Caddyfile"
else
  echo "--- Caddyfile-Modus origin: scripts/hetzner/Caddyfile.origin -> $SSH_TARGET:$DEPLOY_REMOTE_DIR/Caddyfile ---"
  scp "${SCP_OPTS[@]}" ./scripts/hetzner/Caddyfile.origin "$SSH_TARGET:$DEPLOY_REMOTE_DIR/Caddyfile"
  if [[ -z "$DEPLOY_DOMAIN" ]]; then
    # Caddyfile.origin nutzt `{$DOMAIN}` als Site-Adresse. Ohne Domain bleibt sie
    # leer und Caddy laedt die Konfiguration nicht (Restart-Schleife) - der
    # IP-/HTTP-Testfall braucht bewusst die ACME-Variante (:80-Fallback).
    echo "⚠️  kein DEPLOY_DOMAIN gesetzt: Caddyfile.origin hat ohne Domain keine Site-Adresse." >&2
    echo "    Fuer einen reinen IP-/HTTP-Test bewusst: DEPLOY_INSTALL_CADDYFILE=1 bash $0" >&2
  fi
  if [[ "$ORIGIN_CERTS_IN_ENV" == "ja" ]]; then
    # Secrets laufen NUR durch Pipes in ein Remote-Kommando mit umask 077: kein
    # Argument (das stuende in der Prozessliste), kein echo, kein Log.
    "${SSH[@]}" "$SSH_TARGET" "mkdir -p $DEPLOY_REMOTE_DIR/certs && chmod 700 $DEPLOY_REMOTE_DIR/certs"
    if printf '%s\n' "$ORIGIN_CERT" | base64 -d | "${SSH[@]}" "$SSH_TARGET" "umask 077; cat > $DEPLOY_REMOTE_DIR/certs/origin.crt" \
       && printf '%s\n' "$ORIGIN_KEY" | base64 -d | "${SSH[@]}" "$SSH_TARGET" "umask 077; cat > $DEPLOY_REMOTE_DIR/certs/origin.key"; then
      "${SSH[@]}" "$SSH_TARGET" "chmod 600 $DEPLOY_REMOTE_DIR/certs/origin.crt $DEPLOY_REMOTE_DIR/certs/origin.key"
      ORIGIN_CERT_INSTALLED="ja"
    else
      echo "❌ ORIGIN_CERT/ORIGIN_KEY liessen sich nicht dekodieren oder schreiben (base64/SSH-Fehler)." >&2
      echo "   Caddy hat damit kein Zertifikat und laeuft in eine Restart-Schleife." >&2
      echo "   Betreiber-Schritte: docs/ORIGIN_TLS_DNS_RUNBOOK.md" >&2
    fi
  elif "${SSH[@]}" "$SSH_TARGET" "test -s $DEPLOY_REMOTE_DIR/certs/origin.crt && test -s $DEPLOY_REMOTE_DIR/certs/origin.key"; then
    # Kein stiller Fallback: hier wird nur GEPRUEFT, dass der Knoten die Zertifikate
    # schon hat (Flottenstart/Portal-Worker) - geschrieben wird nichts.
    echo "   Hinweis: ORIGIN_CERT/ORIGIN_KEY sind nicht im env; die vorhandenen Zertifikate auf dem Knoten bleiben unveraendert."
    ORIGIN_CERT_INSTALLED="ja"
  else
    # Der gefaehrliche Fall: Origin-TLS-Caddyfile, aber kein Zertifikat. Laut sagen,
    # NICHT still auf ACME umschalten (das kann hinter dem Worker nie validieren).
    echo "❌ ORIGIN_CERT/ORIGIN_KEY fehlen im env und $DEPLOY_REMOTE_DIR/certs ist leer (kein ACME-Fallback)." >&2
    echo "   Caddy startet ohne Zertifikat in eine Restart-Schleife - die Domain bleibt 522/525." >&2
    echo "   Betreiber-Schritte (Origin-TLS nachziehen):" >&2
    echo "     1. Zertifikatspaar im env bereitstellen (base64, z. B. aus .env.portal):" >&2
    echo "        set -a; . ./.env.portal; set +a   # Werte dabei nie ausgeben" >&2
    echo "     2. Origin-Deploy mit Zertifikaten wiederholen:" >&2
    echo "        ORIGIN_CERT=\"\$ORIGIN_CERT\" ORIGIN_KEY=\"\$ORIGIN_KEY\" bash $0" >&2
    echo "     Quelle/Referenz: scripts/hetzner/Caddyfile.origin + docs/ORIGIN_TLS_DNS_RUNBOOK.md" >&2
    echo "     ACME nur bewusst (ohne Cloudflare-Worker-Route): DEPLOY_INSTALL_CADDYFILE=1 bash $0" >&2
  fi
fi
# Nur ein Boolean - keine Werte, kein Zertifikatsinhalt im Log.
echo "   Origin-Zertifikat installiert: $ORIGIN_CERT_INSTALLED"

# --- .env auf den Server bringen (INFRA-HETZNER-001) ---
# Default ist 0 (siehe Kopfkommentar): die Knoten-.env ist rollen-skopiert und
# gehoert dem Portal-Worker. Ein Sync muss deshalb bewusst angefordert werden.
if [[ "$DEPLOY_SYNC_ENV" == "1" && -f ./.env ]]; then
  echo "⚠️  DEPLOY_SYNC_ENV=1: die lokale .env ERSETZT die rollen-skopierte .env auf $SSH_TARGET"
  echo "    Betroffen: $DEPLOY_REMOTE_DIR/.env (Rollen-Secrets wie TRUST_PROXY/STUDIO_ACCESS_TOKEN inklusive)"
  # Vorher sichern: der Sync darf die Rollenkonfiguration nicht ohne Wiederweg
  # verwerfen (`.env.bak-predeploy` bleibt auf dem Knoten liegen).
  "${SSH[@]}" "$SSH_TARGET" "cd $DEPLOY_REMOTE_DIR && if [ -f .env ]; then cp .env .env.bak-predeploy && echo '   Remote-.env gesichert: $DEPLOY_REMOTE_DIR/.env.bak-predeploy'; fi"
  scp "${SCP_OPTS[@]}" ./.env "$SSH_TARGET:$DEPLOY_REMOTE_DIR/.env"
else
  if [[ "$DEPLOY_SYNC_ENV" == "1" ]]; then
    echo "⚠️  DEPLOY_SYNC_ENV=1 gesetzt, aber ./.env fehlt lokal - es wird nichts synchronisiert."
  else
    echo "--- .env-Sync aus (DEPLOY_SYNC_ENV=0): die Knoten-.env bleibt unangetastet ---"
  fi
  # Nur ein KALTSTART-Fallback: `cp -n` ueberschreibt eine vorhandene .env NICHT.
  "${SSH[@]}" "$SSH_TARGET" "cd $DEPLOY_REMOTE_DIR && cp -n .env.hetzner.example .env 2>/dev/null || true"
fi

# --- DOMAIN in Remote-.env setzen/leeren ---
if [[ -n "$DEPLOY_DOMAIN" ]]; then
  echo "--- DOMAIN=$DEPLOY_DOMAIN in Remote-.env setzen ---"
  "${SSH[@]}" "$SSH_TARGET" "cd $DEPLOY_REMOTE_DIR && \
    (grep -q '^DOMAIN=' .env && sed -i 's|^DOMAIN=.*|DOMAIN=${DEPLOY_DOMAIN}|' .env) || \
    echo 'DOMAIN=${DEPLOY_DOMAIN}' >> .env"
else
  echo "--- kein DEPLOY_DOMAIN gesetzt; DOMAIN wird leer gelassen (nur http/IP-Test) ---"
  "${SSH[@]}" "$SSH_TARGET" "cd $DEPLOY_REMOTE_DIR && \
    (grep -q '^DOMAIN=' .env && sed -i 's|^DOMAIN=.*|DOMAIN=|' .env) || true"
fi

if [[ "$DEPLOY_MODE" == "docker" ]]; then
  echo "=== [4/5] Remote starten (Modus: docker) ==="
  # Medien-Overlay nur, wenn auf dem Knoten wirklich Inhalte liegen: sonst
  # wuerden leere Bind-Mounts die Modell-/Library-Pfade des Images maskieren
  # (siehe docker-compose.media.yml + scripts/hetzner/deliver-media.sh).
  MEDIA_OVERLAY=""
  if "${SSH[@]}" "$SSH_TARGET" "test -f $DEPLOY_REMOTE_DIR/docker-compose.media.yml && [ -n \"\$(ls -A $DEPLOY_REMOTE_DIR/media 2>/dev/null)\" ]"; then
    MEDIA_OVERLAY=" -f docker-compose.media.yml"
    echo "--- Medien-Overlay aktiv ($DEPLOY_REMOTE_DIR/media gefunden) ---"
  fi
  if [[ "$DEPLOY_REMOTE_BUILD" != "1" ]]; then
    echo "--- Rollback-Image sichern (remote) ---"
    "${SSH[@]}" "$SSH_TARGET" "docker image tag $IMAGE_APP ${IMAGE_APP}-rollback 2>/dev/null || true"
    echo "--- Images via docker save | ssh docker load übertragen ---"
    docker save "$IMAGE_APP" "$IMAGE_MASTER" | "${SSH[@]}" "$SSH_TARGET" "docker load"
    echo "--- docker compose up -d --no-build --force-recreate audiomonastry master-player (Projekt $COMPOSE_PROJECT) ---"
    "${SSH[@]}" "$SSH_TARGET" "cd $DEPLOY_REMOTE_DIR && \
       COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT docker compose -f $COMPOSE_FILE$MEDIA_OVERLAY up -d --no-build --force-recreate audiomonastry master-player && \
       COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT docker compose -f $COMPOSE_FILE$MEDIA_OVERLAY up -d caddy"
  else
    # PERF-P1-003 (2026-09-21): Der Remote-Build lief bisher OHNE Medien-Overlay,
    # OHNE Rollback-Image und OHNE Build-Stempel. Damit war er auf app-1 nicht
    # benutzbar:
    #   * ohne -f docker-compose.media.yml fehlen die Mounts -> Library/Instrumente
    #     leer und /models/htdemucs.onnx 404 (genau der Fehler vom 2026-09-20),
    #   * ohne Rollback-Tag gibt es keinen Rueckweg,
    #   * ohne AUDIOMONASTRY_COMMIT/BUILD_TIME (docker-compose.hetzner.yml liest sie
    #     fuer die Build-Args) stuende "unknown" in /api/health -> Commit-Paritaet
    #     fuer den Knoten nicht pruefbar.
    echo "--- Rollback-Image sichern (remote) ---"
    "${SSH[@]}" "$SSH_TARGET" "docker image tag $IMAGE_APP ${IMAGE_APP}-rollback 2>/dev/null || true"
    echo "--- Remote-Build (docker compose up -d --build, Projekt $COMPOSE_PROJECT) ---"
    echo "    Grund fuer den Remote-Build: die Leitung zum Knoten ist der Engpass"
    echo "    (gemessen 2026-09-21: ~1 MB/s hoch). Ein lokaler Build muss das ganze"
    echo "    Image hochschieben (~338 MB -> ~6 min), der Remote-Build nur die"
    echo "    Quellaenderungen (rsync-Delta) und baut dort auf schneller Leitung."
    "${SSH[@]}" "$SSH_TARGET" "cd $DEPLOY_REMOTE_DIR && \
       AUDIOMONASTRY_VERSION='$APP_VERSION' AUDIOMONASTRY_COMMIT='$APP_COMMIT' AUDIOMONASTRY_BUILD_TIME='$BUILD_TIME' \
       COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT docker compose -f $COMPOSE_FILE$MEDIA_OVERLAY up -d --build"
  fi
else
  echo "=== [4/5] Remote starten (Modus: node) ==="
  "${SSH[@]}" "$SSH_TARGET" "cd $DEPLOY_REMOTE_DIR && \
     bash scripts/hetzner/start-prod.sh"
fi

if [[ -n "$DEPLOY_DOMAIN" ]]; then
  BASE_URL="https://$DEPLOY_DOMAIN"
else
  BASE_URL="http://${DEPLOY_HOST#*@}"
fi

echo "=== [5/5] Health-Check + Smoke-Test + Commit-Paritaet ==="
wait_health "$BASE_URL" || true

if [[ "$DEPLOY_SMOKE" == "1" ]] && command -v curl >/dev/null 2>&1; then
  echo "--- Smoke-Test (Basispfade) ---"
  for path in /api/health /api/cloud/health /api/master/health; do
    echo "==> GET $BASE_URL$path"
    curl -fsS "$BASE_URL$path" || echo "⚠️  $path nicht erreichbar"
    echo
  done
fi

# PROD-P1-F4: Staleness-Gate. "Fertig" heisst jetzt Health UND Commit-Paritaet.
# Eine Abweichung heisst: der Container laeuft auf einem anderen Stand als das
# Repo (real passiert am 2026-09-20: Image vom 18.09. bei Repo-Commit ae5e749) -
# das darf nicht still durchlaufen. Die Entscheidung liegt in
# scripts/hetzner/lib/build-parity.sh (parity_gate), damit Tests genau diesen
# Pfad fahren koennen. "Nicht pruefbar" blockiert bewusst nicht.
if ! parity_gate "$BASE_URL" "$APP_COMMIT" app-1 "$DEPLOY_ALLOW_STALE"; then
  echo "" >&2
  echo "❌ Deployment-ABWEICHUNG: der laufende Container entspricht NICHT dem Repo-Stand $APP_COMMIT." >&2
  echo "   Abbruch (Exit 1), damit keine still veraltete Flotte weiterlaeuft." >&2
  echo "   Bewusst veraltet weiterfahren:  DEPLOY_ALLOW_STALE=1 (Grund dokumentieren)" >&2
  echo "   Rollback auf die Vorversion:    ssh $SSH_TARGET 'docker tag ${IMAGE_APP}-rollback $IMAGE_APP && cd $DEPLOY_REMOTE_DIR && docker compose -f $COMPOSE_FILE up -d --no-build --force-recreate audiomonastry'" >&2
  echo "   Betreiber-Schritte: docs/ORIGIN_TLS_DNS_RUNBOOK.md, docs/HETZNER_DEPLOY.md §3" >&2
  exit 1
fi

echo ""
echo "✅ Deployment abgeschlossen: $BASE_URL"
echo "   Stand:     version=$APP_VERSION commit=$APP_COMMIT buildTime=$BUILD_TIME"
echo ""
echo "   Logs:      ssh $SSH_TARGET 'docker compose -f $DEPLOY_REMOTE_DIR/$COMPOSE_FILE logs -f audiomonastry'"
echo "   Rollback:  ssh $SSH_TARGET 'docker tag ${IMAGE_APP}-rollback $IMAGE_APP && cd $DEPLOY_REMOTE_DIR && docker compose -f $COMPOSE_FILE up -d --no-build --force-recreate audiomonastry'"
echo "   Optional Auto-Shutdown: ssh $SSH_TARGET 'sudo bash $DEPLOY_REMOTE_DIR/scripts/hetzner/install-idle-shutdown.sh'"
