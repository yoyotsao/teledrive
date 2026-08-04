export interface CeilingOptions {
  /** On flood, ceiling ≤ backoff × the rate that triggered it. */
  backoff: number;
  /** Fraction of ceiling where the fast ramp gives way to the slow creep. */
  slowZone: number;
  /** Ceiling is never learned below this (parts/s). */
  floor: number;
  /** Additive step (parts/s) inside the slow zone. */
  slowStep: number;
  /** Minimum time between slow-zone ticks. */
  slowIntervalMs: number;
  /** Clean time at the ceiling before a probe past it is attempted. */
  probeCooldownMs: number;
  /** Failed probes double the cooldown, capped here. */
  probeCooldownMaxMs: number;
  /** Rate bump (parts/s) when probing past the ceiling. */
  probeStep: number;
  /** Clean time the probe rate must be sustained before the ceiling is raised. */
  probeConfirmMs: number;
  /** Distinct floods within escalationWindowMs that trigger escalation. */
  escalationCount: number;
  /** Sliding window for counting distinct floods toward escalation. */
  escalationWindowMs: number;
  /** Harder multiplicative cut while escalated. */
  escalatedDecreaseFactor: number;
  /** Ceiling is additionally dropped by this factor while escalated. */
  escalatedCeilingFactor: number;
  /** Clean window enforced while escalated. */
  escalatedCleanWindowMs: number;
  /** Flood-free time required to de-escalate. */
  escalationResetMs: number;
}

export interface AdaptiveRateLimiterOptions {
  initialRate: number;
  minRate: number;
  maxRate: number;
  decreaseFactor: number;
  increaseStep: number;
  increaseIntervalMs: number;
  cleanWindowMs: number;
  burst: number;
  storageKey?: string;
  label?: string;
  /**
   * Ceiling-memory tuning. When omitted, reportFlood/reportSuccess behave as a
   * plain AIMD pacer (no ceiling learning) — keeps the class generic.
   */
  ceiling?: CeilingOptions;
}

interface PersistedRate {
  rate: number;
  ceiling: number | null;
  updatedAt: number;
}

const PERSIST_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PERSIST_DEBOUNCE_MS = 2000;
const PERSIST_LOAD_DISCOUNT = 0.8;

/**
 * Adaptive-Increase-Multiplicative-Decrease pacer for Telegram account-level
 * rate limits (SaveFilePart/SaveBigFilePart). Uses virtual-time slot
 * scheduling instead of token counting: each wait() synchronously reserves
 * the next slot, so concurrent callers are serialized ~1/rate apart and can
 * never all pass through at once — this is what prevents the thundering-herd
 * reburst that a token-bucket wait() (see rateLimiter.ts) suffers from under
 * high concurrency.
 *
 * With `ceiling` options supplied, plain AIMD is augmented with ceiling
 * memory: the rate that triggers each FLOOD_WAIT is remembered, the pacer
 * ramps fast only well below it, creeps near it, holds at it, and only probes
 * past it after a long clean period. This converts the AIMD sawtooth (which
 * must overshoot to find the limit, so floods recur every cycle) into
 * convergence just below the discovered limit.
 */
export class AdaptiveRateLimiter {
  private rate: number;
  private ceiling: number | null = null;
  private nextSlotAt = 0;
  private penaltyUntil = 0;
  private lastFloodAt: number | null = null;
  private lastIncreaseAt = 0;
  private floods = 0;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  // Ceiling-memory state
  private floodEvents: number[] = [];
  private escalatedUntil = 0;
  private probeStartedAt: number | null = null;
  private probeCooldownMs: number;
  private lastProbeEndedAt = Date.now();

  constructor(private opts: AdaptiveRateLimiterOptions) {
    this.probeCooldownMs = opts.ceiling?.probeCooldownMs ?? 0;
    this.rate = this.loadInitialRate();
  }

  private loadInitialRate(): number {
    const { storageKey, initialRate, minRate, maxRate, label, ceiling: ceilOpts } = this.opts;
    const clampRate = (r: number) => Math.min(maxRate, Math.max(minRate, r));
    const clampCeiling = (c: number) =>
      Math.min(maxRate, Math.max(ceilOpts?.floor ?? minRate, c));

    if (storageKey) {
      try {
        const raw = window.localStorage.getItem(storageKey);
        if (raw) {
          const parsed = JSON.parse(raw) as PersistedRate;
          if (
            typeof parsed.rate === 'number' &&
            typeof parsed.updatedAt === 'number' &&
            Date.now() - parsed.updatedAt < PERSIST_MAX_AGE_MS
          ) {
            if (typeof parsed.ceiling === 'number' && parsed.ceiling > 0) {
              this.ceiling = clampCeiling(parsed.ceiling);
            }
            // Start below the ceiling (if known) so a fresh session creeps up
            // gently instead of overshooting into a flood on the first ramp.
            const cap = this.ceiling ?? maxRate;
            const rate = clampRate(Math.min(parsed.rate, cap) * PERSIST_LOAD_DISCOUNT);
            console.log(
              `[Perf][${label ?? 'RateLimiter'}] init rate=${rate.toFixed(1)} parts/s ceiling=${this.ceiling?.toFixed(1) ?? 'none'} (source=storage)`,
            );
            return rate;
          }
        }
      } catch {
        // ignore malformed/inaccessible storage, fall through to default
      }
    }
    console.log(`[Perf][${label ?? 'RateLimiter'}] init rate=${initialRate.toFixed(1)} parts/s (source=default)`);
    return initialRate;
  }

  private persist(immediate: boolean): void {
    const { storageKey } = this.opts;
    if (!storageKey) return;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    const write = () => {
      try {
        const payload: PersistedRate = { rate: this.rate, ceiling: this.ceiling, updatedAt: Date.now() };
        window.localStorage.setItem(storageKey, JSON.stringify(payload));
      } catch {
        // storage unavailable (private mode, quota) — non-fatal
      }
    };
    if (immediate) {
      write();
    } else {
      this.persistTimer = setTimeout(write, PERSIST_DEBOUNCE_MS);
    }
  }

  /** Resolves once the caller's reserved virtual-time slot has arrived. */
  async wait(): Promise<void> {
    const interval = 1000 / this.rate;
    const now = Date.now();
    const earliest = Math.max(now, this.penaltyUntil);
    const scheduled = Math.max(this.nextSlotAt, earliest - this.opts.burst * interval);
    this.nextSlotAt = scheduled + interval;
    const delay = scheduled - now;
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  /**
   * Halt the feed for `seconds` without touching rate, ceiling, or lastFloodAt.
   *
   * For server-side limits that are NOT "you are sending too fast" — chiefly
   * FLOOD_PREMIUM_WAIT, an account-tier upload cap. Cutting the rate cannot
   * make those go away (observed: thousands of them at the 0.5 parts/s floor),
   * so reacting with a rate cut only compounds Telegram's throttle with our
   * own, and — because the cut is persisted — keeps us slow for hours after
   * Telegram has stopped throttling. Waiting out the window at full rate is
   * the only response that helps.
   */
  pause(seconds?: number): void {
    const waitSeconds = typeof seconds === 'number' && seconds > 0 ? seconds : 10;
    this.pauseUntil(Date.now() + waitSeconds * 1000 + 1000);
  }

  private pauseUntil(until: number): void {
    this.penaltyUntil = Math.max(this.penaltyUntil, until);
    this.nextSlotAt = Math.max(this.nextSlotAt, this.penaltyUntil);
  }

  /** Multiplicative decrease + halt feed until the penalty window elapses. */
  reportFlood(seconds?: number): void {
    const now = Date.now();
    this.floods += 1;
    this.lastFloodAt = now;
    const waitSeconds = typeof seconds === 'number' && seconds > 0 ? seconds : 10;

    // The penalty-window guard doubles as a distinct-event guard: N concurrent
    // chunks failing on the same server flood all land here, but only the first
    // (before penaltyUntil is pushed forward) actually cuts the rate and counts
    // toward escalation. Without this every flood would instantly "escalate".
    if (now >= this.penaltyUntil) {
      const ceilOpts = this.opts.ceiling;
      const prevRate = this.rate;

      if (ceilOpts) {
        this.floodEvents.push(now);
        this.floodEvents = this.floodEvents.filter((t) => now - t < ceilOpts.escalationWindowMs);
        const escalate = this.floodEvents.length >= ceilOpts.escalationCount;
        if (escalate) this.escalatedUntil = now + ceilOpts.escalationResetMs;

        const clampCeiling = (c: number) => Math.min(this.opts.maxRate, Math.max(ceilOpts.floor, c));
        const cand = prevRate * ceilOpts.backoff;
        // ceiling is never raised by a flood: below it → pull to midpoint (fast
        // convergence when the account limit drops); at it → drift down `backoff`
        // each time; above it (a probe) → leave essentially intact.
        let nextCeiling = this.ceiling === null ? cand : Math.min(cand, (this.ceiling + prevRate) / 2);
        if (escalate) nextCeiling *= ceilOpts.escalatedCeilingFactor;
        this.ceiling = clampCeiling(nextCeiling);

        const wasProbe = this.probeStartedAt !== null;
        this.probeStartedAt = null;
        if (wasProbe) {
          // A probe overshot: cheap exit to just below the ceiling and back off
          // the next probe, rather than halving the (already reasonable) rate.
          this.rate = Math.max(this.opts.minRate, this.ceiling * ceilOpts.slowZone);
          this.probeCooldownMs = Math.min(this.probeCooldownMs * 2, ceilOpts.probeCooldownMaxMs);
          this.lastProbeEndedAt = now;
        } else {
          const factor = escalate ? ceilOpts.escalatedDecreaseFactor : this.opts.decreaseFactor;
          this.rate = Math.max(this.opts.minRate, this.rate * factor);
        }
        console.warn(
          `[Perf][${this.opts.label ?? 'RateLimiter'}] FLOOD_WAIT #${this.floods}: wait=${waitSeconds}s rate ${prevRate.toFixed(1)}→${this.rate.toFixed(1)} ceiling=${this.ceiling.toFixed(1)}${escalate ? ' [escalated]' : ''}${wasProbe ? ' [probe-fail]' : ''} parts/s`,
        );
      } else {
        this.rate = Math.max(this.opts.minRate, this.rate * this.opts.decreaseFactor);
        console.warn(
          `[Perf][${this.opts.label ?? 'RateLimiter'}] FLOOD_WAIT #${this.floods}: wait=${waitSeconds}s rate ${prevRate.toFixed(1)}→${this.rate.toFixed(1)} parts/s`,
        );
      }
      this.persist(true);
    }
    this.pauseUntil(now + waitSeconds * 1000 + 1000);
  }

  /** Additive increase, gated by a clean window since the last flood. */
  reportSuccess(): void {
    const now = Date.now();
    const ceilOpts = this.opts.ceiling;
    const escalated = now < this.escalatedUntil;
    const cleanWindow = escalated && ceilOpts ? ceilOpts.escalatedCleanWindowMs : this.opts.cleanWindowMs;

    if (this.lastFloodAt !== null && now - this.lastFloodAt < cleanWindow) return;
    if (this.rate >= this.opts.maxRate) return;

    // No ceiling configured, or nothing learned yet (haven't hit a wall) →
    // plain AIMD ramp, identical to the pre-ceiling behavior.
    if (!ceilOpts || this.ceiling === null) {
      if (now - this.lastIncreaseAt < this.opts.increaseIntervalMs) return;
      this.lastIncreaseAt = now;
      this.rate = Math.min(this.opts.maxRate, this.rate + this.opts.increaseStep);
      console.log(
        `[Perf][${this.opts.label ?? 'RateLimiter'}] ramp → ${this.rate.toFixed(1)} parts/s${this.ceiling !== null ? ` (ceiling=${(this.ceiling as number).toFixed(1)})` : ''}`,
      );
      this.persist(false);
      return;
    }

    // A probe that has held the higher rate cleanly long enough → adopt it as
    // the new ceiling.
    if (this.probeStartedAt !== null && now - this.probeStartedAt >= ceilOpts.probeConfirmMs) {
      this.ceiling = Math.min(this.opts.maxRate, this.rate);
      this.probeStartedAt = null;
      this.lastProbeEndedAt = now;
      this.probeCooldownMs = ceilOpts.probeCooldownMs;
      console.log(`[Perf][${this.opts.label ?? 'RateLimiter'}] probe confirmed → ceiling=${this.ceiling.toFixed(1)} parts/s`);
      this.persist(false);
      return;
    }

    const slowStart = this.ceiling * ceilOpts.slowZone;
    if (this.rate < slowStart) {
      // Fast zone: full-speed ramp, clamped at the slow-zone boundary.
      if (now - this.lastIncreaseAt < this.opts.increaseIntervalMs) return;
      this.lastIncreaseAt = now;
      this.rate = Math.min(slowStart, this.rate + this.opts.increaseStep);
      console.log(`[Perf][${this.opts.label ?? 'RateLimiter'}] ramp → ${this.rate.toFixed(1)} parts/s (ceiling=${this.ceiling.toFixed(1)})`);
      this.persist(false);
    } else if (this.rate < this.ceiling) {
      // Slow zone: creep toward the ceiling.
      if (now - this.lastIncreaseAt < ceilOpts.slowIntervalMs) return;
      this.lastIncreaseAt = now;
      this.rate = Math.min(this.ceiling, this.rate + ceilOpts.slowStep);
      console.log(`[Perf][${this.opts.label ?? 'RateLimiter'}] creep → ${this.rate.toFixed(1)} parts/s (ceiling=${this.ceiling.toFixed(1)})`);
      this.persist(false);
    } else {
      // Holding at the ceiling. Probe past it only after a long clean period.
      if (this.probeStartedAt !== null) return;
      if (this.lastFloodAt !== null && now - this.lastFloodAt < this.probeCooldownMs) return;
      if (now - this.lastProbeEndedAt < this.probeCooldownMs) return;
      this.rate = Math.min(this.opts.maxRate, this.rate + ceilOpts.probeStep);
      this.probeStartedAt = now;
      this.lastIncreaseAt = now;
      console.log(`[Perf][${this.opts.label ?? 'RateLimiter'}] probe → ${this.rate.toFixed(1)} parts/s (ceiling=${this.ceiling.toFixed(1)})`);
      this.persist(false);
    }
  }

  stats(): { rate: number; floods: number; ceiling: number | null } {
    return { rate: this.rate, floods: this.floods, ceiling: this.ceiling };
  }
}
