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
}

interface PersistedRate {
  rate: number;
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
 */
export class AdaptiveRateLimiter {
  private rate: number;
  private nextSlotAt = 0;
  private penaltyUntil = 0;
  private lastFloodAt: number | null = null;
  private lastIncreaseAt = 0;
  private floods = 0;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private opts: AdaptiveRateLimiterOptions) {
    this.rate = this.loadInitialRate();
  }

  private loadInitialRate(): number {
    const { storageKey, initialRate, minRate, maxRate, label } = this.opts;
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
            const rate = Math.min(maxRate, Math.max(minRate, parsed.rate * PERSIST_LOAD_DISCOUNT));
            console.log(`[Perf][${label ?? 'RateLimiter'}] init rate=${rate.toFixed(1)} parts/s (source=storage)`);
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
        const payload: PersistedRate = { rate: this.rate, updatedAt: Date.now() };
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

  /** Multiplicative decrease + halt feed until the penalty window elapses. */
  reportFlood(seconds?: number): void {
    const now = Date.now();
    this.floods += 1;
    this.lastFloodAt = now;
    const waitSeconds = typeof seconds === 'number' && seconds > 0 ? seconds : 10;
    if (now >= this.penaltyUntil) {
      const prevRate = this.rate;
      this.rate = Math.max(this.opts.minRate, this.rate * this.opts.decreaseFactor);
      console.warn(
        `[Perf][${this.opts.label ?? 'RateLimiter'}] FLOOD_WAIT #${this.floods}: wait=${waitSeconds}s rate ${prevRate.toFixed(1)}→${this.rate.toFixed(1)} parts/s`,
      );
      this.persist(true);
    }
    this.penaltyUntil = Math.max(this.penaltyUntil, now + waitSeconds * 1000 + 1000);
    this.nextSlotAt = Math.max(this.nextSlotAt, this.penaltyUntil);
  }

  /** Additive increase, gated by a clean window since the last flood. */
  reportSuccess(): void {
    const now = Date.now();
    if (this.lastFloodAt !== null && now - this.lastFloodAt < this.opts.cleanWindowMs) return;
    if (now - this.lastIncreaseAt < this.opts.increaseIntervalMs) return;
    if (this.rate >= this.opts.maxRate) return;
    this.lastIncreaseAt = now;
    this.rate = Math.min(this.opts.maxRate, this.rate + this.opts.increaseStep);
    console.log(`[Perf][${this.opts.label ?? 'RateLimiter'}] ramp → ${this.rate.toFixed(1)} parts/s`);
    this.persist(false);
  }

  stats(): { rate: number; floods: number } {
    return { rate: this.rate, floods: this.floods };
  }
}
