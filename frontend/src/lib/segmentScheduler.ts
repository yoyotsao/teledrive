import { FAILOVER_ATTEMPT_MIN_AGE_MS, FAILOVER_SCORE_THRESHOLD, MAX_CONCURRENT_FILES } from '../config';
import type { AccountActivityRegistry, ActivityLease, IdleSpeedSnapshot } from './accountActivityRegistry';
import type { Clock, UploadSpeedTracker } from './uploadSpeedTracker';
import type { AttemptLease, PremiumFloodNotice, SegmentAttemptRunner, SegmentFileJobInput, SegmentMigrationEvent, SegmentResult, SegmentState } from './segmentUploadTypes';

export type SchedulerDiagnostic =
  | { type: 'premium-flood'; accountId: number; accountName: string; taskId: string; fileJobId: string; segmentIndex: number; attemptId: number; waitSeconds: number; penaltyUntil: number; pacerMode: 'normal' | 'frozen' | 'cautious'; scheduledRate: number; bLiveSpeed: number; logicalUploadedBytes: number; remainingRatio: number; accountAcceptedParts: number; accountAcceptedBytes: number; taskAcceptedParts: number; taskAcceptedBytes: number }
  | { type: 'migration'; taskId: string; segmentIndex: number; oldAttemptId: number; newAttemptId: number; fromAccountId: number; toAccountId: number; aSnapshotSpeed: number; snapshotAge: number; bLiveSpeed: number; remainingRatio: number; failoverScore: number; abandonedLogicalBytes: number; migrationCount: 1 };

export interface SegmentSchedulerOptions {
  activity: AccountActivityRegistry;
  speed: UploadSpeedTracker;
  clock?: Clock;
  maxJobsPerAccount?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  onDiagnostic?: (event: SchedulerDiagnostic) => void;
}

type CompletedSegment = SegmentResult & { hasThumbnail: boolean };
interface SegmentTask {
  taskId: string; fileJobId: string; segment: SegmentFileJobInput['segments'][number]; state: SegmentState;
  attemptId: number; attemptStartedAt: number | null; latestPremiumFloodAt: number | null; migrationCount: number;
  currentAccountId: number | null; attemptedAccountIds: Set<number>; attemptInFlightRpcs: Map<number, number>;
  attemptRpcLeases: Map<number, ActivityLease[]>; completedPartIndexes: Set<number>; logicalUploadedBytes: number;
  controller: AbortController; jobLease: ActivityLease | null; drainingAttemptId: number | null;
  migrationTargetAccountId: number | null; result: CompletedSegment | null; error: unknown; cleaned: boolean;
}
interface FileJob {
  input: SegmentFileJobInput; tasks: SegmentTask[];
  resolve: (result: { parts: CompletedSegment[]; hasThumbnail: boolean }) => void;
  reject: (reason: unknown) => void; settled: boolean;
}

function sameLease(task: SegmentTask, lease: AttemptLease): boolean {
  return task.taskId === lease.taskId && task.attemptId === lease.attemptId && task.currentAccountId === lease.accountId;
}
function isTerminal(task: SegmentTask): boolean { return task.state === 'completed' || task.state === 'failed'; }

export class SegmentScheduler {
  private readonly jobs = new Map<string, FileJob>();
  private runnerCursor = 0;
  private readonly maxJobsPerAccount: number;
  private readonly clock: Clock;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private deadlineAt: number | null = null;

  constructor(private readonly options: SegmentSchedulerOptions) {
    this.maxJobsPerAccount = options.maxJobsPerAccount ?? MAX_CONCURRENT_FILES;
    this.clock = options.clock ?? Date.now;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    options.activity.subscribe(() => this.reevaluate());
  }

  enqueueFile(input: SegmentFileJobInput): Promise<{ parts: CompletedSegment[]; hasThumbnail: boolean }> {
    if (this.jobs.has(input.fileJobId)) return Promise.reject(new Error(`Segment file job already exists: ${input.fileJobId}`));
    if (input.runners.length === 0) return Promise.reject(new Error('沒有可用的 Telegram 帳號（全部離線）'));
    return new Promise((resolve, reject) => {
      const job: FileJob = {
        input,
        tasks: input.segments.map((segment) => ({
          taskId: `${input.fileJobId}:${segment.index}`, fileJobId: input.fileJobId, segment, state: 'pending',
          attemptId: 1, attemptStartedAt: null, latestPremiumFloodAt: null, migrationCount: 0, currentAccountId: null,
          attemptedAccountIds: new Set(), attemptInFlightRpcs: new Map(), attemptRpcLeases: new Map(),
          completedPartIndexes: new Set(), logicalUploadedBytes: 0, controller: new AbortController(), jobLease: null,
          drainingAttemptId: null, migrationTargetAccountId: null, result: null, error: null, cleaned: false,
        })), resolve, reject, settled: false,
      };
      this.jobs.set(input.fileJobId, job);
      this.reevaluate();
      this.settleFileJob(job);
    });
  }

  reevaluate(): void {
    // Migration wins over ordinary dispatch. A synchronous commit makes each
    // following account observe the reservation/lease transition immediately.
    for (const accountId of this.idleRunnerAccounts()) {
      const candidate = this.bestCandidateFor(accountId);
      if (candidate) this.commitMigration(accountId, candidate.taskId);
    }
    for (const job of this.jobs.values()) {
      if (job.settled) continue;
      for (const task of job.tasks) if (task.state === 'pending') this.dispatch(job, task);
      this.settleFileJob(job);
    }
    this.rescheduleDeadline();
  }

  private idleRunnerAccounts(): number[] {
    const accounts = new Set<number>();
    for (const job of this.jobs.values()) for (const runner of job.input.runners) {
      if (this.options.activity.isTrulyIdle(runner.accountId) && this.options.activity.validIdleSnapshot(runner.accountId)) accounts.add(runner.accountId);
    }
    return [...accounts];
  }

  private bestCandidateFor(accountId: number): SegmentTask | null {
    const snapshot = this.options.activity.validIdleSnapshot(accountId);
    if (!snapshot) return null;
    let best: SegmentTask | null = null;
    let bestScore = FAILOVER_SCORE_THRESHOLD;
    for (const job of this.jobs.values()) {
      if (job.settled || job.input.migrationEnabled === false) continue;
      // An idle account may appear in another file job, but it may only take
      // over work whose own runner set can actually execute the new attempt.
      if (!job.input.runners.some((runner) => runner.accountId === accountId)) continue;
      for (const task of job.tasks) {
        if (!this.isCandidate(task, this.clock()) || task.attemptedAccountIds.has(accountId)) continue;
        const score = this.failoverScore(task, snapshot);
        if (score > bestScore) { best = task; bestScore = score; }
      }
    }
    return best;
  }

  private dispatch(job: FileJob, task: SegmentTask): void {
    const { runners } = job.input;
    const start = this.runnerCursor++ % runners.length;
    for (let offset = 0; offset < runners.length; offset++) {
      const runner = runners[(start + offset) % runners.length];
      const jobLease = this.options.activity.tryBeginByteUploadJob(runner.accountId, this.maxJobsPerAccount);
      if (!jobLease) continue;
      const lease = { taskId: task.taskId, attemptId: task.attemptId, accountId: runner.accountId };
      task.currentAccountId = runner.accountId;
      task.attemptedAccountIds.add(runner.accountId);
      task.jobLease = jobLease;
      task.state = 'active';
      task.attemptStartedAt = this.clock();
      task.controller = new AbortController();
      this.runAttempt(job, task, runner, lease);
      return;
    }
  }

  private runAttempt(job: FileJob, task: SegmentTask, runner: SegmentAttemptRunner, lease: AttemptLease): void {
    const hooks = {
      signal: task.controller.signal,
      onRpcStart: (): boolean => this.onRpcStart(task, lease),
      onRpcSettled: (): void => this.onRpcSettled(task, lease),
      onPartAccepted: (partIndex: number, bytes: number): void => this.onPartAccepted(job, task, lease, partIndex, bytes),
      onPremiumFlood: (event: PremiumFloodNotice): void => this.onPremiumFlood(task, runner, lease, event),
      grantFinalize: (): boolean => this.grantFinalize(lease),
    };
    Promise.resolve().then(() => runner.run({ lease, file: job.input.file, segment: task.segment, thumb: task.segment.index === 0 ? job.input.thumb : undefined, hooks })).then(
      (result) => this.completeAttempt(job, task, lease, result),
      (error: unknown) => this.failAttempt(job, task, lease, error),
    );
  }

  private onRpcStart(task: SegmentTask, lease: AttemptLease): boolean {
    if (!sameLease(task, lease) || task.state !== 'active') return false;
    const rpcLease = this.options.activity.beginUploadRpc(lease.accountId);
    task.attemptInFlightRpcs.set(lease.attemptId, (task.attemptInFlightRpcs.get(lease.attemptId) ?? 0) + 1);
    const leases = task.attemptRpcLeases.get(lease.attemptId) ?? [];
    leases.push(rpcLease);
    task.attemptRpcLeases.set(lease.attemptId, leases);
    return true;
  }

  private onRpcSettled(task: SegmentTask, lease: AttemptLease): void {
    const rpcLease = task.attemptRpcLeases.get(lease.attemptId)?.pop();
    if (!rpcLease) return;
    rpcLease.release();
    const remaining = Math.max(0, (task.attemptInFlightRpcs.get(lease.attemptId) ?? 1) - 1);
    task.attemptInFlightRpcs.set(lease.attemptId, remaining);
    if (task.drainingAttemptId === lease.attemptId && remaining === 0) this.activateMigratedAttempt(task);
    this.rescheduleDeadline();
  }

  private onPartAccepted(job: FileJob, task: SegmentTask, lease: AttemptLease, partIndex: number, bytes: number): void {
    // Physical success survives a revoked lease; logical progress never does.
    this.options.speed.recordPhysicalSuccess({ accountId: lease.accountId, taskId: task.cleaned ? null : lease.taskId, attemptId: lease.attemptId, bytes });
    if (!sameLease(task, lease) || task.state !== 'active' || task.completedPartIndexes.has(partIndex)) return;
    task.completedPartIndexes.add(partIndex);
    task.logicalUploadedBytes += bytes;
    this.options.speed.recordEffectivePart({ ...lease, partIndex, bytes });
    job.input.onProgress?.({ logicalFileBytes: job.tasks.reduce((sum, candidate) => sum + candidate.logicalUploadedBytes, 0), totalFileBytes: job.input.file.size });
    this.reevaluate();
  }

  private onPremiumFlood(task: SegmentTask, runner: SegmentAttemptRunner, lease: AttemptLease, event: PremiumFloodNotice): void {
    if (!sameLease(task, lease) || task.state !== 'active') return;
    const accountAccepted = this.options.speed.accountPhysicalSincePreviousPremiumFlood(lease.accountId);
    const taskAccepted = this.options.speed.taskPhysicalSincePreviousPremiumFlood(task.taskId);
    this.emitDiagnostic({
      type: 'premium-flood', accountId: lease.accountId, accountName: runner.accountName, taskId: task.taskId,
      fileJobId: task.fileJobId, segmentIndex: task.segment.index, attemptId: task.attemptId,
      waitSeconds: event.waitSeconds, penaltyUntil: event.penaltyUntil, pacerMode: event.pacerMode, scheduledRate: event.scheduledRate,
      bLiveSpeed: this.options.speed.attemptEffectiveBytesPerSecond(lease), logicalUploadedBytes: task.logicalUploadedBytes,
      remainingRatio: this.remainingRatio(task), accountAcceptedParts: accountAccepted.parts, accountAcceptedBytes: accountAccepted.bytes,
      taskAcceptedParts: taskAccepted.parts, taskAcceptedBytes: taskAccepted.bytes,
    });
    this.options.speed.markPremiumFloodCycle(lease.accountId, task.taskId);
    task.latestPremiumFloodAt = this.clock();
    this.reevaluate();
  }

  private isCandidate(task: SegmentTask, now: number): boolean {
    return task.state === 'active' && task.attemptStartedAt !== null
      && now - task.attemptStartedAt >= FAILOVER_ATTEMPT_MIN_AGE_MS
      && task.latestPremiumFloodAt !== null && now - task.latestPremiumFloodAt <= FAILOVER_ATTEMPT_MIN_AGE_MS
      && task.migrationCount === 0 && task.logicalUploadedBytes < task.segment.size;
  }

  private failoverScore(task: SegmentTask, snapshot: IdleSpeedSnapshot): number {
    if (task.currentAccountId === null) return 0;
    const liveSpeed = this.options.speed.attemptEffectiveBytesPerSecond({ taskId: task.taskId, attemptId: task.attemptId, accountId: task.currentAccountId });
    return liveSpeed === 0 ? Infinity : (snapshot.bytesPerSecond / liveSpeed) * this.remainingRatio(task);
  }

  private remainingRatio(task: SegmentTask): number { return Math.max(0, (task.segment.size - task.logicalUploadedBytes) / task.segment.size); }

  private commitMigration(accountId: number, taskId: string): boolean {
    const found = this.taskFor(taskId);
    if (!found) return false;
    const { job, task } = found;
    const now = this.clock();
    const snapshot = this.options.activity.validIdleSnapshot(accountId);
    if (!snapshot || task.attemptedAccountIds.has(accountId) || !this.isCandidate(task, now)
      || !job.input.runners.some((runner) => runner.accountId === accountId)) return false;
    const score = this.failoverScore(task, snapshot);
    if (!(score > FAILOVER_SCORE_THRESHOLD) || !this.options.activity.tryReserve(accountId, task.taskId)) return false;
    const oldAttemptId = task.attemptId;
    const oldAccountId = task.currentAccountId!;
    const oldController = task.controller;
    const abandonedLogicalBytes = task.logicalUploadedBytes;
    const oldLiveSpeed = this.options.speed.attemptEffectiveBytesPerSecond({ taskId: task.taskId, attemptId: oldAttemptId, accountId: oldAccountId });

    // Do not abort until every observable ownership field is a new generation.
    task.state = 'migrating';
    task.drainingAttemptId = oldAttemptId;
    task.attemptId++;
    task.currentAccountId = null;
    task.attemptStartedAt = null;
    task.latestPremiumFloodAt = null;
    task.logicalUploadedBytes = 0;
    task.completedPartIndexes.clear();
    task.migrationCount = 1;
    task.migrationTargetAccountId = accountId;
    task.attemptedAccountIds.add(accountId);
    task.jobLease?.release();
    task.jobLease = null;
    oldController.abort();
    this.emitMigration(job, { fileJobId: task.fileJobId, taskId: task.taskId, segmentIndex: task.segment.index, abandonedLogicalBytes,
      logicalFileBytes: job.tasks.reduce((sum, candidate) => sum + candidate.logicalUploadedBytes, 0), totalFileBytes: job.input.file.size,
      message: '重新分派上傳帳號，該區段將從頭重傳' });
    this.emitDiagnostic({ type: 'migration', taskId: task.taskId, segmentIndex: task.segment.index, oldAttemptId,
      newAttemptId: task.attemptId, fromAccountId: oldAccountId, toAccountId: accountId, aSnapshotSpeed: snapshot.bytesPerSecond,
      snapshotAge: now - snapshot.createdAt, bLiveSpeed: oldLiveSpeed,
      remainingRatio: Math.max(0, (task.segment.size - abandonedLogicalBytes) / task.segment.size), failoverScore: score,
      abandonedLogicalBytes, migrationCount: 1 });
    if ((task.attemptInFlightRpcs.get(oldAttemptId) ?? 0) === 0) this.activateMigratedAttempt(task);
    this.rescheduleDeadline();
    return true;
  }

  private activateMigratedAttempt(task: SegmentTask): void {
    const targetAccountId = task.migrationTargetAccountId;
    if (targetAccountId === null || task.drainingAttemptId === null || task.state !== 'migrating') return;
    const drainingAttemptId = task.drainingAttemptId;
    const job = this.jobs.get(task.fileJobId);
    if (!job) return;
    const runner = job.input.runners.find((candidate) => candidate.accountId === targetAccountId);
    const jobLease = this.options.activity.activateReservation(targetAccountId, task.taskId, this.maxJobsPerAccount);
    if (!jobLease || !runner) {
      this.options.activity.releaseReservation(targetAccountId, task.taskId);
      this.options.speed.clearAttempt(task.taskId, drainingAttemptId);
      task.drainingAttemptId = null;
      this.failTask(job, task, new Error('接手帳號無法開始上傳'));
      return;
    }
    this.options.speed.clearAttempt(task.taskId, drainingAttemptId);
    task.drainingAttemptId = null;
    task.migrationTargetAccountId = null;
    task.currentAccountId = targetAccountId;
    task.jobLease = jobLease;
    task.state = 'active';
    task.attemptStartedAt = this.clock();
    task.controller = new AbortController();
    this.runAttempt(job, task, runner, { taskId: task.taskId, attemptId: task.attemptId, accountId: targetAccountId });
    this.rescheduleDeadline();
  }

  private grantFinalize(lease: AttemptLease): boolean {
    const found = this.taskFor(lease.taskId);
    if (!found || !sameLease(found.task, lease) || found.task.state !== 'active') return false;
    found.task.state = 'finalizing';
    this.rescheduleDeadline();
    return true;
  }

  private completeAttempt(job: FileJob, task: SegmentTask, lease: AttemptLease, result: CompletedSegment): void {
    if (!sameLease(task, lease) || task.state !== 'finalizing') return;
    task.result = result;
    task.state = 'completed';
    this.cleanupTask(task);
    this.settleFileJob(job);
    this.reevaluate();
  }
  private failAttempt(job: FileJob, task: SegmentTask, lease: AttemptLease, error: unknown): void {
    if (!sameLease(task, lease) || (task.state !== 'active' && task.state !== 'finalizing')) return;
    this.failTask(job, task, error);
  }
  private failTask(job: FileJob, task: SegmentTask, error: unknown): void {
    if (isTerminal(task)) return;
    task.error = error;
    task.state = 'failed';
    this.cleanupTask(task);
    this.settleFileJob(job);
    this.reevaluate();
  }
  private cleanupTask(task: SegmentTask): void {
    if (task.cleaned) return;
    task.cleaned = true;
    if (task.migrationTargetAccountId !== null) this.options.activity.releaseReservation(task.migrationTargetAccountId, task.taskId);
    task.migrationTargetAccountId = null;
    task.controller.abort();
    task.jobLease?.release();
    task.jobLease = null;
    this.options.speed.clearAttempt(task.taskId, task.attemptId);
    this.options.speed.clearTask(task.taskId);
    task.currentAccountId = null;
    task.attemptStartedAt = null;
    task.latestPremiumFloodAt = null;
    this.rescheduleDeadline();
  }

  private taskFor(taskId: string): { job: FileJob; task: SegmentTask } | null {
    for (const job of this.jobs.values()) {
      const task = job.tasks.find((candidate) => candidate.taskId === taskId);
      if (task) return { job, task };
    }
    return null;
  }
  private emitDiagnostic(event: SchedulerDiagnostic): void {
    try { this.options.onDiagnostic?.(event); } catch { /* observers cannot interrupt a committed transition */ }
  }
  private emitMigration(job: FileJob, event: SegmentMigrationEvent): void {
    try { job.input.onMigration?.(event); } catch { /* observers cannot interrupt a committed transition */ }
  }
  private rescheduleDeadline(): void {
    const now = this.clock();
    let nearest: number | null = null;
    const consider = (deadline: number | null): void => { if (deadline !== null && deadline > now && (nearest === null || deadline < nearest)) nearest = deadline; };
    for (const job of this.jobs.values()) {
      for (const runner of job.input.runners) consider(this.options.activity.validIdleSnapshot(runner.accountId)?.expiresAt ?? null);
      for (const task of job.tasks) {
        if (task.state !== 'active' || task.attemptStartedAt === null || task.currentAccountId === null) continue;
        consider(task.attemptStartedAt + FAILOVER_ATTEMPT_MIN_AGE_MS);
        if (task.latestPremiumFloodAt !== null) consider(task.latestPremiumFloodAt + FAILOVER_ATTEMPT_MIN_AGE_MS + 1);
        consider(this.options.speed.nextAttemptEffectiveExpiry({ taskId: task.taskId, attemptId: task.attemptId, accountId: task.currentAccountId }));
      }
    }
    if (nearest === this.deadlineAt) return;
    if (this.deadlineTimer !== null) this.clearTimer(this.deadlineTimer);
    this.deadlineAt = nearest;
    this.deadlineTimer = nearest === null ? null : this.setTimer(() => { this.deadlineTimer = null; this.deadlineAt = null; this.reevaluate(); }, Math.max(0, nearest - now));
  }
  private settleFileJob(job: FileJob): void {
    if (job.settled || job.tasks.some((task) => !isTerminal(task))) return;
    job.settled = true;
    this.jobs.delete(job.input.fileJobId);
    this.rescheduleDeadline();
    const failedTask = job.tasks.find((task) => task.state === 'failed');
    if (failedTask) { job.reject(failedTask.error); return; }
    const parts = job.tasks.map((task) => task.result!).sort((a, b) => a.index - b.index);
    job.resolve({ parts, hasThumbnail: parts.some((part) => part.index === 0 && part.hasThumbnail) });
  }
}
