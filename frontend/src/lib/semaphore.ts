/**
 * Semaphore for limiting concurrent operations
 */
export class Semaphore {
  private available: number;
  private waitQueue: Array<() => void> = [];

  constructor(maxConcurrency: number) {
    this.available = maxConcurrency;
  }

  /**
   * Acquire a slot. Returns a promise that resolves when a slot is available.
   */
  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return;
    }

    // No slots available, wait in queue
    return new Promise<void>((resolve) => {
      this.waitQueue.push(resolve);
    });
  }

  /**
   * Release a slot, allowing the next waiting acquire to resolve.
   */
  release(): void {
    const next = this.waitQueue.shift();
    if (next) {
      // Resolve next waiter's promise (they take the slot)
      next();
    } else {
      // No one waiting, increment available slots
      this.available++;
    }
  }

  /** Free slots right now (0 when saturated). Used to pick the least-loaded account. */
  freeSlots(): number {
    return this.available;
  }

  /**
   * Convenience method: acquire a slot, run the function, then release.
   * Always releases even if the function throws.
   */
  async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}