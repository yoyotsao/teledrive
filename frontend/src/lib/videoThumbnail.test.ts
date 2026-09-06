/**
 * Why this matters: a 2.09 GiB mp4 whose video track is MPEG-4 Part 2 (`mp4v`,
 * the DivX/Xvid family) made every upload of that file fail. Chrome has no
 * decoder for that codec, but the file's AAC audio track initialises fine, so
 * `loadedmetadata` fires with a valid `duration` and `videoWidth === 0`. The old
 * code fed that straight into the canvas — `Math.min(1, 320 / 0)` is 1, so the
 * canvas became 0x0 — and `canvas.toBlob()` returns null for a canvas with no
 * pixels, which surfaced as "Failed to create blob from canvas" three times in
 * a row. These asserts pin that a missing frame size is reported as "no frame
 * to capture" instead of silently collapsing into a zero-sized canvas.
 */
import { describe, expect, it } from 'vitest';
import { thumbCanvasSize } from './videoThumbnail.ts';

describe('thumbCanvasSize', () => {
  // --- 沒有畫面尺寸：瀏覽器解不出視訊軌，不能假裝有畫布 ------------------------
  it('returns null when the browser reported no frame dimensions', () => {
    expect(thumbCanvasSize(0, 0, 320)).toBeNull();
  });

  it('returns null when only one dimension is missing', () => {
    expect(thumbCanvasSize(1080, 0, 320)).toBeNull();
    expect(thumbCanvasSize(0, 1920, 320)).toBeNull();
  });

  it('returns null for non-finite dimensions', () => {
    expect(thumbCanvasSize(NaN, NaN, 320)).toBeNull();
    expect(thumbCanvasSize(Infinity, 1080, 320)).toBeNull();
  });

  it('returns null for negative dimensions', () => {
    expect(thumbCanvasSize(-1080, -1920, 320)).toBeNull();
  });

  // --- 正常影片：等比縮到 maxWidth ---------------------------------------------
  it('scales a portrait 1080x1920 frame down to the width cap', () => {
    expect(thumbCanvasSize(1080, 1920, 320)).toEqual({ width: 320, height: 569 });
  });

  it('scales a landscape 1920x1080 frame down to the width cap', () => {
    expect(thumbCanvasSize(1920, 1080, 320)).toEqual({ width: 320, height: 180 });
  });

  // --- 小影片不放大，否則縮圖會比原始畫面模糊 ---------------------------------
  it('never upscales a frame narrower than the cap', () => {
    expect(thumbCanvasSize(200, 100, 320)).toEqual({ width: 200, height: 100 });
  });

  // --- 極端長寬比：四捨五入不可把某一邊變成 0，那又會是 0 面積畫布 ------------
  it('keeps both dimensions at least 1 for an extreme aspect ratio', () => {
    const size = thumbCanvasSize(1_000_000, 1, 320);
    expect(size).not.toBeNull();
    expect(size!.height).toBeGreaterThanOrEqual(1);
    expect(size!.width).toBeGreaterThanOrEqual(1);
  });
});
