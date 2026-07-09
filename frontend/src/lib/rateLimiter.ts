/**
 * Token-bucket rate limiter. Caps operations to `ratePerSecond`, allowing a burst
 * of up to `burst` immediately before throttling kicks in.
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;

  constructor(private ratePerSecond: number, private burst: number) {
    this.tokens = burst;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.ratePerSecond);
    this.lastRefill = now;
  }

  /**
   * Empty the bucket and push the refill clock `ms` into the future, so every
   * subsequent wait() stalls until the penalty window has elapsed. Used for
   * adaptive backoff when Telegram signals FLOOD_WAIT.
   */
  penalize(ms: number): void {
    this.tokens = 0;
    this.lastRefill = Date.now() + ms;
  }

  /** Resolves once a token is available, waiting if necessary. */
  async wait(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    const deficit = 1 - this.tokens;
    const delayMs = (deficit / this.ratePerSecond) * 1000;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    this.refill();
    this.tokens = Math.max(0, this.tokens - 1);
  }
}
