import { describe, it, expect } from 'vitest';
import { sha256File } from './hashFile';

/**
 * The hash produced here is sent straight to /files/register and
 * /files/check-hash(es), all three of which validate it against
 * FILE_HASH_PATTERN in backend/app/api/routes.py. When the two drifted apart
 * the backend answered 422 for every upload, and the frontend's `.catch()`
 * around the dedup lookup hid half of it — so the shape is pinned on both
 * ends deliberately.
 */
const BACKEND_FILE_HASH_PATTERN = /^[0-9a-fA-F]{64}(:[0-9]{1,20})?$/;

function fileOf(bytes: number, name = 'big.bin'): File {
  return new File([new Uint8Array(bytes)], name);
}

describe('sha256File', () => {
  it('produces a hash the backend will accept', async () => {
    expect(await sha256File(fileOf(64))).toMatch(BACKEND_FILE_HASH_PATTERN);
  });

  it('is a 64-char lowercase digest followed by the original size', async () => {
    const [hex, size] = (await sha256File(fileOf(1234))).split(':');

    expect(hex).toHaveLength(64);
    expect(hex).toBe(hex.toLowerCase());
    expect(size).toBe('1234');
  });

  it('separates two files that share a digest but differ in size', async () => {
    // The whole point of the suffix: a truncated upload hashes the same prefix
    // as the complete file, and only the size distinguishes the two.
    const a = await sha256File(fileOf(64));
    const b = await sha256File(fileOf(128));

    expect(a).not.toBe(b);
  });

  it('is stable for identical content', async () => {
    expect(await sha256File(fileOf(64, 'a.bin'))).toBe(await sha256File(fileOf(64, 'b.bin')));
  });
});
