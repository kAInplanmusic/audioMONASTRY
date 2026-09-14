import { defineConfig } from '@playwright/test';

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
 */
const E2E_BASE_URL = process.env.E2E_BASE_URL?.replace(/\/$/, '');

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: E2E_BASE_URL ?? 'http://localhost:8080',
    trace: 'retain-on-failure',
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
