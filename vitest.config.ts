import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    // ARCH-PERF-001: Robuste Timeout-Budgets gegen Flaky-Timeouts unter
    // Volllast (Server-Integrationstests wie aiRoutes/aiSecurityPenTest
    // brauchen bei paralleler tsc-/CPU-Last mehr als die 5 s Default).
    testTimeout: 15_000,
    hookTimeout: 20_000,
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
