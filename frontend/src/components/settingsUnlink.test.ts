import { expect, it, vi } from 'vitest';
import { flushThenUnlinkSecondaryAccount } from './SettingsDialog';

it('flushes a secondary account before unlinking and forgetting its local session', async () => {
  const calls: string[] = [];
  await flushThenUnlinkSecondaryAccount(20, {
    flush: async id => { calls.push(`flush:${id}`); },
    unlink: async id => { calls.push(`unlink:${id}`); },
    forget: async id => { calls.push(`forget:${id}`); },
  });

  expect(calls).toEqual(['flush:20', 'unlink:20', 'forget:20']);
});

it('aborts unlinking when the target-account flush fails', async () => {
  const unlink = vi.fn(async () => undefined);
  const forget = vi.fn(async () => undefined);

  await expect(flushThenUnlinkSecondaryAccount(20, {
    flush: async () => { throw Error('offline'); },
    unlink,
    forget,
  })).rejects.toThrow('offline');

  expect(unlink).not.toHaveBeenCalled();
  expect(forget).not.toHaveBeenCalled();
});
