import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountActivityRegistry } from './accountActivityRegistry';
import { LeaseRevokedError } from './gramjs';
import { SegmentScheduler } from './segmentScheduler';
import type { SegmentAttemptInput, SegmentAttemptRunner, SegmentMigrationEvent, SegmentResult } from './segmentUploadTypes';
import { UploadSpeedTracker } from './uploadSpeedTracker';

class ControlledRunner implements SegmentAttemptRunner {
  calls: SegmentAttemptInput[] = [];
  private pending: {
    resolve: (value: SegmentResult & { hasThumbnail: boolean }) => void;
    reject: (reason?: unknown) => void;
  } | null = null;

  constructor(readonly accountId: number, readonly accountName: string) {}

  run(input: SegmentAttemptInput): Promise<SegmentResult & { hasThumbnail: boolean }> {
    this.calls.push(input);
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
    });
  }

  finish(value: SegmentResult & { hasThumbnail: boolean }): void {
    if (!this.pending) throw new Error('no pending segment attempt');
    this.pending.resolve(value);
    this.pending = null;
  }

  fail(reason: unknown): void {
    if (!this.pending) throw new Error('no pending segment attempt');
    this.pending.reject(reason);
    this.pending = null;
  }
}

function latestAttempt(runner: ControlledRunner): SegmentAttemptInput {
  const input = runner.calls[runner.calls.length - 1];
  if (!input) throw new Error(`no attempt for ${runner.accountName}`);
  return input;
}

function startRpc(runner: ControlledRunner): boolean { return latestAttempt(runner).hooks.onRpcStart(); }
function settleRpc(runner: ControlledRunner): void { latestAttempt(runner).hooks.onRpcSettled(); }
function acceptPart(runner: ControlledRunner, partIndex: number, bytes: number): void { latestAttempt(runner).hooks.onPartAccepted(partIndex, bytes); }
function premiumFlood(runner: ControlledRunner): void {
  latestAttempt(runner).hooks.onPremiumFlood({ waitSeconds: 60, penaltyUntil: 60_000, pacerMode: 'frozen', scheduledRate: 1 });
}
function grantFinalize(runner: ControlledRunner): boolean { return latestAttempt(runner).hooks.grantFinalize(); }
function segmentResult(input: SegmentAttemptInput, messageId: number, fileId: string): SegmentResult & { hasThumbnail: boolean } {
  return {
    index: input.segment.index, message_id: messageId, file_id: fileId,
    size: input.segment.size, account_id: input.lease.accountId, hasThumbnail: input.segment.index === 0,
  };
}
async function flushScheduler(): Promise<void> { await vi.advanceTimersByTimeAsync(0); }

async function migratedFixture(fileJobId: string) {
  const tracker = new UploadSpeedTracker(Date.now, 30_000);
  const activity = new AccountActivityRegistry(tracker, Date.now);
  activity.setAvailability(10, { online: true, ready: true });
  activity.setAvailability(20, { online: true, ready: true });
  const busyA = activity.tryBeginByteUploadJob(10, 1)!;
  const scheduler = new SegmentScheduler({ activity, speed: tracker, maxJobsPerAccount: 1 });
  const runnerB = new ControlledRunner(20, 'B');
  const runnerA = new ControlledRunner(10, 'A');
  const migrations: SegmentMigrationEvent[] = [];
  const progress: number[] = [];
  const promise = scheduler.enqueueFile({
    fileJobId, file: { size: 600, name: `${fileJobId}.bin` } as File,
    segments: [{ index: 0, offset: 0, parts: 1, size: 600 }], runners: [runnerB, runnerA],
    onProgress: (event) => progress.push(event.logicalFileBytes),
    onMigration: (event) => migrations.push(event),
  });

  await flushScheduler();
  await vi.advanceTimersByTimeAsync(1);
  acceptPart(runnerB, 0, 360);
  premiumFlood(runnerB);
  tracker.recordAccountEffectiveUnit(10, `${fileJobId}:prior-a`, 'part-0', 2_400);
  await vi.advanceTimersByTimeAsync(29_999);
  busyA.release();
  const idleSnapshot = activity.runtime(10).idleSnapshot;
  await flushScheduler();

  return { activity, idleSnapshot, migrations, progress, promise, runnerA, runnerB, tracker };
}

function schedulerFor(...accountIds: number[]): SegmentScheduler {
  const tracker = new UploadSpeedTracker(() => 30_000, 30_000);
  const activity = new AccountActivityRegistry(tracker, () => 30_000);
  for (const accountId of accountIds) {
    activity.setAvailability(accountId, { online: true, ready: true });
  }
  return new SegmentScheduler({ activity, speed: tracker, maxJobsPerAccount: 1 });
}

async function makeCandidateFixture(options: { aBytes?: number; bBytes?: number } = {}) {
  const tracker = new UploadSpeedTracker(Date.now, 30_000);
  const activity = new AccountActivityRegistry(tracker, Date.now);
  activity.setAvailability(10, { online: true, ready: true });
  activity.setAvailability(20, { online: true, ready: true });
  tracker.recordAccountEffectiveUnit(10, 'prior-a-work', 'part-0', options.aBytes ?? 240);
  activity.tryBeginByteUploadJob(10, 1)?.release();
  const scheduler = new SegmentScheduler({ activity, speed: tracker, maxJobsPerAccount: 1 });
  const never = new Promise<never>(() => undefined);
  let source: Parameters<SegmentAttemptRunner['run']>[0] | undefined;
  let target: Parameters<SegmentAttemptRunner['run']>[0] | undefined;
  let targetCalls = 0;
  const runnerB: SegmentAttemptRunner = { accountId: 20, accountName: 'B', run(input) { source = input; return never; } };
  const runnerA: SegmentAttemptRunner = { accountId: 10, accountName: 'A', run(input) { target = input; targetCalls++; return never; } };
  void scheduler.enqueueFile({
    fileJobId: 'fixture', file: { size: 600, name: 'fixture.bin' } as File,
    segments: [{ index: 0, offset: 0, parts: 1, size: 600 }], runners: [runnerB, runnerA],
  });
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(1);
  if (options.bBytes !== undefined) {
    tracker.recordEffectivePart({ taskId: 'fixture:0', attemptId: 1, accountId: 20, partIndex: 0, bytes: options.bBytes });
  }
  return {
    activity,
    scheduler,
    source: source!,
    get target() { return target; },
    get targetCalls() { return targetCalls; },
  };
}

describe('SegmentScheduler', () => {
  afterEach(() => vi.useRealTimers());

  it('clears task-scoped tracker state after terminal cleanup', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const tracker = new UploadSpeedTracker(Date.now, 30_000);
    const clearTask = vi.spyOn(tracker, 'clearTask');
    const activity = new AccountActivityRegistry(tracker, Date.now);
    activity.setAvailability(10, { online: true, ready: true });
    const scheduler = new SegmentScheduler({ activity, speed: tracker, maxJobsPerAccount: 1 });
    const runner = new ControlledRunner(10, 'A');
    const completion = scheduler.enqueueFile({
      fileJobId: 'terminal-cleanup', file: { size: 12, name: 'terminal.bin' } as File,
      segments: [{ index: 0, offset: 0, parts: 1, size: 12 }], runners: [runner],
    });

    await flushScheduler();
    acceptPart(runner, 0, 12);
    expect(grantFinalize(runner)).toBe(true);
    runner.finish(segmentResult(latestAttempt(runner), 1, 'terminal-file'));
    await expect(completion).resolves.toMatchObject({ parts: [{ file_id: 'terminal-file' }] });

    expect(clearTask).toHaveBeenCalledExactlyOnceWith('terminal-cleanup:0');
  });

  it('migrates only when a premium-flooded attempt scores strictly above two', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const tracker = new UploadSpeedTracker(Date.now, 30_000);
    const activity = new AccountActivityRegistry(tracker, Date.now);
    activity.setAvailability(10, { online: true, ready: true });
    activity.setAvailability(20, { online: true, ready: true });
    tracker.recordAccountEffectiveUnit(10, 'prior-a-work', 'part-0', 240);
    activity.tryBeginByteUploadJob(10, 1)?.release();

    const scheduler = new SegmentScheduler({ activity, speed: tracker, maxJobsPerAccount: 1 });
    let source: Parameters<SegmentAttemptRunner['run']>[0] | undefined;
    let targetCalls = 0;
    const never = new Promise<never>(() => undefined);
    const runnerB: SegmentAttemptRunner = {
      accountId: 20,
      accountName: 'B',
      run(input) {
        source = input;
        return never;
      },
    };
    const runnerA: SegmentAttemptRunner = {
      accountId: 10,
      accountName: 'A',
      run() {
        targetCalls++;
        return never;
      },
    };

    void scheduler.enqueueFile({
      fileJobId: 'candidate',
      file: { size: 600, name: 'candidate.bin' } as File,
      segments: [{ index: 0, offset: 0, parts: 1, size: 600 }],
      runners: [runnerB, runnerA],
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(source).toBeDefined();

    await vi.advanceTimersByTimeAsync(1);
    tracker.recordEffectivePart({ taskId: 'candidate:0', attemptId: 1, accountId: 20, partIndex: 0, bytes: 60 });
    const abortObservations: unknown[] = [];
    source!.hooks.signal.addEventListener('abort', () => {
      const task = (scheduler as unknown as { jobs: Map<string, { tasks: Array<Record<string, unknown>> }> }).jobs.get('candidate')!.tasks[0];
      abortObservations.push({
        runtime: activity.runtime(10),
        state: task.state,
        attemptId: task.attemptId,
        currentAccountId: task.currentAccountId,
        logicalUploadedBytes: task.logicalUploadedBytes,
        migrationCount: task.migrationCount,
        attemptedA: (task.attemptedAccountIds as Set<number>).has(10),
      });
    });
    source!.hooks.onPremiumFlood({ waitSeconds: 60, penaltyUntil: 60_000, pacerMode: 'frozen', scheduledRate: 1 });
    await vi.advanceTimersByTimeAsync(29_999);

    // A's snapshot is 8 B/s, B's live speed is 2 B/s, and the segment remains whole: score = 4.
    expect(targetCalls).toBe(1);
    expect(abortObservations).toEqual([{
      runtime: expect.objectContaining({ reservedTaskId: 'candidate:0', activeByteUploadJobs: 0, idleSnapshot: null }),
      state: 'migrating', attemptId: 2, currentAccountId: null, logicalUploadedBytes: 0,
      migrationCount: 1, attemptedA: true,
    }]);
  });

  it('does not migrate at the strict score-two threshold', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    // A is 8 B/s and B is 4 B/s, so the whole-segment score is exactly 2.
    const fixture = await makeCandidateFixture({ aBytes: 240, bBytes: 120 });
    fixture.source.hooks.onPremiumFlood({ waitSeconds: 60, penaltyUntil: 60_000, pacerMode: 'frozen', scheduledRate: 1 });

    await vi.advanceTimersByTimeAsync(29_999);

    expect(fixture.targetCalls).toBe(0);
    expect(fixture.source.hooks.signal.aborted).toBe(false);
  });

  it('requires a current premium flood even after the attempt reaches thirty seconds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const fixture = await makeCandidateFixture({ bBytes: 60 });

    await vi.advanceTimersByTimeAsync(29_999);

    expect(fixture.targetCalls).toBe(0);
    expect(fixture.source.hooks.signal.aborted).toBe(false);
  });

  it('wakes at the effective-speed expiry and migrates once the score becomes infinite', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    // At 30,000 ms B is still 4 B/s and score is exactly two. Its sole
    // effective bucket expires one millisecond later, making the score Infinity.
    const fixture = await makeCandidateFixture({ aBytes: 240, bBytes: 120 });
    fixture.source.hooks.onPremiumFlood({ waitSeconds: 60, penaltyUntil: 60_000, pacerMode: 'frozen', scheduledRate: 1 });

    await vi.advanceTimersByTimeAsync(29_999);
    expect(fixture.targetCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(fixture.targetCalls).toBe(1);
    expect(fixture.source.hooks.signal.aborted).toBe(true);
  });

  it('lets finalize win when it is granted before migration can commit', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const fixture = await makeCandidateFixture({ bBytes: 60 });

    expect(fixture.source.hooks.grantFinalize()).toBe(true);
    fixture.source.hooks.onPremiumFlood({ waitSeconds: 60, penaltyUntil: 60_000, pacerMode: 'frozen', scheduledRate: 1 });
    await vi.advanceTimersByTimeAsync(29_999);

    expect(fixture.targetCalls).toBe(0);
    expect(fixture.source.hooks.signal.aborted).toBe(false);
  });

  it('rejects a stale finalize after migration while accepting the new lease', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const fixture = await makeCandidateFixture({ bBytes: 60 });
    fixture.source.hooks.onPremiumFlood({ waitSeconds: 60, penaltyUntil: 60_000, pacerMode: 'frozen', scheduledRate: 1 });
    await vi.advanceTimersByTimeAsync(29_999);

    expect(fixture.source.hooks.grantFinalize()).toBe(false);
    expect(fixture.target?.hooks.grantFinalize()).toBe(true);
  });

  it('ignores an old runner rejection after its lease was revoked', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const tracker = new UploadSpeedTracker(Date.now, 30_000);
    const activity = new AccountActivityRegistry(tracker, Date.now);
    activity.setAvailability(10, { online: true, ready: true });
    activity.setAvailability(20, { online: true, ready: true });
    tracker.recordAccountEffectiveUnit(10, 'prior-a-work', 'part-0', 240);
    activity.tryBeginByteUploadJob(10, 1)?.release();
    const scheduler = new SegmentScheduler({ activity, speed: tracker, maxJobsPerAccount: 1 });
    let source: Parameters<SegmentAttemptRunner['run']>[0] | undefined;
    let target: Parameters<SegmentAttemptRunner['run']>[0] | undefined;
    let rejectSource!: (reason: unknown) => void;
    const sourcePromise = new Promise<never>((_, reject) => { rejectSource = reject; });
    const never = new Promise<never>(() => undefined);
    const runnerB: SegmentAttemptRunner = { accountId: 20, accountName: 'B', run(input) { source = input; return sourcePromise; } };
    const runnerA: SegmentAttemptRunner = { accountId: 10, accountName: 'A', run(input) { target = input; return never; } };
    void scheduler.enqueueFile({
      fileJobId: 'stale-rejection', file: { size: 600, name: 'stale.bin' } as File,
      segments: [{ index: 0, offset: 0, parts: 1, size: 600 }], runners: [runnerB, runnerA],
    });
    await vi.advanceTimersByTimeAsync(1);
    tracker.recordEffectivePart({ taskId: 'stale-rejection:0', attemptId: 1, accountId: 20, partIndex: 0, bytes: 60 });
    source!.hooks.onPremiumFlood({ waitSeconds: 60, penaltyUntil: 60_000, pacerMode: 'frozen', scheduledRate: 1 });
    await vi.advanceTimersByTimeAsync(29_999);

    const abortError = new Error('old lease revoked');
    abortError.name = 'AbortError';
    rejectSource(abortError);
    await vi.advanceTimersByTimeAsync(0);

    expect(target?.hooks.signal.aborted).toBe(false);
    expect(target?.hooks.grantFinalize()).toBe(true);
  });

  it('drains only the revoked attempt before activating its reservation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const tracker = new UploadSpeedTracker(Date.now, 30_000);
    const activity = new AccountActivityRegistry(tracker, Date.now);
    activity.setAvailability(10, { online: true, ready: true });
    activity.setAvailability(20, { online: true, ready: true });
    tracker.recordAccountEffectiveUnit(10, 'prior-a-work', 'part-0', 240);
    activity.tryBeginByteUploadJob(10, 1)?.release();
    const scheduler = new SegmentScheduler({ activity, speed: tracker, maxJobsPerAccount: 1 });
    let source: Parameters<SegmentAttemptRunner['run']>[0] | undefined;
    let target: Parameters<SegmentAttemptRunner['run']>[0] | undefined;
    const never = new Promise<never>(() => undefined);
    const runnerB: SegmentAttemptRunner = { accountId: 20, accountName: 'B', run(input) { source = input; return never; } };
    const runnerA: SegmentAttemptRunner = { accountId: 10, accountName: 'A', run(input) { target = input; return never; } };
    void scheduler.enqueueFile({
      fileJobId: 'drain', file: { size: 600, name: 'drain.bin' } as File,
      segments: [{ index: 0, offset: 0, parts: 1, size: 600 }], runners: [runnerB, runnerA],
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(source!.hooks.onRpcStart()).toBe(true);
    const unrelated = activity.beginUploadRpc(20);
    tracker.recordEffectivePart({ taskId: 'drain:0', attemptId: 1, accountId: 20, partIndex: 0, bytes: 60 });
    source!.hooks.onPremiumFlood({ waitSeconds: 60, penaltyUntil: 60_000, pacerMode: 'frozen', scheduledRate: 1 });
    await vi.advanceTimersByTimeAsync(30_000);

    expect(source!.hooks.signal.aborted).toBe(true);
    expect(source!.hooks.onRpcStart()).toBe(false);
    expect(target).toBeUndefined();
    source!.hooks.onPartAccepted(0, 60);
    expect(tracker.accountPhysicalBytesPerSecond(20)).toBe(2);
    source!.hooks.onRpcSettled();
    await vi.advanceTimersByTimeAsync(0);

    expect(activity.runtime(20).inFlightUploadRPCs).toBe(1);
    expect(target).toMatchObject({ lease: { taskId: 'drain:0', attemptId: 2, accountId: 10 }, segment: { offset: 0 } });
    unrelated.release();
  });

  it('never reserves a target that cannot run the candidate task', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const tracker = new UploadSpeedTracker(Date.now, 30_000);
    const activity = new AccountActivityRegistry(tracker, Date.now);
    activity.setAvailability(10, { online: true, ready: true });
    activity.setAvailability(20, { online: true, ready: true });
    activity.setAvailability(30, { online: true, ready: true });
    tracker.recordAccountEffectiveUnit(10, 'prior-a-work', 'part-0', 240);
    activity.tryBeginByteUploadJob(10, 1)?.release();
    const scheduler = new SegmentScheduler({ activity, speed: tracker, maxJobsPerAccount: 1 });
    let source: Parameters<SegmentAttemptRunner['run']>[0] | undefined;
    const never = new Promise<never>(() => undefined);
    const runnerB: SegmentAttemptRunner = { accountId: 20, accountName: 'B', run(input) { source = input; return never; } };
    const runnerC: SegmentAttemptRunner = { accountId: 30, accountName: 'C', run: () => never };
    const runnerA: SegmentAttemptRunner = { accountId: 10, accountName: 'A', run: () => never };
    // C keeps this unrelated job active, while its runner list makes A visible
    // to idle-account discovery without granting A permission for B's task.
    void scheduler.enqueueFile({
      fileJobId: 'unrelated', file: { size: 600, name: 'unrelated.bin' } as File,
      segments: [{ index: 0, offset: 0, parts: 1, size: 600 }], runners: [runnerC, runnerA],
    });
    void scheduler.enqueueFile({
      fileJobId: 'candidate-only-b', file: { size: 600, name: 'candidate.bin' } as File,
      segments: [{ index: 0, offset: 0, parts: 1, size: 600 }], runners: [runnerB],
    });
    await vi.advanceTimersByTimeAsync(0);
    // A exists in another live scheduler job, but is deliberately absent from
    // this candidate's runner list.
    await vi.advanceTimersByTimeAsync(1);
    tracker.recordEffectivePart({ taskId: 'candidate-only-b:0', attemptId: 1, accountId: 20, partIndex: 0, bytes: 60 });
    source!.hooks.onPremiumFlood({ waitSeconds: 60, penaltyUntil: 60_000, pacerMode: 'frozen', scheduledRate: 1 });
    await vi.advanceTimersByTimeAsync(29_999);

    expect(activity.runtime(10)).toMatchObject({ reservedTaskId: null, activeByteUploadJobs: 0 });
    expect(source!.hooks.signal.aborted).toBe(false);
  });

  it('launches the reserved target when it becomes unavailable during drain', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const tracker = new UploadSpeedTracker(Date.now, 30_000);
    const activity = new AccountActivityRegistry(tracker, Date.now);
    activity.setAvailability(10, { online: true, ready: true });
    activity.setAvailability(20, { online: true, ready: true });
    tracker.recordAccountEffectiveUnit(10, 'prior-a-work', 'part-0', 360);
    activity.tryBeginByteUploadJob(10, 1)?.release();
    const scheduler = new SegmentScheduler({ activity, speed: tracker, maxJobsPerAccount: 1 });
    let source: Parameters<SegmentAttemptRunner['run']>[0] | undefined;
    const never = new Promise<never>(() => undefined);
    const runnerB: SegmentAttemptRunner = { accountId: 20, accountName: 'B', run(input) { source = input; return never; } };
    let target: Parameters<SegmentAttemptRunner['run']>[0] | undefined;
    const runnerA: SegmentAttemptRunner = { accountId: 10, accountName: 'A', run(input) { target = input; return never; } };
    const promise = scheduler.enqueueFile({
      fileJobId: 'offline-drain', file: { size: 600, name: 'offline.bin' } as File,
      segments: [{ index: 0, offset: 0, parts: 1, size: 600 }], runners: [runnerB, runnerA],
    });
    void promise.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(source!.hooks.onRpcStart()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    source!.hooks.onPartAccepted(0, 60);
    source!.hooks.onPremiumFlood({ waitSeconds: 60, penaltyUntil: 60_000, pacerMode: 'frozen', scheduledRate: 1 });
    await vi.advanceTimersByTimeAsync(29_999);
    activity.setAvailability(10, { online: false, ready: false });
    source!.hooks.onRpcSettled();
    await vi.advanceTimersByTimeAsync(0);

    expect(target).toMatchObject({ lease: { taskId: 'offline-drain:0', attemptId: 2, accountId: 10 } });
    expect(activity.runtime(10)).toMatchObject({ online: false, ready: false, activeByteUploadJobs: 1, reservedTaskId: null });
  });

  it('continues the committed handoff when migration observers throw', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const tracker = new UploadSpeedTracker(Date.now, 30_000);
    const activity = new AccountActivityRegistry(tracker, Date.now);
    activity.setAvailability(10, { online: true, ready: true });
    activity.setAvailability(20, { online: true, ready: true });
    tracker.recordAccountEffectiveUnit(10, 'prior-a-work', 'part-0', 240);
    activity.tryBeginByteUploadJob(10, 1)?.release();
    const scheduler = new SegmentScheduler({ activity, speed: tracker, maxJobsPerAccount: 1, onDiagnostic: () => { throw new Error('diagnostic failed'); } });
    let source: Parameters<SegmentAttemptRunner['run']>[0] | undefined;
    let targetCalls = 0;
    const never = new Promise<never>(() => undefined);
    const runnerB: SegmentAttemptRunner = { accountId: 20, accountName: 'B', run(input) { source = input; return never; } };
    const runnerA: SegmentAttemptRunner = { accountId: 10, accountName: 'A', run: () => { targetCalls++; return never; } };
    void scheduler.enqueueFile({
      fileJobId: 'throwing-observers', file: { size: 600, name: 'throwing.bin' } as File,
      segments: [{ index: 0, offset: 0, parts: 1, size: 600 }], runners: [runnerB, runnerA],
      onMigration: () => { throw new Error('migration observer failed'); },
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1);
    tracker.recordEffectivePart({ taskId: 'throwing-observers:0', attemptId: 1, accountId: 20, partIndex: 0, bytes: 60 });
    expect(() => source!.hooks.onPremiumFlood({ waitSeconds: 60, penaltyUntil: 60_000, pacerMode: 'frozen', scheduledRate: 1 })).not.toThrow();
    await vi.advanceTimersByTimeAsync(29_999);

    expect(source!.hooks.signal.aborted).toBe(true);
    expect(targetCalls).toBe(1);
  });

  it('completes a normal segment and reports its accepted bytes', async () => {
    const scheduler = schedulerFor(20);
    const file = { size: 512, name: 'large.bin' } as File;
    const runnerB: SegmentAttemptRunner = {
      accountId: 20,
      accountName: 'B',
      async run(input) {
        expect(input.hooks.onRpcStart()).toBe(true);
        input.hooks.onPartAccepted(0, 512);
        input.hooks.onRpcSettled();
        expect(input.hooks.grantFinalize()).toBe(true);
        return {
          index: input.segment.index, message_id: 200, file_id: 'file-b',
          size: input.segment.size, account_id: 20, hasThumbnail: false,
        };
      },
    };
    const progress: number[] = [];
    const migrations: SegmentMigrationEvent[] = [];

    const promise = scheduler.enqueueFile({
      fileJobId: 'file-1',
      file,
      segments: [{ index: 0, offset: 0, parts: 1, size: 512 }],
      runners: [runnerB],
      onProgress: (event) => progress.push(event.logicalFileBytes),
      onMigration: (event) => migrations.push(event),
    });

    await expect(promise).resolves.toMatchObject({ parts: [{ index: 0, account_id: 20 }] });
    expect(progress).toEqual([512]);
    expect(migrations).toEqual([]);
  });

  it('returns completed segments in segment order rather than message order', async () => {
    const scheduler = schedulerFor(20);
    const runner: SegmentAttemptRunner = {
      accountId: 20,
      accountName: 'B',
      async run(input) {
        expect(input.hooks.grantFinalize()).toBe(true);
        return {
          index: input.segment.index,
          message_id: input.segment.index === 0 ? 900 : 100,
          file_id: `file-${input.segment.index}`,
          size: input.segment.size,
          account_id: 20,
          hasThumbnail: input.segment.index === 0,
        };
      },
    };

    await expect(scheduler.enqueueFile({
      fileJobId: 'file-2',
      file: { size: 1_024, name: 'two.bin' } as File,
      segments: [
        { index: 0, offset: 0, parts: 1, size: 512 },
        { index: 1, offset: 512, parts: 1, size: 512 },
      ],
      runners: [runner],
    })).resolves.toMatchObject({
      parts: [{ index: 0, message_id: 900 }, { index: 1, message_id: 100 }],
      hasThumbnail: true,
    });
  });

  it('keeps B active while A is busy, then rolls back once into a fresh A attempt after A becomes truly idle', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const tracker = new UploadSpeedTracker(Date.now, 30_000);
    const activity = new AccountActivityRegistry(tracker, Date.now);
    activity.setAvailability(10, { online: true, ready: true });
    activity.setAvailability(20, { online: true, ready: true });
    const busyA = activity.tryBeginByteUploadJob(10, 1)!;
    const scheduler = new SegmentScheduler({ activity, speed: tracker, maxJobsPerAccount: 1 });
    const runnerB = new ControlledRunner(20, 'B');
    const runnerA = new ControlledRunner(10, 'A');

    const migrations: SegmentMigrationEvent[] = [];
    const progress: number[] = [];
    const promise = scheduler.enqueueFile({
      fileJobId: 'busy-a', file: { size: 600, name: 'busy-a.bin' } as File,
      segments: [{ index: 0, offset: 0, parts: 1, size: 600 }], runners: [runnerB, runnerA],
      onProgress: (event) => progress.push(event.logicalFileBytes),
      onMigration: (event) => migrations.push(event),
    });
    await flushScheduler();
    await vi.advanceTimersByTimeAsync(1);
    acceptPart(runnerB, 0, 360);
    premiumFlood(runnerB);
    tracker.recordAccountEffectiveUnit(10, 'busy-a:prior-a', 'part-0', 2_400);
    await vi.advanceTimersByTimeAsync(29_999);

    expect(runnerB.calls).toHaveLength(1);
    expect(latestAttempt(runnerB).hooks.signal.aborted).toBe(false);
    expect(runnerA.calls).toHaveLength(0);

    busyA.release();
    expect(activity.runtime(10).idleSnapshot).toMatchObject({ bytesPerSecond: 80 });
    await flushScheduler();

    expect(migrations).toEqual([expect.objectContaining({
      abandonedLogicalBytes: 360, logicalFileBytes: 0, totalFileBytes: 600,
      message: '重新分派上傳帳號，該區段將從頭重傳',
    })]);
    expect(latestAttempt(runnerB).hooks.signal.aborted).toBe(true);
    expect(runnerA.calls).toHaveLength(1);
    expect(latestAttempt(runnerA)).toMatchObject({ lease: { attemptId: 2, accountId: 10 }, segment: { index: 0, offset: 0 } });
    expect(progress).toEqual([360]);

    acceptPart(runnerA, 0, 600);
    expect(grantFinalize(runnerA)).toBe(true);
    runnerA.finish(segmentResult(latestAttempt(runnerA), 901, 'fresh-a-file'));
    await expect(promise).resolves.toMatchObject({ parts: [{ file_id: 'fresh-a-file', account_id: 10 }] });
  });

  it('keeps a late B fulfillment physical-only and lets fresh A provide the sole segment result', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const fixture = await migratedFixture('late-b-fulfillment');

    expect(fixture.idleSnapshot).toMatchObject({ bytesPerSecond: 80 });
    expect(fixture.migrations).toHaveLength(1);
    expect(grantFinalize(fixture.runnerB)).toBe(false);
    acceptPart(fixture.runnerB, 0, 600);
    fixture.runnerB.finish(segmentResult(latestAttempt(fixture.runnerB), 200, 'late-b-file'));
    await flushScheduler();

    expect(fixture.progress).toEqual([360]);
    expect(fixture.tracker.accountPhysicalBytesPerSecond(20)).toBe(32);
    expect(fixture.runnerA.calls).toHaveLength(1);
    acceptPart(fixture.runnerA, 0, 600);
    expect(grantFinalize(fixture.runnerA)).toBe(true);
    fixture.runnerA.finish(segmentResult(latestAttempt(fixture.runnerA), 901, 'fresh-a-file'));

    await expect(fixture.promise).resolves.toEqual({
      parts: [{ index: 0, message_id: 901, file_id: 'fresh-a-file', size: 600, account_id: 10, hasThumbnail: true }],
      hasThumbnail: true,
    });
  });

  it('ignores a late AbortError from B without changing the fresh A generation or progress', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const fixture = await migratedFixture('late-b-abort');

    fixture.runnerB.fail(new DOMException('lease revoked', 'AbortError'));
    await flushScheduler();

    expect(fixture.migrations).toHaveLength(1);
    expect(fixture.progress).toEqual([360]);
    expect(latestAttempt(fixture.runnerA).lease).toEqual({ taskId: 'late-b-abort:0', attemptId: 2, accountId: 10 });
    acceptPart(fixture.runnerA, 0, 600);
    expect(grantFinalize(fixture.runnerA)).toBe(true);
    fixture.runnerA.finish(segmentResult(latestAttempt(fixture.runnerA), 902, 'abort-safe-a-file'));

    await expect(fixture.promise).resolves.toMatchObject({ parts: [{ file_id: 'abort-safe-a-file', account_id: 10 }] });
  });

  it('ignores a late LeaseRevokedError from B without failing or overwriting fresh A', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const fixture = await migratedFixture('late-b-lease-revoked');

    fixture.runnerB.fail(new LeaseRevokedError());
    await flushScheduler();

    expect(fixture.migrations).toHaveLength(1);
    expect(fixture.progress).toEqual([360]);
    expect(latestAttempt(fixture.runnerA).lease).toEqual({ taskId: 'late-b-lease-revoked:0', attemptId: 2, accountId: 10 });
    acceptPart(fixture.runnerA, 0, 600);
    expect(grantFinalize(fixture.runnerA)).toBe(true);
    fixture.runnerA.finish(segmentResult(latestAttempt(fixture.runnerA), 903, 'lease-safe-a-file'));

    await expect(fixture.promise).resolves.toMatchObject({ parts: [{ file_id: 'lease-safe-a-file', account_id: 10 }] });
  });

  it('keeps a single premium-flooded account on its original attempt and file id', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const tracker = new UploadSpeedTracker(Date.now, 30_000);
    const activity = new AccountActivityRegistry(tracker, Date.now);
    activity.setAvailability(20, { online: true, ready: true });
    const scheduler = new SegmentScheduler({ activity, speed: tracker, maxJobsPerAccount: 1 });
    const runnerB = new ControlledRunner(20, 'B');
    const migrations: SegmentMigrationEvent[] = [];
    const promise = scheduler.enqueueFile({
      fileJobId: 'single-b', file: { size: 600, name: 'single-b.bin' } as File,
      segments: [{ index: 0, offset: 0, parts: 1, size: 600 }], runners: [runnerB],
      onMigration: (event) => migrations.push(event),
    });

    await flushScheduler();
    await vi.advanceTimersByTimeAsync(1);
    expect(startRpc(runnerB)).toBe(true);
    acceptPart(runnerB, 0, 360);
    premiumFlood(runnerB);
    settleRpc(runnerB);
    await vi.advanceTimersByTimeAsync(29_999);

    expect(runnerB.calls).toHaveLength(1);
    expect(runnerB.calls[0].lease.attemptId).toBe(1);
    expect(migrations).toHaveLength(0);
    expect(grantFinalize(runnerB)).toBe(true);
    runnerB.finish(segmentResult(latestAttempt(runnerB), 220, 'single-b-file'));

    await expect(promise).resolves.toMatchObject({ parts: [{ file_id: 'single-b-file', account_id: 20 }] });
    expect(runnerB.calls).toHaveLength(1);
  });

  it('does not let an A with an in-flight RPC replace premium-flooded B', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const tracker = new UploadSpeedTracker(Date.now, 30_000);
    const activity = new AccountActivityRegistry(tracker, Date.now);
    activity.setAvailability(10, { online: true, ready: true });
    activity.setAvailability(20, { online: true, ready: true });
    tracker.recordAccountEffectiveUnit(10, 'a-prior-work', 'part-0', 2_400);
    activity.tryBeginByteUploadJob(10, 1)?.release();
    const aRpc = activity.beginUploadRpc(10);
    const scheduler = new SegmentScheduler({ activity, speed: tracker, maxJobsPerAccount: 1 });
    const runnerB = new ControlledRunner(20, 'B');
    const runnerA = new ControlledRunner(10, 'A');
    const migrations: SegmentMigrationEvent[] = [];
    void scheduler.enqueueFile({
      fileJobId: 'a-rpc', file: { size: 600, name: 'a-rpc.bin' } as File,
      segments: [{ index: 0, offset: 0, parts: 1, size: 600 }], runners: [runnerB, runnerA],
      onMigration: (event) => migrations.push(event),
    });

    await flushScheduler();
    await vi.advanceTimersByTimeAsync(1);
    acceptPart(runnerB, 0, 360);
    premiumFlood(runnerB);
    await vi.advanceTimersByTimeAsync(29_999);

    expect(activity.runtime(10).inFlightUploadRPCs).toBe(1);
    expect(migrations).toHaveLength(0);
    expect(latestAttempt(runnerB).hooks.signal.aborted).toBe(false);
    expect(runnerA.calls).toHaveLength(0);
    aRpc.release();
  });

  it('dispatches a normal pending A task instead of migrating B when the score is exactly two', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const tracker = new UploadSpeedTracker(Date.now, 30_000);
    const activity = new AccountActivityRegistry(tracker, Date.now);
    activity.setAvailability(10, { online: true, ready: true });
    activity.setAvailability(20, { online: true, ready: true });
    tracker.recordAccountEffectiveUnit(10, 'a-prior-work', 'part-0', 1_800);
    activity.tryBeginByteUploadJob(10, 1)?.release();
    const scheduler = new SegmentScheduler({ activity, speed: tracker, maxJobsPerAccount: 1 });
    const runnerB = new ControlledRunner(20, 'B');
    const runnerA = new ControlledRunner(10, 'A');
    const migrations: SegmentMigrationEvent[] = [];
    void scheduler.enqueueFile({
      fileJobId: 'score-two-active-b', file: { size: 600, name: 'active-b.bin' } as File,
      segments: [{ index: 0, offset: 0, parts: 1, size: 600 }], runners: [runnerB, runnerA],
      onMigration: (event) => migrations.push(event),
    });
    await flushScheduler();
    await vi.advanceTimersByTimeAsync(1);
    acceptPart(runnerB, 0, 360);
    premiumFlood(runnerB);
    await vi.advanceTimersByTimeAsync(29_999);

    void scheduler.enqueueFile({
      fileJobId: 'score-two-pending-a', file: { size: 600, name: 'pending-a.bin' } as File,
      segments: [{ index: 0, offset: 0, parts: 1, size: 600 }], runners: [runnerA],
    });
    await flushScheduler();

    expect(migrations).toHaveLength(0);
    expect(latestAttempt(runnerB).hooks.signal.aborted).toBe(false);
    expect(latestAttempt(runnerA).lease).toEqual({ taskId: 'score-two-pending-a:0', attemptId: 1, accountId: 10 });
  });

  it('does not cascade among three premium-flooded accounts before an eligible A becomes truly idle', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const tracker = new UploadSpeedTracker(Date.now, 30_000);
    const activity = new AccountActivityRegistry(tracker, Date.now);
    for (const accountId of [10, 20, 30]) activity.setAvailability(accountId, { online: true, ready: true });
    const scheduler = new SegmentScheduler({ activity, speed: tracker, maxJobsPerAccount: 1 });
    const runnerA = new ControlledRunner(10, 'A');
    const runnerB = new ControlledRunner(20, 'B');
    const runnerC = new ControlledRunner(30, 'C');
    const migrations: SegmentMigrationEvent[] = [];
    const promise = scheduler.enqueueFile({
      fileJobId: 'three-flooded', file: { size: 3_600, name: 'three-flooded.bin' } as File,
      segments: [
        { index: 0, offset: 0, parts: 1, size: 2_400 },
        { index: 1, offset: 2_400, parts: 1, size: 600 },
        { index: 2, offset: 3_000, parts: 1, size: 600 },
      ],
      runners: [runnerA, runnerB, runnerC], onMigration: (event) => migrations.push(event),
    });

    await flushScheduler();
    await vi.advanceTimersByTimeAsync(1);
    acceptPart(runnerA, 0, 2_400);
    acceptPart(runnerB, 0, 360);
    acceptPart(runnerC, 0, 360);
    premiumFlood(runnerA);
    premiumFlood(runnerB);
    premiumFlood(runnerC);
    await vi.advanceTimersByTimeAsync(29_999);

    expect(migrations).toHaveLength(0);
    expect(runnerA.calls).toHaveLength(1);
    expect(runnerB.calls).toHaveLength(1);
    expect(runnerC.calls).toHaveLength(1);

    expect(grantFinalize(runnerA)).toBe(true);
    runnerA.finish(segmentResult(latestAttempt(runnerA), 100, 'original-a-file'));
    await flushScheduler();

    expect(migrations).toEqual([expect.objectContaining({ taskId: 'three-flooded:1', abandonedLogicalBytes: 360, logicalFileBytes: 2_760 })]);
    expect(runnerA.calls).toHaveLength(2);
    expect(latestAttempt(runnerA).lease).toEqual({ taskId: 'three-flooded:1', attemptId: 2, accountId: 10 });
    expect(latestAttempt(runnerC).hooks.signal.aborted).toBe(false);
    void promise.catch(() => undefined);
  });

  it('leaves all attempts in place when a newly idle A makes the score exactly two', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const tracker = new UploadSpeedTracker(Date.now, 30_000);
    const activity = new AccountActivityRegistry(tracker, Date.now);
    for (const accountId of [10, 20, 30]) activity.setAvailability(accountId, { online: true, ready: true });
    const scheduler = new SegmentScheduler({ activity, speed: tracker, maxJobsPerAccount: 1 });
    const runnerA = new ControlledRunner(10, 'A');
    const runnerB = new ControlledRunner(20, 'B');
    const runnerC = new ControlledRunner(30, 'C');
    const migrations: SegmentMigrationEvent[] = [];
    void scheduler.enqueueFile({
      fileJobId: 'score-two', file: { size: 3_000, name: 'score-two.bin' } as File,
      segments: [
        { index: 0, offset: 0, parts: 1, size: 1_800 },
        { index: 1, offset: 1_800, parts: 1, size: 600 },
        { index: 2, offset: 2_400, parts: 1, size: 600 },
      ],
      runners: [runnerA, runnerB, runnerC], onMigration: (event) => migrations.push(event),
    });

    await flushScheduler();
    await vi.advanceTimersByTimeAsync(1);
    acceptPart(runnerA, 0, 1_800);
    acceptPart(runnerB, 0, 360);
    acceptPart(runnerC, 0, 360);
    premiumFlood(runnerA);
    premiumFlood(runnerB);
    premiumFlood(runnerC);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(grantFinalize(runnerA)).toBe(true);
    runnerA.finish(segmentResult(latestAttempt(runnerA), 101, 'score-two-a-file'));
    await flushScheduler();

    expect(activity.runtime(10).idleSnapshot).toMatchObject({ bytesPerSecond: 60 });
    expect(migrations).toHaveLength(0);
    expect(runnerA.calls).toHaveLength(1);
    expect(runnerB.calls).toHaveLength(1);
    expect(runnerC.calls).toHaveLength(1);
  });
});
