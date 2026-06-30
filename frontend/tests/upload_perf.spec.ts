/**
 * Upload performance test — drag-drop N small files and monitor network throughput.
 *
 * Prerequisites:
 *   1. App is running (npm run dev in frontend/)
 *   2. Session already configured (localStorage has tg_session + tg_jwt)
 *   3. Optional: run `python tests/generate_test_files.py` to produce real disk files
 *
 * Env vars:
 *   PERF_FILE_COUNT  — number of synthetic files to drop  (default: 1000)
 *   PERF_FILE_KB     — each file size in KB               (default: 5)
 *   PERF_DURATION_S  — how long to monitor after drop     (default: 120)
 *
 * Run:
 *   cd frontend && npx playwright test upload_perf --project=chromium --reporter=line
 *   PERF_FILE_COUNT=100000 npx playwright test upload_perf --project=chromium --reporter=line
 */

import { test, expect } from '@playwright/test';

const FILE_COUNT = parseInt(process.env.PERF_FILE_COUNT ?? '1000');
const FILE_KB    = parseInt(process.env.PERF_FILE_KB    ?? '5');
const DURATION_S = parseInt(process.env.PERF_DURATION_S ?? '120');

test.setTimeout((DURATION_S + 60) * 1000);

test(`drag-drop ${FILE_COUNT} × ${FILE_KB}KB files — network throughput`, async ({ page, context }) => {

  // ── CDP network monitoring (WebSocket = GramJS MTProto) ──────────────────
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');

  let wsSentBytes     = 0;
  let wsReceivedBytes = 0;

  interface Sample { ts: number; sent: number }
  const samples: Sample[] = [];

  // payloadData for binary frames is base64 — actual bytes ≈ length × 0.75
  cdp.on('Network.webSocketFrameSent',     (e) => { wsSentBytes     += e.response.payloadData.length; });
  cdp.on('Network.webSocketFrameReceived', (e) => { wsReceivedBytes += e.response.payloadData.length; });

  const sampler = setInterval(() => {
    samples.push({ ts: Date.now(), sent: wsSentBytes });
  }, 5_000);

  // Capture browser console errors to diagnose upload failures
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 200));
  });
  page.on('pageerror', (err) => consoleErrors.push('[pageerror] ' + err.message.slice(0, 200)));

  // ── Navigate & check login ────────────────────────────────────────────────
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');

  const loginVisible = await page
    .locator('input[placeholder*="session"], input[placeholder*="Session"]')
    .first().isVisible().catch(() => false);
  if (loginVisible) {
    clearInterval(sampler);
    test.skip(true, 'Login required — configure session in the app first');
    return;
  }

  await page.waitForSelector('text=Root', { timeout: 30_000 });

  // Verify drop zone element is in DOM (data-testid added for test targeting)
  const dropZoneInfo = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="drive-drop-zone"]');
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(10)], 'probe.bin'));
    return {
      dropZoneFound: !!el,
      dropZoneTag: el?.tagName ?? 'NOT FOUND',
      dtFilesLen: dt.files.length,
      dtItemsLen: dt.items.length,
    };
  });
  console.log('[Perf] Diagnostics:', dropZoneInfo);

  console.log(`\n[Perf] App ready. Building ${FILE_COUNT.toLocaleString()} × ${FILE_KB} KB files in browser…`);

  // ── Build DataTransfer + dispatch drop in browser ─────────────────────────
  // Files are created inside page.evaluate so no MB of data flows through CDP.
  // Content: buf[i] = i & 0xff — deterministic, fast, no crypto overhead.
  const dropStart = Date.now();

  await page.evaluate(
    async ({ count, kbSize }: { count: number; kbSize: number }) => {
      const YIELD_EVERY = 500; // yield control every N files to keep tab responsive
      const dt = new DataTransfer();
      const byteSize = kbSize * 1024;

      for (let i = 0; i < count; i++) {
        const buf = new Uint8Array(byteSize);
        buf.fill(i & 0xff);
        dt.items.add(
          new File([buf], `perf_${String(i).padStart(6, '0')}.bin`, {
            type: 'application/octet-stream',
          })
        );
        if (i % YIELD_EVERY === YIELD_EVERY - 1) {
          await new Promise<void>((r) => setTimeout(r, 0));
        }
      }

      const opts: DragEventInit = { dataTransfer: dt, bubbles: true, cancelable: true };
      const target = document.querySelector('[data-testid="drive-drop-zone"]') ?? document.body;
      target.dispatchEvent(new DragEvent('dragenter', opts));
      target.dispatchEvent(new DragEvent('dragover',  opts));
      target.dispatchEvent(new DragEvent('drop',      opts));
    },
    { count: FILE_COUNT, kbSize: FILE_KB }
  );

  console.log(`[Perf] DataTransfer built + drop dispatched in ${Date.now() - dropStart} ms`);

  // ── Wait for upload UI ────────────────────────────────────────────────────
  try {
    await page.waitForSelector('text=上傳中', { timeout: 30_000 });
  } catch {
    clearInterval(sampler);
    throw new Error('Upload UI never appeared — drop event not handled by ChonkyDrive');
  }
  console.log(`[Perf] Upload started. Monitoring for ${DURATION_S}s…\n`);

  // ── Polling loop ──────────────────────────────────────────────────────────
  const deadline   = Date.now() + DURATION_S * 1_000;
  let prevSent     = 0;
  let prevTime     = Date.now();
  let prevDoneStr  = '';
  let stuckTicks   = 0;

  while (Date.now() < deadline) {
    await page.waitForTimeout(10_000);

    const now     = Date.now();
    const elapsed = (now - prevTime) / 1000;
    const delta   = (wsSentBytes - prevSent) * 0.75; // base64 → actual bytes
    const mbps    = delta / elapsed / (1024 * 1024);

    const doneText = await page
      .locator('text=/上傳中 \\d+/')
      .first()
      .textContent()
      .catch(() => '(hidden)');

    console.log(
      `[${new Date().toISOString().slice(11, 19)}]` +
      `  UI: "${doneText ?? ''}"` +
      `  |  WS↑ ${mbps.toFixed(2)} MB/s` +
      `  |  total ↑${(wsSentBytes  * 0.75 / 1048576).toFixed(1)} MB` +
      `  ↓${(wsReceivedBytes * 0.75 / 1048576).toFixed(1)} MB`
    );

    if (doneText === prevDoneStr) {
      stuckTicks++;
      if (stuckTicks >= 3) console.warn('[Perf] ⚠️  No progress for 30 s — upload may be stuck');
    } else {
      stuckTicks  = 0;
      prevDoneStr = doneText ?? '';
    }

    prevSent = wsSentBytes;
    prevTime = now;
  }

  clearInterval(sampler);

  // ── Final report ──────────────────────────────────────────────────────────
  const totalActualMB = wsSentBytes * 0.75 / 1048576;
  const avgMbps = totalActualMB / DURATION_S;

  const windows = samples.slice(1).map((s, i) => {
    const dt = (s.ts - samples[i].ts) / 1000;
    const db = (s.sent - samples[i].sent) * 0.75 / 1048576;
    return db / dt;
  });
  const sorted   = [...windows].sort((a, b) => a - b);
  const peakMbps = windows.length ? Math.max(...windows) : 0;
  const p50Mbps  = sorted.length  ? sorted[Math.floor(sorted.length / 2)] : 0;

  if (consoleErrors.length > 0) {
    console.log('\n[Perf] Browser errors (first 10):');
    consoleErrors.slice(0, 10).forEach((e, i) => console.log(`  [${i}] ${e}`));
  }

  console.log('\n╔══════════════════════════════════════════════╗');
  console.log(`║  Files dropped  : ${FILE_COUNT.toLocaleString().padStart(8)} × ${FILE_KB} KB`);
  console.log(`║  Monitor window : ${DURATION_S} s`);
  console.log(`║  Total WS ↑     : ${totalActualMB.toFixed(1)} MB`);
  console.log(`║  Avg throughput : ${avgMbps.toFixed(2)} MB/s`);
  console.log(`║  Peak (5 s win) : ${peakMbps.toFixed(2)} MB/s`);
  console.log(`║  P50  (5 s win) : ${p50Mbps.toFixed(2)} MB/s`);
  console.log(`║  Stuck ticks    : ${stuckTicks}`);
  console.log('╚══════════════════════════════════════════════╝\n');

  expect(wsSentBytes, 'No WebSocket upload traffic detected').toBeGreaterThan(0);
  expect(stuckTicks,  'Upload stuck — no progress for last 30 s').toBeLessThan(3);
});
