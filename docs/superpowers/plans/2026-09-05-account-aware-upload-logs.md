# Account-Aware Adaptive Upload Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove verbose split-segment scheduling logs, prefix useful upload diagnostics with the Telegram account label, and let each account's adaptive limiter explore beyond the former 12 parts/s ceiling.

**Architecture:** Keep the account display name on each `TelegramClientManager`, because that object already owns the per-account upload pacer and split-upload operations. Add one small pure formatter for account-prefixed console lines and use it for limiter and segment-completion messages. Raise only the limiter's absolute safety ceiling from 12 to 32 parts/s; retain conservative startup, per-account FLOOD feedback, learned ceilings, and the existing 12-request concurrency guard.

**Tech Stack:** React 18, TypeScript, GramJS 2.26.x, Vitest 4, Playwright 1.59

**Spec:** User requirements from the 2026-09-05 conversation; no separate design document.

## Global Constraints

- Binary data must continue to travel directly between Telegram CDN and the browser through GramJS; port 8000 remains metadata-only.
- Backend port remains 8000 and frontend port remains 3000.
- No new frontend environment variables are required; any future frontend variable must use the `VITE_` prefix.
- Do not manually verify in the browser. Use unit tests for exact console output and Playwright for automated browser regression verification.
- Preserve unrelated dirty-worktree changes; modify only the files listed below.
- `CHUNK_RATE_MAX` becomes exactly `32` parts/s: this is an absolute safety bound, not a claimed sustainable rate.
- `MAX_CONCURRENT_CHUNKS` remains exactly `12`; changing request concurrency requires separate throughput and latency evidence.
- Do not remove the absolute rate bound: the current controller reacts to `FLOOD_WAIT` but does not detect throughput saturation from latency alone.
- Exact intended examples:

```text
[ji32k7au6y4][Perf][ChunkRate:8838273312] ramp → 10.1 parts/s
[test1][SplitUpload:8773541354] segment 0 sent, message_id: 3
```

- Remove every successful-segment scheduling line matching this shape:

```text
[SplitUpload:8773541354] segment 6: 1000 parts at offset 3145728000
```

- Keep error logs such as failed chunk attempts; they are outside this request and remain useful for diagnosis.

---

## File Structure

- Create `frontend/src/lib/accountLog.ts`: pure functions for resolving the display-name fallback and formatting tagged account log lines.
- Create `frontend/src/lib/accountLog.test.ts`: exact unit coverage for username/label and numeric-ID fallback formatting.
- Modify `frontend/src/lib/adaptiveRateLimiter.ts`: accept an optional account display name and apply it to rate-related log lines.
- Modify `frontend/src/lib/adaptiveRateLimiter.test.ts`: verify initialization and ramp logs include the account prefix and that the production limiter can ramp beyond 12 parts/s.
- Modify `frontend/src/config.ts`: raise the absolute adaptive-rate safety ceiling to 32 parts/s while keeping chunk concurrency at 12.
- Modify `frontend/src/lib/gramjs.ts`: retain the display name on each account manager, pass it to the pacer, remove segment scheduling logs, and prefix segment-completion logs.
- Modify `frontend/src/App.tsx`: pass the known account label when adopting restored and newly authenticated clients.
- Modify `frontend/src/components/SettingsDialog.tsx`: pass the linked account label when adopting a secondary client.
- Create `frontend/src/lib/gramjsLogging.test.ts`: exercise `uploadSegment()` with stubbed Telegram operations and assert that it emits only the account-prefixed completion line.

### Task 1: Shared Account Log Formatting

**Files:**
- Create: `frontend/src/lib/accountLog.ts`
- Create: `frontend/src/lib/accountLog.test.ts`

**Interfaces:**
- Produces: `resolveAccountLogName(accountName: string | null | undefined, accountId: number): string`
- Produces: `formatAccountLog(accountName: string | null | undefined, accountId: number, tags: readonly string[], message: string): string`
- Consumers: `adaptiveRateLimiter.ts` and `gramjs.ts` in later tasks.

- [ ] **Step 1: Write failing formatter tests**

Create `frontend/src/lib/accountLog.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formatAccountLog, resolveAccountLogName } from './accountLog.ts';

describe('account log formatting', () => {
  it('uses the trimmed account label ahead of all log tags', () => {
    expect(resolveAccountLogName('  test1  ', 8773541354)).toBe('test1');
    expect(
      formatAccountLog('test1', 8773541354, ['Perf', 'ChunkRate:8773541354'], 'ramp → 4.5 parts/s'),
    ).toBe('[test1][Perf][ChunkRate:8773541354] ramp → 4.5 parts/s');
  });

  it('falls back to the numeric account id when no label is known', () => {
    expect(resolveAccountLogName('  ', 8773541354)).toBe('8773541354');
    expect(
      formatAccountLog(undefined, 8773541354, ['SplitUpload:8773541354'], 'segment 0 sent, message_id: 3'),
    ).toBe('[8773541354][SplitUpload:8773541354] segment 0 sent, message_id: 3');
  });
});
```

- [ ] **Step 2: Run the test and confirm the RED state**

Run:

```powershell
cd frontend
npm run test:unit -- src/lib/accountLog.test.ts
```

Expected: FAIL because `accountLog.ts` does not exist.

- [ ] **Step 3: Implement the pure formatter**

Create `frontend/src/lib/accountLog.ts`:

```ts
export function resolveAccountLogName(
  accountName: string | null | undefined,
  accountId: number,
): string {
  return accountName?.trim() || String(accountId);
}

export function formatAccountLog(
  accountName: string | null | undefined,
  accountId: number,
  tags: readonly string[],
  message: string,
): string {
  const prefix = [resolveAccountLogName(accountName, accountId), ...tags]
    .map((tag) => `[${tag}]`)
    .join('');
  return `${prefix} ${message}`;
}
```

- [ ] **Step 4: Run the formatter tests and confirm GREEN**

Run:

```powershell
cd frontend
npm run test:unit -- src/lib/accountLog.test.ts
```

Expected: 2 tests PASS with no warnings.

- [ ] **Step 5: Commit the formatter unit**

```powershell
git add frontend/src/lib/accountLog.ts frontend/src/lib/accountLog.test.ts
git commit -m "refactor(logging): add account-aware log formatter"
```

### Task 2: Preserve Account Display Names on Telegram Clients

**Files:**
- Create: `frontend/src/lib/gramjsLogging.test.ts`
- Modify: `frontend/src/lib/gramjs.ts:88-126,205-232,372-402,1400-1427`
- Modify: `frontend/src/App.tsx:43-50,76-90`
- Modify: `frontend/src/components/SettingsDialog.tsx:45-64`

**Interfaces:**
- Consumes: `resolveAccountLogName()` from Task 1.
- Produces: `TelegramClientManager.accountName: string`
- Produces: `TelegramClientManager.setAccountIdentity(accountId: number, accountName?: string | null): void`
- Changes: `adoptClient(accountId: number, manager: TelegramClientManager, accountName?: string | null): void`
- Keeps: all existing callers that omit the third `adoptClient` argument valid.

- [ ] **Step 1: Add failing identity tests**

Add to `frontend/src/lib/gramjsLogging.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { TelegramClientManager, adoptClient } from './gramjs.ts';

describe('TelegramClientManager log identity', () => {
  it('retains the account id and display name supplied at construction', () => {
    const manager = new TelegramClientManager(8773541354, 'test1');
    expect(manager.accountId).toBe(8773541354);
    expect(manager.accountName).toBe('test1');
  });

  it('adopts a freshly authenticated manager with its resolved label', () => {
    const manager = new TelegramClientManager();
    adoptClient(8838273312, manager, 'ji32k7au6y4');
    expect(manager.accountId).toBe(8838273312);
    expect(manager.accountName).toBe('ji32k7au6y4');
  });
});
```

- [ ] **Step 2: Run the identity tests and confirm the RED state**

Run:

```powershell
cd frontend
npm run test:unit -- src/lib/gramjsLogging.test.ts
```

Expected: FAIL because the constructor has no display-name argument and `accountName` does not exist.

- [ ] **Step 3: Add identity state to `TelegramClientManager`**

In `frontend/src/lib/gramjs.ts`, add the property and setter:

```ts
accountId: number;
accountName: string;

constructor(accountId = 0, accountName = '') {
  this.accountId = accountId;
  this.accountName = accountName.trim();
}

setAccountIdentity(accountId: number, accountName?: string | null): void {
  this.accountId = accountId;
  if (accountName?.trim()) this.accountName = accountName.trim();
}
```

When `doInitialize()` resolves `getMe()`, update both values without changing connection behavior:

```ts
if (myself.id != null) {
  this.setAccountIdentity(
    Number(myself.id),
    myself.username || myself.firstName || String(myself.id),
  );
}
```

Change pool construction and adoption:

```ts
export function getClientFor(accountId: number): TelegramClientManager {
  let c = clients.get(accountId);
  if (!c) {
    const stored = loadAccounts().find((account) => account.id === accountId);
    c = new TelegramClientManager(accountId, stored?.label ?? '');
    clients.set(accountId, c);
  }
  return c;
}

export function adoptClient(
  accountId: number,
  manager: TelegramClientManager,
  accountName?: string | null,
): void {
  manager.setAccountIdentity(accountId, accountName);
  clients.set(accountId, manager);
}
```

- [ ] **Step 4: Pass labels at all adoption sites**

In `frontend/src/App.tsx`, preserve the stored label during restored-session key correction and pass the freshly resolved login label:

```ts
adoptClient(client.accountId, client, account.label);
```

```ts
adoptClient(loginResp.user_id, client, label);
```

In `frontend/src/components/SettingsDialog.tsx`, pass the linked account label:

```ts
const accountName = linked.label ?? String(linked.telegram_user_id);
adoptClient(linked.telegram_user_id, client, accountName);
await saveAccount({
  id: linked.telegram_user_id,
  label: accountName,
  session: sessionString,
});
```

- [ ] **Step 5: Run identity tests and type-check**

Run:

```powershell
cd frontend
npm run test:unit -- src/lib/gramjsLogging.test.ts
npx tsc --noEmit
```

Expected: identity tests PASS and TypeScript exits 0.

- [ ] **Step 6: Commit identity plumbing**

```powershell
git add frontend/src/lib/gramjs.ts frontend/src/lib/gramjsLogging.test.ts frontend/src/App.tsx frontend/src/components/SettingsDialog.tsx
git commit -m "refactor(logging): retain Telegram account display names"
```

### Task 3: Prefix Adaptive Rate Logs with the Account Name

**Files:**
- Modify: `frontend/src/lib/adaptiveRateLimiter.ts:31-50,101-140,250-335`
- Modify: `frontend/src/lib/adaptiveRateLimiter.test.ts`
- Modify: `frontend/src/lib/gramjs.ts:88-126,230-232`

**Interfaces:**
- Consumes: `formatAccountLog()` from Task 1.
- Adds: `AdaptiveRateLimiterOptions.accountId?: number`
- Adds: `AdaptiveRateLimiterOptions.accountName?: string`
- Keeps: `AdaptiveRateLimiterOptions.label` as the inner component tag, such as `ChunkRate:8773541354`.
- Produces: account-prefixed `init`, `FLOOD_WAIT`, `ramp`, `creep`, and `probe` messages for consistency.

- [ ] **Step 1: Write failing rate-log tests**

Add a focused block to `frontend/src/lib/adaptiveRateLimiter.test.ts` and restore the console spy after each test:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.restoreAllMocks());

describe('account-aware diagnostics', () => {
  it('prefixes initialization and ramp logs with the account name', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const limiter = new AdaptiveRateLimiter({
      ...opts,
      accountId: 8773541354,
      accountName: 'test1',
      label: 'ChunkRate:8773541354',
    });

    limiter.reportSuccess();

    expect(log).toHaveBeenCalledWith(
      '[test1][Perf][ChunkRate:8773541354] init rate=4.0 parts/s (source=default)',
    );
    expect(log).toHaveBeenCalledWith(
      '[test1][Perf][ChunkRate:8773541354] ramp → 4.5 parts/s',
    );
  });
});
```

Update the existing Vitest import rather than adding a duplicate import statement.

- [ ] **Step 2: Run the focused test and confirm the RED state**

Run:

```powershell
cd frontend
npm run test:unit -- src/lib/adaptiveRateLimiter.test.ts
```

Expected: FAIL because the actual line starts with `[Perf]` rather than `[test1][Perf]`.

- [ ] **Step 3: Centralize limiter log formatting**

In `frontend/src/lib/adaptiveRateLimiter.ts`, import `formatAccountLog`, add `accountId?: number` and `accountName?: string` to `AdaptiveRateLimiterOptions`, and create these private helpers. The branch without `accountId` preserves the existing generic limiter output for any non-account consumer:

```ts
private formatLog(message: string): string {
  const label = this.opts.label ?? 'RateLimiter';
  if (this.opts.accountId === undefined) {
    return `[Perf][${label}] ${message}`;
  }
  return formatAccountLog(
    this.opts.accountName,
    this.opts.accountId,
    ['Perf', label],
    message,
  );
}

private log(message: string): void {
  console.log(this.formatLog(message));
}

private warn(message: string): void {
  console.warn(this.formatLog(message));
}
```

Replace each repeated `[Perf][...]` construction with `this.log(...)` or `this.warn(...)`. Keep every existing message body and logging level unchanged.

In `frontend/src/lib/gramjs.ts`, change the pacer factory signature and pass the manager identity:

```ts
function createChunkPacer(accountId: number, accountName: string): AdaptiveRateLimiter {
  return new AdaptiveRateLimiter({
    // existing rate and ceiling options stay unchanged
    storageKey: `teledrive_chunk_rate_v3_${accountId}`,
    accountId,
    accountName,
    label: `ChunkRate:${accountId}`,
  });
}
```

```ts
if (!this._chunkPacer) {
  this._chunkPacer = createChunkPacer(
    this.accountId,
    resolveAccountLogName(this.accountName, this.accountId),
  );
}
```

- [ ] **Step 4: Run focused and full limiter tests**

Run:

```powershell
cd frontend
npm run test:unit -- src/lib/accountLog.test.ts src/lib/adaptiveRateLimiter.test.ts src/lib/gramjsLogging.test.ts
```

Expected: all focused tests PASS and existing flood/pacing assertions remain unchanged.

- [ ] **Step 5: Commit account-prefixed rate logs**

```powershell
git add frontend/src/lib/adaptiveRateLimiter.ts frontend/src/lib/adaptiveRateLimiter.test.ts frontend/src/lib/gramjs.ts
git commit -m "feat(logging): prefix rate diagnostics with account names"
```

### Task 4: Raise the Adaptive Exploration Ceiling

**Files:**
- Modify: `frontend/src/config.ts:13-24,90-116`
- Modify: `frontend/src/lib/adaptiveRateLimiter.test.ts`

**Interfaces:**
- Changes: `CHUNK_RATE_MAX` from `12` to `32` parts/s.
- Keeps: `MAX_CONCURRENT_CHUNKS = 12` as the in-flight request guard.
- Keeps: `CHUNK_RATE_INIT = 4`, `CHUNK_RATE_MIN = 0.5`, ramp interval/step, FLOOD backoff, ceiling memory, persistence key, and all Telegram request behavior.
- Produces: a controller that may ramp above 12 only after successful parts and still cannot exceed 32.

- [ ] **Step 1: Write a failing test that exercises the former ceiling**

Update the imports in `frontend/src/lib/adaptiveRateLimiter.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHUNK_RATE_MAX, MAX_CONCURRENT_CHUNKS } from '../config.ts';
```

Ensure the shared cleanup restores both spies and fake timers:

```ts
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
```

Add this test:

```ts
describe('production exploration ceiling', () => {
  it('can ramp beyond 12 parts/s while retaining the 12-request concurrency guard', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const limiter = new AdaptiveRateLimiter({
      ...opts,
      initialRate: 12,
      maxRate: CHUNK_RATE_MAX,
      increaseIntervalMs: 10_000,
      ceiling: undefined,
      label: 'ChunkRate:test',
    });

    vi.advanceTimersByTime(10_000);
    limiter.reportSuccess();

    expect(CHUNK_RATE_MAX).toBe(32);
    expect(MAX_CONCURRENT_CHUNKS).toBe(12);
    expect(limiter.stats().rate).toBe(12.5);
  });
});
```

- [ ] **Step 2: Run the focused test and confirm the RED state**

Run:

```powershell
cd frontend
npm run test:unit -- src/lib/adaptiveRateLimiter.test.ts
```

Expected: FAIL because `CHUNK_RATE_MAX` is currently 12 and `reportSuccess()` returns without increasing a 12 parts/s rate.

- [ ] **Step 3: Raise only the hard safety ceiling**

In `frontend/src/config.ts`, keep `MAX_CONCURRENT_CHUNKS` unchanged and replace the rate ceiling declaration and its misleading concurrency claim with:

```ts
/**
 * Absolute safety ceiling for the adaptive per-account pacer. This must sit
 * above the normal operating range so FLOOD feedback and learned ceilings,
 * rather than this constant, determine each account's sustainable rate.
 */
export const CHUNK_RATE_MAX = 32;
```

Do not change the persistence key `teledrive_chunk_rate_v3_*`. A stored rate of 12 with no learned ceiling remains compatible: it reloads at the existing 0.8 discount and may then ramp toward 32. A stored learned ceiling remains intentionally authoritative until the existing probe logic raises it.

- [ ] **Step 4: Run the focused limiter suite and confirm GREEN**

Run:

```powershell
cd frontend
npm run test:unit -- src/lib/adaptiveRateLimiter.test.ts
```

Expected: all limiter tests PASS; the new test observes rate `12.5`, maximum `32`, and concurrency `12`.

- [ ] **Step 5: Commit the ceiling adjustment**

```powershell
git add frontend/src/config.ts frontend/src/lib/adaptiveRateLimiter.test.ts
git commit -m "perf(upload): raise adaptive rate safety ceiling"
```

### Task 5: Remove Segment Scheduling Logs and Prefix Completion Logs

**Files:**
- Modify: `frontend/src/lib/gramjs.ts:508-569`
- Modify: `frontend/src/lib/gramjsLogging.test.ts`

**Interfaces:**
- Consumes: `formatAccountLog()` from Task 1.
- Changes console behavior only; `uploadSegment()` inputs, Telegram requests, return value, retries, progress callbacks, and error propagation stay unchanged.

- [ ] **Step 1: Write the failing `uploadSegment()` logging test**

Extend `frontend/src/lib/gramjsLogging.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.restoreAllMocks());

describe('uploadSegment logging', () => {
  it('emits only an account-prefixed completion line for a successful segment', async () => {
    const manager = new TelegramClientManager(8773541354, 'test1');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    Object.assign(manager as unknown as Record<string, unknown>, {
      client: {},
      initPromise: Promise.resolve(),
      sendFilePartGated: vi.fn().mockResolvedValue(undefined),
      sendFileWithOptionalThumb: vi.fn().mockResolvedValue({
        message: { id: 3 },
        hasThumbnail: false,
      }),
    });

    const file = new File([new Uint8Array([1])], 'one-byte.bin');
    await manager.uploadSegment(file, { index: 0, offset: 0, parts: 1, size: 1 });

    const lines = log.mock.calls.map(([line]) => String(line));
    expect(lines).toEqual([
      '[test1][SplitUpload:8773541354] segment 0 sent, message_id: 3',
    ]);
    expect(lines.some((line) => line.includes('parts at offset'))).toBe(false);
  });
});
```

Merge imports with the identity tests from Task 2 so the test file has one Vitest import and one GramJS import.

- [ ] **Step 2: Run the test and confirm the RED state**

Run:

```powershell
cd frontend
npm run test:unit -- src/lib/gramjsLogging.test.ts
```

Expected: FAIL because the current method logs both the scheduling line and an unprefixed completion line.

- [ ] **Step 3: Remove the verbose scheduling log**

Delete only this statement from `uploadSegment()`:

```ts
console.log(`[SplitUpload:${this.accountId}] segment ${segment.index}: ${segment.parts} parts at offset ${segment.offset}`);
```

Do not remove failed-part logs or change segment planning.

- [ ] **Step 4: Format completion as one account-prefixed string**

Replace the existing completion `console.log` with:

```ts
console.log(formatAccountLog(
  this.accountName,
  this.accountId,
  [`SplitUpload:${this.accountId}`],
  `segment ${segment.index} sent, message_id: ${msg.id}`,
));
```

This applies to every completed segment index, not only segment 0.

- [ ] **Step 5: Run focused tests and confirm GREEN**

Run:

```powershell
cd frontend
npm run test:unit -- src/lib/accountLog.test.ts src/lib/adaptiveRateLimiter.test.ts src/lib/gramjsLogging.test.ts
```

Expected: all focused tests PASS; no captured successful-upload line contains `parts at offset`.

- [ ] **Step 6: Commit split-upload log cleanup**

```powershell
git add frontend/src/lib/gramjs.ts frontend/src/lib/gramjsLogging.test.ts
git commit -m "feat(logging): simplify account upload diagnostics"
```

### Task 6: Full Automated Verification

**Files:**
- Verify only; no expected file changes.

**Interfaces:**
- Consumes: all behavior implemented in Tasks 1-5.
- Produces: automated evidence that unit, build, and isolated browser regressions pass.

- [ ] **Step 1: Verify obsolete scheduling strings are absent from production source**

Run:

```powershell
rg -n "segment .*parts at offset" frontend/src
```

Expected: exit code 1 with no matches.

- [ ] **Step 2: Run the complete frontend unit suite**

Run:

```powershell
cd frontend
npm run test:unit
```

Expected: exit code 0; all Vitest tests PASS.

- [ ] **Step 3: Build the frontend**

Run:

```powershell
cd frontend
npm run build
```

Expected: TypeScript and Vite build exit 0.

- [ ] **Step 4: Start services on the locked ports**

Use the repository commands from `AGENTS.md` to stop stale listeners, then start:

```powershell
cd backend
python main.py
```

```powershell
cd frontend
npm run dev -- --port 3000 --strictPort
```

Expected: backend listens on 8000 and frontend listens on 3000.

- [ ] **Step 5: Run Playwright automated regression verification**

Use Playwright MCP against `http://localhost:3000` to open the isolated test flow, capture browser console errors, and verify the authenticated drive shell renders. Do not perform manual clicking or a real Telegram upload; exact upload-log output is covered deterministically by Vitest.

Then run the repository suite:

```powershell
cd frontend
npm run test:e2e
```

Expected: isolated Playwright project PASS with no new browser console errors caused by account identity or logging changes.

- [ ] **Step 6: Review the final diff without changing unrelated work**

Run:

```powershell
git -c safe.directory=D:/python/teledrive diff -- frontend/src/lib/accountLog.ts frontend/src/lib/accountLog.test.ts frontend/src/lib/adaptiveRateLimiter.ts frontend/src/lib/adaptiveRateLimiter.test.ts frontend/src/lib/gramjs.ts frontend/src/lib/gramjsLogging.test.ts frontend/src/App.tsx frontend/src/components/SettingsDialog.tsx
git -c safe.directory=D:/python/teledrive status --short
```

Expected: only the planned logging/identity changes are attributable to this work; pre-existing user changes remain intact.

- [ ] **Step 7: Commit any final test-only adjustment, if one was necessary**

If verification required a scoped test adjustment, commit only its listed files:

```powershell
git add frontend/src/lib/accountLog.test.ts frontend/src/lib/adaptiveRateLimiter.test.ts frontend/src/lib/gramjsLogging.test.ts
git commit -m "test(logging): cover account-aware upload output"
```

If no adjustment was necessary, do not create an empty commit.
