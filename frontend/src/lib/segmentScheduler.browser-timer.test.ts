import { describe, expect, it } from 'vitest';
import { AccountActivityRegistry } from './accountActivityRegistry';
import { SegmentScheduler } from './segmentScheduler';
import type { SegmentAttemptRunner } from './segmentUploadTypes';
import { UploadSpeedTracker } from './uploadSpeedTracker';

describe('SegmentScheduler browser timers', () => {
  it('binds the browser timer receiver when scheduling a deadline', async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const strictSetTimeout = function (this: unknown): ReturnType<typeof setTimeout> {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      return 1 as ReturnType<typeof setTimeout>;
    } as typeof setTimeout;
    const strictClearTimeout = function (this: unknown): void {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
    } as typeof clearTimeout;

    globalThis.setTimeout = strictSetTimeout;
    globalThis.clearTimeout = strictClearTimeout;

    try {
      const tracker = new UploadSpeedTracker(() => 0, 30_000);
      const activity = new AccountActivityRegistry(tracker, () => 0);
      activity.setAvailability(10, { online: true, ready: true });
      const pending = new Promise<never>(() => undefined);
      const runner: SegmentAttemptRunner = {
        accountId: 10,
        accountName: 'A',
        run: () => pending,
      };
      const scheduler = new SegmentScheduler({
        activity,
        speed: tracker,
        clock: () => 0,
        maxJobsPerAccount: 1,
      });

      let rejection: unknown;
      void scheduler.enqueueFile({
        fileJobId: 'browser-timer-receiver',
        file: { size: 1, name: 'timer.bin' } as File,
        segments: [{ index: 0, offset: 0, parts: 1, size: 1 }],
        runners: [runner],
      }).catch((error: unknown) => { rejection = error; });

      await Promise.resolve();
      await Promise.resolve();

      expect(rejection).toBeUndefined();
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });
});
