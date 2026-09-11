# Storage Migration Batched Forward Design

**Date:** 2026-09-12
**Status:** Approved
**Scope:** Reduce Saved Messages → shared-channel migration RPC count by batching Telegram forwards while preserving the existing item journal, recovery, quorum, and group-atomic commit semantics.

## Goals

- Forward up to 100 Saved Messages in one Telegram `forwardMessages` request when they share the same source account and frozen target channel.
- Keep one durable `operation_id` and `random_id` per migration item.
- Preserve read-only recovery before any replay of an uncertain/in-flight operation.
- Preserve split-file group atomicity at backend commit/rollback boundaries.
- Keep Telegram bytes and session state browser-owned.

## Non-goals

- No new multi-account concurrency in this change.
- No quorum weakening.
- No backend schema change unless an existing contract proves insufficient.
- No attempt to batch items from different source accounts into one Telegram RPC.

## Batch model

The runner may prepare multiple runnable groups and flatten their actionable items into source-account batches. A batch contains at most 100 items and every item shares the same `telegram_user_id` and target channel. Batch order follows the claimed group/item order so persisted progress remains deterministic.

Before the Telegram RPC, every item in the batch must have a durable migration operation with its own frozen random ID and must be leased/attached to that operation. The browser then issues one `forwardMessages` request with parallel `messages[]` and `randomId[]` vectors.

The batch result is mapped back by position only after validating that Telegram returned exactly one forwarded message per source item. Each result is then persisted and reconciled through the existing per-item metadata endpoints. A malformed or incomplete batch response is treated as uncertain: the runner must not invent new random IDs or blindly resend individual items.

## GramJS adapter

`TelegramClientManager` gains a `forwardBatchToTarget` method accepting up to 100 `{messageId, randomId}` entries. `forwardToTarget` remains as a compatibility wrapper over a one-item batch.

A pure helper in `forwardResult.ts` normalizes both observed GramJS nested results (`[[msg1, msg2, ...]]`) and its declared flat result (`[msg1, msg2, ...]`). The helper rejects missing slots and count mismatches so callers never silently associate the wrong destination message with a source item.

## Runner integration

The migration runner keeps the existing bounded group pull/claim loop and group commit rules. For newly planned/retryable items it:

1. Ensures and attaches durable operations for the candidate items.
2. Groups candidates by source account.
3. Chunks each source-account list to at most 100.
4. Saves recovery cursors for every operation before the RPC.
5. Issues one batch forward RPC per chunk.
6. Persists/reconciles each returned result using that item's existing operation/result version flow.
7. Collects verification evidence and commits each complete group only when all its parts are verified.

Sending/recovering/uncertain items continue through the existing read-only recovery path first. They are not mixed into a fresh batch unless recovery proves no durable result and replay is safe with their frozen operation/random ID.

## Error handling

- A batch may never contain items from different source accounts.
- Empty batches and batches larger than 100 are rejected before Telegram is called.
- Result count mismatch or a missing result slot fails the batch without assigning results to later items.
- `FLOOD_WAIT` keeps the existing account-level message limiter behavior; full retry-at persistence remains a separate follow-up.
- HTTP 409 remains a bounded refresh/retry concern and does not justify creating new operation/random IDs.

## Verification

Unit coverage must prove:

- 100 source messages produce one Telegram forward call.
- 101 source messages are split into two calls.
- Different source accounts never share one batch.
- Nested and flat GramJS result shapes map one-to-one in source order.
- Missing/mismatched result slots are rejected.
- Existing one-item `forwardToTarget` behavior remains compatible.
- Existing bounded migration, photo migration, recovery, quorum, and group-atomic tests remain green.

TypeScript type-checking must pass before completion.