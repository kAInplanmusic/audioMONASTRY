import { defineConfig } from '@playwright/test';
import { readFileSync } from 'node:fs';

/**
 * audioMONASTRY – E2E-Smoke-Tests (Playwright)
 *
 * Lokal (Standard):
 *   Startet den Dev-Server (Express + Vite) automatisch auf Port 8080.
 *
 * Gegen eine entfernte Instanz (z. B. Hetzner):
 *   E2E_BASE_URL=https://deine-domain.de npm run test:e2e
 *   Dann wird KEIN Dev-Server gestartet und gegen E2E_BASE_URL getestet.
 *
 * Namensraum: bewusst E2E_BASE_URL statt BASE_URL – in Entwickler-Shells ist
 * BASE_URL häufig von AI-Gateways belegt (z. B. CometAPI) und würde die
 * E2E-Läufe still auf den falschen Host lenken.
 *
 * Auth: Der Signalisierungs-Server fährt fail-closed – ohne Token UND ohne
 * expliziten Dev-/Test-Modus blockt er API und Socket außer /api/health. In der CI
 * ließ das ALLE Session-Tests scheitern (Job-Log: „FATAL: STUDIO_ACCESS_TOKEN fehlt
 * und kein expliziter Dev-/Test-Modus aktiv"). Der Reset-Hook /api/session/reset
 * verlangt den Token sogar im Dev-Modus – diese Invariante ist bewusst und wird von
 * tests/server.test.ts abgesichert. Deshalb bekommt die Suite einen Token (CI: env,
 * lokal: .env) und das `studio`-Cookie wird hier zentral für ALLE Kontexte gesetzt.
 */
const E2E_BASE_URL = process.env.E2E_BASE_URL?.replace(/\/$/, '');
const BASE_URL = E2E_BASE_URL ?? 'http://localhost:8080';

/** Studio-Token aus der Umgebung oder (lokal) aus der `.env`. */
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

/**
 * Globales `studio`-Cookie (Portal-Flow; im Betrieb 24 h gültig).
 *
 * Zentral hier statt in einzelnen Specs: würde es nur in einzelnen Specs gesetzt
 * (wie zuvor in collab.spec.ts), wären bei konfiguriertem Token alle übrigen
 * Kontexte ausgesperrt. Ohne Token wird kein Cookie gesetzt.
 */
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
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    ...(storageState ? { storageState } : {}),
  },
  expect: {
    // WebKit rendert beim Kaltstart langsamer (DCT-124 Browser-Matrix).
    timeout: 10_000,
  },
  webServer: E2E_BASE_URL
    ? undefined
    : {
        command: 'npm run dev',
        url: 'http://localhost:8080/api/health',
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
