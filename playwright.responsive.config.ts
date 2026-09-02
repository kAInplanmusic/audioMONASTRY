import { defineConfig, devices } from '@playwright/test';

/**
 * audioMONASTRY – Responsive-/Plattform-Matrix (P1-1)
 * =====================================================
 * Cross-Browser-Lauf der Responsive-Suite:
 *   - Chromium: iPhone SE/14, Pixel 7 (Android-Emulation), Desktop 1920
 *   - Firefox:  Desktop 1920
 *   - WebKit:   in CI ergänzbar (Safari/iOS); lokal je nach System-
 *               Dependencies via `npx playwright install-deps` aktivierbar.
 *
 * Nutzung:
 *   npm run test:e2e:responsive
 *   BASE_URL=https://deine-domain.de npm run test:e2e:responsive
 */
const BASE_URL = process.env.BASE_URL?.replace(/\/$/, '');

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'responsive.spec.ts',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: BASE_URL ?? 'http://localhost:8080',
    trace: 'retain-on-failure',
  },
  expect: {
    timeout: 10_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  ],
  webServer: BASE_URL
    ? undefined
    : {
        command: 'npm run dev',
        url: 'http://localhost:8080/api/health',
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
