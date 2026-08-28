/**
 * Self-check for ChunkAssembly. Run from frontend/:
 *   npx esbuild --bundle --platform=node --format=esm \
 *     src/lib/chunkAssembly.selfcheck.ts | node --input-type=module
 *
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
import { ChunkAssembly } from './chunkAssembly.ts';

function check(label: string, cond: boolean): void {
  if (!cond) throw new Error(`FAIL: ${label}`);
  console.log(`ok - ${label}`);
}

function throws(label: string, fn: () => unknown): void {
  try {
    fn();
  } catch {
    console.log(`ok - ${label}`);
    return;
  }
  throw new Error(`FAIL: ${label} (no throw)`);
}

const KB = 1024;
const chunk = (n: number, fill: number) => new Uint8Array(n).fill(fill);

// --- 剛開始:什麼都還沒到,絕不能算完成 ---------------------------------------
{
  const a = new ChunkAssembly(3, 5 * KB);
  check('a fresh assembly is not complete', !a.isComplete());
  check('a fresh assembly reports every chunk missing', a.missing().join(',') === '0,1,2');
}

// --- 迴歸:只有開頭連續幾塊到齊(舊行為就是在這裡放行) ------------------------
{
  const a = new ChunkAssembly(3, 5 * KB);
  a.put(0, chunk(2 * KB, 1));
  a.put(1, chunk(2 * KB, 2));
  check('a leading prefix is not a complete file', !a.isComplete());
  throws('asking an incomplete assembly for bytes throws', () => a.parts());
}

// --- 中間破洞:最後一塊到了也不能算完成 ---------------------------------------
{
  const a = new ChunkAssembly(3, 5 * KB);
  a.put(0, chunk(2 * KB, 1));
  a.put(2, chunk(1 * KB, 3));
  check('a hole in the middle is not complete', !a.isComplete());
  check('missing() names exactly the hole', a.missing().join(',') === '1');
}

// --- 全部 slot 都填了,但位元組總數短少 = 截斷,必須擋下 ------------------------
{
  const a = new ChunkAssembly(3, 5 * KB);
  a.put(0, chunk(2 * KB, 1));
  a.put(1, chunk(2 * KB, 2));
  a.put(2, chunk(512, 3)); // 尾塊短少 512B
  check('every slot filled but bytes short of file_size is not complete', !a.isComplete());
  throws('a short-byte assembly refuses to hand out bytes', () => a.parts());
}

// --- 完整:每塊都在且總長吻合 --------------------------------------------------
{
  const a = new ChunkAssembly(3, 5 * KB);
  a.put(2, chunk(1 * KB, 3)); // 亂序抵達
  a.put(0, chunk(2 * KB, 1));
  a.put(1, chunk(2 * KB, 2));
  check('all chunks present and bytes matching file_size is complete', a.isComplete());
  check('no chunk is missing', a.missing().length === 0);
  const parts = a.parts();
  check('parts() returns one entry per chunk', parts.length === 3);
  const firstBytes = await Promise.all(parts.map(async (p) => new Uint8Array(await p.arrayBuffer())[0]));
  check('parts()是依 chunk index 排序,不是抵達順序', firstBytes.join(',') === '1,2,3');
  check('received() 回報已收位元組', a.receivedBytes === 5 * KB);
}

// --- 尾塊比 512KB 短是正常的(Telegram 只回到 EOF) ----------------------------
{
  const a = new ChunkAssembly(2, 512 * KB + 7);
  a.put(0, chunk(512 * KB, 1));
  a.put(1, chunk(7, 2));
  check('a short final chunk at EOF is still a complete file', a.isComplete());
}

// --- 空檔案:0 chunk 就是完成,不該卡住 ----------------------------------------
{
  const a = new ChunkAssembly(0, 0);
  check('an empty file is complete with no chunks', a.isComplete());
  check('an empty file yields no parts', a.parts().length === 0);
}

// --- 重複投遞同一塊不該把位元組算兩次 -----------------------------------------
{
  const a = new ChunkAssembly(1, 1 * KB);
  a.put(0, chunk(1 * KB, 1));
  a.put(0, chunk(1 * KB, 1));
  check('re-putting a chunk does not double-count bytes', a.receivedBytes === 1 * KB);
  check('re-putting a chunk keeps the file complete', a.isComplete());
}

console.log('\nAll ChunkAssembly self-checks passed.');
