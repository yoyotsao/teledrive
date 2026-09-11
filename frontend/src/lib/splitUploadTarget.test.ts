import { describe, expect, it, vi } from 'vitest';
import { createUploadFileSpread } from './splitUpload.ts';
import type { TelegramClientManager } from './gramjs.ts';

function manager(accountId = 22) {
  return {
    accountId,
    uploadSmallFile: vi.fn(async () => ({
      index: 0,
      message_id: 10,
      file_id: 'media-10',
      size: 12,
      account_id: accountId,
      hasThumbnail: false,
    })),
    asSegmentRunner: vi.fn(() => ({ accountId, accountName: 'writer', run: vi.fn() })),
  } as unknown as TelegramClientManager;
}

describe('frozen target split uploads', () => {
  it('passes one frozen peer and persisted random id to a pinned small send', async () => {
    const writer = manager();
    const upload = createUploadFileSpread({
      scheduler: { enqueueFile: vi.fn() },
      clients: () => [writer],
      withAccountSlot: async (fn) => fn(writer),
      smallFileLimit: 12,
    });

    await upload(
      { size: 12, name: 'small.bin' } as File,
      undefined,
      null,
      writer,
      { targetPeer: 'channel-peer', randomIds: ['7001'] },
    );

    expect(writer.uploadSmallFile).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'small.bin' }),
      null,
      'channel-peer',
      '7001',
    );
  });

  it('passes one frozen peer and the whole persisted random-id vector to the pinned segment runner', async () => {
    const writer = manager();
    const enqueueFile = vi.fn(async (input: any) => ({
      parts: input.segments.map((segment: any) => ({
        index: segment.index,
        message_id: segment.index + 1,
        file_id: `media-${segment.index}`,
        size: segment.size,
        account_id: 22,
        hasThumbnail: false,
      })),
      hasThumbnail: false,
    }));
    const upload = createUploadFileSpread({
      scheduler: { enqueueFile },
      clients: () => [writer],
      plan: () => [
        { index: 0, offset: 0, parts: 1, size: 512 },
        { index: 1, offset: 512, parts: 1, size: 512 },
      ],
      smallFileLimit: 0,
    });

    await upload(
      { size: 1024, name: 'large.bin' } as File,
      undefined,
      null,
      writer,
      { targetPeer: 'channel-peer', randomIds: ['8001', '8002'] },
    );

    expect(writer.asSegmentRunner).toHaveBeenCalledWith({
      targetPeer: 'channel-peer',
      randomIds: ['8001', '8002'],
    });
    expect(enqueueFile.mock.calls[0][0].migrationEnabled).toBe(false);
  });
});
