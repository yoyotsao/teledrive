/**
 * Self-check for planSegments — the one piece of the multi-account split path
 * whose failure is silent. Run from frontend/:
 *   npx esbuild --bundle --platform=node --format=esm \
 *     src/lib/splitUpload.selfcheck.ts | node --input-type=module
 *
 * Why this matters: segments used to be ordered by telegram message_id, which
 * only increases within one account. Once segments are spread over several
 * accounts that ordering scrambles the file and the merged download is corrupt
 * with no error anywhere. The properties below are what "the file survives"
 * means: segment offsets are contiguous in index order, and the sizes add up
 * to exactly the original — regardless of what message ids come back.
 */
import { planSegments } from './segmentPlan.ts';
import { CHUNK_SIZE, MAX_PARTS_PER_FILE } from '../config.ts';

function check(label: string, cond: boolean): void {
  if (!cond) throw new Error(`FAIL: ${label}`);
  console.log(`ok - ${label}`);
}

const SEGMENT_BYTES = CHUNK_SIZE * MAX_PARTS_PER_FILE; // 512MB

const sizes = [
  1,
  CHUNK_SIZE,
  CHUNK_SIZE + 1,
  SEGMENT_BYTES - 1,
  SEGMENT_BYTES,
  SEGMENT_BYTES + 1,
  SEGMENT_BYTES * 3,
  SEGMENT_BYTES * 2 + 12345,
];

for (const size of sizes) {
  const segments = planSegments(size);

  check(`${size}: at least one segment`, segments.length > 0);
  check(`${size}: indices are 0..n-1 in order`,
    segments.every((s, i) => s.index === i));
  check(`${size}: sizes sum to the file size`,
    segments.reduce((n, s) => n + s.size, 0) === size);
  check(`${size}: offsets are contiguous in index order`,
    segments.every((s, i) => s.offset === (i === 0 ? 0 : segments[i - 1].offset + segments[i - 1].size)));
  check(`${size}: no segment exceeds one Telegram message`,
    segments.every((s) => s.parts <= MAX_PARTS_PER_FILE && s.size <= SEGMENT_BYTES));
  check(`${size}: every segment's parts cover its bytes`,
    segments.every((s) => s.parts === Math.ceil(s.size / CHUNK_SIZE)));
}

// The regression nail: sorting by a message-id-like value that is NOT monotonic
// across accounts must not be how order is recovered. Index order is.
const scrambled = planSegments(SEGMENT_BYTES * 3)
  .map((s, i) => ({ ...s, message_id: [900, 100, 500][i] }))
  .sort((a, b) => a.index - b.index);
check('index order survives non-monotonic message ids',
  scrambled.map((s) => s.offset).join() === [0, SEGMENT_BYTES, SEGMENT_BYTES * 2].join());

console.log('\nAll planSegments checks passed.');
