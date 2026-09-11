import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountActivityRegistry } from './accountActivityRegistry';
import { SegmentScheduler } from './segmentScheduler';
import { createUploadFileSpread } from './splitUpload';
import type { TelegramClientManager } from './gramjs';
import type { SegmentAttemptInput, SegmentAttemptRunner, SegmentFileJobInput, SegmentResult } from './segmentUploadTypes';
import { UploadSpeedTracker } from './uploadSpeedTracker';

class ControlledRunner implements SegmentAttemptRunner {
  calls: SegmentAttemptInput[] = [];
  private pending: {
    resolve: (value: SegmentResult & { hasThumbnail: boolean }) => void;
    reject: (reason?: unknown) => void;
  } | null = null;

  constructor(readonly accountId: number, readonly accountName: string) {}

  run(input: SegmentAttemptInput): Promise<SegmentResult & { hasThumbnail: boolean }> {
    this.calls.push(input);
    return new Promise((resolve, reject) => { this.pending = { resolve, reject }; });
  }

  finish(value: SegmentResult & { hasThumbnail: boolean }): void {
    if (!this.pending) throw new Error('no pending segment attempt');
    this.pending.resolve(value);
    this.pending = null;
  }
}

const clientA = {
  accountId: 10,
  asSegmentRunner: () => ({ accountId: 10, accountName: 'A', run: vi.fn() }),
  uploadSmallFile: vi.fn(),
} as unknown as TelegramClientManager;

const clientB = {
  accountId: 20,
  asSegmentRunner: () => ({ accountId: 20, accountName: 'B', run: vi.fn() }),
  uploadSmallFile: vi.fn(),
} as unknown as TelegramClientManager;

describe('createUploadFileSpread', () => {
  afterEach(() => vi.useRealTimers());

  it('keeps non-pinned large files scheduler-owned while sorting returned parts and forwarding migration progress', async () => {
    const largeFile = { size: 1536, name: 'large.bin' } as File;
    const enqueueFile = vi.fn(async (input: SegmentFileJobInput) => {
      input.onMigration?.({
        fileJobId: input.fileJobId,
        taskId: 'large:1',
        segmentIndex: 1,
        abandonedLogicalBytes: 512,
        logicalFileBytes: 512,
        totalFileBytes: 1536,
        message: '重新分派上傳帳號，該區段將從頭重傳',
      });
      return {
        parts: [
          { index: 2, message_id: 298, file_id: 'part-2', size: 512, account_id: 10, hasThumbnail: false },
          { index: 0, message_id: 300, file_id: 'part-0', size: 512, account_id: 10, hasThumbnail: false },
          { index: 1, message_id: 299, file_id: 'part-1', size: 512, account_id: 20, hasThumbnail: false },
        ],
        hasThumbnail: false,
      };
    });
    const accountSlotCalls = vi.fn();
    const withAccountSlot = async <T,>(_fn: (client: TelegramClientManager) => Promise<T>): Promise<T> => {
      accountSlotCalls();
      throw new Error('large-file dispatch must not acquire an account-pool slot');
    };
    const upload = createUploadFileSpread({
      scheduler: { enqueueFile },
      clients: () => [clientA, clientB],
      plan: () => [
        { index: 0, offset: 0, parts: 1, size: 512 },
        { index: 1, offset: 512, parts: 1, size: 512 },
        { index: 2, offset: 1024, parts: 1, size: 512 },
      ],
      withAccountSlot,
      smallFileLimit: 0,
    });
    const progress: Array<{ percent: number; detail?: unknown }> = [];

    const result = await upload(largeFile, (percent, detail) => progress.push({ percent, detail }));

    expect(enqueueFile.mock.calls[0][0].segments.map((segment) => segment.index)).toEqual([0, 1, 2]);
    expect(enqueueFile.mock.calls[0][0]).toMatchObject({
      runners: [expect.objectContaining({ accountId: 10 }), expect.objectContaining({ accountId: 20 })],
      migrationEnabled: true,
    });
    expect(result.parts.map((part) => part.index)).toEqual([0, 1, 2]);
    expect(result.parts.map((part) => part.account_id)).toEqual([10, 20, 10]);
    expect(accountSlotCalls).not.toHaveBeenCalled();
    expect(progress).toEqual([
      {
        percent: 33,
        detail: { reason: 'migration', message: '重新分派上傳帳號，該區段將從頭重傳' },
      },
      { percent: 100, detail: undefined },
    ]);
  });

  it('limits a pinned large-file job to its runner and disables migration', async () => {
    const enqueueFile = vi.fn(async (input: SegmentFileJobInput) => ({
      parts: input.segments.map((segment) => ({
        index: segment.index, message_id: segment.index + 1, file_id: `part-${segment.index}`,
        size: segment.size, account_id: 20, hasThumbnail: segment.index === 0,
      })),
      hasThumbnail: true,
    }));
    const upload = createUploadFileSpread({
      scheduler: { enqueueFile },
      clients: () => [clientA],
      plan: () => [{ index: 0, offset: 0, parts: 1, size: 512 }],
      withAccountSlot: async (fn) => fn(clientA),
      smallFileLimit: 0,
    });

    await upload({ size: 512, name: 'pinned.bin' } as File, undefined, null, clientB);

    expect(enqueueFile).toHaveBeenCalledWith(expect.objectContaining({
      runners: [expect.objectContaining({ accountId: 20 })],
      migrationEnabled: false,
    }));
  });

  it('keeps small files on an account slot and reports completion', async () => {
    const uploadSmallFile = vi.mocked(clientA.uploadSmallFile);
    uploadSmallFile.mockResolvedValueOnce({
      index: 0, message_id: 1, file_id: 'small', size: 12, account_id: 10, hasThumbnail: true,
    });
    let accountSlotCalls = 0;
    const withAccountSlot = async <T,>(fn: (client: TelegramClientManager) => Promise<T>): Promise<T> => {
      accountSlotCalls++;
      return fn(clientA);
    };
    const enqueueFile = vi.fn();
    const upload = createUploadFileSpread({
      scheduler: { enqueueFile },
      clients: () => [clientA, clientB],
      withAccountSlot,
      smallFileLimit: 12,
    });
    const progress: number[] = [];

    const result = await upload({ size: 12, name: 'small.bin' } as File, (percent) => progress.push(percent));

    expect(accountSlotCalls).toBe(1);
    expect(uploadSmallFile).toHaveBeenCalledTimes(1);
    expect(enqueueFile).not.toHaveBeenCalled();
    expect(progress).toEqual([100]);
    expect(result).toMatchObject({ totalParts: 1, hasThumbnail: true, parts: [{ account_id: 10 }] });
  });

  it('returns index-sorted real storage accounts only after every scheduled segment resolves', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const tracker = new UploadSpeedTracker(Date.now, 30_000);
    const activity = new AccountActivityRegistry(tracker, Date.now);
    activity.setAvailability(10, { online: true, ready: true });
    activity.setAvailability(20, { online: true, ready: true });
    const scheduler = new SegmentScheduler({ activity, speed: tracker, maxJobsPerAccount: 1 });
    const runnerA = new ControlledRunner(10, 'A');
    const runnerB = new ControlledRunner(20, 'B');
    const clientFor = (runner: ControlledRunner) => ({
      accountId: runner.accountId,
      asSegmentRunner: () => runner,
    }) as unknown as TelegramClientManager;
    const upload = createUploadFileSpread({
      scheduler,
      clients: () => [clientFor(runnerA), clientFor(runnerB)],
      plan: () => [
        { index: 0, offset: 0, parts: 1, size: 512 },
        { index: 1, offset: 512, parts: 1, size: 512 },
      ],
      smallFileLimit: 0,
    });
    const registrations: unknown[] = [];
    const resultPromise = upload({ size: 1_024, name: 'ordered.bin' } as File).then((result) => {
      registrations.push(result);
      return result;
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(runnerA.calls).toHaveLength(1);
    expect(runnerB.calls).toHaveLength(1);
    expect(runnerB.calls[0].hooks.grantFinalize()).toBe(true);
    runnerB.finish({ index: 1, message_id: 100, file_id: 'stored-by-b', size: 512, account_id: 20, hasThumbnail: false });
    await vi.advanceTimersByTimeAsync(0);

    expect(registrations).toEqual([]);
    expect(runnerA.calls[0].hooks.grantFinalize()).toBe(true);
    runnerA.finish({ index: 0, message_id: 900, file_id: 'stored-by-a', size: 512, account_id: 10, hasThumbnail: true });

    await expect(resultPromise).resolves.toMatchObject({
      parts: [
        { index: 0, message_id: 900, file_id: 'stored-by-a', account_id: 10 },
        { index: 1, message_id: 100, file_id: 'stored-by-b', account_id: 20 },
      ],
      totalParts: 2,
      hasThumbnail: true,
    });
    expect(registrations).toHaveLength(1);
  });
});
