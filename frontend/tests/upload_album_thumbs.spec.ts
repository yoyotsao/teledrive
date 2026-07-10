/**
 * Album batching + embedded thumbnail e2e.
 *
 * Verifies: (1) dropping 25 small files produces ceil(25/10)=3 SendMultiMedia
 * batches (not 25 sendFile messages); (2) dropped images get thumbnails in the
 * grid (embedded doc thumb downloaded via GramJS).
 *
 * Run: cd frontend && npx playwright test upload_album_thumbs --project=chromium --reporter=line
 */
import { test, expect } from '@playwright/test';

const SMALL_FILE_COUNT = 25;
const IMAGE_COUNT = 3;

test.setTimeout(180_000);

test('small files batch into albums and images get embedded thumbnails', async ({ page }) => {
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

  // ── Phase A: 25 small binary files → expect 3 album batches ──────────────
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

  await page.waitForSelector(`text=/上傳中 ${SMALL_FILE_COUNT} \\/ ${SMALL_FILE_COUNT}/`, { timeout: 120_000 });

  const albumLogs = consoleMessages.filter((m) => m.includes('[Album] SendMultiMedia batch size:'));
  console.log(`[Test] SendMultiMedia batches: ${albumLogs.length}`);
  expect(albumLogs.length, '25 small files should ride exactly 3 album batches').toBe(3);

  // ── Phase B: 3 PNG images → thumbnails render from embedded doc thumbs ───
  await page.evaluate(async (count: number) => {
    const makePng = (hue: number): Promise<Blob> => new Promise((resolve) => {
      const canvas = document.createElement('canvas');
      canvas.width = 400; canvas.height = 300;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = `hsl(${hue}, 80%, 50%)`;
      ctx.fillRect(0, 0, 400, 300);
      ctx.fillStyle = '#fff';
      ctx.font = '48px sans-serif';
      ctx.fillText(String(hue), 20, 60);
      canvas.toBlob((b) => resolve(b!), 'image/png');
    });
    const dt = new DataTransfer();
    const suffix = Math.random().toString(36).slice(2, 8);
    for (let i = 0; i < count; i++) {
      const blob = await makePng(i * 120);
      dt.items.add(new File([blob], `thumb_${suffix}_${i}.png`, { type: 'image/png' }));
    }
    const opts: DragEventInit = { dataTransfer: dt, bubbles: true, cancelable: true };
    const target = document.querySelector('[data-testid="drive-drop-zone"]') ?? document.body;
    target.dispatchEvent(new DragEvent('dragenter', opts));
    target.dispatchEvent(new DragEvent('dragover', opts));
    target.dispatchEvent(new DragEvent('drop', opts));
  }, IMAGE_COUNT);

  await page.waitForSelector(`text=/上傳中 ${IMAGE_COUNT} \\/ ${IMAGE_COUNT}/`, { timeout: 120_000 });

  // Thumbnails arrive async after the folder re-list; poll for blob: <img> tags.
  await expect
    .poll(async () => page.locator('img[src^="blob:"]').count(), { timeout: 60_000 })
    .toBeGreaterThanOrEqual(IMAGE_COUNT);
});
