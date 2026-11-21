import { defineConfig } from '@playwright/test';

const origin = 'http://127.0.0.1:4380';
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'release-output.spec.ts',
  workers: 1,
  timeout: 45_000,
  use: { browserName: 'chromium', baseURL: origin, trace: 'retain-on-failure' },
  webServer: {
    command: 'node build-worklets.mjs && node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4380 --strictPort',
    url: `${origin}/tests/e2e/fixtures/release-output.html`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
