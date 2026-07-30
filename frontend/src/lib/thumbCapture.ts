import { generateThumbnail } from '../api/client';
import { generateVideoThumbnail } from './videoThumbnail';

const DEFAULT_TIMEOUT_MS = 15000;

/** True for files eligible for Telegram album grouping and thumbnail capture. */
export function isMediaFile(file: File): boolean {
  return file.type.startsWith('image/') || file.type.startsWith('video/');
}

/**
 * Capture a thumbnail blob from a local image/video file. Returns null for
 * NON-media files. For media files it retries a few times before giving up —
 * Canvas/decode capture flakes under the concurrent load of a big batch upload,
 * and callers now treat a null thumb on a media file as an upload FAILURE (a
 * media file must never land in the drive without a thumbnail), so a single
 * transient failure must not doom the upload.
 */
export async function captureThumb(file: File, timeoutMs = DEFAULT_TIMEOUT_MS, attempts = 3): Promise<Blob | null> {
  const isImage = file.type.startsWith('image/');
  const isVideo = file.type.startsWith('video/');
  if (!isImage && !isVideo) return null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const capture = isVideo ? generateVideoThumbnail(file) : generateThumbnail(file, 200);
      const blob = await Promise.race([
        capture,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Thumbnail capture timeout')), timeoutMs)
        ),
      ]);
      if (blob) return blob;
      // generateThumbnail resolved null (e.g. canvas.toBlob gave nothing) — retry.
      throw new Error('Thumbnail capture returned empty');
    } catch (err) {
      const last = attempt === attempts;
      console.warn(`[Thumb] capture attempt ${attempt}/${attempts} failed${last ? '' : ', retrying'}:`, err instanceof Error ? err.message : err);
      if (last) return null;
    }
  }
  return null;
}
