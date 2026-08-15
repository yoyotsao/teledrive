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
    firstBackoff: 0.5,
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

// Cold start (ceiling still null) must converge in ONE flood. Setting the first
// ceiling to backoff (0.95) × the flooding rate leaves it a hair under a rate
// already proven too fast, so it takes ~5 more floods to find the wall — and 3
// floods inside escalationWindowMs escalate, which drives the rate to minRate
// and the ceiling to floor. firstBackoff is the harder one-shot cut that keeps
// a fresh page load from re-running that collapse every session.
check('first flood learns the ceiling at firstBackoff × the flooding rate', cut.ceiling === 2);
check('first flood leaves the rate at the ceiling, not above it', cut.rate === cut.ceiling);

// wait() — a penalty window must bind the parts that were already asleep on a
// slot reserved before the flood landed. reportFlood/pause can only push
// nextSlotAt forward; they cannot reschedule a pending setTimeout, so without
// the re-check in wait() up to MAX_CONCURRENT_CHUNKS parts wake on stale
// deadlines and fire into a punished account — each harvesting the same
// window's remaining seconds (a 12→10→8→6→5→3 countdown in the wild) and
// extending it. Rate 0.5 here so one slot interval is a whole 2s.
const gated = new AdaptiveRateLimiter({ ...opts, initialRate: 0.5, label: 'penalty-window' });
const t1 = Date.now();
const firedAt: number[] = [];
const waiters = Array.from({ length: 12 }, () =>
  gated.wait().then(() => firedAt.push(Date.now() - t1)),
);
// Let the parts the burst allowance already released reach the server — those
// are the ones that come back FLOOD_WAIT, and they cannot be recalled.
await new Promise((r) => setTimeout(r, 50));
const alreadyGone = firedAt.length;
gated.reportFlood(6);
const windowEndsAt = Date.now() - t1 + 6_000 + 1_000;
await Promise.all(waiters);

const stillAsleep = firedAt.slice(alreadyGone);
check(
  'penalty window holds back every part that had not left yet',
  stillAsleep.every((t) => t >= windowEndsAt - 100),
);
check(
  'parts released after the window stay paced 1/rate apart',
  stillAsleep.slice(1).every((t, i) => t - stillAsleep[i] >= 2_000 - 100),
);

console.log('\nall checks passed');
