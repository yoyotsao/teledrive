/**
 * Playwright globalSetup — reuses a logged-in session if storageState.json is
 * still valid; otherwise opens a real, visible Chrome window and waits for you
 * to log in manually (QR code or phone), the same way you'd log in normally.
 * Once logged in, that session is cached to storageState.json so future test
 * runs skip the manual step until the session actually expires.
 */
import { chromium } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, 'storageState.json');
const BASE_URL = 'https://teledrive.yoyotsaoteledrive.dpdns.org';
const LOGIN_WAIT_MS = 5 * 60_000; // give plenty of time to scan a QR code / enter SMS code

async function isExistingSessionValid(): Promise<boolean> {
  if (!fs.existsSync(STATE_FILE)) return false;
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ storageState: STATE_FILE });
    const page = await ctx.newPage();
    await page.goto(BASE_URL);
    await page.waitForSelector('text=登出', { timeout: 10_000 });
    return true;
  } catch {
    return false;
  } finally {
    await browser.close();
  }
}

export default async function globalSetup() {
  if (await isExistingSessionValid()) {
    console.log('[auth-setup] Reusing existing storageState.json — already logged in.');
    return;
  }

  console.log('[auth-setup] No valid session found. Opening a real Chrome window —');
  console.log('[auth-setup] please log in manually (QR code or phone). Waiting up to 5 minutes…');

  const browser = await chromium.launch({ headless: false, channel: 'chrome' });
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(BASE_URL);

    // The app shows a "登出" (logout) button only once login succeeds.
    await page.waitForSelector('text=登出', { timeout: LOGIN_WAIT_MS });
    console.log('[auth-setup] Login detected — saving session state.');

    await ctx.storageState({ path: STATE_FILE });
  } finally {
    await browser.close();
  }
}
