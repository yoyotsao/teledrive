import { describe, expect, it } from 'vitest';
import { AccountActivityRegistry } from './accountActivityRegistry';
import { UploadSpeedTracker } from './uploadSpeedTracker';

const MiB = 1024 * 1024;

describe('AccountActivityRegistry', () => {
  it('requires every idle gate to clear before freezing a speed snapshot', () => {
    let now = 30_000;
    const tracker = new UploadSpeedTracker(() => now, 30_000);
    const registry = new AccountActivityRegistry(tracker, () => now);
    registry.setAvailability(10, { online: true, ready: true });

    const job = registry.tryBeginByteUploadJob(10, 3);
    expect(job).not.toBeNull();
    expect(registry.isTrulyIdle(10)).toBe(false);
    tracker.recordAccountEffectiveUnit(10, 'completed-work', 'part-0', 15 * MiB);

    const rpc = registry.beginUploadRpc(10);
    job!.release();
    expect(registry.isTrulyIdle(10)).toBe(false);
    rpc.release();
    expect(registry.isTrulyIdle(10)).toBe(true);
    expect(registry.validIdleSnapshot(10)).toMatchObject({
      bytesPerSecond: 0.5 * MiB,
      createdAt: 30_000,
      expiresAt: 330_000,
    });
  });

  it('activates a reservation atomically and makes its job lease idempotent', () => {
    let now = 30_000;
    const tracker = new UploadSpeedTracker(() => now, 30_000);
    const registry = new AccountActivityRegistry(tracker, () => now);
    registry.setAvailability(10, { online: true, ready: true });
    tracker.recordAccountEffectiveUnit(10, 'completed-work', 'part-0', 15 * MiB);
    const priorJob = registry.tryBeginByteUploadJob(10, 3);
    priorJob!.release();

    expect(registry.tryReserve(10, 'task-1')).toBe(true);
    expect(registry.runtime(10).activeByteUploadJobs).toBe(0);
    const migratedJob = registry.activateReservation(10, 'task-1', 3);
    expect(migratedJob).not.toBeNull();
    expect(registry.runtime(10)).toMatchObject({ reservedTaskId: null, activeByteUploadJobs: 1 });
    migratedJob!.release();
    migratedJob!.release();
    expect(registry.runtime(10).activeByteUploadJobs).toBe(0);
  });

  it('does not create a snapshot without recent effective bytes', () => {
    let now = 30_000;
    const registry = new AccountActivityRegistry(new UploadSpeedTracker(() => now, 30_000), () => now);
    registry.setAvailability(10, { online: true, ready: true });

    const job = registry.tryBeginByteUploadJob(10, 3);
    job!.release();

    expect(registry.validIdleSnapshot(10)).toBeNull();
    expect(registry.tryReserve(10, 'task-1')).toBe(false);
  });

  it('ignores retry and revoked physical bytes when creating a snapshot', () => {
    let now = 30_000;
    const tracker = new UploadSpeedTracker(() => now, 30_000);
    const registry = new AccountActivityRegistry(tracker, () => now);
    registry.setAvailability(10, { online: true, ready: true });
    tracker.recordPhysicalSuccess({ accountId: 10, taskId: 'retry', attemptId: 2, bytes: 15 * MiB });

    const job = registry.tryBeginByteUploadJob(10, 3);
    job!.release();

    expect(registry.validIdleSnapshot(10)).toBeNull();
  });

  it('expires snapshots after five minutes and invalidates them when a byte job starts', () => {
    let now = 30_000;
    const tracker = new UploadSpeedTracker(() => now, 30_000);
    const registry = new AccountActivityRegistry(tracker, () => now);
    registry.setAvailability(10, { online: true, ready: true });
    tracker.recordAccountEffectiveUnit(10, 'completed-work', 'part-0', 15 * MiB);

    const firstJob = registry.tryBeginByteUploadJob(10, 3);
    firstJob!.release();
    expect(registry.validIdleSnapshot(10)).not.toBeNull();

    const nextJob = registry.tryBeginByteUploadJob(10, 3);
    expect(registry.validIdleSnapshot(10)).toBeNull();
    nextJob!.release();
    now = 330_001;
    expect(registry.validIdleSnapshot(10)).toBeNull();
  });

  it('never decrements upload RPCs below zero when a lease settles twice', () => {
    let now = 30_000;
    const registry = new AccountActivityRegistry(new UploadSpeedTracker(() => now, 30_000), () => now);
    registry.setAvailability(10, { online: true, ready: true });

    const rpc = registry.beginUploadRpc(10);
    rpc.release();
    rpc.release();

    expect(registry.runtime(10).inFlightUploadRPCs).toBe(0);
  });

  it('coalesces subscriber notification until the current transaction has completed', async () => {
    let now = 30_000;
    const registry = new AccountActivityRegistry(new UploadSpeedTracker(() => now, 30_000), () => now);
    let notifications = 0;
    registry.subscribe(() => { notifications++; });

    registry.setAvailability(10, { online: true, ready: true });
    registry.beginUploadRpc(10).release();
    expect(notifications).toBe(0);

    await Promise.resolve();
    expect(notifications).toBe(1);
  });
});
