/**
 * Why this matters: thumbnail capture retries because canvas/video decode
 * genuinely flakes under the load of a big batch upload. But a codec the
 * browser has no decoder for fails identically every single time, and each
 * wasted attempt used to leave behind a live <video> element still holding a
 * reference to the whole file (2.09 GiB, in the case that exposed this) and
 * re-requesting an already-revoked blob URL forever. So retrying must be
 * reserved for failures that can plausibly succeed next time; a permanent
 * "no decoder" verdict has to short-circuit the loop on the first attempt.
 */
import { describe, expect, it, vi } from 'vitest';
import { captureWithRetries } from './thumbRetry.ts';
import { UndecodableVideoError } from './videoThumbnail.ts';

const aThumb = () => new Blob(['jpeg'], { type: 'image/jpeg' });

describe('captureWithRetries', () => {
  // --- 一次就成功：不該有第二次嘗試 -------------------------------------------
  it('returns the thumbnail without retrying when the first attempt works', async () => {
    const thumb = aThumb();
    const capture = vi.fn().mockResolvedValue(thumb);

    const result = await captureWithRetries(capture, 1000, 3);

    expect(result).toEqual({ thumb, undecodable: false });
    expect(capture).toHaveBeenCalledTimes(1);
  });

  // --- 偶發失敗：這正是重試存在的理由 -----------------------------------------
  it('retries a transient failure and returns the later success', async () => {
    const thumb = aThumb();
    const capture = vi.fn()
      .mockRejectedValueOnce(new Error('decode blew up'))
      .mockResolvedValue(thumb);

    const result = await captureWithRetries(capture, 1000, 3);

    expect(result).toEqual({ thumb, undecodable: false });
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it('treats a resolved null as a transient failure and retries', async () => {
    const thumb = aThumb();
    const capture = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(thumb);

    const result = await captureWithRetries(capture, 1000, 3);

    expect(result).toEqual({ thumb, undecodable: false });
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it('gives up after the configured number of transient failures', async () => {
    const capture = vi.fn().mockRejectedValue(new Error('decode blew up'));

    const result = await captureWithRetries(capture, 1000, 3);

    expect(result).toEqual({ thumb: null, undecodable: false });
    expect(capture).toHaveBeenCalledTimes(3);
  });

  // --- 永久失敗：重試一百次也是同一個結果,只會多洩漏兩個 video 元素 -----------
  it('does not retry a video the browser has no decoder for', async () => {
    const capture = vi.fn().mockRejectedValue(new UndecodableVideoError('hgshequ.mp4'));

    const result = await captureWithRetries(capture, 1000, 3);

    expect(result).toEqual({ thumb: null, undecodable: true });
    expect(capture).toHaveBeenCalledTimes(1);
  });

  // --- 卡住的擷取:不能讓一支影片無限期擋住上傳佇列 ---------------------------
  it('times out a capture that never settles, and reports it as retryable', async () => {
    const capture = vi.fn().mockImplementation(() => new Promise<Blob>(() => {}));

    const result = await captureWithRetries(capture, 20, 2);

    expect(result).toEqual({ thumb: null, undecodable: false });
    expect(capture).toHaveBeenCalledTimes(2);
  });
});
