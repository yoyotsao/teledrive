import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramClientManager, adoptClient } from './gramjs.ts';

afterEach(() => vi.restoreAllMocks());

describe('TelegramClientManager log identity', () => {
  it('retains the account id and display name supplied at construction', () => {
    const manager = new TelegramClientManager(8773541354, 'test1');
    expect(manager.accountId).toBe(8773541354);
    expect(manager.accountName).toBe('test1');
  });

  it('adopts a freshly authenticated manager with its resolved label', () => {
    const manager = new TelegramClientManager();
    adoptClient(8838273312, manager, 'ji32k7au6y4');
    expect(manager.accountId).toBe(8838273312);
    expect(manager.accountName).toBe('ji32k7au6y4');
  });
});

describe('uploadSegment logging', () => {
  it('emits only an account-prefixed completion line for a successful segment', async () => {
    const manager = new TelegramClientManager(8773541354, 'test1');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    Object.assign(manager as unknown as Record<string, unknown>, {
      client: {},
      initPromise: Promise.resolve(),
      sendFilePartGated: vi.fn().mockResolvedValue(undefined),
      sendFileWithOptionalThumb: vi.fn().mockResolvedValue({
        message: { id: 3 },
        hasThumbnail: false,
      }),
    });

    const file = new File([new Uint8Array([1])], 'one-byte.bin');
    await manager.uploadSegment(file, { index: 0, offset: 0, parts: 1, size: 1 });

    const lines = log.mock.calls.map(([line]) => String(line));
    expect(lines).toEqual([
      '[test1][SplitUpload:8773541354] segment 0 sent, message_id: 3',
    ]);
    expect(lines.some((line) => line.includes('parts at offset'))).toBe(false);
  });
});
