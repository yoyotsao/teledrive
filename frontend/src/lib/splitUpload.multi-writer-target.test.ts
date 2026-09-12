import { describe, expect, it, vi } from 'vitest';
import { createUploadFileSpread } from './splitUpload.ts';
import type { TelegramClientManager } from './gramjs.ts';

function writer(accountId: number) {
  const run = vi.fn(async (attempt: any) => ({
    index: attempt.segment.index,
    message_id: 1000 + attempt.segment.index,
    file_id: `media-${accountId}-${attempt.segment.index}`,
    size: attempt.segment.size,
    account_id: accountId,
    hasThumbnail: false,
  }));
  const asSegmentRunner = vi.fn(() => ({
    accountId,
    accountName: `writer-${accountId}`,
    run,
  }));
  return {
    manager: { accountId, asSegmentRunner } as unknown as TelegramClientManager,
    asSegmentRunner,
    run,
  };
}

describe('multi-writer frozen channel targets', () => {
  it('keeps the original segment scheduler but gives every writer its own verified peer', async () => {
    const a = writer(10);
    const b = writer(20);
    const before = vi.fn(async (_context: any) => undefined);
    const after = vi.fn(async (_context: any) => undefined);
    const enqueueFile = vi.fn(async (input: any) => {
      const first = await input.runners[0].run({ segment: input.segments[0] });
      const second = await input.runners[1].run({ segment: input.segments[1] });
      return { parts: [second, first], hasThumbnail: false };
    });
    const upload = createUploadFileSpread({
      scheduler: { enqueueFile },
      clients: () => [a.manager, b.manager],
      plan: () => [
        { index: 0, offset: 0, parts: 1, size: 512 },
        { index: 1, offset: 512, parts: 1, size: 512 },
      ],
      smallFileLimit: 0,
    });
    const file = { size: 1024, name: 'large.bin' } as File;

    const result = await upload(file, undefined, null, undefined, {
      randomIds: ['7001', '7002'],
      writers: [
        { manager: a.manager, targetPeer: 'peer-a' },
        { manager: b.manager, targetPeer: 'peer-b' },
      ],
      beforeSegmentAttempt: before,
      afterSegmentAttempt: after,
    });

    expect(a.asSegmentRunner).toHaveBeenCalledWith({ targetPeer: 'peer-a', randomIds: ['7001', '7002'] });
    expect(b.asSegmentRunner).toHaveBeenCalledWith({ targetPeer: 'peer-b', randomIds: ['7001', '7002'] });
    expect(enqueueFile.mock.calls[0][0].migrationEnabled).toBe(false);
    expect(before.mock.calls.map(([context]) => context)).toEqual([
      { segmentIndex: 0, accountId: 10 },
      { segmentIndex: 1, accountId: 20 },
    ]);
    expect(after.mock.calls.map(([context]) => ({ segmentIndex: context.segmentIndex, accountId: context.accountId }))).toEqual([
      { segmentIndex: 0, accountId: 10 },
      { segmentIndex: 1, accountId: 20 },
    ]);
    expect(result.parts.map((part) => [part.index, part.account_id])).toEqual([[0, 10], [1, 20]]);
  });
});
