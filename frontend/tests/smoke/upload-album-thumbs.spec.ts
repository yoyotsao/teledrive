/**
 * Multi-file upload + embedded thumbnail e2e.
 *
 * Verifies: (1) dropping 25 small files together all upload successfully
 * (each sent as its own message via sendFile — messages.SendMultiMedia was
 * found to hang indefinitely against this account/GramJS combination and is
 * no longer used, see docs/superpowers/specs/2026-07-10-embedded-thumb-album-upload-design.md);
 * (2) a single dropped image gets an embedded thumbnail (only the single-file
 * upload path attaches a thumb — multi-file drops do not).
 *
 * Run: cd frontend && npm run test:e2e:smoke
 */
import { test, expect } from '@playwright/test';

const SMALL_FILE_COUNT = 25;

test.setTimeout(180_000);

test('multiple small files upload successfully and a single image gets an embedded thumbnail @real', async ({ page }) => {
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

  // ── Phase A: 25 small binary files dropped together → all must succeed ───
  await page.evaluate(async (count: number) => {
    const dt = new DataTransfer();
    for (let i = 0; i < count; i++) {
      const buf = new Uint8Array(2048);
      buf.fill(i & 0xff);
      // random suffix so re-runs don't dedup against previous test data
      const suffix = Math.random().toString(36).slice(2, 8);
      dt.items.add(new File([buf], `album_${suffix}_${i}.bin`, { type: 'application/octet-stream' }));
    }
    const opts: DragEventInit = { dataTransfer: dt, bubbles: true, cancelable: true };
    const target = document.querySelector('[data-testid="drive-drop-zone"]') ?? document.body;
    target.dispatchEvent(new DragEvent('dragenter', opts));
    target.dispatchEvent(new DragEvent('dragover', opts));
    target.dispatchEvent(new DragEvent('drop', opts));
  }, SMALL_FILE_COUNT);

  await page.waitForSelector(`text=/上傳中 ${SMALL_FILE_COUNT} \\/ ${SMALL_FILE_COUNT}/`, { timeout: 150_000 });

  const failLogs = consoleMessages.filter((m) => m.includes('[Album] Individual file send failed'));
  expect(failLogs.length, `expected all ${SMALL_FILE_COUNT} files to send successfully`).toBe(0);

  // ── Phase B: a single PNG image → thumbnail renders from the embedded doc thumb ───
  await page.evaluate(async () => {
    const blob: Blob = await new Promise((resolve) => {
      const canvas = document.createElement('canvas');
      canvas.width = 400; canvas.height = 300;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = 'hsl(200, 80%, 50%)';
      ctx.fillRect(0, 0, 400, 300);
      canvas.toBlob((b) => resolve(b!), 'image/png');
    });
    const suffix = Math.random().toString(36).slice(2, 8);
    const dt = new DataTransfer();
    dt.items.add(new File([blob], `thumb_${suffix}.png`, { type: 'image/png' }));
    const opts: DragEventInit = { dataTransfer: dt, bubbles: true, cancelable: true };
    const target = document.querySelector('[data-testid="drive-drop-zone"]') ?? document.body;
    target.dispatchEvent(new DragEvent('dragenter', opts));
    target.dispatchEvent(new DragEvent('dragover', opts));
    target.dispatchEvent(new DragEvent('drop', opts));
  });

  await page.waitForSelector('text=/上傳中 1 \\/ 1/', { timeout: 60_000 });

  // Thumbnails arrive async after the folder re-list; poll for blob: <img> tags.
  await expect
    .poll(async () => page.locator('img[src^="blob:"]').count(), { timeout: 60_000 })
    .toBeGreaterThanOrEqual(1);
});
