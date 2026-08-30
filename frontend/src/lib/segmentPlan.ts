/**
 * How a large file is cut into Telegram-message-sized segments.
 *
 * Kept free of any runtime import (no GramJS, no client pool) for one reason:
 * segmentPlan.test.ts must be able to run this bare in node. A mistake
 * here corrupts files silently, so the check has to actually be runnable.
 */
import { CHUNK_SIZE, MAX_PARTS_PER_FILE } from '../config';

/** Files at or below this go out as a single sendFile, no segmentation. */
export const SMALL_FILE_LIMIT = 10 * 1024 * 1024;

export type Segment = { index: number; offset: number; parts: number; size: number };

/**
 * Cut a file into Telegram-message-sized segments. Pure — this is the piece
 * the self-check pins down, because a mistake here silently corrupts files.
 */
export function planSegments(fileSize: number): Segment[] {
  const segments: Segment[] = [];
  let offset = 0;
  while (offset < fileSize) {
    const remaining = fileSize - offset;
    const parts = Math.min(MAX_PARTS_PER_FILE, Math.ceil(remaining / CHUNK_SIZE));
    // Not parts * CHUNK_SIZE: the final segment is short, and overstating it
    // makes the registered filesize larger than the bytes that actually exist.
    const size = Math.min(parts * CHUNK_SIZE, remaining);
    segments.push({ index: segments.length, offset, parts, size });
    offset += size;
  }
  return segments;
}

