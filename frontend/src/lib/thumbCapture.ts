import { generateThumbnail } from '../api/client';
import { generateVideoThumbnail } from './videoThumbnail';
import { captureWithRetries, type ThumbCaptureResult } from './thumbRetry';
import { Semaphore } from './semaphore';
import { MAX_CONCURRENT_FILES } from '../config';

const DEFAULT_TIMEOUT_MS = 15000;

// Canvas/video decode is a browser resource, not a Telegram one. Upload slots are
// now per account, so without this gate an N-account drive would run N times as
// many simultaneous decodes - and capture is exactly what flakes under that load.
const captureGate = new Semaphore(MAX_CONCURRENT_FILES);

export type { ThumbCaptureResult };

/** True for files eligible for Telegram album grouping and thumbnail capture. */
export function isMediaFile(file: File): boolean {
  return file.type.startsWith('image/') || file.type.startsWith('video/');
}

/**
 * Capture a thumbnail blob from a local image/video file.
 *
 * Callers treat a null thumb on a media file as an upload FAILURE - a media file
 * must never land in the drive without a thumbnail - so capture retries a few
 * times before giving up and a single transient failure must not doom the
 * upload. The exception is `undecodable`: when the browser has no decoder for
 * the video track there is no frame to capture on any attempt, and failing
 * forever would make the file permanently unstorable, so those upload as plain
 * thumbless documents instead.
 *
 * Non-media files return `{ thumb: null, undecodable: false }` and legitimately
 * carry no thumbnail.
 */
export async function captureThumb(
  file: File,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  attempts = 3,
): Promise<ThumbCaptureResult> {
  const isImage = file.type.startsWith('image/');
  const isVideo = file.type.startsWith('video/');
  if (!isImage && !isVideo) return { thumb: null, undecodable: false };
  return captureGate.withSlot(() => captureWithRetries(
    () => (isVideo ? generateVideoThumbnail(file) : generateThumbnail(file, 200)),
    timeoutMs,
    attempts,
  ));
}
