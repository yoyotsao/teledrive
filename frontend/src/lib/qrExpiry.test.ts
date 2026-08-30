/**
 * Why this matters: Telegram issues each QR login token with ~29s of life, but
 * GramJS's signInUserWithQrCode refreshes on a hardcoded 30s timer and never
 * looks at `expires` (node_modules/telegram/client/auth.js:38). Measured on the
 * live site and in an isolated Node repro, the refresh lands 30.0-30.5s apart
 * against a 28-29s token, so the last second-and-a-bit of every cycle shows a
 * QR that Telegram will refuse — the phone answers "掃描二維碼發生錯誤" and the
 * web page, which threw `expires` away, cheerfully keeps showing the dead code.
 * These asserts pin that we call a token dead slightly BEFORE its deadline,
 * because the phone still has to get its acceptLoginToken to Telegram.
 */
import { describe, expect, it } from 'vitest';
import { qrFreshness, SCAN_LATENCY_MS } from './qrExpiry.ts';

const NOW = 1_700_000_000_000; // fixed clock; nothing here may read the real one
const at = (secondsFromNow: number) => Math.floor(NOW / 1000) + secondsFromNow;

describe('qrFreshness', () => {
  // --- 還沒拿到 token：不能顯示一張不存在的 QR --------------------------------
  it('treats "no token yet" as unusable with no time left', () => {
    const f = qrFreshness(0, NOW);
    expect(f.usable).toBe(false);
    expect(f.secondsLeft).toBe(0);
  });

  // --- 剛發下來的 token：正常可掃 ---------------------------------------------
  it('reports a freshly issued token as usable for its full life', () => {
    const f = qrFreshness(at(29), NOW);
    expect(f.usable).toBe(true);
    expect(f.secondsLeft).toBe(29);
  });

  // --- 核心：過期前就要停止顯示，因為手機送出 accept 還要時間 ------------------
  describe('the scan-latency margin', () => {
    it('is a positive whole number of milliseconds', () => {
      expect(Number.isInteger(SCAN_LATENCY_MS)).toBe(true);
      expect(SCAN_LATENCY_MS).toBeGreaterThan(0);
    });

    it('marks a token dying within the margin as already unusable', () => {
      const justInsideMargin = qrFreshness(at(0) + Math.ceil(SCAN_LATENCY_MS / 1000) - 1, NOW);
      expect(justInsideMargin.usable).toBe(false);
    });

    it('keeps a token that outlives the margin usable', () => {
      const clearOfMargin = qrFreshness(Math.floor((NOW + SCAN_LATENCY_MS + 2000) / 1000), NOW);
      expect(clearOfMargin.usable).toBe(true);
    });
  });

  // --- 已經過期：絕不能再顯示，倒數也不能變負數 -------------------------------
  it('never counts an expired token below zero', () => {
    const f = qrFreshness(at(-5), NOW);
    expect(f.usable).toBe(false);
    expect(f.secondsLeft).toBe(0);
  });

  // --- 這正是量到的失效窗口：GramJS 第 30.2 秒才換，token 第 29 秒就死 ---------
  it('calls the token GramJS leaves on screen until its 30.2s refresh dead', () => {
    const issuedAt = NOW;
    const expiresAt = Math.floor(issuedAt / 1000) + 29;

    expect(qrFreshness(expiresAt, issuedAt + 30_200).usable).toBe(false);
    expect(qrFreshness(expiresAt, issuedAt + 15_000).usable).toBe(true);
  });

  // --- 純函式：問兩次必須得到同一個答案 ---------------------------------------
  it('is pure — asking twice at the same instant gives the same answer', () => {
    const expiresAt = at(20);

    expect(qrFreshness(expiresAt, NOW)).toEqual(qrFreshness(expiresAt, NOW));
  });
});
