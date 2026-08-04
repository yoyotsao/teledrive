/**
 * Self-check for the pacer's two distinct flood responses.
 * Run from frontend/ (esbuild strips the types node's strip-only mode rejects):
 *   npx esbuild --bundle --platform=node --format=esm \
 *     src/lib/adaptiveRateLimiter.selfcheck.ts | node --input-type=module
 *
 * Why this matters: FLOOD_PREMIUM_WAIT is an account-tier upload cap, not a
 * "too fast" signal. Cutting the rate never reduces it (it fired thousands of
 * times at the 0.5 parts/s floor, and official Telegram Desktop hits the same
 * wall), but the cut IS persisted — so treating it like FLOOD_WAIT keeps the
 * upload throttled for hours after Telegram has stopped throttling. pause()
 * must wait without touching rate or ceiling; reportFlood() must still cut,
 * because for a genuine FLOOD_WAIT the cut is what helps.
 */
import { AdaptiveRateLimiter } from './adaptiveRateLimiter.ts';

function check(label: string, cond: boolean): void {
  if (!cond) throw new Error(`FAIL: ${label}`);
  console.log(`ok - ${label}`);
}

// No storageKey → never touches window.localStorage, so this runs bare in node.
const opts = {
  initialRate: 4,
  minRate: 0.5,
  maxRate: 12,
  decreaseFactor: 0.5,
  increaseStep: 0.5,
  increaseIntervalMs: 10_000,
  cleanWindowMs: 20_000,
  burst: 2,
  ceiling: {
    backoff: 0.95,
    slowZone: 0.8,
    floor: 1.0,
    slowStep: 0.1,
    slowIntervalMs: 30_000,
    probeCooldownMs: 300_000,
    probeCooldownMaxMs: 1_800_000,
    probeStep: 0.2,
    probeConfirmMs: 60_000,
    escalationCount: 3,
    escalationWindowMs: 120_000,
    escalatedDecreaseFactor: 0.3,
    escalatedCeilingFactor: 0.9,
    escalatedCleanWindowMs: 60_000,
    escalationResetMs: 600_000,
  },
};

// pause() — the FLOOD_PREMIUM_WAIT path must not self-throttle.
const premium = new AdaptiveRateLimiter({ ...opts, label: 'premium-path' });
const before = premium.stats();
for (let i = 0; i < 50; i++) premium.pause(6);
const after = premium.stats();
check('pause() leaves rate untouched', after.rate === before.rate);
check('pause() learns no ceiling', after.ceiling === null);
check('pause() is not counted as a flood', after.floods === 0);

// ...but it must still actually hold the feed back.
const t0 = Date.now();
await premium.wait();
check('pause() delays the next slot', Date.now() - t0 > 900);

// reportFlood() — the genuine FLOOD_WAIT path must still cut the rate.
const genuine = new AdaptiveRateLimiter({ ...opts, label: 'flood-path' });
genuine.reportFlood(6);
const cut = genuine.stats();
check('reportFlood() cuts the rate', cut.rate === 2); // 4 × decreaseFactor 0.5
check('reportFlood() learns a ceiling', cut.ceiling !== null);
check('reportFlood() counts the flood', cut.floods === 1);

console.log('\nall checks passed');
