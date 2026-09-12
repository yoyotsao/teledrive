# Storage Migration Batched Forward Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce migration Telegram RPC count by forwarding up to 100 same-source Saved Messages per request without weakening recovery, quorum, or group atomicity.

**Architecture:** Add a strict batch-result normalizer and a `TelegramClientManager.forwardBatchToTarget` primitive. Refactor the migration runner to prepare durable per-item operations first, group only fresh forward candidates by source account, send chunks of at most 100, then persist/reconcile results per item and keep existing group verification/commit boundaries.

**Tech Stack:** TypeScript, React/Vite, GramJS, Vitest

**Spec:** `docs/superpowers/specs/2026-09-12-storage-migration-batch-forward-design.md`

## Global Constraints

- Maximum 100 messages per batch.
- Never mix source Telegram accounts in one batch.
- Keep one durable operation ID and random ID per migration item.
- Do not weaken two-reader quorum or split-file group atomicity.
- Telegram bytes and sessions remain browser-only.
- No new backend schema in this change.

---

### Task 1: Normalize multi-message GramJS forward results

**Files:**
- Modify: `frontend/src/lib/forwardResult.ts`
- Test: `frontend/src/lib/forwardResult.test.ts`

**Interfaces:**
- Produces: `unwrapForwardedMessages(result: unknown, sourceMessageIds: readonly number[]): any[]`
- Preserves: `unwrapForwardedMessage(result: unknown, messageId: number): any`

- [ ] **Step 1: Write failing tests** for nested/flat two-message results, missing slots, and count mismatch.
- [ ] **Step 2: Run** `npm test -- --run src/lib/forwardResult.test.ts` from `frontend`; expected failure because `unwrapForwardedMessages` does not exist.
- [ ] **Step 3: Implement** strict normalization; flatten one GramJS source-chat nesting level, require exact cardinality, and require every slot to contain a message id. Implement the legacy one-message helper as a one-element wrapper.
- [ ] **Step 4: Re-run** the focused test; expected pass.
- [ ] **Step 5: Commit** `feat: normalize batched forward results`.

### Task 2: Add GramJS batched forward primitive

**Files:**
- Modify: `frontend/src/lib/gramjs.ts`
- Test: add `frontend/src/lib/gramjs.forwardBatch.test.ts`

**Interfaces:**
- Produces: `forwardBatchToTarget(entity, entries, targetPeer): Promise<TargetAwareSendResult[]>`, where each entry is `{ messageId: number; randomId: string }` and length is 1..100.
- Preserves: `forwardToTarget(entity, messageId, targetPeer, randomId)` as compatibility wrapper.

- [ ] **Step 1: Write failing tests** proving one call for 100 entries, rejection for 0/101 entries, parallel message/random-id vectors, and source-order result mapping.
- [ ] **Step 2: Run** the focused test; expected failure because `forwardBatchToTarget` does not exist.
- [ ] **Step 3: Implement** one rate-limited GramJS `forwardMessages` call with the existing three-attempt flood handling and strict result normalization.
- [ ] **Step 4: Re-run** focused tests plus `forwardResult.test.ts`; expected pass.
- [ ] **Step 5: Commit** `feat: batch Telegram forwards`.

### Task 3: Batch migration fresh forwards by source account

**Files:**
- Modify: `frontend/src/maintenance/migrateSavedMessagesToChannel.ts`
- Modify/Test: `frontend/src/maintenance/migrateSavedMessagesToChannel.test.ts`
- Preserve: `frontend/src/maintenance/migrateSavedMessagesToChannel.photo.test.ts`

**Interfaces:**
- Consumes: `TelegramClientManager.forwardBatchToTarget`
- Produces: runner behavior that chunks fresh `planned`/`retryable` candidates by `telegram_user_id`, max 100 per batch.

- [ ] **Step 1: Extend the runner test harness** with migration-operation methods and a Telegram hook that records batch calls.
- [ ] **Step 2: Add failing tests**: 100 same-source items => one forward call; 101 => two; mixed source accounts => separate calls; each item retains its own operation/random id and reconciled result.
- [ ] **Step 3: Run** the focused migration tests; expected failure because runner still forwards one item at a time.
- [ ] **Step 4: Refactor runner** to prepare/attach operations, save per-item recovery cursors, issue same-source chunks, persist/reconcile each result, then reuse existing evidence and group commit logic. Keep uncertain/sending/recovering recovery first.
- [ ] **Step 5: Re-run** migration unit tests; expected pass.
- [ ] **Step 6: Commit** `feat: batch storage migration forwards`.

### Task 4: Final regression verification

**Files:** No production changes expected.

- [ ] **Step 1: Run typecheck**: `npx tsc --noEmit` from `frontend`.
- [ ] **Step 2: Run focused Vitest**: `npx vitest run src/lib/forwardResult.test.ts src/lib/gramjs.forwardBatch.test.ts src/maintenance/migrateSavedMessagesToChannel.test.ts src/maintenance/migrateSavedMessagesToChannel.photo.test.ts`.
- [ ] **Step 3: Run the repository's normal frontend test command** if distinct from the focused command.
- [ ] **Step 4: Inspect final diff** for accidental backend/schema changes and confirm batch size/source-account constraints remain explicit.
- [ ] **Step 5: Commit any test-only corrections** with `test: cover batched migration forwards`.