/**
 * Generate a thumbnail from a video file using browser's video element and canvas.
 * This is much faster than using FFmpeg WASM - captures first frame instantly.
 */

const MAX_THUMB_WIDTH = 320;

/**
 * Thrown when the browser parsed the container but reports no frame size, which
 * means it has no decoder for the video track. The case that exposed this was a
 * 2.09 GiB mp4 carrying MPEG-4 Part 2 (`mp4v`, the DivX/Xvid family) video plus
 * AAC audio: the audio track initialises, so `loadedmetadata` fires with a real
 * duration while `videoWidth`/`videoHeight` stay 0. No retry count can conjure a
 * frame out of a codec the browser cannot decode, so callers treat this as "this
 * file has no capturable frame" rather than as a capture failure.
 */
export class UndecodableVideoError extends Error {
  constructor(fileName: string) {
    super(`Browser has no video decoder for ${fileName}`);
    this.name = 'UndecodableVideoError';
  }
}

/**
 * Canvas size for a thumbnail of a videoWidth x videoHeight frame, capped at
 * maxWidth and never upscaled. Returns null when the browser gave us no usable
 * frame size: a canvas with no pixels makes `canvas.toBlob()` hand back null, so
 * the caller has to bail out rather than draw into one. Both dimensions are
 * clamped to at least 1 so an extreme aspect ratio cannot round its way back
 * into a zero-area canvas.
 */
export function thumbCanvasSize(
  videoWidth: number,
  videoHeight: number,
  maxWidth: number = MAX_THUMB_WIDTH,
): { width: number; height: number } | null {
  if (!Number.isFinite(videoWidth) || !Number.isFinite(videoHeight)) return null;
  if (videoWidth <= 0 || videoHeight <= 0) return null;
  const ratio = Math.min(1, maxWidth / videoWidth);
  return {
    width: Math.max(1, Math.round(videoWidth * ratio)),
    height: Math.max(1, Math.round(videoHeight * ratio)),
  };
}

/**
 * @param videoFile - The video file to extract thumbnail from
 * @param seekTime - Time in seconds to seek to (default: 0 for first frame)
 * @returns Promise<Blob> - JPEG image blob
 */
export async function generateVideoThumbnail(videoFile: File, seekTime: number = 0): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    if (!ctx) {
      reject(new Error('Failed to get canvas context'));
      return;
    }

    // Set video attributes for thumbnail extraction
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    video.autoplay = false;

    // Create object URL for the video file
    const videoUrl = URL.createObjectURL(videoFile);

    // Every exit path goes through here, and the element is torn down BEFORE the
    // URL is revoked. Revoking first leaves an element that still has the blob
    // loaded re-requesting a URL that no longer resolves - that is the
    // ERR_FILE_NOT_FOUND flood a failed capture used to produce, one immortal
    // <video> per attempt still pinning the entire file in memory.
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      video.onloadedmetadata = null;
      video.onseeked = null;
      video.onerror = null;
      try {
        video.pause();
        video.removeAttribute('src');
        video.load();
      } catch {
        // A browser that objects to being torn down mid-load changes nothing here.
      }
      URL.revokeObjectURL(videoUrl);
      settle();
    };

    video.onloadedmetadata = () => {
      try {
        const size = thumbCanvasSize(video.videoWidth, video.videoHeight);
        if (!size) {
          finish(() => reject(new UndecodableVideoError(videoFile.name)));
          return;
        }
        canvas.width = size.width;
        canvas.height = size.height;

        video.currentTime = Math.min(seekTime || 0.1, video.duration);
      } catch (err) {
        // A non-finite duration makes the currentTime assignment throw. Without
        // this the promise would hang and the element would never be released.
        finish(() => reject(err));
      }
    };

    video.onseeked = () => {
      try {
        // Draw video frame to canvas
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        // Convert canvas to blob
        canvas.toBlob(
          (blob) => {
            finish(() => {
              if (blob) resolve(blob);
              else reject(new Error('Failed to create blob from canvas'));
            });
          },
          'image/jpeg',
          0.85 // JPEG quality
        );
      } catch (err) {
        finish(() => reject(err));
      }
    };

    video.onerror = () => {
      finish(() => reject(new Error(`Failed to load video file: ${videoFile.name}`)));
    };

    // Load the video
    video.src = videoUrl;
  });
}
