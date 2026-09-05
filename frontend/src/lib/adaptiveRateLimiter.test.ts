/**
 * Why this matters: FLOOD_PREMIUM_WAIT is an account-tier upload cap, not a
 * "too fast" signal. Cutting the rate never reduces it (it fired thousands of
 * times at the 0.5 parts/s floor, and official Telegram Desktop hits the same
 * wall), but the cut IS persisted — so treating it like FLOOD_WAIT keeps the
 * upload throttled for hours after Telegram has stopped throttling. pause()
 * must wait without touching rate or ceiling; reportFlood() must still cut,
 * because for a genuine FLOOD_WAIT the cut is what helps.
 *
 * These tests move real wall-clock time (the limiter schedules with setTimeout
 * against Date.now()); the waits are kept to a few seconds.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHUNK_RATE_MAX, MAX_CONCURRENT_CHUNKS } from '../config.ts';
import { AdaptiveRateLimiter } from './adaptiveRateLimiter.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

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

describe('account-aware diagnostics', () => {
  it('prefixes initialization and ramp logs with the account name', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const limiter = new AdaptiveRateLimiter({
      ...opts,
      accountId: 8773541354,
      accountName: 'test1',
      label: 'ChunkRate:8773541354',
    });

    limiter.reportSuccess();
    vi.advanceTimersByTime(opts.increaseIntervalMs);
    limiter.reportSuccess();

    expect(log).toHaveBeenCalledWith(
      '[test1][Perf][ChunkRate:8773541354] init rate=4.0 parts/s (source=default)',
    );
    expect(log).toHaveBeenCalledWith(
      '[test1][Perf][ChunkRate:8773541354] ramp → 4.5 parts/s',
    );
  });
});

describe('production exploration ceiling', () => {
  it('can ramp beyond 12 parts/s while retaining the 12-request concurrency guard', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const limiter = new AdaptiveRateLimiter({
      ...opts,
      initialRate: 12,
      maxRate: CHUNK_RATE_MAX,
      increaseIntervalMs: 10_000,
      ceiling: undefined,
      label: 'ChunkRate:test',
    });

    vi.advanceTimersByTime(10_000);
    limiter.reportSuccess();

    expect(CHUNK_RATE_MAX).toBe(32);
    expect(MAX_CONCURRENT_CHUNKS).toBe(12);
    expect(limiter.stats().rate).toBe(12.5);
  });
});

describe('pause() — the FLOOD_PREMIUM_WAIT path', () => {
  it('does not self-throttle, however often it fires', () => {
    const premium = new AdaptiveRateLimiter({ ...opts, label: 'premium-path' });
    const before = premium.stats();

    for (let i = 0; i < 50; i++) premium.pause(6);

    const after = premium.stats();
    expect(after.rate).toBe(before.rate);
    expect(after.ceiling).toBeNull();
    expect(after.floods).toBe(0);
  });

  it('still actually holds the feed back', async () => {
    // A 1s pause rather than the 6s Telegram usually sends: the property is
    // that the next slot moves at all, and this run costs a second instead of
    // seven. The full-length window is exercised by the penalty-window test.
    const premium = new AdaptiveRateLimiter({ ...opts, label: 'premium-delay' });
    premium.pause(1);

    const t0 = Date.now();
    await premium.wait();

    expect(Date.now() - t0).toBeGreaterThan(900);
  }, 10_000);
});

describe('reportFlood() — the genuine FLOOD_WAIT path', () => {
  it('cuts the rate and records the flood', () => {
    const genuine = new AdaptiveRateLimiter({ ...opts, label: 'flood-path' });

    genuine.reportFlood(6);

    const cut = genuine.stats();
    expect(cut.rate).toBe(2); // 4 × decreaseFactor 0.5
    expect(cut.ceiling).not.toBeNull();
    expect(cut.floods).toBe(1);
  });

  it('converges on the wall in one flood from a cold start', () => {
    // Setting the first ceiling to backoff (0.95) × the flooding rate leaves it
    // a hair under a rate already proven too fast, so it would take ~5 more
    // floods to find the wall — and 3 floods inside escalationWindowMs escalate,
    // driving the rate to minRate and the ceiling to floor. firstBackoff is the
    // harder one-shot cut that keeps a fresh page load from re-running that
    // collapse every session.
    const genuine = new AdaptiveRateLimiter({ ...opts, label: 'cold-start' });

    genuine.reportFlood(6);

    const cut = genuine.stats();
    expect(cut.ceiling).toBe(2); // firstBackoff 0.5 × initialRate 4
    expect(cut.rate).toBe(cut.ceiling);
  });
});

describe('wait() — the penalty window', () => {
  it('binds parts that were already asleep when the flood landed', async () => {
    // reportFlood/pause can only push nextSlotAt forward; they cannot
    // reschedule a pending setTimeout, so without the re-check inside wait()
    // up to MAX_CONCURRENT_CHUNKS parts wake on stale deadlines and fire into
    // a punished account — each harvesting the same window's remaining seconds
    // (a 12→10→8→6→5→3 countdown in the wild) and extending it.
    // Rate 0.5 here so one slot interval is a whole 2s.
    const gated = new AdaptiveRateLimiter({ ...opts, initialRate: 0.5, label: 'penalty-window' });
    const t1 = Date.now();
    const firedAt: number[] = [];
    const waiters = Array.from({ length: 12 }, () =>
      gated.wait().then(() => firedAt.push(Date.now() - t1)),
    );

    // Let the parts the burst allowance already released reach the server —
    // those are the ones that come back FLOOD_WAIT, and cannot be recalled.
    await new Promise((r) => setTimeout(r, 50));
    const alreadyGone = firedAt.length;
    gated.reportFlood(6);
    const windowEndsAt = Date.now() - t1 + 6_000 + 1_000;
    await Promise.all(waiters);

    const stillAsleep = firedAt.slice(alreadyGone);
    expect(stillAsleep.every((t) => t >= windowEndsAt - 100)).toBe(true);
    // And once released they stay paced 1/rate apart.
    expect(stillAsleep.slice(1).every((t, i) => t - stillAsleep[i] >= 2_000 - 100)).toBe(true);
  }, 30_000);
});
