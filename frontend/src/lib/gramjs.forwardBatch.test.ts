import { describe, expect, it, vi } from 'vitest';
import { TelegramClientManager } from './gramjs.ts';

function documentMessage(id: number) {
  return {
    id,
    media: {
      className: 'MessageMediaDocument',
      document: {
        id: BigInt(10_000 + id),
        accessHash: BigInt(20_000 + id),
        size: id,
        mimeType: 'application/octet-stream',
        attributes: [],
        fileReference: new Uint8Array(),
      },
    },
  };
}

function readyManager(forwardMessages: ReturnType<typeof vi.fn>): TelegramClientManager {
  const manager = new TelegramClientManager(42, 'writer');
  (manager as any).client = { forwardMessages };
  (manager as any).initPromise = Promise.resolve();
  (manager as any).messageRateLimiter = { wait: vi.fn(async () => undefined), penalize: vi.fn() };
  return manager;
}

describe('TelegramClientManager.forwardBatchToTarget', () => {
  it('forwards 100 source messages in one Telegram RPC with parallel message/random-id vectors', async () => {
    const entries = Array.from({ length: 100 }, (_, index) => ({
      messageId: index + 1,
      randomId: String(9_000_000 + index),
    }));
    const forwardMessages = vi.fn(async (_peer, _params) => [entries.map((entry) => documentMessage(entry.messageId))]);
    const manager = readyManager(forwardMessages);

    const results = await manager.forwardBatchToTarget('me', entries, 'channel-peer');

    expect(forwardMessages).toHaveBeenCalledTimes(1);
    const [peer, params] = forwardMessages.mock.calls[0] as [unknown, any];
    expect(peer).toBe('channel-peer');
    expect(params.messages).toEqual(entries.map((entry) => entry.messageId));
    expect(params.randomId.map((value: unknown) => String(value))).toEqual(entries.map((entry) => entry.randomId));
    expect(results).toHaveLength(100);
    expect(results.map((result) => result.messageId)).toEqual(entries.map((entry) => entry.messageId));
    expect(results[0]).toMatchObject({ mediaKind: 'document', mediaId: '10001', size: 1, accessHash: '20001' });
  });

  it('rejects an empty batch before calling Telegram', async () => {
    const forwardMessages = vi.fn();
    const manager = readyManager(forwardMessages);

    await expect(manager.forwardBatchToTarget('me', [], 'channel-peer')).rejects.toThrow(/1.*100|batch/i);
    expect(forwardMessages).not.toHaveBeenCalled();
  });

  it('rejects more than 100 messages before calling Telegram', async () => {
    const forwardMessages = vi.fn();
    const manager = readyManager(forwardMessages);
    const entries = Array.from({ length: 101 }, (_, index) => ({ messageId: index + 1, randomId: String(index + 1) }));

    await expect(manager.forwardBatchToTarget('me', entries, 'channel-peer')).rejects.toThrow(/100/);
    expect(forwardMessages).not.toHaveBeenCalled();
  });
});
