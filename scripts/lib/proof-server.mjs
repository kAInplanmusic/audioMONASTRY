/**
 * Gemeinsame Bausteine der Live-Beweis-Skripte, die den Dev-Server SELBST starten
 * ==============================================================================
 * `scripts/mjpeg-live-proof.mjs` und `scripts/webgpu-live-proof.mjs` fahren
 * denselben Ablauf hoch: Port frei? -> `tsx server.ts` im eigenen Prozessbaum
 * (detached, damit die Vite-Kinder mit sterben) -> auf `/api/health` warten.
 * Diese vier Bausteine liegen jetzt genau einmal hier; die Skripte behalten ihre
 * eigenen Timeouts und Abbruchmeldungen.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ist der Port frei? Sonst wuerde der Beweis einen FREMDEN (alten) Server messen. */
export const portIsFree = (port) => new Promise((resolve) => {
  const probe = createServer();
  probe.once('error', () => resolve(false));
  probe.once('listening', () => probe.close(() => resolve(true)));
  probe.listen(port, '127.0.0.1');
});

/** Wartet auf HTTP 200 von `/api/health` (Abbruch nach `timeoutMs`). */
export const waitForHealth = async (appUrl, timeoutMs) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await fetch(`${appUrl}/api/health`)).ok) return true;
    } catch { /* noch nicht bereit */ }
    await sleep(500);
  }
  return false;
};

/**
 * Startet den Dev-Server (`tsx server.ts`) ohne Build. `extraEnv` wird in die
 * Prozessumgebung gemischt (z. B. ein Studio-Token).
 *
 * `detached: true` + Kill der Prozessgruppe: der Dev-Server startet Vite mit
 * festem HMR-Port (24678). Blieb ein Kindprozess zurueck (z. B. weil das Skript
 * abgebrochen wurde), blockierte er diesen Port und liess ANDERE E2E-Laeufe mit
 * "WebSocket closed without opened" scheitern - genau das ist passiert.
 *
 * @returns {{ server: import('node:child_process').ChildProcess, log: string[] }}
 */
export const startDevServer = ({ port, extraEnv = {} }) => {
  const server = spawn('npx', ['tsx', 'server.ts'], {
    env: { ...process.env, PORT: String(port), NODE_ENV: 'development', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  const log = [];
  server.stdout.on('data', (d) => log.push(String(d)));
  server.stderr.on('data', (d) => log.push(String(d)));
  return { server, log };
};
