/**
 * Self-check for qrFreshness. Run from frontend/:
 *   npx esbuild --bundle --platform=node --format=esm \
 *     src/lib/qrExpiry.selfcheck.ts | node --input-type=module
 *
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
import { qrFreshness, SCAN_LATENCY_MS } from './qrExpiry.ts';

function check(label: string, cond: boolean): void {
  if (!cond) throw new Error(`FAIL: ${label}`);
  console.log(`ok - ${label}`);
}

const NOW = 1_700_000_000_000; // fixed clock; nothing here may read the real one
const at = (secondsFromNow: number) => Math.floor(NOW / 1000) + secondsFromNow;

// --- 還沒拿到 token：不能顯示一張不存在的 QR --------------------------------
{
  const f = qrFreshness(0, NOW);
  check('no token yet is not usable', !f.usable);
  check('no token yet reports no time left', f.secondsLeft === 0);
}

// --- 剛發下來的 token：正常可掃 ---------------------------------------------
{
  const f = qrFreshness(at(29), NOW);
  check('a freshly issued token is usable', f.usable);
  check('a freshly issued token reports its full life', f.secondsLeft === 29);
}

// --- 核心：過期前就要停止顯示，因為手機送出 accept 還要時間 ------------------
{
  check('the scan-latency margin is a whole number of ms', Number.isInteger(SCAN_LATENCY_MS));
  check('the scan-latency margin is more than zero', SCAN_LATENCY_MS > 0);

  const justInsideMargin = qrFreshness(at(0) + Math.ceil(SCAN_LATENCY_MS / 1000) - 1, NOW);
  check('a token dying within the scan latency is already unusable', !justInsideMargin.usable);

  const clearOfMargin = qrFreshness(Math.floor((NOW + SCAN_LATENCY_MS + 2000) / 1000), NOW);
  check('a token that outlives the scan latency stays usable', clearOfMargin.usable);
}

// --- 已經過期：絕不能再顯示，倒數也不能變負數 -------------------------------
{
  const f = qrFreshness(at(-5), NOW);
  check('an expired token is not usable', !f.usable);
  check('an expired token never counts below zero', f.secondsLeft === 0);
}

// --- 這正是量到的失效窗口：GramJS 第 30.2 秒才換，token 第 29 秒就死 ---------
{
  const issuedAt = NOW;
  const expiresAt = Math.floor(issuedAt / 1000) + 29;
  const atRefresh = qrFreshness(expiresAt, issuedAt + 30_200);
  check('the token GramJS leaves on screen until its 30.2s refresh is dead', !atRefresh.usable);

  const midCycle = qrFreshness(expiresAt, issuedAt + 15_000);
  check('the same token mid-cycle is still fine', midCycle.usable);
}

// --- 純函式：問兩次必須得到同一個答案 ---------------------------------------
{
  const expiresAt = at(20);
  const a = qrFreshness(expiresAt, NOW);
  const b = qrFreshness(expiresAt, NOW);
  check('asking twice at the same instant gives the same answer', a.usable === b.usable && a.secondsLeft === b.secondsLeft);
}

console.log('\nAll qrExpiry self-checks passed.');
