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
import type { SegmentResult, TelegramClientManager } from './gramjs';
import { withAccountSlot } from './accountPool';

export { planSegments, SMALL_FILE_LIMIT } from './segmentPlan';
export type { Segment } from './segmentPlan';

export type SplitUploadResult = {
  /** Segments in file order — index 0 first. Safe to use as part_index. */
  parts: SegmentResult[];
  originalName: string;
  totalParts: number;
  hasThumbnail: boolean;
};

/**
 * Upload `file`, spreading its segments over the drive's linked accounts.
 * Small files take one account and one message; large ones fan out.
 *
 * @param pinned - upload entirely on this account (album fallbacks and any
 *                 caller that has already claimed a slot). Omit to dispatch.
 */
export async function uploadFileSpread(
  file: File,
  onProgress?: (pct: number) => void,
  thumb?: Blob | null,
  pinned?: TelegramClientManager,
): Promise<SplitUploadResult> {
  const run = <T,>(fn: (c: TelegramClientManager) => Promise<T>): Promise<T> =>
    pinned ? fn(pinned) : withAccountSlot(fn);

  if (file.size <= SMALL_FILE_LIMIT) {
    const result = await run((client) => client.uploadSmallFile(file, thumb));
    onProgress?.(100);
    const { hasThumbnail, ...part } = result;
    return { parts: [part], originalName: file.name, totalParts: 1, hasThumbnail };
  }

  const segments = planSegments(file.size);
  const totalChunks = segments.reduce((n, s) => n + s.parts, 0);
  let completedChunks = 0;
  const reportChunk = () => {
    completedChunks++;
    onProgress?.(Math.min(99, Math.round((completedChunks / totalChunks) * 100)));
  };

  console.log(`[SplitUpload] ${file.name}: ${segments.length} segment(s), ${totalChunks} parts`);

  const results = await Promise.all(segments.map((segment) =>
    // The thumb rides on segment 0 only — it represents the whole file, and the
    // listing reads it from the first part.
    run((client) => client.uploadSegment(file, segment, segment.index === 0 ? thumb : undefined, reportChunk))
  ));

  // Segment index, never message_id: see the file header.
  results.sort((a, b) => a.index - b.index);
  onProgress?.(100);

  return {
    parts: results.map(({ hasThumbnail: _drop, ...part }) => part),
    originalName: file.name,
    totalParts: results.length,
    hasThumbnail: results.some((r) => r.index === 0 && r.hasThumbnail),
  };
}
