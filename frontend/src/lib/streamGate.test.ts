/**
 * Why this matters: the video preview's "stop accepting preload chunks" flag
 * used to be a latch that gated the only code able to clear it. Closing a
 * video set it; the sole reset sat INSIDE startKeepalive(), which the chunk
 * handler only reaches AFTER the flag check. So the first chunk of the next
 * video was rejected with 'Streaming stopped', the Service Worker retried 3x
 * and answered 503 — no video could ever be previewed again without an F5.
 * These asserts pin that open/close are the only inputs and that asking the
 * gate a question never changes its answer.
 */
import { describe, expect, it } from 'vitest';
import { StreamGate } from './streamGate.ts';

describe('StreamGate', () => {
  // --- 頁面剛載入：第一支影片必須能串流 ----------------------------------------
  it('accepts chunk requests when fresh', () => {
    expect(new StreamGate().accepts()).toBe(true);
  });

  // --- 關閉預覽：關掉後才抵達的預載 chunk 必須被擋掉 ----------------------------
  it('rejects late preload chunks once the preview is closed', () => {
    const gate = new StreamGate();
    gate.closed();

    expect(gate.accepts()).toBe(false);
  });

  // --- 迴歸：關掉一支再開下一支，必須重新放行（這就是 503 卡死的成因）----------
  it('streams again when a new video opens after a previous close', () => {
    const gate = new StreamGate();
    gate.closed();
    gate.opened();

    expect(gate.accepts()).toBe(true);
  });

  // --- accepts() 必須無副作用：問兩次答案要一樣，不能靠「被放行」來自我解鎖 ------
  it('does not unlatch itself when asked twice', () => {
    const gate = new StreamGate();
    gate.closed();
    gate.accepts();

    expect(gate.accepts()).toBe(false);
  });

  // --- open/close 可重複進出，狀態只由這兩個事件決定 ---------------------------
  it('is decided only by open/close, however often each repeats', () => {
    const gate = new StreamGate();

    gate.opened();
    gate.opened();
    expect(gate.accepts()).toBe(true);

    gate.closed();
    gate.closed();
    expect(gate.accepts()).toBe(false);

    gate.opened();
    expect(gate.accepts()).toBe(true);
  });
});
