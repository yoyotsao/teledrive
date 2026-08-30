/**
 * Why this matters: a full download used to be able to finish "successfully"
 * with only a prefix of the file in hand. downloadFileChunked() doubled as a
 * streaming primitive and resolved as soon as ~10MB of contiguous bytes had
 * arrived; the download path forgot to ask for the whole file, so every
 * non-image over 10MB was saved to disk truncated at ~10MB while the console
 * kept logging chunks nobody would ever read. Split files got that treatment
 * per part, producing a corrupt merge.
 *
 * These asserts pin the rule that made it impossible: bytes are only handed
 * out when every chunk is present AND their total matches the file size the
 * server declared, and asking for the bytes of an incomplete assembly throws
 * instead of quietly returning a short file.
 *
 * Chunks are held as Blobs so a multi-GB download does not sit in the JS heap;
 * the ordering assert reads them back to prove that wrapping preserves file
 * order regardless of the order chunks arrived in.
 */
import { describe, expect, it } from 'vitest';
import { ChunkAssembly } from './chunkAssembly.ts';

const KB = 1024;
const chunk = (n: number, fill: number) => new Uint8Array(n).fill(fill);

describe('ChunkAssembly', () => {
  // --- 剛開始：什麼都還沒到，絕不能算完成 ---------------------------------------
  it('is not complete before anything arrives', () => {
    const a = new ChunkAssembly(3, 5 * KB);

    expect(a.isComplete()).toBe(false);
    expect(a.missing()).toEqual([0, 1, 2]);
  });

  // --- 迴歸：只有開頭連續幾塊到齊（舊行為就是在這裡放行）------------------------
  it('does not treat a leading prefix as a complete file', () => {
    const a = new ChunkAssembly(3, 5 * KB);
    a.put(0, chunk(2 * KB, 1));
    a.put(1, chunk(2 * KB, 2));

    expect(a.isComplete()).toBe(false);
    expect(() => a.parts()).toThrow();
  });

  // --- 中間破洞：最後一塊到了也不能算完成 ---------------------------------------
  it('is not complete with a hole in the middle, and names the hole', () => {
    const a = new ChunkAssembly(3, 5 * KB);
    a.put(0, chunk(2 * KB, 1));
    a.put(2, chunk(1 * KB, 3));

    expect(a.isComplete()).toBe(false);
    expect(a.missing()).toEqual([1]);
  });

  // --- 全部 slot 都填了，但位元組總數短少 = 截斷，必須擋下 ------------------------
  it('refuses an assembly whose slots are all filled but bytes fall short', () => {
    const a = new ChunkAssembly(3, 5 * KB);
    a.put(0, chunk(2 * KB, 1));
    a.put(1, chunk(2 * KB, 2));
    a.put(2, chunk(512, 3)); // 尾塊短少 512B

    expect(a.isComplete()).toBe(false);
    expect(() => a.parts()).toThrow();
  });

  // --- 完整：每塊都在且總長吻合 --------------------------------------------------
  it('completes when every chunk is present and the bytes match file_size', async () => {
    const a = new ChunkAssembly(3, 5 * KB);
    a.put(2, chunk(1 * KB, 3)); // 亂序抵達
    a.put(0, chunk(2 * KB, 1));
    a.put(1, chunk(2 * KB, 2));

    expect(a.isComplete()).toBe(true);
    expect(a.missing()).toEqual([]);
    expect(a.receivedBytes).toBe(5 * KB);

    const parts = a.parts();
    expect(parts).toHaveLength(3);
    // parts() 是依 chunk index 排序，不是抵達順序
    const firstBytes = await Promise.all(
      parts.map(async (p) => new Uint8Array(await p.arrayBuffer())[0]),
    );
    expect(firstBytes).toEqual([1, 2, 3]);
  });

  // --- 尾塊比 512KB 短是正常的（Telegram 只回到 EOF）----------------------------
  it('accepts a short final chunk at EOF', () => {
    const a = new ChunkAssembly(2, 512 * KB + 7);
    a.put(0, chunk(512 * KB, 1));
    a.put(1, chunk(7, 2));

    expect(a.isComplete()).toBe(true);
  });

  // --- 空檔案：0 chunk 就是完成，不該卡住 ----------------------------------------
  it('treats an empty file as complete with no parts', () => {
    const a = new ChunkAssembly(0, 0);

    expect(a.isComplete()).toBe(true);
    expect(a.parts()).toEqual([]);
  });

  // --- 重複投遞同一塊不該把位元組算兩次 -----------------------------------------
  it('does not double-count a chunk delivered twice', () => {
    const a = new ChunkAssembly(1, 1 * KB);
    a.put(0, chunk(1 * KB, 1));
    a.put(0, chunk(1 * KB, 1));

    expect(a.receivedBytes).toBe(1 * KB);
    expect(a.isComplete()).toBe(true);
  });
});
