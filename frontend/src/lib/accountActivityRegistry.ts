import { FAILOVER_IDLE_SNAPSHOT_TTL_MS } from '../config';
import { Clock, uploadSpeedTracker, UploadSpeedTracker } from './uploadSpeedTracker';

export interface IdleSpeedSnapshot {
  bytesPerSecond: number;
  createdAt: number;
  expiresAt: number;
}

export interface AccountRuntime {
  accountId: number;
  activeByteUploadJobs: number;
  inFlightUploadRPCs: number;
  reservedTaskId: string | null;
  idleSnapshot: IdleSpeedSnapshot | null;
  online: boolean;
  ready: boolean;
}

export interface ActivityLease {
  release(): void;
}

export class AccountActivityRegistry {
  private readonly runtimes = new Map<number, AccountRuntime>();
  private readonly listeners = new Set<() => void>();
  private notificationQueued = false;

  constructor(
    private readonly speed: UploadSpeedTracker,
    private readonly clock: Clock = Date.now,
  ) {}

  setAvailability(accountId: number, state: { online: boolean; ready: boolean }): void {
    const runtime = this.stateFor(accountId);
    runtime.online = state.online;
    runtime.ready = state.ready;
    this.notify();
  }

  tryBeginByteUploadJob(accountId: number, maxJobs: number): ActivityLease | null {
    const runtime = this.stateFor(accountId);
    if (!runtime.online || !runtime.ready || runtime.reservedTaskId !== null || runtime.activeByteUploadJobs >= maxJobs) {
      return null;
    }

    runtime.activeByteUploadJobs++;
    runtime.idleSnapshot = null;
    this.notify();
    return this.byteJobLease(accountId);
  }

  beginUploadRpc(accountId: number): ActivityLease {
    const runtime = this.stateFor(accountId);
    runtime.inFlightUploadRPCs++;
    this.notify();
    return this.rpcLease(accountId);
  }

  tryReserve(accountId: number, taskId: string): boolean {
    const runtime = this.stateFor(accountId);
    if (!runtime.online || !runtime.ready || !this.isTrulyIdle(accountId) || !this.validIdleSnapshot(accountId)) {
      return false;
    }

    runtime.reservedTaskId = taskId;
    runtime.idleSnapshot = null;
    this.notify();
    return true;
  }

  activateReservation(accountId: number, taskId: string, maxJobs: number): ActivityLease | null {
    const runtime = this.stateFor(accountId);
    if (runtime.reservedTaskId !== taskId || runtime.activeByteUploadJobs >= maxJobs) return null;

    runtime.reservedTaskId = null;
    runtime.activeByteUploadJobs++;
    runtime.idleSnapshot = null;
    this.notify();
    return this.byteJobLease(accountId);
  }

  releaseReservation(accountId: number, taskId: string): void {
    const runtime = this.stateFor(accountId);
    if (runtime.reservedTaskId !== taskId) return;

    runtime.reservedTaskId = null;
    this.notify();
  }

  isTrulyIdle(accountId: number): boolean {
    const runtime = this.stateFor(accountId);
    return runtime.activeByteUploadJobs === 0
      && runtime.inFlightUploadRPCs === 0
      && runtime.reservedTaskId === null;
  }

  validIdleSnapshot(accountId: number): IdleSpeedSnapshot | null {
    const snapshot = this.stateFor(accountId).idleSnapshot;
    return snapshot && snapshot.expiresAt > this.clock() ? { ...snapshot } : null;
  }

  runtime(accountId: number): Readonly<AccountRuntime> {
    const runtime = this.stateFor(accountId);
    return {
      ...runtime,
      idleSnapshot: this.validIdleSnapshot(accountId),
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private stateFor(accountId: number): AccountRuntime {
    let runtime = this.runtimes.get(accountId);
    if (!runtime) {
      runtime = {
        accountId,
        activeByteUploadJobs: 0,
        inFlightUploadRPCs: 0,
        reservedTaskId: null,
        idleSnapshot: null,
        online: false,
        ready: false,
      };
      this.runtimes.set(accountId, runtime);
    }
    return runtime;
  }

  private byteJobLease(accountId: number): ActivityLease {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        const runtime = this.stateFor(accountId);
        const wasIdle = this.isTrulyIdle(accountId);
        runtime.activeByteUploadJobs = Math.max(0, runtime.activeByteUploadJobs - 1);
        this.freezeIdleSnapshotAfterSettlement(accountId, wasIdle);
        this.notify();
      },
    };
  }

  private rpcLease(accountId: number): ActivityLease {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        const runtime = this.stateFor(accountId);
        const wasIdle = this.isTrulyIdle(accountId);
        runtime.inFlightUploadRPCs = Math.max(0, runtime.inFlightUploadRPCs - 1);
        this.freezeIdleSnapshotAfterSettlement(accountId, wasIdle);
        this.notify();
      },
    };
  }

  private freezeIdleSnapshotAfterSettlement(accountId: number, wasIdle: boolean): void {
    if (wasIdle || !this.isTrulyIdle(accountId) || !this.speed.hasRecentAccountEffectiveBytes(accountId)) return;

    const createdAt = this.clock();
    this.stateFor(accountId).idleSnapshot = {
      bytesPerSecond: this.speed.accountEffectiveBytesPerSecond(accountId),
      createdAt,
      expiresAt: createdAt + FAILOVER_IDLE_SNAPSHOT_TTL_MS,
    };
  }

  private notify(): void {
    if (this.notificationQueued) return;
    this.notificationQueued = true;
    queueMicrotask(() => {
      this.notificationQueued = false;
      for (const listener of this.listeners) listener();
    });
  }
}

export const accountActivityRegistry = new AccountActivityRegistry(uploadSpeedTracker);
