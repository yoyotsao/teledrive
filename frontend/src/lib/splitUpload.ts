/**
 * Uploading one file across several Telegram accounts.
 *
 * A file larger than MAX_PARTS_PER_FILE × CHUNK_SIZE (512MB) can't fit in one
 * Telegram message, so it becomes several messages ("segments") that the
 * download path concatenates back together. Each segment is independent, so
 * each can go to a different account and they can all run at once — which is
 * where the multi-account throughput actually comes from for big files.
 *
 * The ordering hazard this file exists to prevent: segments used to be ordered
 * by telegram message_id. Message ids only increase within ONE account, so the
 * moment segments are spread across accounts that comparison shuffles the file
 * and the merged download is corrupt. Order is carried explicitly by segment
 * index instead, from planSegments() all the way to part_index in the DB.
 */
import { planSegments, SMALL_FILE_LIMIT } from './segmentPlan';
import { getAllClients, type SegmentResult, type TelegramClientManager } from './gramjs';
import { withAccountSlot } from './accountPool';
import { accountActivityRegistry } from './accountActivityRegistry';
import { SegmentScheduler } from './segmentScheduler';
import type { SegmentFileJobInput } from './segmentUploadTypes';
import { uploadSpeedTracker } from './uploadSpeedTracker';

export { planSegments, SMALL_FILE_LIMIT } from './segmentPlan';
export type { Segment } from './segmentPlan';

export type SplitUploadResult = {
  /** Segments in file order — index 0 first. Safe to use as part_index. */
  parts: SegmentResult[];
  originalName: string;
  totalParts: number;
  hasThumbnail: boolean;
};

export type SplitUploadProgressDetail =
  | { reason: 'migration'; message: '重新分派上傳帳號，該區段將從頭重傳' };

export type SplitUploadProgress = (percent: number, detail?: SplitUploadProgressDetail) => void;

export interface FrozenSplitWriterTarget {
  manager: TelegramClientManager;
  targetPeer: any;
}

export interface FrozenSplitAttemptContext {
  segmentIndex: number;
  accountId: number;
}

export interface FrozenSplitSendTarget {
  targetPeer?: any;
  randomIds: readonly string[];
  /** Verified writers for one immutable shared-channel target. */
  writers?: readonly FrozenSplitWriterTarget[];
  /** Durable intent hook. Runs before this segment can issue any Telegram RPC. */
  beforeSegmentAttempt?: (context: FrozenSplitAttemptContext) => Promise<void>;
  /** Durable result hook. Must finish before the scheduler marks the segment complete. */
  afterSegmentAttempt?: (
    context: FrozenSplitAttemptContext & { result: SegmentResult & { hasThumbnail: boolean } },
  ) => Promise<void>;
}

export interface SplitUploadDependencies {
  scheduler: Pick<SegmentScheduler, 'enqueueFile'>;
  clients: () => TelegramClientManager[];
  plan?: typeof planSegments;
  withAccountSlot?: typeof withAccountSlot;
  smallFileLimit?: number;
}

let nextFileJobId = 0;

function fileJobIdFor(file: File): string {
  nextFileJobId++;
  return `split-upload:${Date.now()}:${nextFileJobId}:${file.name}`;
}

function percentage(logicalFileBytes: number, fileSize: number): number {
  return fileSize === 0 ? 100 : Math.round(Math.max(0, Math.min(1, logicalFileBytes / fileSize)) * 100);
}

/**
 * Creates the split-upload adapter around the shared segment scheduler.
 * The scheduler owns account selection and migration for a large file as one
 * job; this layer only translates its byte/migration events to UI progress.
 */
export function createUploadFileSpread(deps: SplitUploadDependencies): typeof uploadFileSpread {
  const plan = deps.plan ?? planSegments;
  const useAccountSlot = deps.withAccountSlot ?? withAccountSlot;
  const smallFileLimit = deps.smallFileLimit ?? SMALL_FILE_LIMIT;

  return async function uploadFileSpreadWithDependencies(
    file: File,
    onProgress?: SplitUploadProgress,
    thumb?: Blob | null,
    pinned?: TelegramClientManager,
    sendTarget?: FrozenSplitSendTarget,
  ): Promise<SplitUploadResult> {
    const run = <T,>(fn: (client: TelegramClientManager) => Promise<T>): Promise<T> =>
      pinned ? fn(pinned) : useAccountSlot(fn);

    if (file.size <= smallFileLimit) {
      const result = await run((client) => client.uploadSmallFile(
        file, thumb, sendTarget?.targetPeer ?? "me", sendTarget?.randomIds?.[0],
      ));
      onProgress?.(100);
      const { hasThumbnail, ...part } = result;
      return { parts: [part], originalName: file.name, totalParts: 1, hasThumbnail };
    }

    const segments = plan(file.size);
    const targetWriters: readonly FrozenSplitWriterTarget[] = sendTarget?.writers?.length
      ? sendTarget.writers
      : pinned
        ? [{ manager: pinned, targetPeer: sendTarget?.targetPeer }]
        : deps.clients().map((manager) => ({ manager, targetPeer: sendTarget?.targetPeer }));
    const runners = targetWriters.map(({ manager, targetPeer }) => {
      const base = manager.asSegmentRunner(
        sendTarget ? { targetPeer, randomIds: sendTarget.randomIds } : undefined,
      );
      if (!sendTarget?.beforeSegmentAttempt && !sendTarget?.afterSegmentAttempt) return base;
      return {
        accountId: base.accountId,
        accountName: base.accountName,
        run: async (attempt: Parameters<typeof base.run>[0]) => {
          const context: FrozenSplitAttemptContext = {
            segmentIndex: attempt.segment.index,
            accountId: base.accountId,
          };
          await sendTarget.beforeSegmentAttempt?.(context);
          const result = await base.run(attempt);
          await sendTarget.afterSegmentAttempt?.({ ...context, result });
          return result;
        },
      };
    });
    const input: SegmentFileJobInput = {
      fileJobId: fileJobIdFor(file),
      file,
      segments,
      runners,
      thumb,
      // A durable multi-writer job may fan out at initial dispatch, but once a
      // segment's uploader_id is persisted that segment must never migrate.
      migrationEnabled: sendTarget?.writers?.length ? false : !pinned,
      onProgress: ({ logicalFileBytes }) => onProgress?.(percentage(logicalFileBytes, file.size)),
      onMigration: ({ logicalFileBytes, message }) => onProgress?.(
        percentage(logicalFileBytes, file.size),
        { reason: 'migration', message },
      ),
    };
    const result = await deps.scheduler.enqueueFile(input);
    const parts = result.parts
      .slice()
      .sort((a, b) => a.index - b.index)
      .map(({ hasThumbnail: _drop, ...part }) => part);

    onProgress?.(100);
    return {
      parts,
      originalName: file.name,
      totalParts: parts.length,
      hasThumbnail: result.hasThumbnail,
    };
  };
}

const productionScheduler = new SegmentScheduler({
  activity: accountActivityRegistry,
  speed: uploadSpeedTracker,
});

const productionUploadFileSpread = createUploadFileSpread({
  scheduler: productionScheduler,
  clients: getAllClients,
  plan: planSegments,
  withAccountSlot,
  smallFileLimit: SMALL_FILE_LIMIT,
});

/**
 * Upload `file`, spreading its segments over the drive's linked accounts.
 * Small files take one account and one message; large ones fan out.
 *
 * @param pinned - upload entirely on this account (album fallbacks and any
 *                 caller that has already claimed a slot). Omit to dispatch.
 */
export async function uploadFileSpread(
  file: File,
  onProgress?: SplitUploadProgress,
  thumb?: Blob | null,
  pinned?: TelegramClientManager,
  sendTarget?: FrozenSplitSendTarget,
): Promise<SplitUploadResult> {
  return productionUploadFileSpread(file, onProgress, thumb, pinned, sendTarget);
}
