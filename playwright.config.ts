import { defineConfig, devices } from '@playwright/test';

/**
 * Browser end-to-end tests. Offline by default: the "replay" target plays a
 * recorded TK5 session back as the browser types. Chrome is the installed
 * browser; Firefox and WebKit are Playwright's builds (npx playwright install).
 */
export default defineConfig({
  testDir: 'test/e2e',
  fullyParallel: true,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5271',
    viewport: { width: 1180, height: 800 },
  },
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.01 } },
  projects: [
    { name: 'chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome' } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: 'npm run build && node scripts/e2e-server.mjs',
    url: 'http://127.0.0.1:5271/targets.json',
    reuseExistingServer: false,
    stdout: 'ignore',
  },
});
