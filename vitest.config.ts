import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
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
