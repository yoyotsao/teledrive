import { UndecodableVideoError } from './videoThumbnail';

export type ThumbCaptureResult = {
  /** The captured JPEG, or null if there is none. */
  thumb: Blob | null;
  /**
   * True when the browser has no decoder for this file's video track. Callers
   * use it to tell "there will never be a frame" apart from "capture failed",
   * because the first is a property of the file and the second is a transient
   * fault worth failing the upload over.
   */
  undecodable: boolean;
};

/**
 * Run a thumbnail capture, retrying transient failures.
 *
 * Retrying exists because canvas/video decode genuinely flakes under the load of
 * a big batch upload. It is deliberately NOT applied to a codec the browser
 * cannot decode: that fails identically every time, and each wasted attempt
 * builds and tears down another decode pipeline over the whole file.
 */
export async function captureWithRetries(
  capture: () => Promise<Blob | null>,
  timeoutMs: number,
  attempts: number,
): Promise<ThumbCaptureResult> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const blob = await Promise.race([
        capture(),
        new Promise<never>((_, rejectRace) => {
          timer = setTimeout(() => rejectRace(new Error('Thumbnail capture timeout')), timeoutMs);
        }),
      ]);
      if (blob) return { thumb: blob, undecodable: false };
      // The image path resolves null (e.g. canvas.toBlob gave nothing) - retry.
      throw new Error('Thumbnail capture returned empty');
    } catch (err) {
      if (err instanceof UndecodableVideoError) {
        console.warn(`[Thumb] ${err.message} - uploading without a thumbnail`);
        return { thumb: null, undecodable: true };
      }
      const last = attempt === attempts;
      console.warn(`[Thumb] capture attempt ${attempt}/${attempts} failed${last ? '' : ', retrying'}:`, err instanceof Error ? err.message : err);
      if (last) return { thumb: null, undecodable: false };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  return { thumb: null, undecodable: false };
}
