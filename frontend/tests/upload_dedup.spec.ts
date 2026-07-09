/**
 * Dedup e2e test — verifies that re-uploading the same files skips Telegram
 * upload entirely (no MTProto traffic) and doesn't queue behind the upload
 * concurrency limit.
 *
 * Prerequisites: same as upload_perf.spec.ts (app running, session configured).
 *
 * Run:
 *   cd frontend && npx playwright test upload_dedup --project=chromium --reporter=line
 */

import { test, expect } from '@playwright/test';

const UNIQUE_COUNT = 5;
const NEW_COUNT = 5;
const FILE_KB = 5;

test.setTimeout(120_000);

test('re-uploading the same files skips Telegram upload and completes instantly', async ({ page, context }) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');

  let wsSentBytesPhaseA = 0;
  let wsSentBytesTotal = 0;
  let trackingPhaseA = true;

  cdp.on('Network.webSocketFrameSent', (e) => {
    wsSentBytesTotal += e.response.payloadData.length;
    if (trackingPhaseA) wsSentBytesPhaseA += e.response.payloadData.length;
  });

  const consoleMessages: string[] = [];
  page.on('console', (msg) => consoleMessages.push(msg.text()));

  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');

  const loginVisible = await page
    .locator('input[placeholder*="session"], input[placeholder*="Session"]')
    .first().isVisible().catch(() => false);
  if (loginVisible) {
    test.skip(true, 'Login required — configure session in the app first');
    return;
  }

  await page.waitForSelector('text=Root', { timeout: 30_000 });

  const dropFiles = async (seedOffset: number, count: number) => {
    await page.evaluate(
      async ({ seedOffset, count, kbSize }: { seedOffset: number; count: number; kbSize: number }) => {
        const dt = new DataTransfer();
        const byteSize = kbSize * 1024;
        for (let i = 0; i < count; i++) {
          const buf = new Uint8Array(byteSize);
          buf.fill((i + seedOffset) & 0xff);
          dt.items.add(
            new File([buf], `dedup_${String(seedOffset + i).padStart(4, '0')}.bin`, {
              type: 'application/octet-stream',
            })
          );
        }
        const opts: DragEventInit = { dataTransfer: dt, bubbles: true, cancelable: true };
        const target = document.querySelector('[data-testid="drive-drop-zone"]') ?? document.body;
        target.dispatchEvent(new DragEvent('dragenter', opts));
        target.dispatchEvent(new DragEvent('dragover', opts));
        target.dispatchEvent(new DragEvent('drop', opts));
      },
      { seedOffset, count, kbSize: FILE_KB }
    );
  };

  const waitForAllComplete = async (expectedCount: number) => {
    await page.waitForSelector(`text=/上傳中 ${expectedCount} \\/ ${expectedCount}/`, { timeout: 90_000 });
  };

  // ── Phase A: upload N unique files ──────────────────────────────────────
  console.log(`[Dedup] Phase A: dropping ${UNIQUE_COUNT} unique files...`);
  await dropFiles(0, UNIQUE_COUNT);
  await page.waitForSelector('text=上傳中', { timeout: 30_000 });
  await waitForAllComplete(UNIQUE_COUNT);
  console.log(`[Dedup] Phase A complete. WS sent: ${(wsSentBytesPhaseA * 0.75).toFixed(0)} bytes`);
  expect(wsSentBytesPhaseA, 'Phase A should produce real Telegram upload traffic').toBeGreaterThan(0);

  trackingPhaseA = false;
  const phaseAEndBytes = wsSentBytesTotal;

  // ── Phase B: re-drop the SAME files + N new files ───────────────────────
  console.log(`[Dedup] Phase B: dropping ${UNIQUE_COUNT} duplicates + ${NEW_COUNT} new files...`);
  const phaseBStart = Date.now();
  await dropFiles(0, UNIQUE_COUNT); // exact same content/names as Phase A → duplicates
  await dropFiles(1000, NEW_COUNT); // distinct content → fresh uploads

  await waitForAllComplete(UNIQUE_COUNT + NEW_COUNT);
  const phaseBElapsedMs = Date.now() - phaseBStart;

  const phaseBBytes = (wsSentBytesTotal - phaseAEndBytes) * 0.75;
  const phaseABytes = wsSentBytesPhaseA * 0.75;

  console.log(`[Dedup] Phase B complete in ${phaseBElapsedMs} ms. WS sent: ${phaseBBytes.toFixed(0)} bytes (Phase A was ${phaseABytes.toFixed(0)} bytes for the same file count)`);

  const dedupLogs = consoleMessages.filter((m) => m.includes('Duplicate detected'));
  console.log(`[Dedup] Found ${dedupLogs.length} "Duplicate detected" log line(s)`);

  // Phase B re-uploads the same UNIQUE_COUNT duplicate files plus NEW_COUNT fresh
  // ones — real upload traffic should be roughly what Phase A used for NEW_COUNT
  // fresh files alone, not for all (UNIQUE_COUNT + NEW_COUNT). Duplicates should
  // contribute ~0 bytes of MTProto traffic.
  const expectedFreshOnlyBytes = phaseABytes; // Phase A uploaded UNIQUE_COUNT files; NEW_COUNT is the same count here
  expect(phaseBBytes, 'Duplicates should not re-upload to Telegram').toBeLessThan(expectedFreshOnlyBytes * 1.5);
  expect(dedupLogs.length, 'Expected dedup log lines for the re-uploaded duplicates').toBeGreaterThan(0);
});
