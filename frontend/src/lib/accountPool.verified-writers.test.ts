import { describe, expect, it } from 'vitest';
import { AccountActivityRegistry } from './accountActivityRegistry';
import { createAccountPool } from './accountPool';
import { UploadSpeedTracker } from './uploadSpeedTracker';

type Client = { accountId: number };

function readyRegistry(...accountIds: number[]): AccountActivityRegistry {
  const tracker = new UploadSpeedTracker(() => 30_000, 30_000);
  const registry = new AccountActivityRegistry(tracker, () => 30_000);
  for (const accountId of accountIds) registry.setAvailability(accountId, { online: true, ready: true });
  return registry;
}

describe('withAccountSlotFrom', () => {
  it('never escapes the verified writer subset even when other linked clients are available', async () => {
    const primary: Client = { accountId: 10 };
    const writerA: Client = { accountId: 20 };
    const writerB: Client = { accountId: 30 };
    const registry = readyRegistry(10, 20, 30);
    const pool = createAccountPool({
      clients: () => [primary, writerA, writerB],
      activity: registry,
      maxConcurrentFiles: 1,
    });

    const chosen = await Promise.all(Array.from({ length: 6 }, () =>
      pool.withAccountSlotFrom([writerA, writerB], async (client) => client.accountId),
    ));

    expect(new Set(chosen)).toEqual(new Set([20, 30]));
    expect(chosen).not.toContain(10);
  });

  it('acquires capacity before invoking the callback so simultaneous work can occupy different writers', async () => {
    const writerA: Client = { accountId: 20 };
    const writerB: Client = { accountId: 30 };
    const registry = readyRegistry(20, 30);
    const pool = createAccountPool({
      clients: () => [writerA, writerB],
      activity: registry,
      maxConcurrentFiles: 1,
    });
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const entered: number[] = [];

    const first = pool.withAccountSlotFrom([writerA, writerB], async (client) => {
      entered.push(client.accountId);
      await hold;
      return client.accountId;
    });
    while (entered.length < 1) await Promise.resolve();

    const second = pool.withAccountSlotFrom([writerA, writerB], async (client) => {
      entered.push(client.accountId);
      return client.accountId;
    });
    while (entered.length < 2) await Promise.resolve();

    expect(new Set(entered)).toEqual(new Set([20, 30]));
    release();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });
});
