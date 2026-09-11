import { expect, it } from 'vitest';
import { RETIRE_PENDING_UPLOAD_STATISTIC, UploadStatistics, taipeiDay } from './uploadStatistics';

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
    clear: () => data.clear(),
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

it('uses Taipei midnight regardless of the browser timezone', () => {
  expect(taipeiDay(new Date('2026-09-06T15:59:59Z'))).toBe('2026-09-06');
  expect(taipeiDay(new Date('2026-09-06T16:00:00Z'))).toBe('2026-09-07');
});

it('persists bytes across reloads and keeps owners and days separate', async () => {
  const storage = memoryStorage();
  const first = new UploadStatistics(storage, 'tab-a');
  first.record(1, 10, 100, new Date('2026-09-06T15:59:59Z'));
  first.record(1, 10, 200, new Date('2026-09-06T15:59:59Z'));
  first.record(1, 10, 50, new Date('2026-09-06T16:00:00Z'));
  first.record(2, 20, 900, new Date('2026-09-06T16:00:00Z'));
  const reloaded = new UploadStatistics(storage, 'tab-b');
  const sent: any[] = [];
  await reloaded.flush(1, async row => { sent.push(row); });
  expect(sent.map(r => [r.day, r.bytes])).toEqual([['2026-09-06', 300], ['2026-09-07', 50]]);
  expect(storage.length).toBe(1);
});

it('retains a failed report and bytes arriving during a flush', async () => {
  const storage = memoryStorage();
  const stats = new UploadStatistics(storage, 'tab-a');
  const day = new Date('2026-09-06T00:00:00Z');
  stats.record(1, 10, 100, day);
  await expect(stats.flush(1, async () => { throw Error('offline'); })).rejects.toThrow('offline');
  await stats.flush(1, async () => { stats.record(1, 10, 200, day); });
  const sent: any[] = [];
  await stats.flush(1, async row => { sent.push(row); });
  expect(sent[0].bytes).toBe(300);
  stats.record(1, 10, 50, day);
  await stats.flush(1, async row => { sent.push(row); });
  expect(sent[1].bytes).toBe(350);
});

it('retires a report only when its sender confirms it is permanently rejected', async () => {
  const storage = memoryStorage();
  const stats = new UploadStatistics(storage, 'tab-a');
  stats.record(1, 10, 100);

  expect(RETIRE_PENDING_UPLOAD_STATISTIC).toBe('retire-pending-upload-statistic');
  await stats.flush(1, async () => RETIRE_PENDING_UPLOAD_STATISTIC);

  expect(storage.length).toBe(0);
});

it('keeps a transient target-account failure pending without sending other accounts', async () => {
  const storage = memoryStorage();
  const stats = new UploadStatistics(storage, 'tab-a');
  stats.record(1, 10, 100);
  stats.record(1, 20, 200);
  const attempted: number[] = [];

  await expect(stats.flush(1, async row => {
    attempted.push(row.telegram_user_id);
    throw Error('offline');
  }, 10)).rejects.toThrow('offline');

  expect(attempted).toEqual([10]);
  expect(storage.length).toBe(2);
});

it('continues syncing healthy accounts after retiring a permanently rejected report', async () => {
  const storage = memoryStorage();
  const stats = new UploadStatistics(storage, 'tab-a');
  stats.record(1, 10, 100);
  stats.record(1, 20, 200);
  const received: number[] = [];
  await stats.flush(1, async row => {
    if (row.telegram_user_id === 10) return RETIRE_PENDING_UPLOAD_STATISTIC;
    received.push(row.bytes);
  });
  expect(received).toEqual([200]);
  expect(storage.length).toBe(0);
});

it('runs a fresh target pass for bytes recorded after an all-account pass has started', async () => {
  const storage = memoryStorage();
  const stats = new UploadStatistics(storage, 'tab-a');
  stats.record(1, 20, 100);
  const allStarted = deferred();
  const releaseAll = deferred();
  const targetSent: number[] = [];
  const all = stats.flush(1, async () => {
    allStarted.resolve();
    await releaseAll.promise;
  });

  await allStarted.promise;
  stats.record(1, 10, 50);
  const target = stats.flush(1, async row => { targetSent.push(row.telegram_user_id); }, 10);
  releaseAll.resolve();

  await all;
  await target;
  expect(targetSent).toEqual([10]);
});

it('does not let an unrelated all-account failure reject a queued target pass', async () => {
  const storage = memoryStorage();
  const stats = new UploadStatistics(storage, 'tab-a');
  stats.record(1, 20, 100);
  const allStarted = deferred();
  const releaseAll = deferred();
  const targetSent: number[] = [];
  const all = stats.flush(1, async () => {
    allStarted.resolve();
    await releaseAll.promise;
    throw Error('account 20 offline');
  });

  await allStarted.promise;
  stats.record(1, 10, 50);
  const target = stats.flush(1, async row => { targetSent.push(row.telegram_user_id); }, 10);
  releaseAll.resolve();

  await expect(all).rejects.toThrow('account 20 offline');
  await expect(target).resolves.toBeUndefined();
  expect(targetSent).toEqual([10]);
});

it('rejects and retains a target row when its fresh target pass fails', async () => {
  const storage = memoryStorage();
  const stats = new UploadStatistics(storage, 'tab-a');
  stats.record(1, 20, 100);
  const allStarted = deferred();
  const releaseAll = deferred();
  const all = stats.flush(1, async () => {
    allStarted.resolve();
    await releaseAll.promise;
  });

  await allStarted.promise;
  stats.record(1, 10, 50);
  const target = stats.flush(1, async () => { throw Error('account 10 offline'); }, 10);
  releaseAll.resolve();

  await all;
  await expect(target).rejects.toThrow('account 10 offline');
  expect(storage.length).toBe(1);
});
