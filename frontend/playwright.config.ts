import { defineConfig, devices } from '@playwright/test';

/**
 * Two suites with very different costs, kept apart on purpose.
 *
 *   isolated — the default. A vite dev server on 5173, an in-memory backend
 *              (tests/support/fakeDrive.ts) and no network. Runs on every
 *              change, needs no Telegram account, leaves nothing behind.
 *
 *   smoke    — the real site, a real logged-in session, real MTProto. This is
 *              the only place upload/download/thumbnail/streaming are actually
 *              proven. It costs Telegram quota and can hit FLOOD_WAIT, so it
 *              never runs by default: `npm run test:e2e:smoke`.
 *
 * Port 5173 rather than 3000: docker compose already serves the built app on
 * 3000, and the isolated suite must not accidentally talk to it.
 */
const LOCAL_URL = 'http://localhost:5173';
const LIVE_URL = process.env.TELEDRIVE_URL ?? 'https://teledrive.yoyotsaoteledrive.dpdns.org';
const AUTH_STATE = './tests/smoke/storageState.json';

// Set by `npm run test:e2e:smoke`. Starting the dev server for a suite that
// only talks to the live site would be 30s of nothing.
const SMOKE_ONLY = process.env.TELEDRIVE_SMOKE === '1';

export default defineConfig({
  testDir: './tests',
  // tests/experiments holds benchmarks, not assertions — see its README.
  testIgnore: ['**/experiments/**'],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never' }], ['junit', { outputFile: 'test-results/playwright-junit.xml' }]]
    : [['list'], ['html', { open: 'never' }]],

  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  webServer: SMOKE_ONLY
    ? undefined
    : {
        command: 'npm run dev -- --port 5173 --strictPort',
        url: LOCAL_URL,
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
        stdout: 'pipe',
        stderr: 'pipe',
      },

  projects: [
    {
      name: 'isolated',
      testDir: './tests/isolated',
      // Chromium only: this layer tests the app's own logic, and running the
      // same DOM assertions three times buys less than it costs.
      use: { ...devices['Desktop Chrome'], baseURL: LOCAL_URL },
    },

    // Logs in once (interactively, the first time) and caches the session.
    {
      name: 'auth',
      testDir: './tests/smoke',
      testMatch: /auth\.setup\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: LIVE_URL },
    },
    {
      name: 'smoke',
      testDir: './tests/smoke',
      testIgnore: /auth\.setup\.ts/,
      dependencies: ['auth'],
      use: { ...devices['Desktop Chrome'], baseURL: LIVE_URL, storageState: AUTH_STATE },
    },
  ],
});
