# Batched Storage Migration Minimal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild batched Saved Messages → shared-channel migration from `master` with the smallest possible production diff, while preserving `master` upload scheduling and throughput behavior.

**Architecture:** Keep `master` as the only upload-runtime baseline. Port only bounded migration summaries/group claims, same-account Telegram forward batching, and migration-specific retry/isolation behavior. Migration may observe normal upload activity and yield, but must not alter upload scheduling, pacing, writer selection, or byte-transfer code.

**Tech Stack:** FastAPI, aiosqlite/SQLite JSON1, React/TypeScript, GramJS, Vitest, Playwright.

**Spec:** Existing shared-channel storage migration behavior on `master`, plus reviewed migration-only behavior from `feat/batched-storage-migration`.

## Global Constraints

- Base every implementation change on `master`.
- Do not cherry-pick the old branch wholesale; use it only as a behavior/patch reference.
- Do not modify `frontend/src/lib/durableUploadRuntime.ts`.
- Do not modify `frontend/src/lib/splitUpload.ts`.
- Do not modify `frontend/src/lib/accountPool.ts`.
- Do not modify `frontend/src/lib/segmentScheduler.ts`.
- Do not modify `frontend/src/config.ts` upload pacing/concurrency constants.
- Do not modify `frontend/src/components/ChonkyDrive.tsx` upload behavior.
- `frontend/src/lib/gramjs.ts` may only gain migration forward batching/result handling; upload methods and limiters stay equivalent to `master`.
- Migration may read `accountActivityRegistry` and yield to normal uploads; it must never reserve, pause, penalize, cancel, or mutate upload activity.
- Preserve one durable Telegram operation ID and one random ID per migration item.
- Never mix different source Telegram accounts in one forward batch.
- Preserve split-file group atomicity and verification quorum.
- Use a runner batch size of 25 items even though the GramJS primitive may support up to 100.

---

### Task 1: Keep bounded migration processing

- [x] Reuse the clean migration-only commits through `64478d0` (bounded backend summaries/groups, bounded frontend runner, batch-forward primitive, transient retry behavior).
- [ ] Verify backend scale/group contracts still pass.

### Task 2: Port only the later migration fixes

- [ ] Refresh stale quorum evidence before backend freshness expiry.
- [ ] Isolate known missing forward mappings; recursively bisect unknown count mismatches.
- [ ] Park only the irreducible failed subset while successful subsets keep progressing.
- [ ] Include future `retry_at` on retryable operation transitions and handle 409 CAS races with one bounded refresh/retry.

### Task 3: Protect normal uploads

- [ ] Add a failing regression proving migration yields before claiming/sending when the source account is busy.
- [ ] Make migration read `accountActivityRegistry.isTrulyIdle(accountId)` without mutating upload activity.
- [ ] Keep batch size at 25 to limit one migration burst.

### Task 4: Regression gates

- [ ] Zero diff vs `master` for `durableUploadRuntime.ts`, `splitUpload.ts`, `accountPool.ts`, `segmentScheduler.ts`, `config.ts`, and `ChonkyDrive.tsx`.
- [ ] `gramjs.ts` diff is limited to migration forward batching/result handling.
- [ ] Run focused backend migration tests, frontend typecheck, migration tests, and the repository normal suite.
- [ ] Browser A/B normal upload throughput against `master` before merging.
