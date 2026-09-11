import { describe, expect, it } from 'vitest';
import { UploadSpeedTracker } from './uploadSpeedTracker';

const MiB = 1024 * 1024;

describe('UploadSpeedTracker', () => {
  it('uses a fixed 30-second denominator and deduplicates effective segment parts', () => {
    let now = 30_000;
    const tracker = new UploadSpeedTracker(() => now, 30_000);
    const key = { taskId: 'file:2', attemptId: 1, accountId: 20 };

    expect(tracker.recordEffectivePart({ ...key, partIndex: 0, bytes: 15 * MiB })).toBe(true);
    expect(tracker.recordEffectivePart({ ...key, partIndex: 0, bytes: 15 * MiB })).toBe(false);
    expect(tracker.attemptEffectiveBytesPerSecond(key)).toBeCloseTo(0.5 * MiB);

    tracker.recordPhysicalSuccess({ accountId: 10, taskId: 'revoked', attemptId: 1, bytes: 30 * MiB });
    expect(tracker.accountPhysicalBytesPerSecond(10)).toBeCloseTo(1 * MiB);
    expect(tracker.accountEffectiveBytesPerSecond(10)).toBe(0);
  });

  it('excludes buckets older than the latest 30-second window', () => {
    let now = 30_000;
    const tracker = new UploadSpeedTracker(() => now, 30_000);
    const key = { taskId: 'file:window', attemptId: 1, accountId: 20 };

    tracker.recordEffectivePart({ ...key, partIndex: 0, bytes: 30 * MiB });
    tracker.recordPhysicalSuccess({ accountId: 20, taskId: 'file:window', attemptId: 1, bytes: 30 * MiB });

    now = 60_001;

    expect(tracker.attemptEffectiveBytesPerSecond(key)).toBe(0);
    expect(tracker.accountPhysicalBytesPerSecond(20)).toBe(0);
  });

  it('reports whether an account has live effective bytes', () => {
    let now = 30_000;
    const tracker = new UploadSpeedTracker(() => now, 30_000);

    expect(tracker.hasRecentAccountEffectiveBytes(20)).toBe(false);
    expect(tracker.recordAccountEffectiveUnit(20, 'thumbnail:2', 'unit:0', 15 * MiB)).toBe(true);
    expect(tracker.recordAccountEffectiveUnit(20, 'thumbnail:2', 'unit:0', 15 * MiB)).toBe(false);
    expect(tracker.recordAccountEffectiveUnit(21, 'thumbnail:2', 'unit:0', 15 * MiB)).toBe(false);
    expect(tracker.accountEffectiveBytesPerSecond(21)).toBe(0);
    expect(tracker.hasRecentAccountEffectiveBytes(20)).toBe(true);

    now = 60_000;
    expect(tracker.hasRecentAccountEffectiveBytes(20)).toBe(false);
  });

  it('resets account and task premium-flood counters at the marked cycle', () => {
    const tracker = new UploadSpeedTracker(() => 30_000, 30_000);

    tracker.recordPhysicalSuccess({ accountId: 10, taskId: 'file:flood', attemptId: 1, bytes: 4 });
    tracker.recordPhysicalSuccess({ accountId: 10, taskId: 'file:flood', attemptId: 1, bytes: 6 });
    expect(tracker.accountPhysicalSincePreviousPremiumFlood(10)).toEqual({ parts: 2, bytes: 10 });
    expect(tracker.taskPhysicalSincePreviousPremiumFlood('file:flood')).toEqual({ parts: 2, bytes: 10 });

    tracker.markPremiumFloodCycle(10, 'file:flood');
    tracker.recordPhysicalSuccess({ accountId: 10, taskId: 'file:flood', attemptId: 2, bytes: 8 });

    expect(tracker.accountPhysicalSincePreviousPremiumFlood(10)).toEqual({ parts: 1, bytes: 8 });
    expect(tracker.taskPhysicalSincePreviousPremiumFlood('file:flood')).toEqual({ parts: 1, bytes: 8 });
  });

  it('uses independent aggregate baselines when premium floods split account and task traffic', () => {
    const tracker = new UploadSpeedTracker(() => 30_000, 30_000);

    tracker.recordPhysicalSuccess({ accountId: 10, taskId: 'file:one', attemptId: 1, bytes: 4 });
    tracker.recordPhysicalSuccess({ accountId: 10, taskId: 'file:two', attemptId: 1, bytes: 6 });
    tracker.markPremiumFloodCycle(10, 'file:one');
    tracker.recordPhysicalSuccess({ accountId: 10, taskId: 'file:two', attemptId: 1, bytes: 8 });
    tracker.recordPhysicalSuccess({ accountId: 10, taskId: 'file:one', attemptId: 2, bytes: 10 });

    expect(tracker.accountPhysicalSincePreviousPremiumFlood(10)).toEqual({ parts: 2, bytes: 18 });
    expect(tracker.taskPhysicalSincePreviousPremiumFlood('file:one')).toEqual({ parts: 1, bytes: 10 });
  });

  it('clears terminal task flood totals and effective-part dedupe state', () => {
    const tracker = new UploadSpeedTracker(() => 30_000, 30_000);
    const key = { taskId: 'file:terminal', attemptId: 1, accountId: 20 };

    tracker.recordPhysicalSuccess({ ...key, bytes: 12 });
    expect(tracker.recordEffectivePart({ ...key, partIndex: 0, bytes: 12 })).toBe(true);

    tracker.clearTask(key.taskId);

    expect(tracker.taskPhysicalSincePreviousPremiumFlood(key.taskId)).toEqual({ parts: 0, bytes: 0 });
    expect(tracker.recordEffectivePart({ ...key, partIndex: 0, bytes: 12 })).toBe(true);
  });

  it('releases direct effective-unit dedupe state when its work ends', () => {
    const tracker = new UploadSpeedTracker(() => 30_000, 30_000);

    expect(tracker.recordAccountEffectiveUnit(20, 'upload-part:123', '0', 12)).toBe(true);
    expect(tracker.recordAccountEffectiveUnit(20, 'upload-part:123', '0', 12)).toBe(false);

    tracker.clearAccountEffectiveWork('upload-part:123');

    expect(tracker.recordAccountEffectiveUnit(20, 'upload-part:123', '0', 12)).toBe(true);
  });

  it('clears every account-scoped speed and premium-flood state when an account is unlinked', () => {
    const tracker = new UploadSpeedTracker(() => 30_000, 30_000);

    tracker.recordAccountEffectiveUnit(20, 'thumbnail:20', 'unit:0', 15);
    tracker.recordPhysicalSuccess({ accountId: 20, taskId: 'file:20', attemptId: 1, bytes: 12 });
    tracker.markPremiumFloodCycle(20, 'file:20');
    tracker.recordPhysicalSuccess({ accountId: 20, taskId: 'file:20', attemptId: 2, bytes: 8 });
    tracker.recordAccountEffectiveUnit(21, 'thumbnail:21', 'unit:0', 10);
    tracker.recordPhysicalSuccess({ accountId: 21, taskId: 'file:21', attemptId: 1, bytes: 6 });

    tracker.clearAccount(20);

    expect(tracker.accountEffectiveBytesPerSecond(20)).toBe(0);
    expect(tracker.accountPhysicalBytesPerSecond(20)).toBe(0);
    expect(tracker.accountPhysicalSincePreviousPremiumFlood(20)).toEqual({ parts: 0, bytes: 0 });
    expect(tracker.accountEffectiveBytesPerSecond(21)).toBeCloseTo(10 / 30);
    expect(tracker.accountPhysicalSincePreviousPremiumFlood(21)).toEqual({ parts: 1, bytes: 6 });
  });

  it('prunes expired rolling buckets when recording new traffic', () => {
    let now = 30_000;
    const tracker = new UploadSpeedTracker(() => now, 30_000);
    const key = { taskId: 'file:prune', attemptId: 1, accountId: 20 };

    tracker.recordEffectivePart({ ...key, partIndex: 0, bytes: 1 });
    tracker.recordPhysicalSuccess({ ...key, bytes: 1 });
    now = 60_001;
    tracker.recordEffectivePart({ ...key, partIndex: 1, bytes: 1 });
    tracker.recordPhysicalSuccess({ ...key, bytes: 1 });

    const state = tracker as unknown as {
      attemptBuckets: Map<string, unknown[]>;
      accountEffectiveBuckets: Map<number, unknown[]>;
      accountPhysicalBuckets: Map<number, unknown[]>;
    };
    expect(state.attemptBuckets.get(JSON.stringify([key.taskId, key.attemptId]))).toHaveLength(1);
    expect(state.accountEffectiveBuckets.get(key.accountId)).toHaveLength(1);
    expect(state.accountPhysicalBuckets.get(key.accountId)).toHaveLength(1);
  });

  it('returns the next attempt bucket expiry after pruning the expired bucket', () => {
    let now = 30_000;
    const tracker = new UploadSpeedTracker(() => now, 30_000);
    const key = { taskId: 'file:expiry', attemptId: 1, accountId: 20 };

    expect(tracker.nextAttemptEffectiveExpiry(key)).toBeNull();
    tracker.recordEffectivePart({ ...key, partIndex: 0, bytes: 1 });
    now = 40_000;
    tracker.recordEffectivePart({ ...key, partIndex: 1, bytes: 1 });

    expect(tracker.nextAttemptEffectiveExpiry(key)).toBe(60_000);
    now = 60_000;
    expect(tracker.nextAttemptEffectiveExpiry(key)).toBe(70_000);
  });

  it('clears only the attempt state while preserving account and physical history', () => {
    let now = 30_000;
    const tracker = new UploadSpeedTracker(() => now, 30_000);
    const key = { taskId: 'file:clear', attemptId: 1, accountId: 20 };

    expect(tracker.recordEffectivePart({ ...key, partIndex: 0, bytes: 15 * MiB })).toBe(true);
    expect(tracker.recordEffectivePart({ ...key, partIndex: 0, bytes: 15 * MiB })).toBe(false);
    tracker.recordAccountEffectiveUnit(20, 'thumbnail:clear', 'unit:0', 5 * MiB);
    tracker.recordPhysicalSuccess({ accountId: 20, taskId: 'file:clear', attemptId: 1, bytes: 12 });

    tracker.clearAttempt(key.taskId, key.attemptId);

    expect(tracker.attemptEffectiveBytesPerSecond(key)).toBe(0);
    expect(tracker.accountEffectiveBytesPerSecond(20)).toBeCloseTo((20 * MiB) / 30);
    expect(tracker.accountPhysicalSincePreviousPremiumFlood(20)).toEqual({ parts: 1, bytes: 12 });
    expect(tracker.recordEffectivePart({ ...key, partIndex: 0, bytes: 15 * MiB })).toBe(true);
  });
});
