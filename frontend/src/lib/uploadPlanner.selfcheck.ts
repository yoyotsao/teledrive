/**
 * Self-check for canonicalExistingParts — the dedup path's last line of defence
 * against re-registering an incomplete upload. Run from frontend/:
 *   npx esbuild --bundle --platform=node --format=cjs \
 *     --outfile=/tmp/uploadPlanner.selfcheck.cjs \
 *     src/lib/uploadPlanner.selfcheck.ts && node /tmp/uploadPlanner.selfcheck.cjs
 *
 * (cjs, unlike splitUpload.selfcheck.ts: this module pulls in the axios client.)
 *
 * Why this matters: a row whose bytes don't add up to the original file is a
 * stub, and dedup used to treat one as a complete file. 38 large files in the
 * live DB were third-generation copies of a single truncated 2026-07-10 upload
 * — each re-upload of the folder registered a fresh 500MB stub for a multi-GB
 * file, carrying the same telegram_message_id forward, uploading nothing. The
 * property below is what stops that: parts may only be reused when they cover
 * the whole file.
 */
import { canonicalExistingParts } from './uploadPlanner.ts';
import { FileInfo } from '../types/index.ts';

const SEGMENT = 524_288_000; // CHUNK_SIZE * MAX_PARTS_PER_FILE

function check(label: string, cond: boolean): void {
  if (!cond) throw new Error(`FAIL: ${label}`);
  console.log(`ok - ${label}`);
}

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
  telegram_user_id: 8838273312,
  ...over,
});

// The live stub: file_id 1786704874149-3eu1o3s-0, a 3.10GB file holding one
// 500MB segment, registered with is_split_file=0 because parts.length was 1.
const TRUNCATED_ORIGINAL = 3_327_000_000;
const stub = row({
  filesize: SEGMENT,
  is_split_file: false,
  part_index: 0,
  total_parts: 1,
  split_group_id: 'g-stub',
  telegram_message_id: 1156,
});
check(
  'truncated single-row stub is rejected (bytes do not cover the file)',
  canonicalExistingParts([stub], TRUNCATED_ORIGINAL).length === 0,
);

// A genuine single-message file: one row, bytes match exactly.
const whole = row({ filesize: 8_000_000, is_split_file: false, telegram_message_id: 2001 });
const wholeParts = canonicalExistingParts([whole], 8_000_000);
check('intact single-message file is reused', wholeParts.length === 1);
check('reused single part carries its message id', wholeParts[0].telegram_message_id === 2001);
check(
  'reused single part inherits the storage account',
  wholeParts[0].telegram_user_id === 8838273312,
);

// A genuine split upload: 3 segments adding up to the original.
const originalSplit = SEGMENT * 2 + 12_345;
const split = [
  row({ filesize: SEGMENT, part_index: 0, total_parts: 3, is_split_file: true, split_group_id: 'g1', telegram_message_id: 3001 }),
  row({ filesize: SEGMENT, part_index: 1, total_parts: 3, is_split_file: true, split_group_id: 'g1', telegram_message_id: 3002 }),
  row({ filesize: 12_345, part_index: 2, total_parts: 3, is_split_file: true, split_group_id: 'g1', telegram_message_id: 3003 }),
];
const splitParts = canonicalExistingParts(split, originalSplit);
check('intact split group is reused', splitParts.length === 3);
check(
  'split parts stay in file order',
  splitParts.map((p) => p.telegram_message_id).join(',') === '3001,3002,3003',
);

// Interrupted registration (page reloaded mid-Promise.all): the group claims 3
// parts but only 2 rows ever reached the DB.
check(
  'split group missing a part is rejected',
  canonicalExistingParts(split.slice(0, 2), originalSplit).length === 0,
);

// Dedup rows multiplying must still collapse to the real part set — the
// property this function already had, kept intact by the size gate.
const multiplied = [...split, ...split.map((f) => ({ ...f, file_id: `${f.file_id}-copy`, split_group_id: 'g2' }))];
check(
  'duplicated rows still collapse to one part per index',
  canonicalExistingParts(multiplied, originalSplit).length === 3,
);

// A stub sitting alongside the intact group must not win: picking the stub
// would hand back one 500MB part for a multi-GB file.
const stubPlusIntact = [
  row({ filesize: SEGMENT, is_split_file: false, part_index: 0, total_parts: 1, split_group_id: 'g-stub2' }),
  ...split,
];
check(
  'intact group wins over a co-existing stub',
  canonicalExistingParts(stubPlusIntact, originalSplit).length === 3,
);

// Rows with no usable message id are not reusable at any size.
check(
  'rows without a message id are rejected',
  canonicalExistingParts([row({ telegram_message_id: null, filesize: 8_000_000, is_split_file: false })], 8_000_000).length === 0,
);

check('empty input returns nothing', canonicalExistingParts([], 123).length === 0);

console.log('\nAll canonicalExistingParts self-checks passed.');
