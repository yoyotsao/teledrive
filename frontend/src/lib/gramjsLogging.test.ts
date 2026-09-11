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

describe('segment runner logging', () => {
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
    await manager.asSegmentRunner().run({
      lease: { taskId: 'logging:0', attemptId: 1, accountId: 8773541354 },
      file,
      segment: { index: 0, offset: 0, parts: 1, size: 1 },
      hooks: {
        signal: new AbortController().signal,
        onRpcStart: () => true,
        onRpcSettled: () => undefined,
        onPartAccepted: () => undefined,
        onPremiumFlood: () => undefined,
        grantFinalize: () => true,
      },
    });

    const lines = log.mock.calls.map(([line]) => String(line));
    expect(lines).toEqual([
      '[test1][SplitUpload:8773541354] segment 0 sent, message_id: 3',
    ]);
    expect(lines.some((line) => line.includes('parts at offset'))).toBe(false);
  });
});

describe('lease-aware segment runner', () => {
  const lease = { taskId: 'job:0', attemptId: 1, accountId: 8773541354 };

  const activeHooks = (overrides: Partial<{
    onRpcStart(): boolean;
    onRpcSettled(): void;
    onPartAccepted(partIndex: number, bytes: number): void;
    grantFinalize(): boolean;
  }> = {}) => ({
    signal: new AbortController().signal,
    onRpcStart: vi.fn(() => true),
    onRpcSettled: vi.fn(),
    onPartAccepted: vi.fn(),
    onPremiumFlood: vi.fn(),
    grantFinalize: vi.fn(() => true),
    ...overrides,
  });

  it('does not finalize a segment when its lease is revoked', async () => {
    const manager = new TelegramClientManager(lease.accountId, 'test1');
    const hooks = activeHooks({ grantFinalize: () => false });
    const sendFile = vi.fn();

    Object.assign(manager as unknown as Record<string, unknown>, {
      client: {}, initPromise: Promise.resolve(),
      sendFilePartGated: vi.fn().mockResolvedValue(undefined),
      sendFileWithOptionalThumb: sendFile,
    });

    await expect(manager.asSegmentRunner().run({
      lease,
      file: new File([new Uint8Array([1])], 'one-byte.bin'),
      segment: { index: 0, offset: 0, parts: 1, size: 1 },
      hooks,
    })).rejects.toMatchObject({ name: 'LeaseRevokedError' });
    expect(sendFile).not.toHaveBeenCalled();
  });

  it('finalizes a segment exactly once after its lease grants finalization', async () => {
    const manager = new TelegramClientManager(lease.accountId, 'test1');
    const hooks = activeHooks();
    const sendFile = vi.fn().mockResolvedValue({ message: { id: 3 }, hasThumbnail: false });

    Object.assign(manager as unknown as Record<string, unknown>, {
      client: {}, initPromise: Promise.resolve(),
      sendFilePartGated: vi.fn().mockResolvedValue(undefined),
      sendFileWithOptionalThumb: sendFile,
    });

    await manager.asSegmentRunner().run({
      lease,
      file: new File([new Uint8Array([1])], 'one-byte.bin'),
      segment: { index: 0, offset: 0, parts: 1, size: 1 },
      hooks,
    });
    expect(hooks.grantFinalize).toHaveBeenCalledTimes(1);
    expect(sendFile).toHaveBeenCalledTimes(1);
  });

  it('pairs each scheduler-owned sender RPC with one start and settlement hook', async () => {
    const manager = new TelegramClientManager(lease.accountId, 'test1');
    const hooks = activeHooks();
    const send = vi.fn().mockResolvedValue(true);

    Object.assign(manager as unknown as Record<string, unknown>, {
      client: { session: { dcId: 2 }, getSender: vi.fn().mockResolvedValue({ send }) },
      _chunkPacer: { wait: vi.fn().mockResolvedValue(undefined), noteSendStarted: vi.fn(), reportSuccess: vi.fn() },
    });

    await (manager as any).sendFilePartGated({ bytes: new Uint8Array([1]) }, 'part', { lease, partIndex: 0, hooks });
    expect(send).toHaveBeenCalledTimes(1);
    expect(hooks.onRpcStart).toHaveBeenCalledTimes(1);
    expect(hooks.onRpcSettled).toHaveBeenCalledTimes(1);
  });
});
