import { FAILOVER_SPEED_WINDOW_MS } from '../config.ts';

export type Clock = () => number;

export interface AttemptSampleKey {
  taskId: string;
  attemptId: number;
  accountId: number;
}

export interface EffectivePartEvent extends AttemptSampleKey {
  partIndex: number;
  bytes: number;
}

export interface PhysicalSuccessEvent {
  accountId: number;
  taskId: string | null;
  attemptId: number | null;
  bytes: number;
}

interface ByteBucket {
  timestamp: number;
  bytes: number;
}

interface PhysicalTotals {
  parts: number;
  bytes: number;
}

function attemptKey(taskId: string, attemptId: number): string {
  return JSON.stringify([taskId, attemptId]);
}

export class UploadSpeedTracker {
  private readonly attemptBuckets = new Map<string, ByteBucket[]>();
  private readonly accountEffectiveBuckets = new Map<number, ByteBucket[]>();
  private readonly accountPhysicalBuckets = new Map<number, ByteBucket[]>();
  private readonly effectivePartIndexes = new Map<string, Map<number, Set<number>>>();
  private readonly accountEffectiveUnitKeysByWork = new Map<string, Set<string>>();
  private readonly accountPhysicalTotals = new Map<number, PhysicalTotals>();
  private readonly taskPhysicalTotals = new Map<string, PhysicalTotals>();
  private readonly accountPremiumFloodMarkers = new Map<number, PhysicalTotals>();
  private readonly taskPremiumFloodMarkers = new Map<string, PhysicalTotals>();

  constructor(
    private readonly clock: Clock = Date.now,
    private readonly windowMs = FAILOVER_SPEED_WINDOW_MS,
  ) {}

  recordEffectivePart(event: EffectivePartEvent): boolean {
    const attemptParts = this.effectivePartIndexes.get(event.taskId)?.get(event.attemptId);
    if (attemptParts?.has(event.partIndex)) return false;

    if (attemptParts) attemptParts.add(event.partIndex);
    else {
      const taskAttempts = this.effectivePartIndexes.get(event.taskId) ?? new Map<number, Set<number>>();
      taskAttempts.set(event.attemptId, new Set([event.partIndex]));
      this.effectivePartIndexes.set(event.taskId, taskAttempts);
    }
    const timestamp = this.clock();
    this.addBucket(this.attemptBuckets, attemptKey(event.taskId, event.attemptId), timestamp, event.bytes);
    this.addBucket(this.accountEffectiveBuckets, event.accountId, timestamp, event.bytes);
    return true;
  }

  recordAccountEffectiveUnit(accountId: number, workId: string, unitId: string, bytes: number): boolean {
    const unitKeys = this.accountEffectiveUnitKeysByWork.get(workId);
    if (unitKeys?.has(unitId)) return false;

    if (unitKeys) unitKeys.add(unitId);
    else this.accountEffectiveUnitKeysByWork.set(workId, new Set([unitId]));
    this.addBucket(this.accountEffectiveBuckets, accountId, this.clock(), bytes);
    return true;
  }

  recordPhysicalSuccess(event: PhysicalSuccessEvent): void {
    this.addBucket(this.accountPhysicalBuckets, event.accountId, this.clock(), event.bytes);
    this.addPhysicalTotals(this.accountPhysicalTotals, event.accountId, event.bytes);
    if (event.taskId !== null) this.addPhysicalTotals(this.taskPhysicalTotals, event.taskId, event.bytes);
  }

  attemptEffectiveBytesPerSecond(key: AttemptSampleKey): number {
    return this.bytesPerSecond(this.attemptBuckets, attemptKey(key.taskId, key.attemptId));
  }

  accountEffectiveBytesPerSecond(accountId: number): number {
    return this.bytesPerSecond(this.accountEffectiveBuckets, accountId);
  }

  accountPhysicalBytesPerSecond(accountId: number): number {
    return this.bytesPerSecond(this.accountPhysicalBuckets, accountId);
  }

  nextAttemptEffectiveExpiry(key: AttemptSampleKey): number | null {
    const buckets = this.liveBuckets(this.attemptBuckets, attemptKey(key.taskId, key.attemptId));
    const oldest = buckets?.[0];
    return oldest ? oldest.timestamp + this.windowMs : null;
  }

  hasRecentAccountEffectiveBytes(accountId: number): boolean {
    return (this.liveBuckets(this.accountEffectiveBuckets, accountId)?.length ?? 0) > 0;
  }

  accountPhysicalSincePreviousPremiumFlood(accountId: number): { parts: number; bytes: number } {
    return this.physicalSince(this.accountPhysicalTotals.get(accountId), this.accountPremiumFloodMarkers.get(accountId));
  }

  taskPhysicalSincePreviousPremiumFlood(taskId: string): { parts: number; bytes: number } {
    return this.physicalSince(this.taskPhysicalTotals.get(taskId), this.taskPremiumFloodMarkers.get(taskId));
  }

  markPremiumFloodCycle(accountId: number, taskId: string): void {
    this.accountPremiumFloodMarkers.set(accountId, this.copyPhysicalTotals(this.accountPhysicalTotals.get(accountId)));
    this.taskPremiumFloodMarkers.set(taskId, this.copyPhysicalTotals(this.taskPhysicalTotals.get(taskId)));
  }

  clearAttempt(taskId: string, attemptId: number): void {
    this.attemptBuckets.delete(attemptKey(taskId, attemptId));
    const taskAttempts = this.effectivePartIndexes.get(taskId);
    taskAttempts?.delete(attemptId);
    if (taskAttempts?.size === 0) this.effectivePartIndexes.delete(taskId);
  }

  clearTask(taskId: string): void {
    this.taskPhysicalTotals.delete(taskId);
    this.taskPremiumFloodMarkers.delete(taskId);
    this.effectivePartIndexes.delete(taskId);
  }

  clearAccount(accountId: number): void {
    this.accountEffectiveBuckets.delete(accountId);
    this.accountPhysicalBuckets.delete(accountId);
    this.accountPhysicalTotals.delete(accountId);
    this.accountPremiumFloodMarkers.delete(accountId);
  }

  clearAccountEffectiveWork(workId: string): void {
    this.accountEffectiveUnitKeysByWork.delete(workId);
  }

  private addBucket<TKey>(bucketsByKey: Map<TKey, ByteBucket[]>, key: TKey, timestamp: number, bytes: number): void {
    const buckets = this.pruneBuckets(bucketsByKey, key, timestamp);
    if (buckets) buckets.push({ timestamp, bytes });
    else bucketsByKey.set(key, [{ timestamp, bytes }]);
  }

  private bytesPerSecond<TKey>(bucketsByKey: Map<TKey, ByteBucket[]>, key: TKey): number {
    const buckets = this.liveBuckets(bucketsByKey, key);
    if (!buckets) return 0;
    return buckets.reduce((total, bucket) => total + bucket.bytes, 0) / (this.windowMs / 1000);
  }

  private liveBuckets<TKey>(bucketsByKey: Map<TKey, ByteBucket[]>, key: TKey): ByteBucket[] | undefined {
    return this.pruneBuckets(bucketsByKey, key, this.clock());
  }

  private pruneBuckets<TKey>(bucketsByKey: Map<TKey, ByteBucket[]>, key: TKey, now: number): ByteBucket[] | undefined {
    const buckets = bucketsByKey.get(key);
    if (!buckets) return undefined;

    const oldestLiveTimestamp = now - this.windowMs;
    const live = buckets.filter((bucket) => bucket.timestamp > oldestLiveTimestamp);
    if (live.length === 0) {
      bucketsByKey.delete(key);
      return undefined;
    }
    if (live.length !== buckets.length) {
      bucketsByKey.set(key, live);
      return live;
    }
    return buckets;
  }

  private addPhysicalTotals<TKey>(totalsByKey: Map<TKey, PhysicalTotals>, key: TKey, bytes: number): void {
    const totals = totalsByKey.get(key);
    if (totals) {
      totals.parts++;
      totals.bytes += bytes;
    } else totalsByKey.set(key, { parts: 1, bytes });
  }

  private copyPhysicalTotals(totals: PhysicalTotals | undefined): PhysicalTotals {
    return totals ? { ...totals } : { parts: 0, bytes: 0 };
  }

  private physicalSince(totals: PhysicalTotals | undefined, marker: PhysicalTotals | undefined): PhysicalTotals {
    const current = this.copyPhysicalTotals(totals);
    const baseline = this.copyPhysicalTotals(marker);
    return { parts: current.parts - baseline.parts, bytes: current.bytes - baseline.bytes };
  }
}

export const uploadSpeedTracker = new UploadSpeedTracker();
