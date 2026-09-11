import { afterEach, describe, expect, it, vi } from 'vitest';
import { Api } from 'telegram';
import { Buffer } from 'buffer';
import { TelegramClientManager } from './gramjs.ts';
import { accountActivityRegistry } from './accountActivityRegistry.ts';
import { SegmentScheduler } from './segmentScheduler.ts';
import { uploadSpeedTracker } from './uploadSpeedTracker.ts';
import { recordUploadedBytes } from './uploadStatisticsSync.ts';
import { CHUNK_SIZE } from '../config.ts';

vi.mock('./uploadStatisticsSync.ts', () => ({ recordUploadedBytes: vi.fn() }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('lease-aware part transport accounting', () => {
  const lease = { taskId: 'job:0', attemptId: 2, accountId: 9 };

  it('does not start a retry after an aborted lease settles its started RPC', async () => {
    const manager = new TelegramClientManager(lease.accountId);
    const controller = new AbortController();
    const send = vi.fn().mockImplementation(async () => {
      controller.abort();
      throw Object.assign(new Error('FLOOD_WAIT_1'), { seconds: 1 });
    });
    const hooks = {
      signal: controller.signal,
      onRpcStart: vi.fn(() => true), onRpcSettled: vi.fn(), onPartAccepted: vi.fn(),
      onPremiumFlood: vi.fn(), grantFinalize: vi.fn(() => true),
    };

    Object.assign(manager as unknown as Record<string, unknown>, {
      client: { session: { dcId: 2 }, getSender: vi.fn().mockResolvedValue({ send }) },
      _chunkPacer: { wait: vi.fn().mockResolvedValue(undefined), noteSendStarted: vi.fn(), reportFlood: vi.fn() },
    });

    await expect((manager as any).sendFilePartGated({ bytes: new Uint8Array([7]) }, 'part', { lease, partIndex: 0, hooks }))
      .rejects.toThrow('FLOOD_WAIT_1');
    expect(send).toHaveBeenCalledTimes(1);
    expect(hooks.onRpcSettled).toHaveBeenCalledTimes(1);
  });

  it('records a successful stale part physically while leaving effective progress to the scheduler', async () => {
    const manager = new TelegramClientManager(lease.accountId);
    const physical = vi.spyOn(uploadSpeedTracker, 'recordPhysicalSuccess');
    const effective = vi.spyOn(uploadSpeedTracker, 'recordEffectivePart');
    // The scheduler's callback records physical traffic before rejecting stale
    // logical progress, exactly as the runner contract requires.
    const onPartAccepted = vi.fn((partIndex: number, bytes: number) => {
      uploadSpeedTracker.recordPhysicalSuccess({ accountId: 9, taskId: 'job:0', attemptId: 2, bytes });
      if (partIndex === -1) throw new Error('stale progress must not be accepted');
    });
    const hooks = {
      signal: new AbortController().signal,
      onRpcStart: vi.fn(() => true), onRpcSettled: vi.fn(), onPartAccepted,
      onPremiumFlood: vi.fn(), grantFinalize: vi.fn(() => true),
    };

    Object.assign(manager as unknown as Record<string, unknown>, {
      client: { session: { dcId: 2 }, getSender: vi.fn().mockResolvedValue({ send: vi.fn().mockResolvedValue(true) }) },
      _chunkPacer: { wait: vi.fn().mockResolvedValue(undefined), noteSendStarted: vi.fn(), reportSuccess: vi.fn() },
    });

    await (manager as any).sendFilePartGated({ bytes: new Uint8Array([1, 2, 3]) }, 'part', { lease, partIndex: 7, hooks });
    expect(physical).toHaveBeenCalledWith({ accountId: 9, taskId: 'job:0', attemptId: 2, bytes: 3 });
    expect(onPartAccepted).toHaveBeenCalledWith(7, 3);
    expect(effective).not.toHaveBeenCalled();
  });

  it('has exactly one real registry RPC lifecycle for a scheduler-owned sender RPC', async () => {
    const accountId = 901_006;
    const manager = new TelegramClientManager(accountId);
    const begin = vi.spyOn(accountActivityRegistry, 'beginUploadRpc');
    let releaseSend!: () => void;
    let started!: () => void;
    const sent = new Promise<void>((resolve) => { started = resolve; });
    const pendingSend = new Promise<void>((resolve) => { releaseSend = resolve; });

    Object.assign(manager as unknown as Record<string, unknown>, {
      client: { session: { dcId: 2 }, getSender: vi.fn().mockResolvedValue({ send: vi.fn(async () => { started(); await pendingSend; }) }) },
      _chunkPacer: { wait: vi.fn().mockResolvedValue(undefined), noteSendStarted: vi.fn(), reportSuccess: vi.fn() },
    });

    accountActivityRegistry.setAvailability(accountId, { online: true, ready: true });
    const scheduler = new SegmentScheduler({ activity: accountActivityRegistry, speed: uploadSpeedTracker, maxJobsPerAccount: 1 });
    const completion = scheduler.enqueueFile({
      fileJobId: 'real-gramjs-lifecycle',
      file: { size: 1, name: 'part.bin' } as File,
      segments: [{ index: 0, offset: 0, parts: 1, size: 1 }],
      runners: [{
        accountId, accountName: 'real',
        async run(input) {
          await (manager as any).sendFilePartGated({ bytes: new Uint8Array([1]) }, 'part', {
            lease: input.lease, partIndex: 0, hooks: input.hooks,
          });
          expect(input.hooks.grantFinalize()).toBe(true);
          return { index: 0, message_id: 1, file_id: 'part', size: 1, account_id: accountId, hasThumbnail: false };
        },
      }],
    });

    await sent;
    expect(begin).toHaveBeenCalledTimes(1);
    expect(accountActivityRegistry.runtime(accountId).inFlightUploadRPCs).toBe(1);
    releaseSend();
    await expect(completion).resolves.toMatchObject({ parts: [{ account_id: accountId }] });
    expect(accountActivityRegistry.runtime(accountId).inFlightUploadRPCs).toBe(0);
    accountActivityRegistry.setAvailability(accountId, { online: false, ready: false });
  });

  it('freezes premium pacing after the flooded send and starts recovery at the next real send', async () => {
    const manager = new TelegramClientManager(lease.accountId);
    const events: string[] = [];
    const send = vi.fn()
      .mockImplementationOnce(async () => { events.push('send-1'); throw { isPremiumFlood: true, seconds: 7, message: 'FLOOD' }; })
      .mockImplementationOnce(async () => { events.push('send-2'); });
    const hooks = {
      signal: new AbortController().signal,
      onRpcStart: vi.fn(() => true), onRpcSettled: vi.fn(), onPartAccepted: vi.fn(),
      onPremiumFlood: vi.fn(), grantFinalize: vi.fn(() => true),
    };

    Object.assign(manager as unknown as Record<string, unknown>, {
      client: { session: { dcId: 2 }, getSender: vi.fn().mockResolvedValue({ send }) },
      _chunkPacer: {
        wait: vi.fn(async () => { events.push('wait'); }),
        noteSendStarted: vi.fn(() => { events.push('note'); }),
        reportPremiumFlood: vi.fn(() => { events.push('premium'); }),
        reportSuccess: vi.fn(), stats: vi.fn(() => ({ rate: 3, penaltyUntil: 9_000 })),
      },
    });

    await (manager as any).sendFilePartGated({ bytes: new Uint8Array([1]) }, 'part', { lease, partIndex: 0, hooks });
    expect(events).toEqual(['wait', 'note', 'send-1', 'premium', 'wait', 'note', 'send-2']);
    expect(hooks.onPremiumFlood).toHaveBeenCalledWith({ waitSeconds: 7, penaltyUntil: 9_000, pacerMode: 'frozen', scheduledRate: 3 });
  });
});

describe('upload statistics accounting', () => {
  it('releases direct SaveFilePart dedupe state after the work lifecycle settles', async () => {
    const manager = new TelegramClientManager(42) as any;
    const clearWork = vi.spyOn(uploadSpeedTracker, 'clearAccountEffectiveWork');
    manager.client = { session: { dcId: 1 }, getSender: async () => ({ send: async () => true }) };
    manager._chunkPacer = {
      wait: async () => {}, noteSendStarted: () => {}, reportSuccess: () => {},
    };

    await manager.uploadFilePartsPaced(Buffer.from([1, 2, 3]), 'three.bin');

    expect(clearWork).toHaveBeenCalledOnce();
    expect(clearWork).toHaveBeenCalledWith(expect.stringMatching(/^upload-part:/));
  });

  it('waits for a late direct part success before clearing failed work dedupe state', async () => {
    vi.useFakeTimers();
    const manager = new TelegramClientManager(42) as any;
    const clearWork = vi.spyOn(uploadSpeedTracker, 'clearAccountEffectiveWork');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let startLate!: () => void;
    const lateStarted = new Promise<void>((resolve) => { startLate = resolve; });
    let releaseLate!: () => void;
    const latePart = new Promise<void>((resolve) => { releaseLate = resolve; });
    let workId = '';

    manager.sendFilePartGated = (request: { fileId: unknown; filePart: number }) => {
      if (request.filePart === 0) return Promise.reject(new Error('part 0 failed'));
      workId = `upload-part:${String(request.fileId)}`;
      startLate();
      return latePart.then(() => {
        uploadSpeedTracker.recordAccountEffectiveUnit(42, workId, '1', 1);
      });
    };

    const upload = manager.uploadFilePartsPaced(Buffer.alloc(CHUNK_SIZE + 1), 'race.bin');
    const settled = upload.then(
      () => ({ error: null }),
      (error: unknown) => ({ error }),
    );
    await lateStarted;
    await vi.advanceTimersByTimeAsync(3_000);

    expect(clearWork).not.toHaveBeenCalled();

    releaseLate();
    await expect(settled).resolves.toMatchObject({ error: { message: 'part 0 failed' } });
    expect(clearWork).toHaveBeenCalledExactlyOnceWith(workId);
    expect(uploadSpeedTracker.recordAccountEffectiveUnit(42, workId, '1', 1)).toBe(true);
  });

  it('releases direct small-send dedupe state after the work lifecycle settles', async () => {
    const manager = new TelegramClientManager(42) as any;
    const clearWork = vi.spyOn(uploadSpeedTracker, 'clearAccountEffectiveWork');
    manager.client = {};
    manager.initPromise = Promise.resolve();
    manager.sendFileWithOptionalThumb = async () => ({
      message: { id: 7, media: { className: 'MessageMediaDocument', document: { id: 9 } } },
      hasThumbnail: false,
    });

    await manager.uploadSmallFile(new File([new Uint8Array([1, 2, 3])], 'three.bin'));

    expect(clearWork).toHaveBeenCalledOnce();
    expect(clearWork).toHaveBeenCalledWith(expect.stringMatching(/^small-send:/));
  });

  it('counts a successful part once after a flood retry and never counts failed sends', async () => {
    vi.mocked(recordUploadedBytes).mockClear();
    const manager = new TelegramClientManager(42) as any;
    const send = vi.fn().mockRejectedValueOnce({ message: 'FLOOD', seconds: 1 }).mockResolvedValueOnce(true);
    manager.client = { session: { dcId: 1 }, getSender: async () => ({ send }) };
    manager._chunkPacer = {
      wait: async () => {},
      noteSendStarted: () => {},
      reportFlood: () => {},
      reportSuccess: () => {},
    };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const request = new Api.upload.SaveFilePart({
      fileId: 1 as any,
      filePart: 0,
      bytes: Buffer.from([1, 2, 3]),
    });

    await manager.sendFilePartGated(request, 'test');
    expect(recordUploadedBytes).toHaveBeenCalledExactlyOnceWith(42, 3);

    send.mockRejectedValueOnce(new Error('invalid request'));
    await expect(manager.sendFilePartGated(request, 'test')).rejects.toThrow('invalid request');
    expect(recordUploadedBytes).toHaveBeenCalledTimes(1);
  });

  it('counts a successful album fallback reupload', async () => {
    vi.mocked(recordUploadedBytes).mockClear();
    const manager = new TelegramClientManager(42) as any;
    manager.client = { invoke: async () => { throw Error('album rejected'); } };
    manager.initPromise = Promise.resolve();
    manager.messageRateLimiter = { wait: async () => {} };
    manager.sendFileLocked = async () => ({
      id: 7,
      media: { className: 'MessageMediaDocument', document: { id: 9 } },
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const file = new File([new Uint8Array([1, 2, 3])], 'three.bin');

    const results = await manager.sendAlbum([
      { file, media: new Api.InputMediaEmpty(), docId: 2, hasThumbnail: false },
    ]);

    expect(results[0].size).toBe(3);
    expect(recordUploadedBytes).toHaveBeenCalledExactlyOnceWith(42, 3);
  });
});
