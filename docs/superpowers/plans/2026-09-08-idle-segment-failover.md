# TeleDrive Idle Segment Failover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add browser-side work stealing that lets a truly idle Telegram account restart one large-file segment stalled by `FLOOD_PREMIUM_WAIT`, while preserving single-owner finalize safety, accurate progress, and existing metadata registration.

**Architecture:** A process-wide `SegmentScheduler` owns every large-segment state transition and delegates one lease-bound attempt at a time to GramJS. A separate account activity registry supplies atomic idle/reservation bookkeeping, while a rolling speed tracker keeps effective and physical bytes distinct. GramJS remains the byte executor; React only consumes progress and migration events, and Python remains metadata-only.

**Tech Stack:** TypeScript 5, React 18, GramJS 2.26.x, Vitest 4 with fake timers, Playwright MCP.

**Spec:** `docs/superpowers/specs/2026-09-07-idle-segment-failover-design.md`

## Global Constraints

- File bytes travel only between the browser and Telegram CDN; no binary request may be added to Python port 8000.
- Python, SQLite schema, and metadata API behavior remain unchanged.
- Only large `SaveBigFilePart` segment attempts can become migration candidates in v1.
- Eligibility is: active for at least 30 seconds, a `FLOOD_PREMIUM_WAIT` in the latest 30 seconds, incomplete, and `migrationCount === 0`.
- Replacement A must satisfy `activeByteUploadJobs === 0`, `inFlightUploadRPCs === 0`, `reservedTaskId === null`, and have an unexpired five-minute effective-speed snapshot.
- Score is `(A_snapshot_speed / B_live_speed) * remainingRatio`; migration requires strict `score > 2`.
- Each segment may migrate at most once and may never return to an account in `attemptedAccountIds`.
- `commitMigration()` and `grantFinalize()` are synchronous competing state transitions with no `await` inside either operation.
- Migration revokes B immediately, drains only B's revoked attempt RPCs, reserves A without incrementing active jobs, then starts A with a new `fileId` at part 0.
- Premium flood freezes ramp without lowering rate; the 60-second clean window starts on the first actual post-wait send, then cautious ramp is at most 0.1 parts/s per 30 seconds.
- `frozen` and `cautious` are page-session state and must not be persisted.
- Scheduler tasks, leases, reservations, and migration generations are page-session state and must not be restored after refresh.
- UI progress may decrease only on a scheduler migration generation change; physical confirmed bytes never decrease.
- Frontend environment switches must use the `VITE_` prefix.
- Browser verification is automated through Playwright MCP; do not use manual browser testing.

---

## File Structure

### New files

- `frontend/src/lib/uploadSpeedTracker.ts` — fixed-window effective/physical samples, deduplication, snapshot inputs, and flood-cycle counters.
- `frontend/src/lib/uploadSpeedTracker.test.ts` — deterministic 30-second window, snapshot, and physical/effective separation tests.
- `frontend/src/lib/accountActivityRegistry.ts` — account-global byte-job, RPC, reservation, readiness, idle transition, and snapshot state.
- `frontend/src/lib/accountActivityRegistry.test.ts` — idle definition and exact counter lifecycle tests.
- `frontend/src/lib/accountPool.test.ts` — reservation-versus-slot race and byte-job wrapper tests.
- `frontend/src/lib/segmentUploadTypes.ts` — shared lease, executor, result, progress, migration, and runner contracts that do not import GramJS.
- `frontend/src/lib/segmentScheduler.ts` — central task state machine, dispatch, scoring, lease validation, migration, drain, finalize CAS, and cleanup.
- `frontend/src/lib/segmentScheduler.test.ts` — scheduler state, scoring, race, drain, cleanup, and single-/three-account tests.
- `frontend/src/lib/splitUpload.test.ts` — large-file scheduler integration, result ordering, and pinned behavior.
- `frontend/src/testing/failoverHarness.ts` — Vite-gated fake executor scenario used only by isolated browser verification.
- `frontend/tests/isolated/upload-failover.spec.ts` — Upload Center rollback/message and late-B browser assertions.

### Modified files

- `frontend/src/config.ts` — named failover and premium-recovery constants.
- `frontend/src/lib/adaptiveRateLimiter.ts` — session-only `normal | frozen | cautious` state and abortable waits.
- `frontend/src/lib/adaptiveRateLimiter.test.ts` — frozen/clean/cautious behavior.
- `frontend/src/lib/accountPool.ts` — atomically coordinate file slots with account byte-job bookkeeping.
- `frontend/src/lib/gramjs.ts` — lease-aware segment executor and transport event reporting for all upload RPCs.
- `frontend/src/lib/gramjsLogging.test.ts` — adapt the segment log test to the executor contract.
- `frontend/src/lib/gramjsStatistics.test.ts` — verify stale explicit successes remain physical traffic only.
- `frontend/src/lib/splitUpload.ts` — submit large segments to the shared scheduler instead of eager account binding.
- `frontend/src/lib/uploadQueue.ts` — one explicit migration rollback action and per-item status message.
- `frontend/src/lib/uploadQueue.test.ts` — controlled regression and ordinary monotonic progress tests.
- `frontend/src/components/UploadCenter.tsx` — display the migration message without changing row height.
- `frontend/src/hooks/useUploadQueue.ts` — install the gated Playwright bridge.
- `frontend/src/components/ChonkyDrive.tsx` — translate scheduler migration progress into the queue action.
- `frontend/src/vite-env.d.ts` — type `VITE_E2E_TEST_HOOKS` and the gated window bridge.
- `frontend/playwright.config.ts` — enable the bridge only for the isolated Playwright server.

### Intentionally unchanged

- `backend/**` — no backend route, model, service, or schema participates in byte transfer or migration.

---

### Task 1: Rolling Effective and Physical Speed Tracker

**Files:**
- Create: `frontend/src/lib/uploadSpeedTracker.ts`
- Create: `frontend/src/lib/uploadSpeedTracker.test.ts`
- Modify: `frontend/src/config.ts`

**Interfaces:**
- Consumes: millisecond timestamps supplied by an injected `Clock = () => number`.
- Produces: `UploadSpeedTracker`, process-wide `uploadSpeedTracker`, `AttemptSampleKey`, `EffectivePartEvent`, `PhysicalSuccessEvent`, and failover timing constants.

- [ ] **Step 1: Add exact configuration constants**

Append these exports to `frontend/src/config.ts`:

```ts
export const FAILOVER_SPEED_WINDOW_MS = 30_000;
export const FAILOVER_ATTEMPT_MIN_AGE_MS = 30_000;
export const FAILOVER_IDLE_SNAPSHOT_TTL_MS = 5 * 60_000;
export const FAILOVER_SCORE_THRESHOLD = 2;
export const PREMIUM_FLOOD_CLEAN_WINDOW_MS = 60_000;
export const PREMIUM_FLOOD_CAUTIOUS_INTERVAL_MS = 30_000;
export const PREMIUM_FLOOD_CAUTIOUS_STEP = 0.1;
```

- [ ] **Step 2: Write failing fixed-window and deduplication tests**

Create tests using an injected numeric clock and cover these exact assertions:

```ts
const MiB = 1024 * 1024;
let now = 30_000;
const tracker = new UploadSpeedTracker(() => now, 30_000);
const key = { taskId: 'file:2', attemptId: 1, accountId: 20 };

expect(tracker.recordEffectivePart({ ...key, partIndex: 0, bytes: 15 * MiB })).toBe(true);
expect(tracker.recordEffectivePart({ ...key, partIndex: 0, bytes: 15 * MiB })).toBe(false);
expect(tracker.attemptEffectiveBytesPerSecond(key)).toBeCloseTo(0.5 * MiB);

tracker.recordPhysicalSuccess({ accountId: 10, taskId: 'revoked', attemptId: 1, bytes: 30 * MiB });
expect(tracker.accountPhysicalBytesPerSecond(10)).toBeCloseTo(1 * MiB);
expect(tracker.accountEffectiveBytesPerSecond(10)).toBe(0);
```

Also advance `now` past 60,000 ms and prove old buckets leave the latest 30-second window.
Record two physical successes, assert both appear in the account/task flood-cycle counters, call `markPremiumFloodCycle()`, record one more success, and assert the next cycle reports only that last success.
Assert `nextAttemptEffectiveExpiry(key)` returns the oldest live bucket's exact expiry and advances to the next bucket after pruning. After `clearAttempt()`, assert attempt speed and dedupe state are removed while account-wide effective speed and physical counters remain intact.

- [ ] **Step 3: Run the new test and confirm the missing-module failure**

Run: `cd frontend && npm run test:unit -- src/lib/uploadSpeedTracker.test.ts`

Expected: FAIL because `./uploadSpeedTracker` does not exist.

- [ ] **Step 4: Implement bucketed tracking with separate counters**

Implement this public surface:

```ts
export type Clock = () => number;
export interface AttemptSampleKey { taskId: string; attemptId: number; accountId: number }
export interface EffectivePartEvent extends AttemptSampleKey { partIndex: number; bytes: number }
export interface PhysicalSuccessEvent {
  accountId: number;
  taskId: string | null;
  attemptId: number | null;
  bytes: number;
}

export class UploadSpeedTracker {
  constructor(clock: Clock = Date.now, windowMs = FAILOVER_SPEED_WINDOW_MS);
  recordEffectivePart(event: EffectivePartEvent): boolean;
  recordAccountEffectiveUnit(accountId: number, workId: string, unitId: string, bytes: number): boolean;
  recordPhysicalSuccess(event: PhysicalSuccessEvent): void;
  attemptEffectiveBytesPerSecond(key: AttemptSampleKey): number;
  accountEffectiveBytesPerSecond(accountId: number): number;
  accountPhysicalBytesPerSecond(accountId: number): number;
  nextAttemptEffectiveExpiry(key: AttemptSampleKey): number | null;
  hasRecentAccountEffectiveBytes(accountId: number): boolean;
  accountPhysicalSincePreviousPremiumFlood(accountId: number): { parts: number; bytes: number };
  taskPhysicalSincePreviousPremiumFlood(taskId: string): { parts: number; bytes: number };
  markPremiumFloodCycle(accountId: number, taskId: string): void;
  clearAttempt(taskId: string, attemptId: number): void;
}

export const uploadSpeedTracker = new UploadSpeedTracker();
```

Use timestamped byte buckets with a fixed `windowMs` denominator. Deduplicate effective units by `(workId, unitId)` and segment parts by `(taskId, attemptId, partIndex)`. Never deduplicate physical successes, because each explicit Telegram success is real transmitted traffic. `nextAttemptEffectiveExpiry()` returns the earliest current-attempt bucket timestamp plus `windowMs`, allowing one scheduler timer to observe speed decay without polling. `clearAttempt()` removes only that attempt's effective buckets and dedupe keys; it must not erase account-wide effective history or any physical/flood-cycle totals.

- [ ] **Step 5: Run tracker tests**

Run: `cd frontend && npm run test:unit -- src/lib/uploadSpeedTracker.test.ts`

Expected: PASS with fixed-denominator, expiry, dedupe, and physical/effective tests green.

- [ ] **Step 6: Commit the tracker slice**

```bash
git add frontend/src/config.ts frontend/src/lib/uploadSpeedTracker.ts frontend/src/lib/uploadSpeedTracker.test.ts
git commit -m "feat(upload): track effective segment speed"
```

### Task 2: Account Activity, Reservation, and Idle Snapshots

**Files:**
- Create: `frontend/src/lib/accountActivityRegistry.ts`
- Create: `frontend/src/lib/accountActivityRegistry.test.ts`
- Modify: `frontend/src/lib/accountPool.ts`
- Create: `frontend/src/lib/accountPool.test.ts`

**Interfaces:**
- Consumes: `UploadSpeedTracker`, `FAILOVER_IDLE_SNAPSHOT_TTL_MS`, and account readiness changes.
- Produces: `AccountActivityRegistry`, `AccountRuntime`, `IdleSpeedSnapshot`, idempotent `ActivityLease`, and `accountActivityRegistry` singleton.

- [ ] **Step 1: Write failing idle and lifecycle tests**

Pin the three independent gates and reservation transition:

```ts
const MiB = 1024 * 1024;
let now = 30_000;
const tracker = new UploadSpeedTracker(() => now, 30_000);
const registry = new AccountActivityRegistry(tracker, () => now);
registry.setAvailability(10, { online: true, ready: true });

const job = registry.tryBeginByteUploadJob(10, 3);
expect(job).not.toBeNull();
expect(registry.isTrulyIdle(10)).toBe(false);
tracker.recordAccountEffectiveUnit(10, 'completed-work', 'part-0', 15 * MiB);

const rpc = registry.beginUploadRpc(10);
job!.release();
expect(registry.isTrulyIdle(10)).toBe(false);
rpc.release();
expect(registry.isTrulyIdle(10)).toBe(true);

expect(registry.tryReserve(10, 'task-1')).toBe(true);
expect(registry.runtime(10).activeByteUploadJobs).toBe(0);
const migratedJob = registry.activateReservation(10, 'task-1', 3);
expect(migratedJob).not.toBeNull();
expect(registry.runtime(10)).toMatchObject({ reservedTaskId: null, activeByteUploadJobs: 1 });
migratedJob!.release();
migratedJob!.release();
expect(registry.runtime(10).activeByteUploadJobs).toBe(0);
```

Add tests proving: no effective sample creates no snapshot; retry/revoked physical bytes do not raise a snapshot; a snapshot expires after five minutes; beginning any job invalidates it immediately; `inFlightUploadRPCs` never becomes negative.

- [ ] **Step 2: Run the registry test and confirm failure**

Run: `cd frontend && npm run test:unit -- src/lib/accountActivityRegistry.test.ts`

Expected: FAIL because the registry module is missing.

- [ ] **Step 3: Implement synchronous account state operations**

Use this exact shape:

```ts
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

export interface ActivityLease { release(): void }

export class AccountActivityRegistry {
  constructor(speed: UploadSpeedTracker, clock?: Clock);
  setAvailability(accountId: number, state: { online: boolean; ready: boolean }): void;
  tryBeginByteUploadJob(accountId: number, maxJobs: number): ActivityLease | null;
  beginUploadRpc(accountId: number): ActivityLease;
  tryReserve(accountId: number, taskId: string): boolean;
  activateReservation(accountId: number, taskId: string, maxJobs: number): ActivityLease | null;
  releaseReservation(accountId: number, taskId: string): void;
  isTrulyIdle(accountId: number): boolean;
  validIdleSnapshot(accountId: number): IdleSpeedSnapshot | null;
  runtime(accountId: number): Readonly<AccountRuntime>;
  subscribe(listener: () => void): () => void;
}

export const accountActivityRegistry = new AccountActivityRegistry(uploadSpeedTracker);
```

Every public mutation is synchronous. Detect `non-idle -> truly idle` after a job release or RPC settle and freeze `speed.accountEffectiveBytesPerSecond(accountId)` only when recent effective bytes exist. `tryReserve()` must require online, ready, true idle, and a valid snapshot. `tryBeginByteUploadJob()` also requires online, ready, no reservation, and capacity. `activateReservation()` validates the matching reservation and capacity, then clears `reservedTaskId` and increments the active-job counter exactly once; it deliberately does not require A to still be online, because a target that disconnects after the irreversible commit must enter its existing reconnect/retry path rather than restore B.

State reads must reflect each mutation immediately, but subscribed notifications must be coalesced into one `queueMicrotask()` instead of invoking listeners inline. This prevents a registry callback from reentering Scheduler selection between A reservation and completion of the task ownership transaction.

- [ ] **Step 4: Write failing account-slot race tests**

Refactor `accountPool.ts` around a testable factory, then prove a client reserved between selection and semaphore acquisition is revalidated and skipped. Also prove one successful wrapper call increments and releases `activeByteUploadJobs` exactly once, and a pinned account waits for its reservation to clear rather than switching accounts.

```ts
const pool = createAccountPool({
  clients: () => [clientA, clientB],
  activity: registry,
  maxConcurrentFiles: 1,
});
const result = await pool.withAccountSlot(async (client) => client.accountId);
expect(result).toBe(clientB.accountId);
expect(registry.runtime(clientB.accountId).activeByteUploadJobs).toBe(0);
```

- [ ] **Step 5: Implement byte-aware slot acquisition**

Export `createAccountPool()` for tests and retain the current production functions as wrappers around one module singleton. After a semaphore is acquired, synchronously call `tryBeginByteUploadJob(accountId, MAX_CONCURRENT_FILES)` before invoking the byte function. If a migration reservation won the race, release the semaphore and choose again. Release the activity lease and semaphore in `finally`.

`withSlotOn()` waits on `activity.subscribe()` until the pinned account becomes eligible; it must not switch accounts. Scheduler-owned large attempts do not use these wrappers, because their active-job transition is performed by `SegmentScheduler`.

- [ ] **Step 6: Run registry, pool, and tracker tests together**

Run: `cd frontend && npm run test:unit -- src/lib/accountActivityRegistry.test.ts src/lib/accountPool.test.ts src/lib/uploadSpeedTracker.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit account activity bookkeeping**

```bash
git add frontend/src/lib/accountActivityRegistry.ts frontend/src/lib/accountActivityRegistry.test.ts frontend/src/lib/accountPool.ts frontend/src/lib/accountPool.test.ts
git commit -m "feat(upload): define true account idle state"
```

### Task 3: Shared Attempt Contracts and Basic Scheduler

**Files:**
- Create: `frontend/src/lib/segmentUploadTypes.ts`
- Create: `frontend/src/lib/segmentScheduler.ts`
- Create: `frontend/src/lib/segmentScheduler.test.ts`
- Modify: `frontend/src/lib/gramjs.ts:150-160`

**Interfaces:**
- Consumes: `Segment`, `UploadSpeedTracker`, `AccountActivityRegistry`, and account runners.
- Produces: GramJS-free shared types and `SegmentScheduler.enqueueFile()` for normal pending-to-completed uploads.

- [ ] **Step 1: Move the result contract out of GramJS**

Define shared types without importing `telegram`:

```ts
export type SegmentResult = {
  index: number;
  message_id: number;
  file_id: string;
  access_hash?: string;
  size: number;
  account_id: number;
};

export type SegmentState = 'pending' | 'active' | 'migrating' | 'finalizing' | 'completed' | 'failed';
export interface AttemptLease { taskId: string; attemptId: number; accountId: number }
export interface SegmentMigrationEvent {
  fileJobId: string;
  taskId: string;
  segmentIndex: number;
  abandonedLogicalBytes: number;
  logicalFileBytes: number;
  totalFileBytes: number;
  message: '重新分派上傳帳號，該區段將從頭重傳';
}
export interface SegmentProgressEvent { logicalFileBytes: number; totalFileBytes: number }
export interface PremiumFloodNotice {
  waitSeconds: number;
  penaltyUntil: number;
  pacerMode: 'frozen';
  scheduledRate: number;
}

export interface SegmentAttemptHooks {
  signal: AbortSignal;
  onRpcStart(): boolean;
  onRpcSettled(): void;
  onPartAccepted(partIndex: number, bytes: number): void;
  onPremiumFlood(event: PremiumFloodNotice): void;
  grantFinalize(): boolean;
}

export interface SegmentAttemptInput {
  lease: AttemptLease;
  file: File;
  segment: Segment;
  thumb?: Blob | null;
  hooks: SegmentAttemptHooks;
}

export interface SegmentAttemptRunner {
  accountId: number;
  accountName: string;
  run(input: SegmentAttemptInput): Promise<SegmentResult & { hasThumbnail: boolean }>;
}

export interface SegmentFileJobInput {
  fileJobId: string;
  file: File;
  segments: Segment[];
  runners: SegmentAttemptRunner[];
  thumb?: Blob | null;
  migrationEnabled?: boolean;
  onProgress?: (event: SegmentProgressEvent) => void;
  onMigration?: (event: SegmentMigrationEvent) => void;
}
```

Import and re-export `SegmentResult` from `gramjs.ts` so existing consumers keep compiling.

- [ ] **Step 2: Write failing normal lifecycle tests**

Use a fake runner that calls `onRpcStart()`, `onPartAccepted()`, `onRpcSettled()`, asserts `grantFinalize() === true`, and returns a result. Verify:

```ts
const file = { size: 512, name: 'large.bin' } as File;
const runnerB: SegmentAttemptRunner = {
  accountId: 20,
  accountName: 'B',
  async run(input) {
    expect(input.hooks.onRpcStart()).toBe(true);
    input.hooks.onPartAccepted(0, 512);
    input.hooks.onRpcSettled();
    expect(input.hooks.grantFinalize()).toBe(true);
    return {
      index: input.segment.index, message_id: 200, file_id: 'file-b',
      size: input.segment.size, account_id: 20, hasThumbnail: false,
    };
  },
};
const progress: number[] = [];
const migrations: SegmentMigrationEvent[] = [];
const promise = scheduler.enqueueFile({
  fileJobId: 'file-1',
  file,
  segments: [{ index: 0, offset: 0, parts: 1, size: 512 }],
  runners: [runnerB],
  onProgress: (event) => progress.push(event.logicalFileBytes),
  onMigration: (event) => migrations.push(event),
});
await expect(promise).resolves.toMatchObject({ parts: [{ index: 0, account_id: 20 }] });
expect(progress).toEqual([512]);
expect(migrations).toEqual([]);
```

Add a two-segment test returning message IDs in reverse numerical order and assert results are sorted by `segment.index`.

- [ ] **Step 3: Run the scheduler test and confirm failure**

Run: `cd frontend && npm run test:unit -- src/lib/segmentScheduler.test.ts`

Expected: FAIL because `SegmentScheduler` is not implemented.

- [ ] **Step 4: Implement pending, active, finalize, completed, and failed states**

Expose this constructor and entry point:

```ts
export interface SegmentSchedulerOptions {
  activity: AccountActivityRegistry;
  speed: UploadSpeedTracker;
  clock?: Clock;
  maxJobsPerAccount?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

export class SegmentScheduler {
  constructor(options: SegmentSchedulerOptions);
  enqueueFile(input: SegmentFileJobInput): Promise<{
    parts: Array<SegmentResult & { hasThumbnail: boolean }>;
    hasThumbnail: boolean;
  }>;
  reevaluate(): void;
}
```

Create one `SegmentTask` per descriptor with `attemptId = 1`, `migrationCount = 0`, empty per-attempt RPC map, and initial account added to `attemptedAccountIds` when dispatched. Normal dispatch must synchronously obtain `activity.tryBeginByteUploadJob(accountId, maxJobsPerAccount)` before changing `pending -> active`; if it fails, leave the task pending and evaluate another account. Only the scheduler mutates task state. The runner may send the finalize RPC only after `hooks.grantFinalize()` synchronously changes `active -> finalizing`.

Validate the captured lease before handling either runner fulfillment or rejection. A stale runner fulfillment cannot write a result, and a stale runner rejection—including `AbortError` and `LeaseRevokedError` caused by migration—cannot fail the task or change state/progress. Only a current lease rejection may enter `failed`; only the same current lease in `finalizing` may accept a result. Keep the file job pending until every sibling task is terminal, then resolve ordered results when all completed or reject with the first preserved segment error when any failed.

- [ ] **Step 5: Run scheduler tests and TypeScript build**

Run: `cd frontend && npm run test:unit -- src/lib/segmentScheduler.test.ts && npm run build`

Expected: PASS; no node-side test imports GramJS.

- [ ] **Step 6: Commit the basic scheduler**

```bash
git add frontend/src/lib/segmentUploadTypes.ts frontend/src/lib/segmentScheduler.ts frontend/src/lib/segmentScheduler.test.ts frontend/src/lib/gramjs.ts
git commit -m "feat(upload): add central segment scheduler"
```

### Task 4: Migration Scoring, Lease Revoke, Per-Attempt Drain, and Cleanup

**Files:**
- Modify: `frontend/src/lib/segmentScheduler.ts`
- Modify: `frontend/src/lib/segmentScheduler.test.ts`

**Interfaces:**
- Consumes: Task 3 scheduler state and runner hooks.
- Produces: synchronous `commitMigration()`, synchronous `grantFinalize()`, lease-scoped drain, diagnostic sink, and terminal cleanup invariants.

- [ ] **Step 1: Add failing qualification and score tests**

Use fake time and add a `makeCandidateFixture()` test helper that creates an already-active B task, records the requested effective speed, records a recent premium flood when requested, and gives idle A the requested valid snapshot. Assert the threshold cases independently:

```ts
const atThreshold = makeCandidateFixture({
  attemptAgeMs: 30_001,
  premiumFloodInWindow: true,
  aSnapshotSpeed: 8,
  bLiveSpeed: 4,
  remainingRatio: 1,
});
expect(atThreshold.score).toBe(2);
atThreshold.scheduler.reevaluate();
expect(atThreshold.runnerA.calls).toHaveLength(0);

const aboveThreshold = makeCandidateFixture({
  attemptAgeMs: 30_001,
  premiumFloodInWindow: true,
  aSnapshotSpeed: 8,
  bLiveSpeed: 2,
  remainingRatio: 1,
});
expect(aboveThreshold.score).toBe(4);
aboveThreshold.scheduler.reevaluate();
expect(aboveThreshold.runnerA.calls).toHaveLength(1);
```

Add separate cases for: age 29,999 ms; no premium flood; ordinary flood; timeout; completed segment; expired A snapshot; A in `attemptedAccountIds`; `migrationCount === 1`; B speed zero before eligibility; B speed zero after eligibility producing `Infinity`. Add a fake-timer case where no new RPC arrives, an old B effective-byte bucket expires, score naturally crosses from below 2 to above 2, and the single scheduler deadline wakes to migrate immediately.

- [ ] **Step 2: Add failing atomic migration and race tests**

During `commitMigration(A, task)`, synchronously inspect state and require:

```ts
expect(activity.runtime(A).reservedTaskId).toBe(taskId);
expect(activity.runtime(A).activeByteUploadJobs).toBe(0);
expect(activity.runtime(A).idleSnapshot).toBeNull();
expect(task.state).toBe('migrating');
expect(task.attemptId).toBe(2);
expect(task.currentAccountId).toBeNull();
expect(task.logicalUploadedBytes).toBe(0);
expect(task.migrationCount).toBe(1);
expect(task.attemptedAccountIds.has(A)).toBe(true);
```

Install an abort listener that synchronously reads scheduler state. Assert it observes every expectation above, including the incremented generation and attempted-account membership; this proves executor notification cannot run against half-revoked ownership. Call migration from two idle accounts in the same turn and assert only one reserves the task. Call `grantFinalize(oldLease)` before and after migration in separate tests; exactly one of finalize or migration may win.

- [ ] **Step 3: Add failing lease-scoped drain tests**

Hold one deferred RPC for revoked attempt X and a separate global RPC for B's unrelated job Y. Settle X only and assert A starts even while B's global `inFlightUploadRPCs === 1`. Also assert:

- B receives `AbortSignal.aborted === true` immediately after commit.
- B cannot start a new RPC after revoke.
- B's explicit late success increments physical bytes but not logical bytes.
- Timeout/unknown late settlement changes neither physical nor logical bytes.
- B's runner promise rejecting with `AbortError` or `LeaseRevokedError` after revoke does not fail or otherwise mutate the migrating/new attempt.
- A gets `attemptId === 2`, a new runner call, and begins at part 0.
- A offline during drain never restores B and ends failed after A's existing retry/timeout path rejects.

- [ ] **Step 4: Implement candidate selection and synchronous commit**

Implement private methods with these signatures and no asynchronous boundary:

```ts
private isCandidate(task: SegmentTask, now: number): boolean;
private failoverScore(task: SegmentTask, snapshot: IdleSpeedSnapshot): number;
private commitMigration(accountId: number, taskId: string): boolean;
private grantFinalize(lease: AttemptLease): boolean;
```

In `commitMigration()`, first revalidate A and B and capture B's old controller/lease. Then complete this scheduler transaction in order: reserve A and invalidate its snapshot; set `state = 'migrating'`; store `drainingAttemptId = oldAttemptId`; increment `attemptId`; set `currentAccountId = null`; clear logical bytes and completed parts; set `migrationCount = 1`; add A to `attemptedAccountIds`. Only after every ownership field is committed may the method call `oldController.abort()` and emit executor/rollback notifications. `AbortController.abort()` can synchronously invoke listeners, so it must never run against partially updated ownership. Keep the whole method synchronous and do not introduce `await`.

Subscribe once to account-registry changes and run `reevaluate()` when an account becomes truly idle. Maintain one nearest-deadline timer whose target is the minimum of: next attempt 30-second qualification, next idle-snapshot expiry, and next current-attempt effective-speed bucket expiry returned by `speed.nextAttemptEffectiveExpiry()`. Reschedule it after every task, flood, speed, snapshot, and terminal event. This lets a waiting B cross the score threshold as old successes age out even if no new RPC arrives, without creating a polling timer per part.

- [ ] **Step 5: Implement exact attempt drain and reservation activation**

`onRpcStart()` increments `task.attemptInFlightRPCs[lease.attemptId]` only for the current active lease. `onRpcSettled()` decrements the recorded attempt even when the lease is stale and resolves that attempt's drain barrier at zero. It must never use the account-global count as the barrier.

After the revoked attempt reaches zero, verify `state === 'migrating'` and the new generation still matches, then call:

```ts
const activeLease = activity.activateReservation(targetAccountId, task.taskId, maxJobsPerAccount);
if (!activeLease) failTask(task, new Error('接手帳號無法開始上傳'));
```

After the old attempt's drain reaches zero, call `speed.clearAttempt(task.taskId, oldAttemptId)` to release its attempt-local buckets and dedupe keys; account-wide effective history and physical counters must remain. Store the returned job lease for exactly-once terminal release, clear `drainingAttemptId`, set current ownership, and invoke A's runner with a fresh attempt.

- [ ] **Step 6: Implement diagnostic and terminal cleanup paths**

Add a structured `onDiagnostic(event)` option with these discriminated variants:

```ts
type SchedulerDiagnostic =
  | {
      type: 'premium-flood'; accountId: number; accountName: string;
      taskId: string; fileJobId: string; segmentIndex: number; attemptId: number;
      waitSeconds: number; penaltyUntil: number;
      pacerMode: 'normal' | 'frozen' | 'cautious';
      scheduledRate: number; bLiveSpeed: number; logicalUploadedBytes: number;
      remainingRatio: number; accountAcceptedParts: number; accountAcceptedBytes: number;
      taskAcceptedParts: number; taskAcceptedBytes: number;
    }
  | {
      type: 'migration'; taskId: string; segmentIndex: number;
      oldAttemptId: number; newAttemptId: number; fromAccountId: number;
      toAccountId: number; aSnapshotSpeed: number; snapshotAge: number;
      bLiveSpeed: number; remainingRatio: number; failoverScore: number;
      abandonedLogicalBytes: number; migrationCount: 1;
    };
```

Each current-lease premium-flood handler must synchronously execute this cycle boundary before reevaluation:

```ts
const accountAccepted = speed.accountPhysicalSincePreviousPremiumFlood(accountId);
const taskAccepted = speed.taskPhysicalSincePreviousPremiumFlood(task.taskId);
emitDiagnostic({
  type: 'premium-flood',
  accountId,
  accountName: runner.accountName,
  taskId: task.taskId,
  fileJobId: task.fileJobId,
  segmentIndex: task.segment.index,
  attemptId: task.attemptId,
  waitSeconds: event.waitSeconds,
  penaltyUntil: event.penaltyUntil,
  pacerMode: event.pacerMode,
  scheduledRate: event.scheduledRate,
  bLiveSpeed: speed.attemptEffectiveBytesPerSecond(lease),
  logicalUploadedBytes: task.logicalUploadedBytes,
  remainingRatio: (task.segment.size - task.logicalUploadedBytes) / task.segment.size,
  accountAcceptedParts: accountAccepted.parts,
  accountAcceptedBytes: accountAccepted.bytes,
  taskAcceptedParts: taskAccepted.parts,
  taskAcceptedBytes: taskAccepted.bytes,
});
speed.markPremiumFloodCycle(accountId, task.taskId);
```

These three operations must finish in one synchronous handler so accepted bytes cannot leak across cycles.

Cleanup must cancel qualification/retry/pacer timers, abort cancellable work, release either a reservation or an active job lease, invalidate all task events, call `speed.clearAttempt(task.taskId, task.attemptId)` for the terminal current attempt, and remain safe on a second call. Clearing attempt state must not delete physical telemetry or account-wide samples. Do not force the account-global RPC count to zero. Format diagnostics through existing account-aware logging and never include access hashes or credentials. Add one test where an idle account can either migrate a qualifying task or start a normal pending task and prove migration wins; add another with two candidates and prove the highest recomputed score wins.

- [ ] **Step 7: Run all scheduler race tests**

Run: `cd frontend && npm run test:unit -- src/lib/segmentScheduler.test.ts`

Expected: PASS, including per-attempt drain, finalize race, stale fulfillment/rejection, rolling-speed expiry wakeup, A-offline, and idempotent cleanup cases.

- [ ] **Step 8: Commit migration semantics**

```bash
git add frontend/src/lib/segmentScheduler.ts frontend/src/lib/segmentScheduler.test.ts
git commit -m "feat(upload): migrate stalled segments safely"
```

### Task 5: Premium Flood Frozen and Cautious Pacer Modes

**Files:**
- Modify: `frontend/src/lib/adaptiveRateLimiter.ts`
- Modify: `frontend/src/lib/adaptiveRateLimiter.test.ts`
- Modify: `frontend/src/lib/gramjsFloodPatch.ts`

**Interfaces:**
- Consumes: premium-recovery constants from Task 1.
- Produces: `reportPremiumFlood()`, `noteSendStarted()`, abortable `wait()`, and stats with `mode`.

- [ ] **Step 1: Replace the current premium pause tests with failing mode tests**

Use Vitest fake timers and assert:

```ts
limiter.reportPremiumFlood(15);
expect(limiter.stats()).toMatchObject({ rate: 4, ceiling: null, mode: 'frozen' });

vi.advanceTimersByTime(16_000);
limiter.reportSuccess();
expect(limiter.stats().rate).toBe(4);
expect(limiter.stats().cleanWindowStart).toBeNull();

limiter.noteSendStarted();
expect(limiter.stats().cleanWindowStart).toBe(Date.now());
vi.advanceTimersByTime(59_999);
limiter.reportSuccess();
expect(limiter.stats()).toMatchObject({ rate: 4, mode: 'frozen' });
vi.advanceTimersByTime(1);
limiter.reportSuccess();
expect(limiter.stats()).toMatchObject({ rate: 4, mode: 'cautious' });
```

Then advance 30 seconds twice and prove each eligible success raises rate by exactly 0.1. Add a second flood during the clean window and prove the clean start resets. Add a new limiter instance and prove it starts in `normal` even if stored rate/ceiling exist.

- [ ] **Step 2: Add a failing abortable-wait test**

Start `wait(signal)` during a penalty, abort the controller, and assert rejection is a DOM `AbortError` without changing rate, ceiling, or mode.

- [ ] **Step 3: Run the focused pacer tests and confirm failure**

Run: `cd frontend && npm run test:unit -- src/lib/adaptiveRateLimiter.test.ts`

Expected: FAIL because the new methods and stats fields are absent.

- [ ] **Step 4: Implement the session-only state machine**

Add:

```ts
export type PacerMode = 'normal' | 'frozen' | 'cautious';

reportPremiumFlood(seconds?: number): void;
noteSendStarted(): void;
async wait(signal?: AbortSignal): Promise<void>;
stats(): {
  rate: number;
  floods: number;
  ceiling: number | null;
  mode: PacerMode;
  penaltyUntil: number;
  cleanWindowStart: number | null;
};
```

`reportPremiumFlood()` holds the current rate, sets `frozen`, clears the clean start, and extends `penaltyUntil`. While frozen, `reportSuccess()` never ramps. `noteSendStarted()` starts the clean clock only after the penalty has elapsed. At 60 clean seconds, switch to cautious without raising rate on that same call. Cautious uses only the 0.1/30-second cadence and never returns to normal in the same instance. A genuine `reportFlood()` keeps its existing rate/ceiling cut and resets an already-started premium recovery window.

Persist only `{ rate, ceiling, updatedAt }`; do not add mode or recovery timestamps to storage.

- [ ] **Step 5: Run pacer tests**

Run: `cd frontend && npm run test:unit -- src/lib/adaptiveRateLimiter.test.ts`

Expected: PASS with no real-time sleeps in the new recovery tests.

- [ ] **Step 6: Commit premium pacing**

```bash
git add frontend/src/lib/adaptiveRateLimiter.ts frontend/src/lib/adaptiveRateLimiter.test.ts frontend/src/lib/gramjsFloodPatch.ts
git commit -m "fix(upload): freeze ramp after premium flood"
```

### Task 6: Lease-Aware GramJS Segment Executor and Transport Accounting

**Files:**
- Modify: `frontend/src/lib/gramjs.ts:212-359,493-665,685-840`
- Modify: `frontend/src/lib/gramjsLogging.test.ts`
- Modify: `frontend/src/lib/gramjsStatistics.test.ts`

**Interfaces:**
- Consumes: `SegmentAttemptRunner`, `SegmentAttemptHooks`, `accountActivityRegistry`, `UploadSpeedTracker`, and abortable pacer methods.
- Produces: `TelegramClientManager.asSegmentRunner()` and exact transport callback boundaries.

- [ ] **Step 1: Write failing executor ownership tests**

Stub `sendFilePartGated` dependencies and verify:

- Every actual `sender.send()` has one account-global RPC lease and one scheduler `onRpcStart()/onRpcSettled()` pair.
- An aborted lease never starts another sender RPC after its already-started RPC settles.
- An explicitly successful stale RPC still calls `recordUploadedBytes()` and records physical speed.
- A stale success does not call effective progress after the scheduler rejects the lease.
- `sendFileWithOptionalThumb()` is never invoked when `grantFinalize()` returns false.
- It is invoked exactly once after `grantFinalize()` returns true.

- [ ] **Step 2: Run GramJS unit tests and confirm the new assertions fail**

Run: `cd frontend && npm run test:unit -- src/lib/gramjsLogging.test.ts src/lib/gramjsStatistics.test.ts`

Expected: FAIL at the missing runner/control surface.

- [ ] **Step 3: Add a lease-aware request context to `sendFilePartGated()`**

Use this internal contract:

```ts
type SegmentPartContext = {
  lease: AttemptLease;
  partIndex: number;
  hooks: SegmentAttemptHooks;
};

private async sendFilePartGated(
  request: InstanceType<typeof Api.upload.SaveFilePart> | InstanceType<typeof Api.upload.SaveBigFilePart>,
  label: string,
  context?: SegmentPartContext,
): Promise<void>;
```

For each retry: first await `chunkPacer.wait(context?.hooks.signal)`, then obtain the sender under the existing deadline. Check the abort signal again after `getSender()` and immediately before `sender.send()`. Only at that boundary call `context.hooks.onRpcStart()` and acquire `accountActivityRegistry.beginUploadRpc(accountId)`; if the hook rejects the stale lease, do not send. Call `chunkPacer.noteSendStarted()` directly before `sender.send()`, so connection setup time cannot count toward the 60-second clean window. In `finally`, call both settle releases exactly once for RPCs that actually crossed the start boundary.

On explicit success, always update existing daily physical statistics and `UploadSpeedTracker.recordPhysicalSuccess()`. Then call `onPartAccepted(partIndex, bytes)`; scheduler lease validation decides whether it is effective. On premium flood, call `chunkPacer.reportPremiumFlood(seconds)`, read the resulting pacer stats, and pass `onPremiumFlood({ waitSeconds, penaltyUntil, pacerMode: 'frozen', scheduledRate: rate })`. Ordinary flood keeps `reportFlood(seconds)`.

- [ ] **Step 4: Convert segment upload into a runner**

Add:

```ts
asSegmentRunner(): SegmentAttemptRunner {
  return {
    accountId: this.accountId,
    accountName: resolveAccountLogName(this.accountName, this.accountId),
    run: (input) => this.uploadSegmentAttempt(input),
  };
}
```

`uploadSegmentAttempt()` generates a new random `fileId` on every call, checks `signal.aborted` before reading/scheduling each part, uses abortable retry delays, and calls `hooks.grantFinalize()` after all parts succeed. If the grant fails, throw a dedicated `LeaseRevokedError` and never call `sendFileWithOptionalThumb()`. Segment 0 alone receives the thumbnail from its current attempt.

- [ ] **Step 5: Publish account availability to the registry**

After `initialize()` identifies a connected account, call `setAvailability(accountId, { online: true, ready: true })`. On handshake failure, explicit disconnect, account removal, and pool reset, publish `online: false, ready: false` before or in the same synchronous cleanup turn. Reconnect success restores both flags and triggers scheduler reevaluation through the registry subscription.

- [ ] **Step 6: Account for non-candidate byte paths**

Top-level small-file and album byte jobs are already held by Task 2's account-pool wrapper. Inside GramJS, route every paced `SaveFilePart` through account-global RPC accounting. Record unique effective units for successful small-file and album parts with stable keys derived from `fileId + partIndex`; record opaque `sendFile` small-file bytes once after explicit success. Metadata registration, JWT refresh, and reads do not call the registry.

- [ ] **Step 7: Run GramJS tests and build**

Run: `cd frontend && npm run test:unit -- src/lib/gramjsLogging.test.ts src/lib/gramjsStatistics.test.ts && npm run build`

Expected: PASS; type checking proves the executor contract and finalize gate are wired.

- [ ] **Step 8: Commit the executor slice**

```bash
git add frontend/src/lib/gramjs.ts frontend/src/lib/gramjsLogging.test.ts frontend/src/lib/gramjsStatistics.test.ts
git commit -m "feat(upload): execute segments with revocable leases"
```

### Task 7: Scheduler-Driven Split Upload

**Files:**
- Modify: `frontend/src/lib/splitUpload.ts`
- Create: `frontend/src/lib/splitUpload.test.ts`
- Modify: `frontend/src/components/ChonkyDrive.tsx:850-904,1187-1204`

**Interfaces:**
- Consumes: tracked account slots from Task 2, `TelegramClientManager.asSegmentRunner()`, and `SegmentScheduler.enqueueFile()`.
- Produces: a shared scheduler-backed `uploadFileSpread()`.

- [ ] **Step 1: Write failing split scheduler tests**

Inject a scheduler facade and segment planner into a testable `createUploadFileSpread()` and verify:

```ts
const largeFile = { size: 1536, name: 'large.bin' } as File;
const enqueueFile = vi.fn(async (input: SegmentFileJobInput) => ({
  parts: input.segments.map((segment, index) => ({
    index: segment.index, message_id: 300 - index, file_id: `part-${index}`,
    size: segment.size, account_id: index % 2 === 0 ? 10 : 20, hasThumbnail: false,
  })),
  hasThumbnail: false,
}));
const upload = createUploadFileSpread({
  scheduler: { enqueueFile },
  clients: () => [clientA, clientB],
  plan: () => [
    { index: 0, offset: 0, parts: 1, size: 512 },
    { index: 1, offset: 512, parts: 1, size: 512 },
    { index: 2, offset: 1024, parts: 1, size: 512 },
  ],
  withAccountSlot: async (fn) => fn(clientA),
  smallFileLimit: 0,
});
const result = await upload(largeFile, (percent, detail) => events.push({ percent, detail }));
expect(enqueueFile.mock.calls[0][0].segments.map((segment) => segment.index)).toEqual([0, 1, 2]);
expect(result.parts.map((part) => part.index)).toEqual([0, 1, 2]);
```

Add a pinned test proving only the pinned runner is supplied and its tasks have migration disabled. Keep the small-file test on `withAccountSlot()` and preserve `onProgress(100)`.

- [ ] **Step 2: Replace eager `Promise.all` account binding**

Keep the public compatibility shape while adding migration detail:

```ts
export interface SplitUploadDependencies {
  scheduler: Pick<SegmentScheduler, 'enqueueFile'>;
  clients: () => TelegramClientManager[];
  plan?: typeof planSegments;
  withAccountSlot?: typeof withAccountSlot;
  smallFileLimit?: number;
}

export function createUploadFileSpread(deps: SplitUploadDependencies): typeof uploadFileSpread;

export type SplitUploadProgressDetail =
  | { reason: 'migration'; message: '重新分派上傳帳號，該區段將從頭重傳' };

export type SplitUploadProgress = (percent: number, detail?: SplitUploadProgressDetail) => void;

export async function uploadFileSpread(
  file: File,
  onProgress?: SplitUploadProgress,
  thumb?: Blob | null,
  pinned?: TelegramClientManager,
): Promise<SplitUploadResult>;
```

The production export uses `planSegments`, `SMALL_FILE_LIMIT`, `getAllClients`, `withAccountSlot`, and one process-wide scheduler configured with the production activity registry and speed tracker. For large files, submit all descriptors under one generated `fileJobId` to that scheduler. Compute percent from `logicalFileBytes / file.size`; a migration callback may therefore emit a lower percent with `reason: 'migration'`. Await all terminal tasks, sort by `index`, and return actual per-result `account_id`. Small files keep their current route.

- [ ] **Step 3: Update both ChonkyDrive callers without changing metadata flow**

Keep `registerUploadedParts()` and `registerFolderFileParts()` after Telegram completion. Pass the new progress callback through both direct-file and folder upload paths. Do not add a backend request during migration or drain.

- [ ] **Step 4: Run split, scheduler, and build checks**

Run: `cd frontend && npm run test:unit -- src/lib/splitUpload.test.ts src/lib/segmentScheduler.test.ts && npm run build`

Expected: PASS; metadata result types still include actual `account_id` and index order.

- [ ] **Step 5: Commit dynamic dispatch**

```bash
git add frontend/src/lib/splitUpload.ts frontend/src/lib/splitUpload.test.ts frontend/src/components/ChonkyDrive.tsx
git commit -m "feat(upload): schedule split segments dynamically"
```

### Task 8: Controlled Upload Center Progress Rollback

**Files:**
- Modify: `frontend/src/lib/uploadQueue.ts`
- Modify: `frontend/src/lib/uploadQueue.test.ts`
- Modify: `frontend/src/components/UploadCenter.tsx`
- Modify: `frontend/src/components/ChonkyDrive.tsx:970-980,1306-1316`

**Interfaces:**
- Consumes: `SplitUploadProgressDetail` from Task 7.
- Produces: `migrationProgressReset` action and `UploadItem.statusMessage`.

- [ ] **Step 1: Write failing reducer tests for the one legal regression**

Add `statusMessage: string | null` to test factories and assert:

```ts
let state = uploadingAt(60);
state = reduce(state, {
  type: 'migrationProgressReset', id: 'a', attempt: 1, progress: 25,
  message: '重新分派上傳帳號，該區段將從頭重傳', now: 1004,
});
expect(state.itemsById.a.progress).toBe(25);
expect(state.itemsById.a.statusMessage).toBe('重新分派上傳帳號，該區段將從頭重傳');

state = reduce(state, { type: 'setProgress', id: 'a', attempt: 1, progress: 20, now: 1005 });
expect(state.itemsById.a.progress).toBe(25);
```

Prove stale file attempts and terminal rows reject `migrationProgressReset`. Prove `complete`, `fail`, and a new file retry clear `statusMessage`.

- [ ] **Step 2: Run queue tests and confirm failure**

Run: `cd frontend && npm run test:unit -- src/lib/uploadQueue.test.ts`

Expected: FAIL because the action and field do not exist.

- [ ] **Step 3: Implement the explicit reducer action**

Add only this regression-capable action:

```ts
| {
    type: 'migrationProgressReset';
    id: string;
    attempt: number;
    progress: number;
    message: '重新分派上傳帳號，該區段將從頭重傳';
    now: number;
  }
```

Clamp its progress to 0–99, permit a lower value, and require the current non-terminal file attempt. Keep ordinary `setProgress` monotonic. Initialize and clear `statusMessage` on the lifecycle boundaries listed in Step 1.

- [ ] **Step 4: Wire scheduler progress to the queue**

Change both `onProgress` closures in `ChonkyDrive.tsx` to dispatch:

```ts
const onProgress: SplitUploadProgress = (pct, detail) => queue.dispatch(
  detail?.reason === 'migration'
    ? { type: 'migrationProgressReset', id, attempt, progress: pct, message: detail.message, now: Date.now() }
    : { type: 'setProgress', id, attempt, progress: pct, now: Date.now() },
);
```

- [ ] **Step 5: Render the message without changing virtual row height**

In `UploadCenter.Row`, use the existing second-line area. When `statusMessage` exists, display it with `data-testid="upload-migration-message"`; otherwise retain the duplicate-name path behavior. Keep `ROW_HEIGHT = 34`.

- [ ] **Step 6: Run reducer tests and build**

Run: `cd frontend && npm run test:unit -- src/lib/uploadQueue.test.ts src/lib/uploadQueueSelectors.test.ts && npm run build`

Expected: PASS; existing monotonic progress tests remain green.

- [ ] **Step 7: Commit UI rollback semantics**

```bash
git add frontend/src/lib/uploadQueue.ts frontend/src/lib/uploadQueue.test.ts frontend/src/components/UploadCenter.tsx frontend/src/components/ChonkyDrive.tsx
git commit -m "feat(upload): show controlled migration rollback"
```

### Task 9: Full Fake-Executor Integration Scenarios

**Files:**
- Modify: `frontend/src/lib/segmentScheduler.test.ts`
- Modify: `frontend/src/lib/splitUpload.test.ts`

**Interfaces:**
- Consumes: completed scheduler, executor contracts, activity registry, tracker, and split facade.
- Produces: deterministic proof of the exact production scenarios without Telegram or network access.

- [ ] **Step 1: Add a reusable controlled fake runner inside the scheduler test**

The fake must expose only production callbacks:

```ts
class ControlledRunner implements SegmentAttemptRunner {
  calls: Array<SegmentAttemptInput> = [];
  private pending: {
    resolve: (value: SegmentResult & { hasThumbnail: boolean }) => void;
    reject: (reason?: unknown) => void;
  } | null = null;
  constructor(readonly accountId: number, readonly accountName: string) {}
  run(input: SegmentAttemptInput): Promise<SegmentResult & { hasThumbnail: boolean }> {
    this.calls.push(input);
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
    });
  }
  finish(value: SegmentResult & { hasThumbnail: boolean }): void {
    if (!this.pending) throw new Error('no pending segment attempt');
    this.pending.resolve(value);
    this.pending = null;
  }
  fail(reason: unknown): void {
    if (!this.pending) throw new Error('no pending segment attempt');
    this.pending.reject(reason);
    this.pending = null;
  }
}
```

Provide test helpers that call `hooks.onRpcStart`, `hooks.onPartAccepted`, `hooks.onPremiumFlood`, `hooks.onRpcSettled`, and `hooks.grantFinalize`; do not call scheduler internals from scenario tests.

- [ ] **Step 2: Test busy A becoming idle and stealing B**

Start A with another byte-job lease, let B reach 60% plus premium floods, and advance to 30 seconds. Assert B remains active while A is busy. Release A, create its effective idle snapshot, and assert one migration event, B abort, A restart at part 0, and progress rollback.

- [ ] **Step 3: Test late B fulfillment and rejection are both stale**

Use two independent fixtures after migration commit. In the fulfillment case, settle B's deferred explicit success and attempt finalize; assert B's finalize returns false, A alone resolves the segment, the file promise has one result, and physical bytes include B's explicit late success. In the rejection case, execute `runnerB.fail(new DOMException('lease revoked', 'AbortError'))`, then repeat with `LeaseRevokedError`; assert neither rejection enters `failed`, changes the new generation, writes progress/result, nor prevents A from completing.

- [ ] **Step 4: Test single-account premium flood**

With only B available, meet all candidate conditions and assert:

```ts
expect(runnerB.calls).toHaveLength(1);
expect(runnerB.calls[0].lease.attemptId).toBe(1);
expect(migrations).toHaveLength(0);
```

Resume B through the same hooks, grant finalize, and complete successfully. Assert no replacement `fileId` attempt was started.

- [ ] **Step 5: Test all three accounts flooded**

Make A, B, and C active and premium-flooded. Assert no migration and no account cycle. Complete A's original work so it becomes truly idle with an effective snapshot, recompute score, and verify migration occurs only when strict score is above 2. Include a score-equals-2 branch that does not migrate.

- [ ] **Step 6: Test actual storage-account metadata inputs**

Resolve multiple fake segment results from different accounts and assert `splitUpload` returns them in segment order with their real `account_id`. Assert no fake backend or registration callback runs until every segment is completed.

- [ ] **Step 7: Run integration-focused unit tests**

Run: `cd frontend && npm run test:unit -- src/lib/segmentScheduler.test.ts src/lib/splitUpload.test.ts`

Expected: PASS for busy-idle handoff, late B, single-account, all-flooded, threshold, and result-order scenarios.

- [ ] **Step 8: Commit integration coverage**

```bash
git add frontend/src/lib/segmentScheduler.test.ts frontend/src/lib/splitUpload.test.ts
git commit -m "test(upload): cover segment failover scenarios"
```

### Task 10: Vite-Gated Browser Harness and Playwright MCP Verification

**Files:**
- Create: `frontend/src/testing/failoverHarness.ts`
- Create: `frontend/tests/isolated/upload-failover.spec.ts`
- Modify: `frontend/src/hooks/useUploadQueue.ts`
- Modify: `frontend/src/vite-env.d.ts`
- Modify: `frontend/playwright.config.ts`

**Interfaces:**
- Consumes: production scheduler/executor contracts and queue dispatch.
- Produces: `window.__TELEDRIVE_FAILOVER_TEST__` only when `VITE_E2E_TEST_HOOKS === '1'`.

- [ ] **Step 1: Type and gate the test bridge**

Add to `vite-env.d.ts`:

```ts
interface ImportMetaEnv {
  readonly VITE_E2E_TEST_HOOKS?: string;
}

interface Window {
  __TELEDRIVE_FAILOVER_TEST__?: {
    start(): Promise<void>;
    releaseIdleAccount(): Promise<void>;
    settleLateSource(): Promise<void>;
    finishTarget(): Promise<void>;
    snapshot(): { sourceFinalizeCalls: number; targetFinalizeCalls: number; migrations: number };
  };
}
```

Set `VITE_E2E_TEST_HOOKS: '1'` in the isolated Playwright `webServer.env`. Production builds without that value must not install the bridge.

- [ ] **Step 2: Implement a deterministic fake-executor harness**

The harness must instantiate the production `SegmentScheduler`, `AccountActivityRegistry`, and `UploadSpeedTracker` with a controlled clock. `start()` enqueues a synthetic visible queue item, advances B to 60%, emits premium flood, and keeps A busy. `releaseIdleAccount()` releases A, creates a valid snapshot, and triggers migration. `settleLateSource()` returns B's explicit stale success and rejected finalize. `finishTarget()` completes A and emits the sole result.

Install and remove the bridge from `useUploadQueue()` in an effect only under the Vite flag. The harness receives `queue.dispatch`; it must not import React or make a network request.

- [ ] **Step 3: Write the isolated browser test**

Create assertions through the public bridge and DOM:

```ts
await openDrive();
await page.evaluate(() => window.__TELEDRIVE_FAILOVER_TEST__!.start());
const row = page.getByTestId('upload-center-row').filter({ hasText: 'failover.bin' });
await expect(row).toContainText('60%');

await page.evaluate(() => window.__TELEDRIVE_FAILOVER_TEST__!.releaseIdleAccount());
await expect(row).toContainText('重新分派上傳帳號，該區段將從頭重傳');
await expect(row).toContainText('0%');

await page.evaluate(() => window.__TELEDRIVE_FAILOVER_TEST__!.settleLateSource());
expect(await page.evaluate(() => window.__TELEDRIVE_FAILOVER_TEST__!.snapshot()))
  .toEqual({ sourceFinalizeCalls: 0, targetFinalizeCalls: 0, migrations: 1 });
```

Finish A and assert one completed row/result. Inspect the fake drive request log and assert migration itself generated no `/api/v1/**` request.

- [ ] **Step 4: Verify through Playwright MCP**

Invoke:

```text
skill(name="playwright", user_message="Run frontend/tests/isolated/upload-failover.spec.ts against the isolated Vite app. Verify the row visibly goes from 60% to 0%, shows the Chinese reassignment message, late source completion creates no duplicate finalize/result, and no API request is made during migration. Return assertions and any trace path; do not perform manual testing.")
```

Expected: all assertions pass in Chromium, with no external Telegram connection.

- [ ] **Step 5: Commit browser verification**

```bash
git add frontend/src/testing/failoverHarness.ts frontend/tests/isolated/upload-failover.spec.ts frontend/src/hooks/useUploadQueue.ts frontend/src/vite-env.d.ts frontend/playwright.config.ts
git commit -m "test(upload): verify failover progress rollback"
```

### Task 11: Final Regression and Architecture Verification

**Files:**
- Verify: all files listed above
- Verify unchanged: `backend/**`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: evidence that the feature is complete without violating TeleDrive's transfer boundary.

- [ ] **Step 1: Run all frontend unit tests**

Run: `cd frontend && npm run test:unit`

Expected: all Vitest suites pass.

- [ ] **Step 2: Run the production build**

Run: `cd frontend && npm run build`

Expected: TypeScript and Vite build complete successfully.

- [ ] **Step 3: Run the complete isolated browser suite through Playwright MCP**

Invoke:

```text
skill(name="playwright", user_message="Run the complete frontend isolated Playwright suite. Include upload-failover.spec.ts and existing upload-center/upload-pipeline coverage. Do not use manual testing or real Telegram. Report pass/fail counts and trace paths for failures.")
```

Expected: all isolated tests pass.

- [ ] **Step 4: Prove the backend transfer boundary stayed untouched**

Run: `git diff --name-only $(git merge-base HEAD origin/main)..HEAD -- backend`

Expected: no output attributable to this feature. If the branch already contains unrelated backend changes, inspect the task commits individually with `git show --name-only <commit>` and confirm none of Tasks 1–10 modified `backend/**`.

- [ ] **Step 5: Inspect secrets and diagnostics**

Run: `rg -n "session|stringSession|authKey|access_hash|tg_jwt" frontend/src/lib/segmentScheduler.ts frontend/src/lib/uploadSpeedTracker.ts frontend/src/testing/failoverHarness.ts`

Expected: no diagnostic payload includes session strings, auth keys, JWTs, or access hashes; type/import mentions alone are not logged.

- [ ] **Step 6: Record final evidence without folding unrelated worktree changes into the feature**

Run: `git status --short && git log --oneline -12`

Expected: task commits are visible; unrelated pre-existing modifications remain unstaged and preserved.
