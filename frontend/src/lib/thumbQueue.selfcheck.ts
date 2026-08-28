/**
 * Self-check for ThumbBatchQueue. Run from frontend/:
 *   npx esbuild --bundle --platform=node --format=esm \
 *     src/lib/thumbQueue.selfcheck.ts | node --input-type=module
 *
 * Why this matters: thumbnails used to be downloaded with a FRESH Semaphore(6)
 * per loaded page, so a fast scroll that appended 28 pages in 15s fanned out to
 * dozens of concurrent upload.GetFile calls on the same MTProto connection. The
 * connection died ("Error: Not connected") and reconnect-looped forever, so the
 * rendered thumbnail count froze — measured live at 400 thumbs for 6000 cards.
 * These asserts pin the three properties that prevent that: one batch at a
 * time, newest page first (that's the page the user is looking at), and queued
 * batches whose view is gone never run at all.
 */
import { ThumbBatchQueue } from './thumbQueue.ts';

function check(label: string, cond: boolean): void {
  if (!cond) throw new Error(`FAIL: ${label}`);
  console.log(`ok - ${label}`);
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// --- 一次只跑一個批次：並發永遠不超過 1 -------------------------------------
{
  const q = new ThumbBatchQueue();
  let running = 0;
  let peak = 0;
  const batch = async () => {
    running++;
    peak = Math.max(peak, running);
    await tick();
    running--;
  };
  await Promise.all(Array.from({ length: 8 }, () => q.enqueue(batch)));
  check('never runs two batches at once (peak concurrency 1)', peak === 1);
}

// --- LIFO：使用者停在最新那頁,最新批次先跑 ---------------------------------
{
  const q = new ThumbBatchQueue();
  const order: number[] = [];
  const gate: Array<() => void> = [];
  // 第一個批次先卡住,讓後面 3 個排隊,才看得出取用順序
  const first = q.enqueue(async () => {
    order.push(0);
    await new Promise<void>((r) => gate.push(r));
  });
  await tick();
  const rest = [1, 2, 3].map((n) => q.enqueue(async () => { order.push(n); }));
  gate[0]();
  await Promise.all([first, ...rest]);
  check('drains newest-queued batch first (LIFO)', order.join(',') === '0,3,2,1');
}

// --- 已中止的批次連跑都不該跑（換資料夾/換檢視就整批作廢）-------------------
{
  const q = new ThumbBatchQueue();
  const ran: string[] = [];
  const ac = new AbortController();
  const gate: Array<() => void> = [];
  const blocker = q.enqueue(async () => { await new Promise<void>((r) => gate.push(r)); });
  await tick();
  const stale = q.enqueue(async () => { ran.push('stale'); }, ac.signal);
  const live = q.enqueue(async () => { ran.push('live'); });
  ac.abort();
  gate[0]();
  const results = await Promise.all([blocker, stale, live]);
  check('drops queued batches whose signal aborted', ran.join(',') === 'live');
  check('reports the dropped batch back to the caller', results[1] === 'dropped');
  check('reports completed batches as done', results[0] === 'done' && results[2] === 'done');
}

// --- 批次丟出例外不能卡死佇列 ----------------------------------------------
{
  const q = new ThumbBatchQueue();
  const ran: string[] = [];
  const boom = q.enqueue(async () => { throw new Error('boom'); });
  const after = q.enqueue(async () => { ran.push('after'); });
  const results = await Promise.all([boom, after]);
  check('a throwing batch does not wedge the queue', ran.join(',') === 'after');
  check('a throwing batch resolves as failed, never rejects', results[0] === 'failed');
}

console.log('\nAll thumbQueue self-checks passed.');
