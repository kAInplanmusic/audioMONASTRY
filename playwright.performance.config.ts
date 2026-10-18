import { defineConfig } from '@playwright/test';
import { readFileSync } from 'node:fs';

/**
 * audioMONASTRY – Performance-Suite gegen den PRODUKTIONS-Build (P2-4)
 * =====================================================================
 * WARUM EIGENE CONFIG (Messbefund 2026-10-18):
 * Der P2-4-Test misst CPU-Last ueber CDP Performance.getMetrics. Laeuft er
 * gegen `npm run dev` (Vite-Dev-Modus, unbundled Module, React-Dev-Doppel-
 * Renders), meldet er reproduzierbar 88,5 % CPU bei 7,6 s Task-Zeit. Derselbe
 * Test gegen den gebauten Server (dist/server.cjs) meldet 4,7 % / 0,38 s —
 * Faktor ~19 Unterschied bei identischem Nutzerverhalten.
 * Ein Performance-Budget muss die AUSGELIEFERTE App bewerten, nicht den
 * Dev-Server. Deshalb: eigene Config mit gebautem Server auf Port 8090.
 *
 * Nutzung:
 *   npm run test:e2e:perf            # baut (falls noetig) und misst gegen PROD
 *   E2E_BASE_URL=https://... npm run test:e2e:perf   # gegen eine echte Instanz
 */
const E2E_BASE_URL = process.env.E2E_BASE_URL?.replace(/\/$/, '');
const PROD_PORT = process.env.PERF_PORT ?? '8090';
const PROD_URL = `http://127.0.0.1:${PROD_PORT}`;

/** Studio-Token aus der Umgebung oder (lokal) aus der `.env` (wie Haupt-Config). */
function studioToken(): string {
  const fromEnv = (process.env.STUDIO_ACCESS_TOKEN ?? '').trim();
  if (fromEnv) return fromEnv;
  try {
    const line = readFileSync(new URL('./.env', import.meta.url), 'utf8')
      .split('\n')
      .find((l) => l.startsWith('STUDIO_ACCESS_TOKEN='));
    return (line?.slice('STUDIO_ACCESS_TOKEN='.length) ?? '').trim().replace(/^["']|["']$/g, '');
  } catch {
    return '';
  }
}

const TOKEN = studioToken();
const BASE_URL = E2E_BASE_URL ?? PROD_URL;
const storageState = TOKEN
  ? {
      cookies: [
        {
          name: 'studio',
          value: TOKEN,
          domain: new URL(BASE_URL).hostname,
          path: '/',
          expires: -1,
          httpOnly: false,
          secure: new URL(BASE_URL).protocol === 'https:',
          sameSite: 'Lax' as const,
        },
      ],
      origins: [] as { origin: string; localStorage: { name: string; value: string }[] }[],
    }
  : undefined;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'performance.spec.ts',
  timeout: 240_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    ...(storageState ? { storageState } : {}),
  },
  expect: { timeout: 20_000 },
  webServer: E2E_BASE_URL
    ? undefined
    : {
        // Prod-Build: vite build + Worklets + Server-Bundle, dann der gebaute Server.
        // Der Build ist idempotent; ein bereits vorhandenes dist/ wird ueberschrieben.
        command: `npm run build && PORT=${PROD_PORT} NODE_ENV=production node dist/server.cjs`,
        url: `${PROD_URL}/api/health`,
        reuseExistingServer: !process.env.CI,
        timeout: 300_000,
      },
});
