import { generateThumbnail } from '../api/client';
import { generateVideoThumbnail } from './videoThumbnail';

const DEFAULT_TIMEOUT_MS = 15000;

/** True for files eligible for Telegram album grouping and thumbnail capture. */
export function isMediaFile(file: File): boolean {
  return file.type.startsWith('image/') || file.type.startsWith('video/');
}

/**
 * Capture a thumbnail blob from a local image/video file. Returns null for
 * non-media files, on capture failure, or on timeout — callers treat null as
 * "upload without thumbnail" (non-fatal).
 */
export async function captureThumb(file: File, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Blob | null> {
  const isImage = file.type.startsWith('image/');
  const isVideo = file.type.startsWith('video/');
  if (!isImage && !isVideo) return null;
  try {
    const capture = isVideo ? generateVideoThumbnail(file) : generateThumbnail(file, 200);
    return await Promise.race([
      capture,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Thumbnail capture timeout')), timeoutMs)
      ),
    ]);
  } catch (err) {
    console.warn('[Thumb] capture failed (non-fatal):', err instanceof Error ? err.message : err);
    return null;
  }
}
