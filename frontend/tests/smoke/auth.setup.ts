/**
 * Logs the smoke suite into the live site, once.
 *
 * Login is a Telegram bot challenge: the browser DMs a one-time nonce from a
 * real account. Nothing here can automate that, so the first run opens a
 * visible window and waits for a human. The session is then cached in
 * storageState.json and reused until Telegram expires it — which is why the
 * smoke suite is a `npm run test:e2e:smoke` decision, not something that fires
 * on every change.
 *
 * Runs as a Playwright setup project (see playwright.config.ts), so the
 * isolated suite never triggers it.
 */
import { chromium, expect, test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, 'storageState.json');
const LOGIN_WAIT_MS = 5 * 60_000; // enough time to scan a QR / read an SMS

test('authenticate', async ({ baseURL }) => {
  test.setTimeout(LOGIN_WAIT_MS + 60_000);

  if (await sessionStillValid(baseURL!)) {
    console.log('[auth] Reusing the cached session in storageState.json.');
    return;
  }

  console.log('[auth] No valid session. Opening a real Chrome window —');
  console.log('[auth] log in manually (QR code or phone). Waiting up to 5 minutes…');

  const browser = await chromium.launch({ headless: false, channel: 'chrome' });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(baseURL!);

    // The logout button appears only once login has actually succeeded.
    await expect(page.getByRole('button', { name: '登出' })).toBeVisible({ timeout: LOGIN_WAIT_MS });
    console.log('[auth] Login detected — caching the session.');

    await context.storageState({ path: STATE_FILE, indexedDB: true });
  } finally {
    await browser.close();
  }
});

async function sessionStillValid(baseURL: string): Promise<boolean> {
  if (!fs.existsSync(STATE_FILE)) return false;
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ storageState: STATE_FILE });
    const page = await context.newPage();
    await page.goto(baseURL);
    await expect(page.getByRole('button', { name: '登出' })).toBeVisible({ timeout: 15_000 });
    return true;
  } catch {
    return false;
  } finally {
    await browser.close();
  }
}
