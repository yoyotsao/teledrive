import { afterEach, expect, it, vi } from 'vitest';

import { removeAccount } from './gramjs';
import { uploadSpeedTracker } from './uploadSpeedTracker';

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it('clears upload speed state while unlinking an account', async () => {
  uploadSpeedTracker.recordAccountEffectiveUnit(20, 'unlink-test', 'unit:0', 15);
  uploadSpeedTracker.recordPhysicalSuccess({ accountId: 20, taskId: 'unlink-test', attemptId: 1, bytes: 12 });
  const transaction = {
    objectStore: () => ({
      put: () => queueMicrotask(() => transaction.oncomplete?.()),
    }),
    oncomplete: undefined as (() => void) | undefined,
    onerror: undefined,
    onabort: undefined,
  };
  const database = {
    transaction: () => transaction,
    close: vi.fn(),
  };
  vi.stubGlobal('indexedDB', {
    open: () => {
      const request = { result: database, onsuccess: undefined as (() => void) | undefined };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
  });

  await removeAccount(20);

  expect(uploadSpeedTracker.accountEffectiveBytesPerSecond(20)).toBe(0);
  expect(uploadSpeedTracker.accountPhysicalSincePreviousPremiumFlood(20)).toEqual({ parts: 0, bytes: 0 });
});
