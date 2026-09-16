// Post-deploy smoke tests against the LIVE site. Runs from the public site
// repo (free Actions minutes) right after GitHub Pages finishes deploying.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.mjs/,
  timeout: 90_000,
  retries: 1,
  workers: 1,
  reporter: [['list'], ['html', { outputFolder: '../smoke-report', open: 'never' }]],
  use: {
    baseURL: process.env.SMOKE_BASE_URL || 'https://clippyt.com',
    ...devices['Desktop Chrome'],
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    navigationTimeout: 45_000,
    actionTimeout: 20_000,
  },
});
