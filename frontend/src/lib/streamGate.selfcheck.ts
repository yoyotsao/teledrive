/**
 * Self-check for StreamGate. Run from frontend/:
 *   npx esbuild --bundle --platform=node --format=esm \
 *     src/lib/streamGate.selfcheck.ts | node --input-type=module
 *
 * Why this matters: the video preview's "stop accepting preload chunks" flag
 * used to be a latch that gated the only code able to clear it. Closing a
 * video set it; the sole reset sat INSIDE startKeepalive(), which the chunk
 * handler only reaches AFTER the flag check. So the first chunk of the next
 * video was rejected with 'Streaming stopped', the Service Worker retried 3x
 * and answered 503 — no video could ever be previewed again without an F5.
 * These asserts pin that open/close are the only inputs and that asking the
 * gate a question never changes its answer.
 */
import { StreamGate } from './streamGate.ts';

function check(label: string, cond: boolean): void {
  if (!cond) throw new Error(`FAIL: ${label}`);
  console.log(`ok - ${label}`);
}

// --- 頁面剛載入：第一支影片必須能串流 ----------------------------------------
{
  const gate = new StreamGate();
  check('a fresh gate accepts chunk requests', gate.accepts());
}

// --- 關閉預覽：關掉後才抵達的預載 chunk 必須被擋掉 ----------------------------
{
  const gate = new StreamGate();
  gate.closed();
  check('closing the preview rejects late preload chunks', !gate.accepts());
}

// --- 迴歸：關掉一支再開下一支,必須重新放行(這就是 503 卡死的成因) ----------
{
  const gate = new StreamGate();
  gate.closed();
  gate.opened();
  check('a newly opened video streams again after a previous close', gate.accepts());
}

// --- accepts() 必須無副作用:問兩次答案要一樣,不能靠「被放行」來自我解鎖 ------
{
  const gate = new StreamGate();
  gate.closed();
  gate.accepts();
  check('accepts() does not unlatch itself when asked twice', !gate.accepts());
}

// --- open/close 可重複進出,狀態只由這兩個事件決定 ---------------------------
{
  const gate = new StreamGate();
  gate.opened();
  gate.opened();
  check('reopening an already open gate stays open', gate.accepts());
  gate.closed();
  gate.closed();
  check('reclosing an already closed gate stays closed', !gate.accepts());
  gate.opened();
  check('the gate reopens after a repeated close', gate.accepts());
}

console.log('\nAll StreamGate self-checks passed.');
