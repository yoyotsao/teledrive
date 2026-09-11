import { describe, expect, it } from 'vitest';
import { AccountActivityRegistry } from './accountActivityRegistry';
import { createAccountPool } from './accountPool';
import { UploadSpeedTracker } from './uploadSpeedTracker';

type TestClient = { accountId: number };

function readyRegistry(...accountIds: number[]): AccountActivityRegistry {
  const tracker = new UploadSpeedTracker(() => 30_000, 30_000);
  const registry = new AccountActivityRegistry(tracker, () => 30_000);
  for (const accountId of accountIds) registry.setAvailability(accountId, { online: true, ready: true });
  return registry;
}

function snapshotFor(registry: AccountActivityRegistry, tracker: UploadSpeedTracker, accountId: number): void {
  tracker.recordAccountEffectiveUnit(accountId, `work-${accountId}`, 'part-0', 15 * 1024 * 1024);
  const job = registry.tryBeginByteUploadJob(accountId, 1);
  job!.release();
}

describe('createAccountPool', () => {
  it('revalidates a selected client after acquiring its semaphore and skips a new reservation', async () => {
    const clientA: TestClient = { accountId: 10 };
    const clientB: TestClient = { accountId: 20 };
    const tracker = new UploadSpeedTracker(() => 30_000, 30_000);
    const registry = new AccountActivityRegistry(tracker, () => 30_000);
    registry.setAvailability(clientA.accountId, { online: true, ready: true });
    registry.setAvailability(clientB.accountId, { online: true, ready: true });
    snapshotFor(registry, tracker, clientA.accountId);
    const pool = createAccountPool({
      clients: () => [clientA, clientB],
      activity: registry,
      maxConcurrentFiles: 1,
    });

    const pending = pool.withAccountSlot(async (client) => client.accountId);
    expect(registry.tryReserve(clientA.accountId, 'migration')).toBe(true);

    expect(await pending).toBe(clientB.accountId);
    expect(registry.runtime(clientB.accountId).activeByteUploadJobs).toBe(0);
  });

  it('holds one activity job for exactly the byte callback lifetime', async () => {
    const client: TestClient = { accountId: 10 };
    const registry = readyRegistry(client.accountId);
    const pool = createAccountPool({ clients: () => [client], activity: registry, maxConcurrentFiles: 1 });

    const result = await pool.withAccountSlot(async () => {
      expect(registry.runtime(client.accountId).activeByteUploadJobs).toBe(1);
      return 'uploaded';
    });

    expect(result).toBe('uploaded');
    expect(registry.runtime(client.accountId).activeByteUploadJobs).toBe(0);
  });

  it('returns a nullable byte callback result without acquiring another slot', async () => {
    const client: TestClient = { accountId: 10 };
    const registry = readyRegistry(client.accountId);
    const pool = createAccountPool({ clients: () => [client], activity: registry, maxConcurrentFiles: 1 });
    let calls = 0;

    const result = await pool.withAccountSlot(async () => {
      calls++;
      if (calls > 1) throw new Error('callback acquired a second slot');
      return null;
    });

    expect(result).toBeNull();
    expect(calls).toBe(1);
  });

  it('waits for a pinned reservation to clear without switching accounts', async () => {
    const clientA: TestClient = { accountId: 10 };
    const clientB: TestClient = { accountId: 20 };
    const tracker = new UploadSpeedTracker(() => 30_000, 30_000);
    const registry = new AccountActivityRegistry(tracker, () => 30_000);
    registry.setAvailability(clientA.accountId, { online: true, ready: true });
    registry.setAvailability(clientB.accountId, { online: true, ready: true });
    snapshotFor(registry, tracker, clientA.accountId);
    expect(registry.tryReserve(clientA.accountId, 'migration')).toBe(true);
    const pool = createAccountPool({
      clients: () => [clientA, clientB],
      activity: registry,
      maxConcurrentFiles: 1,
    });
    let selectedAccountId: number | null = null;

    const pending = pool.withSlotOn(clientA, async () => {
      selectedAccountId = clientA.accountId;
      return clientA.accountId;
    });
    await Promise.resolve();
    expect(selectedAccountId).toBeNull();

    registry.releaseReservation(clientA.accountId, 'migration');
    expect(await pending).toBe(clientA.accountId);
    expect(selectedAccountId).toBe(clientA.accountId);
    expect(clientB.accountId).not.toBe(selectedAccountId);
  });
});
