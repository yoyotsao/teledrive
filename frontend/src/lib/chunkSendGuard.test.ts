/**
 * Why this matters: a 512KB part is handed to a raw MTProtoSender via
 * `sender.send()`, which only appends to the send queue and returns a promise.
 * gramjs never rejects that promise when the connection breaks — `disconnect()`
 * closes the socket and abandons `_pendingState` silently. So one transient DC
 * fault (`-500 No workers running`, a dropped socket) leaves the awaiting chunk
 * hanging FOREVER, and because the chunk holds an uploadSemaphore slot for the
 * whole await, that slot is never released. Slot by slot the account's upload
 * concurrency bleeds to zero: the queue does not fail, it wedges (observed as
 * slotWait growing into the hours).
 *
 * The guard here is the bound that gramjs does not provide: every part send
 * must settle within a deadline, and a server-side fault must be recognised as
 * retryable rather than fatal.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ChunkSendTimeoutError,
  isTransientServerError,
  sendWithDeadline,
} from './chunkSendGuard.ts';

describe('sendWithDeadline', () => {
  // --- 正常送出：不該被 deadline 干擾，計時器要清掉 ---------------------------
  it('returns the send result untouched when it settles in time', async () => {
    const result = await sendWithDeadline(() => Promise.resolve('ok'), 1000, 'SaveBigFilePart#3');
    expect(result).toBe('ok');
  });

  it('propagates the send error unchanged when the send rejects', async () => {
    const boom = new Error('FLOOD_WAIT_5');
    await expect(sendWithDeadline(() => Promise.reject(boom), 1000, 'part#3')).rejects.toBe(boom);
  });

  // --- 核心：永不 settle 的 send 必須被斷開，槽位才放得回去 -------------------
  it('rejects with ChunkSendTimeoutError when the send never settles', async () => {
    vi.useFakeTimers();
    try {
      const pending = sendWithDeadline(() => new Promise<never>(() => {}), 30_000, 'part#7');
      const assertion = expect(pending).rejects.toBeInstanceOf(ChunkSendTimeoutError);
      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('names the part in the timeout message so the log says which chunk wedged', async () => {
    vi.useFakeTimers();
    try {
      const pending = sendWithDeadline(() => new Promise<never>(() => {}), 5_000, 'SaveFilePart(clip.mp4)#2');
      const assertion = expect(pending).rejects.toThrow(/SaveFilePart\(clip\.mp4\)#2/);
      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  // --- 被放生的 promise 之後才炸，不可變成 unhandled rejection ---------------
  it('swallows a late rejection from the abandoned send', async () => {
    type Emitter = { on(e: string, f: () => void): void; off(e: string, f: () => void): void };
    const proc = (globalThis as { process?: Emitter }).process!;
    const unhandled = vi.fn();
    proc.on('unhandledRejection', unhandled);
    try {
      let fail!: (e: unknown) => void;
      const pending = sendWithDeadline(
        () => new Promise<never>((_, reject) => { fail = reject; }),
        10,
        'part#1',
      );
      await expect(pending).rejects.toBeInstanceOf(ChunkSendTimeoutError);
      fail(new Error('connection closed, far too late'));
      // Node reports unhandled rejections a macrotask after the fact, so give
      // it a real one — fake timers would hide the very thing under test.
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      proc.off('unhandledRejection', unhandled);
    }
    expect(unhandled).not.toHaveBeenCalled();
  });
});

describe('isTransientServerError', () => {
  // --- 這正是把上傳打斷的那顆錯誤 --------------------------------------------
  it('treats -500 No workers running as transient', () => {
    expect(isTransientServerError({ code: -500, errorMessage: 'No workers running' })).toBe(true);
  });

  it('treats a positive 500 INTERNAL the same way', () => {
    expect(isTransientServerError({ code: 500, errorMessage: 'INTERNAL' })).toBe(true);
  });

  it('treats a 503 Timeout as transient', () => {
    expect(isTransientServerError({ code: -503, errorMessage: 'Timeout' })).toBe(true);
  });

  it('recognises our own send deadline as transient', () => {
    expect(isTransientServerError(new ChunkSendTimeoutError('part#4', 30_000))).toBe(true);
  });

  // --- 客戶端錯誤重試只是浪費配額 --------------------------------------------
  it('does not treat a 400 as transient', () => {
    expect(isTransientServerError({ code: 400, errorMessage: 'FILE_PART_INVALID' })).toBe(false);
  });

  it('does not treat FLOOD_WAIT as transient (the pacer owns that path)', () => {
    expect(isTransientServerError({ code: 420, errorMessage: 'FLOOD_WAIT_42' })).toBe(false);
  });

  it('is safe on null and on a plain Error', () => {
    expect(isTransientServerError(null)).toBe(false);
    expect(isTransientServerError(new Error('something else'))).toBe(false);
  });
});
