import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
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
