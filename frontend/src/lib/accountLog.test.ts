import { describe, expect, it } from 'vitest';
import { formatAccountLog, resolveAccountLogName } from './accountLog.ts';

describe('account log formatting', () => {
  it('uses the trimmed account label ahead of all log tags', () => {
    expect(resolveAccountLogName('  test1  ', 8773541354)).toBe('test1');
    expect(
      formatAccountLog('test1', 8773541354, ['Perf', 'ChunkRate:8773541354'], 'ramp ??4.5 parts/s'),
    ).toBe('[test1][Perf][ChunkRate:8773541354] ramp ??4.5 parts/s');
  });

  it('falls back to the numeric account id when no label is known', () => {
    expect(resolveAccountLogName('  ', 8773541354)).toBe('8773541354');
    expect(
      formatAccountLog(undefined, 8773541354, ['SplitUpload:8773541354'], 'segment 0 sent, message_id: 3'),
    ).toBe('[8773541354][SplitUpload:8773541354] segment 0 sent, message_id: 3');
  });
});
