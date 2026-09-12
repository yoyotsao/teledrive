import { describe, expect, it, vi } from 'vitest';
import { TelegramClientManager } from './gramjs';

describe('TelegramClientManager upload sender', () => {
  it('serializes split-upload bytes when the page Buffer is a different constructor', async () => {
    class PageBuffer extends Uint8Array {
      static from(data: Uint8Array): PageBuffer {
        return new PageBuffer(data);
      }
    }

    const originalBuffer = (globalThis as any).Buffer;
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    (globalThis as any).Buffer = PageBuffer;

    try {
      const manager = new TelegramClientManager(42, 'test');
      Object.assign(manager as unknown as Record<string, unknown>, {
        client: {},
        initPromise: Promise.resolve(),
        sendFilePartGated: vi.fn(async (request: { getBytes(): Uint8Array }) => {
          request.getBytes();
        }),
        sendFileWithOptionalThumb: vi.fn().mockResolvedValue({
          message: { id: 3 },
          hasThumbnail: false,
        }),
      });

      const upload = manager.asSegmentRunner().run({
        lease: { taskId: 'buffer:0', attemptId: 1, accountId: 42 },
        file: new File([new Uint8Array([1, 2, 3])], 'three.bin'),
        segment: { index: 0, offset: 0, parts: 1, size: 3 },
        hooks: {
          signal: new AbortController().signal,
          onRpcStart: () => true,
          onRpcSettled: () => undefined,
          onPartAccepted: () => undefined,
          onPremiumFlood: () => undefined,
          grantFinalize: () => true,
        },
      });
      const result = expect(upload).resolves.toMatchObject({ message_id: 3, size: 3 });

      await vi.runAllTimersAsync();
      await result;
    } finally {
      (globalThis as any).Buffer = originalBuffer;
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it('sends home-DC file parts on the already-connected main sender', async () => {
    const manager = new TelegramClientManager(42, 'test');
    const send = vi.fn().mockResolvedValue(true);
    const mainSender = { send, isConnected: () => true };
    const getSender = vi.fn().mockResolvedValue(mainSender);

    (manager as any).client = {
      session: { dcId: 2 },
      _sender: mainSender,
      getSender,
    };
    (manager as any)._chunkPacer = {
      wait: vi.fn().mockResolvedValue(undefined),
      noteSendStarted: vi.fn(),
      reportSuccess: vi.fn(),
      reportPremiumFlood: vi.fn(),
      reportFlood: vi.fn(),
      stats: vi.fn(() => ({ rate: 1, floods: 0, ceiling: null, penaltyUntil: 0 })),
    };

    const controller = new AbortController();
    await (manager as any).sendFilePartGated(
      { bytes: new Uint8Array([1]), fileId: 1, filePart: 0 },
      'sender regression',
      {
        lease: { taskId: 't', attemptId: 1, accountId: 42 },
        partIndex: 0,
        hooks: {
          signal: controller.signal,
          onRpcStart: () => true,
          onRpcSettled: vi.fn(),
          onPartAccepted: vi.fn(),
          onPremiumFlood: vi.fn(),
          grantFinalize: () => true,
        },
      },
    );

    expect(send).toHaveBeenCalledTimes(1);
    expect(getSender.mock.calls).toEqual([[]]);
  });
});
