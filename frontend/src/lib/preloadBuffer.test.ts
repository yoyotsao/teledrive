/**
 * Why this matters: the Service Worker's lookahead buffer used to answer "is
 * the chunk at this offset ready?" with data-or-null, so a chunk that was
 * still IN FLIGHT counted as a miss and the player's own request for that same
 * offset fired a SECOND upload.GetFile for bytes already on their way.
 *
 * That only ever happens when the lookahead has fallen behind — i.e. when the
 * connection is already too slow — and doubling the request load at exactly
 * that moment is how playback goes from "a bit slow" to visibly stuttering.
 * Every chunk the player has to wait for gets downloaded twice, the lookahead
 * can never catch up, and it stays that way for the rest of the video.
 *
 * These asserts pin the way out: one request per offset, ever, whether that
 * offset is finished, in flight, or brand new.
 */
import { describe, expect, it, vi } from 'vitest';
import { PreloadBuffer } from './preloadBuffer.ts';

const tick = () => new Promise((r) => setTimeout(r, 0));

/** A fetcher whose每個 offset 只有在被明確放行後才完成。 */
function gatedFetcher() {
  const gates = new Map<number, (bytes: ArrayBuffer) => void>();
  const calls: number[] = [];
  const fetchChunk = (offset: number) => {
    calls.push(offset);
    return new Promise<ArrayBuffer>((resolve) => gates.set(offset, resolve));
  };
  const release = (offset: number, size = 8) => {
    const resolve = gates.get(offset);
    if (!resolve) throw new Error(`nothing in flight at offset ${offset}`);
    gates.delete(offset);
    resolve(new ArrayBuffer(size));
  };
  return { fetchChunk, calls, release };
}

describe('PreloadBuffer', () => {
  // --- 已下載完成的塊直接給，不再打第二次 ------------------------------------
  it('serves a finished preload without fetching again', async () => {
    const { fetchChunk, calls, release } = gatedFetcher();
    const buffer = new PreloadBuffer(3, fetchChunk);

    buffer.schedule(0, 100, 1000);
    release(100);
    await tick();

    const chunk = await buffer.take(100, 100);

    expect(chunk.byteLength).toBe(8);
    expect(calls.filter((o) => o === 100)).toEqual([100]);
  });

  // --- 這就是回歸點：還在飛的塊要用等的,不能再發一次 -------------------------
  it('awaits an in-flight preload instead of issuing a second request', async () => {
    const { fetchChunk, calls, release } = gatedFetcher();
    const buffer = new PreloadBuffer(3, fetchChunk);

    buffer.schedule(0, 100, 1000); // 100/200/300 起飛,都還沒回來
    const taken = buffer.take(100, 100);
    await tick();

    // 播放器要的 offset 正在下載中 —— 不可以因此再打一次 GetFile
    expect(calls.filter((o) => o === 100)).toEqual([100]);

    release(100, 16);
    expect((await taken).byteLength).toBe(16);
    expect(calls.filter((o) => o === 100)).toEqual([100]);
  });

  // --- 沒被預抓過的 offset 才自己抓,而且只抓一次 -----------------------------
  it('fetches an offset nobody preloaded, exactly once', async () => {
    const { fetchChunk, calls, release } = gatedFetcher();
    const buffer = new PreloadBuffer(3, fetchChunk);

    const first = buffer.take(500, 100);
    const second = buffer.take(500, 100);
    await tick();

    expect(calls.filter((o) => o === 500)).toEqual([500]);

    release(500, 32);
    expect((await first).byteLength).toBe(32);
    expect((await second).byteLength).toBe(32);
  });

  // --- 預抓深度與 EOF ---------------------------------------------------------
  it('schedules exactly lookahead chunks and stops at EOF', async () => {
    const { fetchChunk, calls } = gatedFetcher();
    const buffer = new PreloadBuffer(3, fetchChunk);

    buffer.schedule(0, 100, 1000);
    expect(calls).toEqual([100, 200, 300]);

    calls.length = 0;
    // 檔案只到 250,第 3 個 lookahead 已越過 EOF
    new PreloadBuffer(3, fetchChunk).schedule(0, 100, 250);
    expect(calls).toEqual([100, 200]);
  });

  // --- 已排隊的 offset 不重複排 ----------------------------------------------
  it('does not re-schedule an offset already in the window', async () => {
    const { fetchChunk, calls } = gatedFetcher();
    const buffer = new PreloadBuffer(3, fetchChunk);

    buffer.schedule(0, 100, 1000);
    buffer.schedule(0, 100, 1000);

    expect(calls).toEqual([100, 200, 300]);
  });

  // --- 播放前進後,落在窗外的塊要放掉,不然長片會把記憶體吃光 -----------------
  it('evicts chunks behind the play head', async () => {
    const { fetchChunk, calls, release } = gatedFetcher();
    const buffer = new PreloadBuffer(1, fetchChunk);

    buffer.schedule(0, 100, 10000);
    release(100);
    await tick();
    expect(buffer.size).toBe(1);

    // 播放頭前進到 300:offset 100 已在後方,應被丟棄
    buffer.schedule(300, 100, 10000);
    expect(buffer.size).toBe(1);

    calls.length = 0;
    const taken = buffer.take(100, 100);
    await tick();
    expect(calls).toEqual([100]); // 被丟掉了,所以重新抓
    release(100);
    await taken;
  });

  // --- 預抓失敗不可以毒化該 offset -------------------------------------------
  it('retries an offset whose preload rejected', async () => {
    const calls: number[] = [];
    let attempt = 0;
    const buffer = new PreloadBuffer(1, async (offset: number) => {
      calls.push(offset);
      if (++attempt === 1) throw new Error('connection reset');
      return new ArrayBuffer(4);
    });

    buffer.schedule(0, 100, 1000);
    await tick();

    const chunk = await buffer.take(100, 100);

    expect(chunk.byteLength).toBe(4);
    expect(calls).toEqual([100, 100]);
  });

  // --- CLEANUP 之後不可以還握著上一支影片的位元組 ----------------------------
  it('drops everything on clear()', async () => {
    const { fetchChunk, release } = gatedFetcher();
    const buffer = new PreloadBuffer(3, fetchChunk);

    buffer.schedule(0, 100, 1000);
    release(100);
    await tick();
    expect(buffer.size).toBe(3);

    buffer.clear();
    expect(buffer.size).toBe(0);
  });

  // --- take() 之後那塊就用掉了,窗格不該再留著它 ------------------------------
  it('consumes the entry it hands out', async () => {
    const { fetchChunk, release } = gatedFetcher();
    const buffer = new PreloadBuffer(3, fetchChunk);

    buffer.schedule(0, 100, 1000);
    release(100);
    await tick();

    await buffer.take(100, 100);

    expect(buffer.size).toBe(2);
  });

  // --- 預抓的 limit 用播放器實際要的塊大小,長度必須一致 ----------------------
  it('preloads with the same chunk size the player is asking for', async () => {
    const seen: Array<[number, number]> = [];
    const buffer = new PreloadBuffer(2, async (offset: number, limit: number) => {
      seen.push([offset, limit]);
      return new ArrayBuffer(limit);
    });

    buffer.schedule(1024, 512, 100000);
    await tick();

    expect(seen).toEqual([[1536, 512], [2048, 512]]);
  });

  it('never leaves an unhandled rejection behind a preload nobody takes', async () => {
    // `process` is not in the app's browser lib, and this file is typechecked
    // by the same tsc run as the app.
    const node = (globalThis as { process?: { on: Function; off: Function } }).process!;
    const onUnhandled = vi.fn();
    node.on('unhandledRejection', onUnhandled);
    try {
      const buffer = new PreloadBuffer(1, async () => {
        throw new Error('gone');
      });
      buffer.schedule(0, 100, 1000);
      await tick();
      await tick();
      expect(onUnhandled).not.toHaveBeenCalled();
    } finally {
      node.off('unhandledRejection', onUnhandled);
    }
  });
});
