import { describe, expect, it, vi } from 'vitest';
import { TelegramClientManager } from './gramjs';

describe('TelegramClientManager upload sender', () => {
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
    expect(getSender).not.toHaveBeenCalled();
  });
});
