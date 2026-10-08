#!/usr/bin/env bash
# Visuelle Baselines lokal aufnehmen/prüfen.
#
# Warum ein Skript: Der visuelle Lauf scheitert an drei Umgebungsfallen, die
# alle nichts mit dem Bild zu tun haben (belegt 2026-10-06, Skill
# devops/audiomonastry-project):
#   1. NODE_ENV=production überspringt die devDependencies -> kein playwright.
#   2. Der Reset-Hook braucht ZWEI Schlösser: NODE_ENV!=production und
#      AUDIOMONASTRY_TEST_RESET=1 (nicht "TEST_RESET_ENABLED").
#   3. STUDIO_ACCESS_TOKEN muss im SERVER-Prozess stehen. dotenv.config() läuft
#      in server.ts für Tests NICHT, und die Konstante wird VOR dem Laden
#      ausgewertet - aus der .env kommt der Token also zu spät.
#
# Aufruf:  scripts/e2e-visual.sh [--update-snapshots]
set -euo pipefail

cd "$(dirname "$0")/.."

TOKEN="${STUDIO_ACCESS_TOKEN:-e2e-visual-token}"
PORT="${PORT:-8080}"
LOG="${TMPDIR:-/tmp}/e2e-visual-server.log"
EXTRA=("$@")

# Lobby-Zustand weg, sonst faelscht ein wiederhergestellter Spielstand das Bild.
rm -f .pa-state/lobbies.json

# Server mit genau den Schaltern starten, die der Reset-Hook verlangt.
#
# WICHTIG: `npm run dev` bzw. `tsx server.ts` startet den Listener NUR, wenn
# NODE_ENV != 'test' (server.ts, unten: `if (NODE_ENV !== 'test') startServer()`).
# Im Testmodus - den der Reset-Hook verlangt - muss startServer() EXPLIZIT
# gerufen werden, sonst importiert der Prozess nur das Modul und endet sofort.
# Genau daran ist ein früherer Anlauf gescheitert (Port blieb zu, Log zeigte nur
# die Werkzeug-Zeile).
NODE_ENV=test \
AUDIOMONASTRY_TEST_RESET=1 \
STUDIO_ACCESS_TOKEN="$TOKEN" \
PORT="$PORT" \
  npx tsx -e "
import('./server.ts').then(async (m) => { await m.startServer(Number(process.env.PORT) || 8080); })
  .catch((e) => { console.error('Serverstart fehlgeschlagen:', e); process.exit(1); });
" > "$LOG" 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT

# Auf Bereitschaft warten - kein blindes sleep.
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null "http://localhost:$PORT/api/health" 2>/dev/null; then
    break
  fi
  sleep 1
done
if ! curl -fsS -o /dev/null "http://localhost:$PORT/api/health" 2>/dev/null; then
  echo "FEHLER: Server kam nicht hoch. Log: $LOG" >&2
  tail -20 "$LOG" >&2
  exit 1
fi

# Belegen, dass der Reset-Hook WIRKLICH offen ist - sonst laufen die Baselines
# gegen einen blutenden Session-Zustand (oder die Suite bricht am Start ab).
RESET=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "x-studio-token: $TOKEN" \
  "http://localhost:$PORT/api/session/reset")
if [ "$RESET" != "200" ]; then
  echo "WARNUNG: /api/session/reset antwortet $RESET (erwartet 200)." >&2
  echo "         Ohne Reset blutet der Session-Zustand zwischen den Tests." >&2
fi

echo "Server bereit (Reset=$RESET), starte Playwright."
NODE_ENV=test STUDIO_ACCESS_TOKEN="$TOKEN" \
  node_modules/.bin/playwright test tests/e2e/visual.spec.ts --reporter=list "${EXTRA[@]}"
