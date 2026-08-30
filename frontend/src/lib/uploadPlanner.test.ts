/**
 * Why this matters: a row whose bytes don't add up to the original file is a
 * stub, and dedup used to treat one as a complete file. 38 large files in the
 * live DB were third-generation copies of a single truncated 2026-07-10 upload
 * — each re-upload of the folder registered a fresh 500MB stub for a multi-GB
 * file, carrying the same telegram_message_id forward, uploading nothing. The
 * property below is what stops that: parts may only be reused when they cover
 * the whole file.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalExistingParts } from './uploadPlanner.ts';
import { FileInfo } from '../types/index.ts';

const SEGMENT = 524_288_000; // CHUNK_SIZE * MAX_PARTS_PER_FILE
const STORAGE_ACCOUNT = 8838273312;

let seq = 0;
const row = (over: Partial<FileInfo>): FileInfo => ({
  file_id: `row-${seq++}`,
  filename: 'movie.mp4',
  filesize: SEGMENT,
  mime_type: 'video/mp4',
  file_type: 'video',
  telegram_message_id: 1000 + seq,
  created_at: '2026-08-14T10:54:34',
  direct_url: null,
  access_hash: '123',
  telegram_user_id: STORAGE_ACCOUNT,
  ...over,
});

/** A genuine split upload: 3 segments adding up to the original. */
const ORIGINAL_SPLIT = SEGMENT * 2 + 12_345;
const splitGroup = () => [
  row({ filesize: SEGMENT, part_index: 0, total_parts: 3, is_split_file: true, split_group_id: 'g1', telegram_message_id: 3001 }),
  row({ filesize: SEGMENT, part_index: 1, total_parts: 3, is_split_file: true, split_group_id: 'g1', telegram_message_id: 3002 }),
  row({ filesize: 12_345, part_index: 2, total_parts: 3, is_split_file: true, split_group_id: 'g1', telegram_message_id: 3003 }),
];

beforeEach(() => {
  seq = 0;
});

describe('canonicalExistingParts', () => {
  describe('rejects anything that does not cover the whole file', () => {
    it('rejects the truncated single-row stub', () => {
      // The live stub: file_id 1786704874149-3eu1o3s-0, a 3.10GB file holding
      // one 500MB segment, registered with is_split_file=0 because
      // parts.length was 1.
      const TRUNCATED_ORIGINAL = 3_327_000_000;
      const stub = row({
        filesize: SEGMENT,
        is_split_file: false,
        part_index: 0,
        total_parts: 1,
        split_group_id: 'g-stub',
        telegram_message_id: 1156,
      });

      expect(canonicalExistingParts([stub], TRUNCATED_ORIGINAL)).toEqual([]);
    });

    it('rejects a split group missing a part', () => {
      // Interrupted registration (page reloaded mid-Promise.all): the group
      // claims 3 parts but only 2 rows ever reached the DB.
      expect(canonicalExistingParts(splitGroup().slice(0, 2), ORIGINAL_SPLIT)).toEqual([]);
    });

    it('rejects rows with no usable message id, whatever their size', () => {
      const noMessage = row({ telegram_message_id: null, filesize: 8_000_000, is_split_file: false });

      expect(canonicalExistingParts([noMessage], 8_000_000)).toEqual([]);
    });

    it('returns nothing for no input', () => {
      expect(canonicalExistingParts([], 123)).toEqual([]);
    });
  });

  describe('reuses an upload that is genuinely intact', () => {
    it('reuses a single-message file whose bytes match exactly', () => {
      const whole = row({ filesize: 8_000_000, is_split_file: false, telegram_message_id: 2001 });

      const parts = canonicalExistingParts([whole], 8_000_000);

      expect(parts).toHaveLength(1);
      expect(parts[0].telegram_message_id).toBe(2001);
      // Without the storage account the copy would be registered against the
      // wrong client and become undownloadable.
      expect(parts[0].telegram_user_id).toBe(STORAGE_ACCOUNT);
    });

    it('reuses an intact split group in file order', () => {
      const parts = canonicalExistingParts(splitGroup(), ORIGINAL_SPLIT);

      expect(parts.map((p) => p.telegram_message_id)).toEqual([3001, 3002, 3003]);
    });
  });

  describe('picks the right group when the drive holds several', () => {
    it('collapses multiplied dedup rows to one part per index', () => {
      const split = splitGroup();
      const multiplied = [
        ...split,
        ...split.map((f) => ({ ...f, file_id: `${f.file_id}-copy`, split_group_id: 'g2' })),
      ];

      expect(canonicalExistingParts(multiplied, ORIGINAL_SPLIT)).toHaveLength(3);
    });

    it('prefers the intact group over a co-existing stub', () => {
      // Picking the stub would hand back one 500MB part for a multi-GB file.
      const stubPlusIntact = [
        row({ filesize: SEGMENT, is_split_file: false, part_index: 0, total_parts: 1, split_group_id: 'g-stub2' }),
        ...splitGroup(),
      ];

      expect(canonicalExistingParts(stubPlusIntact, ORIGINAL_SPLIT)).toHaveLength(3);
    });
  });
});
