/**
 * Why this matters: segments used to be ordered by telegram message_id, which
 * only increases within one account. Once segments are spread over several
 * accounts that ordering scrambles the file and the merged download is corrupt
 * with no error anywhere. The properties below are what "the file survives"
 * means: segment offsets are contiguous in index order, and the sizes add up
 * to exactly the original — regardless of what message ids come back.
 */
import { describe, expect, it } from 'vitest';
import { planSegments } from './segmentPlan.ts';
import { CHUNK_SIZE, MAX_PARTS_PER_FILE } from '../config.ts';

const SEGMENT_BYTES = CHUNK_SIZE * MAX_PARTS_PER_FILE; // 512MB

// Sizes chosen to sit on every boundary the planner can get wrong: one byte,
// one chunk, either side of a segment, and multi-segment with a remainder.
const SIZES = [
  1,
  CHUNK_SIZE,
  CHUNK_SIZE + 1,
  SEGMENT_BYTES - 1,
  SEGMENT_BYTES,
  SEGMENT_BYTES + 1,
  SEGMENT_BYTES * 3,
  SEGMENT_BYTES * 2 + 12345,
];

describe.each(SIZES)('planSegments(%d)', (size) => {
  const segments = planSegments(size);

  it('produces at least one segment', () => {
    expect(segments.length).toBeGreaterThan(0);
  });

  it('indexes them 0..n-1 in order', () => {
    expect(segments.every((s, i) => s.index === i)).toBe(true);
  });

  it('covers exactly the file size', () => {
    expect(segments.reduce((n, s) => n + s.size, 0)).toBe(size);
  });

  it('lays the offsets out contiguously in index order', () => {
    expect(
      segments.every(
        (s, i) => s.offset === (i === 0 ? 0 : segments[i - 1].offset + segments[i - 1].size),
      ),
    ).toBe(true);
  });

  it('keeps every segment inside one Telegram message', () => {
    expect(
      segments.every((s) => s.parts <= MAX_PARTS_PER_FILE && s.size <= SEGMENT_BYTES),
    ).toBe(true);
  });

  it("covers each segment's bytes with its own parts", () => {
    expect(segments.every((s) => s.parts === Math.ceil(s.size / CHUNK_SIZE))).toBe(true);
  });
});

describe('segment ordering', () => {
  // The regression nail: sorting by a message-id-like value that is NOT
  // monotonic across accounts must not be how order is recovered. Index is.
  it('survives non-monotonic message ids', () => {
    const scrambled = planSegments(SEGMENT_BYTES * 3)
      .map((s, i) => ({ ...s, message_id: [900, 100, 500][i] }))
      .sort((a, b) => a.index - b.index);

    expect(scrambled.map((s) => s.offset)).toEqual([0, SEGMENT_BYTES, SEGMENT_BYTES * 2]);
  });
});
