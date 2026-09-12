# Large Shared-Channel Migration Batching Design

**Date:** 2026-09-12  
**Status:** Proposed  
**Scope:** Make the existing Saved Messages → shared private broadcast channel migration usable with at least 65,830 metadata rows while retaining SQLite and browser-owned Telegram transfers.

## Context

The current production drive contains roughly 65,830 Saved Messages file rows. Creating a dry-run manifest timed out at nginx/Cloudflare and then blocked unrelated metadata requests.

The failure is caused by application query shape, not SQLite capacity:

1. `create_migration_manifest` reads every source row and performs one awaited `INSERT` per item.
2. It then returns `get_migration_job`, which hydrates every item and executes an evidence query per item.
3. `list_migration_jobs` repeats the same full hydration for every job.
4. The browser runner loads all items and reloads the entire job after every group, producing near-O(N²) work and unbounded JSON responses.

One dry-run job with 65,829 items already exists. It contains metadata only and must remain readable after this change without being executed as a real migration.

## Constraints

- Telegram media bytes and sessions remain in the browser through GramJS.
- Python remains a SQLite metadata service and performs no Telegram RPC.
- SQLite remains the database. PostgreSQL is explicitly out of scope and would conflict with the repository's current architecture constraint.
- A migration runs while the maintenance page is open. Closing or reloading the page stops new work; reopening it resumes from persisted operations, leases, and item states.
- Split-file parts move atomically as one group.
- No retry may blindly repeat a Telegram side effect. Existing persisted operation IDs and random IDs remain authoritative.
- The existing database schema is upgraded additively. No file-location rows or existing migration jobs are deleted.

## Considered approaches

### 1. Increase nginx/Cloudflare timeouts

Rejected. It hides the first timeout but retains 130k-plus queries, huge responses, single-connection starvation, and the runner's O(N²) reload behavior.

### 2. Move to PostgreSQL

Rejected for this change. PostgreSQL would not fix the unbounded API contract or runner algorithm. It would also require a separate replacement of the connection layer, SQL dialect, schema management, deployment, backups, and tests.

### 3. SQLite summaries plus group-bounded pull processing

Selected. SQLite can handle this metadata volume when set-based writes and bounded reads are used. The browser pulls a small number of complete groups, processes one group at a time, and resumes by querying current server state rather than retaining a 65k-item client snapshot.

## Backend design

### Set-based manifest creation

`create_migration_manifest` will:

1. Validate and freeze the current channel target in a short `BEGIN IMMEDIATE` transaction.
2. Insert the job row.
3. Populate `storage_migration_items` with one `INSERT INTO … SELECT` from `files`. SQLite `json_object` constructs the immutable source-location snapshot in SQL.
4. Commit before hydrating any response.
5. Return a bounded job summary.

The number of SQL statements is constant with respect to file count. Manifest creation does not materialize all file rows in Python.

### Job summary contract

Create, list, and get-job endpoints return `StorageMigrationJobSummary`, containing:

- immutable job identity and frozen target fields;
- job state and version;
- `dry_run`;
- `total_items` and `total_groups`;
- counts grouped by item state;
- the earliest future `retry_at`, if any;
- timestamps.

They never embed the complete `items` array. Summary response size is independent of migration size.

### Bounded group endpoints

Add owner-scoped endpoints:

- `GET /storage-migrations/{migration_id}/groups?scope=runnable&limit=25`
- `GET /storage-migrations/{migration_id}/groups?scope=applied&after=<group_id>&limit=25`
- `POST /storage-migrations/{migration_id}/groups/{group_id}/claim`

`scope=runnable` selects complete groups that currently contain actionable states, excludes active foreign leases, and excludes `retryable` items whose `retry_at` is still in the future. Because completed groups leave the runnable set, the runner does not need a long-lived cursor and cannot skip an earlier retry.

The browse/rollback form uses keyset pagination by `group_id`. Every response includes complete items for the selected groups and their evidence, loaded with bounded bulk queries rather than per-item queries.

Group claim validates every expected item version and atomically leases all nonterminal parts to one browser run ID. It either claims the complete group or changes nothing. Existing item mutation endpoints remain owner-scoped and CAS-protected.

### Bounded mutation responses

Item mutations return one item. Group claim/commit/rollback return one group result plus a job summary. No mutation returns every job item.

Add indexes supporting `(migration_id, state, retry_at, group_id)` and `(migration_id, group_id, part_index, item_id)`. Existing indexes remain compatible.

### Transaction behavior

No transaction is held while producing a large JSON response. Set-based manifest creation may briefly hold a write transaction, but all later Telegram work occurs outside backend transactions. Each item/group CAS transaction remains short.

## Browser runner design

The maintenance page stores only job summaries and the currently active group.

When the user clicks **執行 / 繼續**:

1. Generate a browser-run UUID kept in memory for this tab.
2. Request up to 25 runnable groups.
3. Atomically claim one complete group.
4. Process its items sequentially with the existing operation journal and frozen random IDs.
5. Collect fresh destination-read evidence from linked accounts.
6. Commit the complete group only after every part has quorum.
7. Refresh the small job summary and request the next runnable group.
8. Stop when the job completes, only future retries remain, no eligible account is online, or the user pauses/closes the page.

The UI exposes **暫停**. Pausing prevents new claims and waits for the current request boundary; it does not cancel an already-issued Telegram RPC. A reload creates a new browser-run UUID. Expired leases become reclaimable, and persisted operation/random-ID recovery prevents blind duplicate sends.

Telegram calls remain sequential per source account. Existing flood/retry classification persists `retry_at`; the UI displays the next retry time instead of spinning.

### Progress display

The page displays:

- total groups/items;
- counts for planned, in-flight, waiting-for-retry, verified, applied, failed, and rolled-back states;
- current group and source account;
- last error and next retry time;
- start/continue, pause, refresh, and rollback controls.

It does not render tens of thousands of item IDs in the DOM.

## Dry run and existing jobs

- A dry run uses the same set-based snapshot but performs no Telegram operation.
- The existing 65,829-item dry-run job remains visible as a summary after deployment.
- A fresh real migration should be created after the batching fix so its snapshot includes files added after the earlier dry run.
- Repeated dry runs remain inert; no automatic deletion is introduced in this change.

## Rollback

Rollback uses the same bounded group pagination. Before each group rollback, the browser refreshes source-read evidence for all applied parts. The backend then applies the existing location-version CAS atomically for the complete group. Closing the page pauses rollback and reopening resumes from remaining applied groups.

## Error handling

- HTTP 409 reloads only the affected group and job summary.
- An active foreign lease causes the runner to move to another eligible group.
- `FLOOD_WAIT` or transient Telegram errors persist a retryable state and timestamp.
- An unavailable source account leaves the item resumable and does not select another account for `@me` source data.
- An uncertain Telegram result performs frozen-identity read-only reconciliation before any replay.
- Zero readers or writers pauses the runner without falling back to Saved Messages.
- Failed or blocked groups remain visible in summary counts and never prevent unrelated metadata API requests.

## Verification strategy

### Backend

- A regression fixture creates 65,830 Saved Messages rows.
- Manifest creation is asserted to use a bounded SQL path and return only a summary.
- Job list/get response shape and query count remain constant as item count increases.
- Group pages are bounded, deterministic, owner-scoped, and never split one group.
- Group claim is atomic under version conflict and competing lease owners.
- Existing uncertain recovery, quorum, commit, unlink-race, split atomicity, and rollback tests remain green.
- Concurrent normal metadata reads are verified not to wait on response hydration after manifest commit.

Timing assertions are diagnostic only; correctness is enforced through bounded query/response behavior rather than fragile wall-clock thresholds.

### Frontend

- Unit tests cover repeated bounded pulls, pause, reload/resume, retry scheduling, 409 refresh, expired-lease recovery, and no full-job reload inside the loop.
- Isolated Playwright tests cover a multi-page migration, progress summaries, pause/resume after reload, split-group atomicity, and rollback pagination.
- Test hooks assert that backend requests contain metadata only and Telegram bytes never reach port 8000.

### Production rollout

1. Preserve the verified SQLite backup made before this work.
2. Run backend, frontend unit, type/build, and isolated Playwright suites.
3. Restart the currently blocked backend only after the corrected code is ready.
4. Rebuild backend/frontend and recreate frontend/cloudflared together.
5. Confirm the old dry-run appears as a bounded summary.
6. Create a fresh dry run, then a fresh real migration.
7. Start with the page open and monitor the first few groups before leaving the resumable runner active.

## Acceptance criteria

- Creating or listing a 65,830-item migration returns a bounded summary without nginx/Cloudflare timeout.
- Normal file/folder metadata requests remain responsive.
- No job endpoint sends an unbounded item array.
- The browser never holds all migration items at once and never reloads the full job after each group.
- Closing and reopening the page resumes without a blind duplicate Telegram send.
- Split files commit or roll back as complete groups.
- Telegram bytes remain browser-only and the backend remains SQLite metadata-only.
