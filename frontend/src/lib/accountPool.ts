/**
 * Spreads byte uploads across the drive's linked Telegram accounts while
 * keeping the account activity registry and per-account file slots in lockstep.
 */
import { MAX_CONCURRENT_FILES } from '../config';
import { accountActivityRegistry, AccountActivityRegistry } from './accountActivityRegistry';
import { getAllClients, TelegramClientManager } from './gramjs';
import { Semaphore } from './semaphore';

export interface AccountPoolClient {
  accountId: number;
}

export interface AccountPoolOptions<TClient extends AccountPoolClient> {
  clients: () => readonly TClient[];
  activity: AccountActivityRegistry;
  maxConcurrentFiles: number;
}

export interface AccountPool<TClient extends AccountPoolClient> {
  nextAccount(): TClient;
  withAccountSlot<T>(fn: (client: TClient) => Promise<T>): Promise<T>;
  withAccountSlotFrom<T>(clients: readonly TClient[], fn: (client: TClient) => Promise<T>): Promise<T>;
  withSlotOn<T>(client: TClient, fn: () => Promise<T>): Promise<T>;
}

type SlotResult<T> = { acquired: true; value: T } | { acquired: false };

export function createAccountPool<TClient extends AccountPoolClient>(options: AccountPoolOptions<TClient>): AccountPool<TClient> {
  const fileSemaphores = new WeakMap<object, Semaphore>();
  let cursor = 0;

  const slotsFor = (client: TClient): Semaphore => {
    let sem = fileSemaphores.get(client);
    if (!sem) {
      sem = new Semaphore(options.maxConcurrentFiles);
      fileSemaphores.set(client, sem);
    }
    return sem;
  };

  const isEligible = (client: TClient): boolean => {
    const runtime = options.activity.runtime(client.accountId);
    return runtime.online
      && runtime.ready
      && runtime.reservedTaskId === null
      && runtime.activeByteUploadJobs < options.maxConcurrentFiles;
  };

  const chooseAccount = (clients: readonly TClient[] = options.clients()): TClient => {
    if (clients.length === 0) throw new Error('沒有可用的 Telegram 帳號（全部離線）');

    const start = cursor++ % clients.length;
    for (let i = 0; i < clients.length; i++) {
      const candidate = clients[(start + i) % clients.length];
      if (isEligible(candidate) && slotsFor(candidate).freeSlots() > 0) return candidate;
    }
    for (let i = 0; i < clients.length; i++) {
      const candidate = clients[(start + i) % clients.length];
      if (isEligible(candidate)) return candidate;
    }
    return clients[start];
  };

  const waitForActivityChange = (): Promise<void> => new Promise((resolve) => {
    const unsubscribe = options.activity.subscribe(() => {
      unsubscribe();
      resolve();
    });
  });

  const acquireOn = async <T>(client: TClient, fn: () => Promise<T>): Promise<SlotResult<T>> => {
    const semaphore = slotsFor(client);
    await semaphore.acquire();
    const lease = options.activity.tryBeginByteUploadJob(client.accountId, options.maxConcurrentFiles);
    if (!lease) {
      semaphore.release();
      return { acquired: false };
    }

    try {
      return { acquired: true, value: await fn() };
    } finally {
      lease.release();
      semaphore.release();
    }
  };

  const withCandidateSlot = async <T>(
    candidates: () => readonly TClient[],
    fn: (client: TClient) => Promise<T>,
  ): Promise<T> => {
    while (true) {
      const clients = candidates();
      const client = chooseAccount(clients);
      const result = await acquireOn(client, () => fn(client));
      if (result.acquired) return result.value;

      const refreshed = candidates();
      if (refreshed.some(isEligible)) continue;
      await waitForActivityChange();
    }
  };

  return {
    nextAccount: () => chooseAccount(),

    async withAccountSlot<T>(fn: (client: TClient) => Promise<T>): Promise<T> {
      return withCandidateSlot(options.clients, fn);
    },

    async withAccountSlotFrom<T>(clients: readonly TClient[], fn: (client: TClient) => Promise<T>): Promise<T> {
      const candidates = [...clients];
      if (candidates.length === 0) throw new Error('沒有可用的 Telegram 帳號（全部離線）');
      return withCandidateSlot(() => candidates, fn);
    },

    async withSlotOn<T>(client: TClient, fn: () => Promise<T>): Promise<T> {
      while (true) {
        const result = await acquireOn(client, fn);
        if (result.acquired) return result.value;
        await waitForActivityChange();
      }
    },
  };
}

const productionPool = createAccountPool<TelegramClientManager>({
  clients: getAllClients,
  activity: accountActivityRegistry,
  maxConcurrentFiles: MAX_CONCURRENT_FILES,
});

/** Round-robin selection used by the album pipeline before its pinned slot is acquired. */
export function nextAccount(): TelegramClientManager {
  return productionPool.nextAccount();
}

/** Pick an account and hold one activity-aware file slot for fn's byte lifetime. */
export function withAccountSlot<T>(fn: (client: TelegramClientManager) => Promise<T>): Promise<T> {
  return productionPool.withAccountSlot(fn);
}

/** Pick only from the supplied verified writers, then hold that writer's byte slot. */
export function withAccountSlotFrom<T>(
  clients: readonly TelegramClientManager[],
  fn: (client: TelegramClientManager) => Promise<T>,
): Promise<T> {
  return productionPool.withAccountSlotFrom(clients, fn);
}

/** Hold a file slot on one pinned account; it never switches accounts while waiting. */
export function withSlotOn<T>(client: TelegramClientManager, fn: () => Promise<T>): Promise<T> {
  return productionPool.withSlotOn(client, fn);
}
