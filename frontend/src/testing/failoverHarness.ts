import { AccountActivityRegistry, type ActivityLease } from '../lib/accountActivityRegistry';
import { SegmentScheduler } from '../lib/segmentScheduler';
import type { SegmentAttemptInput, SegmentAttemptRunner, SegmentResult } from '../lib/segmentUploadTypes';
import { UploadSpeedTracker } from '../lib/uploadSpeedTracker';
import type { UploadAction, UploadQueueState } from '../lib/uploadQueue';

type Dispatch = (action: UploadAction) => UploadQueueState;
type ControlledResult = SegmentResult & { hasThumbnail: boolean };

const FILE_ID = 'failover-harness-file';
const FILE_SIZE = 100;

function resultFor(input: SegmentAttemptInput, messageId: number): ControlledResult {
  return {
    index: input.segment.index,
    message_id: messageId,
    file_id: `failover-${input.lease.accountId}`,
    size: input.segment.size,
    account_id: input.lease.accountId,
    hasThumbnail: true,
  };
}

function flushScheduler(): Promise<void> {
  return Promise.resolve().then(() => Promise.resolve());
}

/**
 * Browser-only deterministic executor used by the isolated failover spec.
 * It drives the actual scheduler and maps its public progress events onto the
 * existing upload queue; it never imports React or calls the metadata API.
 */
export function createFailoverHarness(dispatch: Dispatch): NonNullable<Window['__TELEDRIVE_FAILOVER_TEST__']> {
  let now = 0;
  let scheduler: SegmentScheduler | null = null;
  let activity: AccountActivityRegistry | null = null;
  let busyA: ActivityLease | null = null;
  let sourceInput: SegmentAttemptInput | null = null;
  let targetInput: SegmentAttemptInput | null = null;
  let resolveSource: ((result: ControlledResult) => void) | null = null;
  let resolveTarget: ((result: ControlledResult) => void) | null = null;
  let job: Promise<unknown> | null = null;
  let sourceFinalizeCalls = 0;
  let targetFinalizeCalls = 0;
  let migrations = 0;

  const source: SegmentAttemptRunner = {
    accountId: 20,
    accountName: 'B',
    run(input) {
      sourceInput = input;
      return new Promise<ControlledResult>((resolve) => { resolveSource = resolve; });
    },
  };
  const target: SegmentAttemptRunner = {
    accountId: 10,
    accountName: 'A',
    run(input) {
      targetInput = input;
      return new Promise<ControlledResult>((resolve) => { resolveTarget = resolve; });
    },
  };

  const requireStarted = (): SegmentScheduler => {
    if (!scheduler || !activity || !busyA || !sourceInput || !resolveSource || !job) throw new Error('failover harness has not started');
    return scheduler;
  };

  return {
    async start(): Promise<void> {
      if (scheduler) throw new Error('failover harness may only start once');

      const tracker = new UploadSpeedTracker(() => now, 30_000);
      activity = new AccountActivityRegistry(tracker, () => now);
      activity.setAvailability(target.accountId, { online: true, ready: true });
      activity.setAvailability(source.accountId, { online: true, ready: true });
      busyA = activity.tryBeginByteUploadJob(target.accountId, 1);
      if (!busyA) throw new Error('could not keep A busy');

      scheduler = new SegmentScheduler({
        activity,
        speed: tracker,
        clock: () => now,
        maxJobsPerAccount: 1,
        setTimer: (() => 0) as typeof setTimeout,
        clearTimer: (() => undefined) as typeof clearTimeout,
      });

      dispatch({
        type: 'enqueue', id: FILE_ID, name: 'failover.bin', size: FILE_SIZE, lastModified: 0,
        destination: { rootFolderId: null, resolvedFolderId: null, folderResolved: false, relativePath: '' }, now,
      });
      dispatch({ type: 'setStatus', id: FILE_ID, attempt: 1, status: 'uploading', now });

      job = scheduler.enqueueFile({
        fileJobId: 'failover-harness-job',
        file: { name: 'failover.bin', size: FILE_SIZE } as File,
        segments: [{ index: 0, offset: 0, parts: 1, size: FILE_SIZE }],
        runners: [source, target],
        onProgress: ({ logicalFileBytes, totalFileBytes }) => dispatch({
          type: 'setProgress', id: FILE_ID, attempt: 1, progress: (logicalFileBytes / totalFileBytes) * 100, now,
        }),
        onMigration: ({ logicalFileBytes, totalFileBytes, message }) => {
          migrations++;
          dispatch({
            type: 'migrationProgressReset', id: FILE_ID, attempt: 1,
            progress: (logicalFileBytes / totalFileBytes) * 100, message, now,
          });
        },
      });
      void job.then(
        () => dispatch({ type: 'complete', id: FILE_ID, attempt: 1, now }),
        (error: unknown) => dispatch({ type: 'fail', id: FILE_ID, attempt: 1, stage: 'telegram', message: String(error), now }),
      );

      await flushScheduler();
      if (!sourceInput) throw new Error('B did not receive the initial attempt');
      now = 1;
      sourceInput.hooks.onPartAccepted(0, 60);
      sourceInput.hooks.onPremiumFlood({ waitSeconds: 60, penaltyUntil: 60_000, pacerMode: 'frozen', scheduledRate: 1 });
      tracker.recordAccountEffectiveUnit(target.accountId, 'prior-a-work', 'part-0', 2_400);
    },

    async releaseIdleAccount(): Promise<void> {
      requireStarted();
      now = 30_000;
      busyA!.release();
      await flushScheduler();
      if (!targetInput) throw new Error('A did not receive the migrated attempt');
    },

    async settleLateSource(): Promise<void> {
      requireStarted();
      if (sourceInput!.hooks.grantFinalize()) sourceFinalizeCalls++;
      resolveSource!(resultFor(sourceInput!, 200));
      await flushScheduler();
    },

    async finishTarget(): Promise<void> {
      requireStarted();
      if (!targetInput || !resolveTarget) throw new Error('A does not have a pending migrated attempt');
      if (!targetInput.hooks.grantFinalize()) throw new Error('A was not allowed to finalize');
      targetFinalizeCalls++;
      resolveTarget(resultFor(targetInput, 100));
      await job!;
    },

    snapshot: () => ({ sourceFinalizeCalls, targetFinalizeCalls, migrations }),
  };
}
