/**
 * Spreads uploads across the drive's linked Telegram accounts.
 *
 * Telegram's upload limits are per account, so N accounts means N independent
 * budgets: each gets its own file-concurrency semaphore here, on top of the
 * per-account chunk semaphore and pacer that live on TelegramClientManager.
 * One account hitting FLOOD_WAIT therefore only slows its own share down.
 */
import { Semaphore } from './semaphore';
import { getAllClients, TelegramClientManager } from './gramjs';
import { MAX_CONCURRENT_FILES } from '../config';

// ponytail: per-account file slots only. If browser upstream or the WebSocket
// count turns out to be the real ceiling, add one global Semaphore here and
// wrap withAccountSlot's body in it.
const fileSemaphores = new WeakMap<TelegramClientManager, Semaphore>();
let cursor = 0;

function slotsFor(client: TelegramClientManager): Semaphore {
  let sem = fileSemaphores.get(client);
  if (!sem) {
    sem = new Semaphore(MAX_CONCURRENT_FILES);
    fileSemaphores.set(client, sem);
  }
  return sem;
}

/**
 * Round-robin across online accounts, but hand the file to an account with a
 * free slot when the round-robin pick is saturated — otherwise a single
 * flooded account would collect a queue while another sits idle.
 */
export function nextAccount(): TelegramClientManager {
  const clients = getAllClients();
  if (clients.length === 0) {
    throw new Error('沒有可用的 Telegram 帳號（全部離線）');
  }
  const start = cursor++ % clients.length;
  for (let i = 0; i < clients.length; i++) {
    const candidate = clients[(start + i) % clients.length];
    if (slotsFor(candidate).freeSlots() > 0) return candidate;
  }
  return clients[start]; // all busy — queue on the round-robin pick
}

/** Pick an account, hold one of ITS file slots for the duration of fn. */
export async function withAccountSlot<T>(fn: (client: TelegramClientManager) => Promise<T>): Promise<T> {
  const client = nextAccount();
  return slotsFor(client).withSlot(() => fn(client));
}

/** Hold a file slot on a specific account (album batches are pinned to one). */
export async function withSlotOn<T>(
  client: TelegramClientManager,
  fn: () => Promise<T>,
): Promise<T> {
  return slotsFor(client).withSlot(fn);
}
