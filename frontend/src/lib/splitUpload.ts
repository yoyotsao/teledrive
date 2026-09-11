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
  ): Promise<SplitUploadResult> {
    const run = <T,>(fn: (client: TelegramClientManager) => Promise<T>): Promise<T> =>
      pinned ? fn(pinned) : useAccountSlot(fn);

    if (file.size <= smallFileLimit) {
      const result = await run((client) => client.uploadSmallFile(file, thumb));
      onProgress?.(100);
      const { hasThumbnail, ...part } = result;
      return { parts: [part], originalName: file.name, totalParts: 1, hasThumbnail };
    }

    const segments = plan(file.size);
    const runners = (pinned ? [pinned] : deps.clients()).map((client) => client.asSegmentRunner());
    const input: SegmentFileJobInput = {
      fileJobId: fileJobIdFor(file),
      file,
      segments,
      runners,
      thumb,
      // A pinned caller may not move to another account; all other segment
      // jobs deliberately defer account assignment to the shared scheduler.
      migrationEnabled: !pinned,
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
): Promise<SplitUploadResult> {
  return productionUploadFileSpread(file, onProgress, thumb, pinned);
}
