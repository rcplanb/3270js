import { defineConfig, devices } from '@playwright/test';

/**
 * Live acceptance against a real TK5 (opt-in):
 *   HERCULES_HOST=… TSO_USER=HERC03 TSO_PASSWORD=… npm run test:e2e:live
 * Runs serially: one TSO user can only be logged on once.
 */
export default defineConfig({
  testDir: 'test/e2e-live',
  workers: 1,
  timeout: 180_000,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    channel: 'chrome',
    baseURL: 'http://127.0.0.1:5271',
    viewport: { width: 1180, height: 800 },
  },
  webServer: {
    command: 'npm run build && node scripts/e2e-server.mjs',
    url: 'http://127.0.0.1:5271/targets.json',
    reuseExistingServer: false,
    stdout: 'ignore',
  },
});
