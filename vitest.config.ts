import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';

const APP_VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version as string;

export default defineConfig({
  // UI2-P1-005: wie vite.config.ts, damit Tests dieselbe Version sehen.
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
  test: {
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    // AUDIT-RESTTODOS C3: NODE_ENV zentral auf 'test' pinnen. Der Host-Shell
    // schwimmt hier gelegentlich NODE_ENV=production mit (npm install prunt
    // dann devDependencies, Server-Gates laufen fail-closed: STUDIO_TOKEN_MISSING,
    // React-Production-Builds im jsdom -> ~90 falsche Ausfaelle ohne Code-Bug).
    // Vitest selbst setzt nur `??= 'test'` (_CLI-API, prepareVitest) und
    // verteilt config.env an die Worker-Umgebungen - ein ambient
    // 'production' ueberlebte beides. test.env gewinnt gegen process.env.
    env: {
      NODE_ENV: 'test',
    },
    // ARCH-PERF-001: Robuste Timeout-Budgets gegen Flaky-Timeouts unter
    // Volllast (Server-Integrationstests wie aiRoutes/aiSecurityPenTest
    // brauchen bei paralleler tsc-/CPU-Last mehr als die 5 s Default).
    //
    // 2026-09-20 von 15 s auf 30 s angehoben: bei 251 Testdateien saturiert die
    // Suite die CPU selbst (Messung: 90 s Wanduhrzeit bei 4-5x Parallelitaet),
    // und die 15-s-Grenze riss in zwei aufeinanderfolgenden Laeufen mit
    // VERSCHIEDENEN Tests - erst tests/securityAuthz.test.ts (Server-Bootstrap,
    // 17,7 s), dann tests/namingConventions.test.ts (Repo-Scan, 17,7 s). Beide
    // liefen allein in 3-4 s durch, die Suite war sonst 251/251 gruen. Es ist
    // also die Last, nicht der Test. Dateien mit noch hoeherem Bedarf setzen ihr
    // Budget weiterhin selbst (z. B. tests/visualMjpegRoutes.test.ts: 60 s).
    testTimeout: 30_000,
    hookTimeout: 30_000,
    environmentOptions: {
      jsdom: { url: 'http://localhost:3000' },
    },
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx', 'tests/**/*.test.mjs'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: 'coverage',
      include: [
        'server/**/*.ts',
        'services/**/*.ts',
        'services/**/*.js',
        'services/**/*.mjs',
        'src/**/*.ts',
        'src/**/*.tsx',
        'scripts/**/*.mjs',
      ],
      exclude: ['**/node_modules/**', '**/dist/**', '**/*.d.ts', '**/__pycache__/**'],
    },
  },
});
