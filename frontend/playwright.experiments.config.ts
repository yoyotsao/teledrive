import { defineConfig, devices } from '@playwright/test';

/**
 * A separate config so the benchmarks in tests/experiments can be run on
 * purpose and never by accident. They point at the live site with the session
 * the smoke suite caches, take minutes, and measure rather than assert — see
 * tests/experiments/README.md.
 *
 *   npx playwright test --config=playwright.experiments.config.ts
 */
export default defineConfig({
  testDir: './tests/experiments',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.TELEDRIVE_URL ?? 'https://teledrive.yoyotsaoteledrive.dpdns.org',
    storageState: './tests/smoke/storageState.json',
    trace: 'off',
    video: 'off',
  },
});
