# Batched Storage Migration Implementation Plan

> **Goal:** Replace unbounded storage-migration hydration with set-based manifest creation, bounded job summaries, complete-group pagination/claiming, and a browser runner that holds only one bounded group at a time.

**Architecture:** Keep the existing SQLite metadata journal, Telegram operation journal, quorum validation, location CAS, and browser-only GramJS data path. Backend changes are query-shape/API-contract changes only. Frontend changes pull complete groups in bounded pages and reuse the existing per-item operation recovery logic.

**Tech stack:** FastAPI, Pydantic v2, aiosqlite/SQLite JSON1, React/TypeScript, Axios, Vitest, Playwright.

---

## Task 1: Lock the bounded backend contract with failing tests

**Files:**
- Modify: `backend/tests/test_storage_migration.py`
- Modify: `backend/tests/test_storage_migration_partial_rollback.py`
- Add: `backend/tests/test_storage_migration_batching.py`

**Steps:**
1. Update existing migration tests so job create/get/list assertions expect summaries rather than `items` arrays.
2. Fetch item details through the new group listing contract in tests that need them.
3. Add a 65,830-row set-based fixture and assert manifest creation returns `total_items`, `total_groups`, state counts, and no `items` field.
4. Add query-shape regression assertions showing create/get/list use a bounded number of SQL statements rather than row-count-proportional hydration.
5. Add runnable/applied group pagination tests covering deterministic ordering, `limit`, keyset `after`, owner isolation, and complete split groups.
6. Add group-claim tests proving all-or-nothing CAS under stale item versions and competing active leases.
7. Run focused backend tests and confirm they fail because the new summary/group APIs do not exist yet.

## Task 2: Implement set-based manifest creation and bounded summaries

**Files:**
- Modify: `backend/app/services/storage_migration.py`
- Modify: `backend/app/services/database.py`
- Modify: `backend/app/models/schemas.py`
- Modify: `backend/app/api/routes.py`

**Steps:**
1. Add the two migration-item indexes required by runnable-state/group scans.
2. Replace Python row hydration + per-item inserts with one `INSERT INTO storage_migration_items … SELECT … FROM files`, using SQLite `json_object` for the immutable source snapshot.
3. Commit before response construction.
4. Replace `get_migration_job`/`list_migration_jobs` full hydration with a constant-size summary aggregate containing totals, per-state counts, earliest future retry, frozen target data, and timestamps.
5. Keep old dry-run rows readable through the same aggregate contract.
6. Run focused backend tests.

## Task 3: Implement complete-group reads, atomic claims, and bounded mutation responses

**Files:**
- Modify: `backend/app/services/storage_migration.py`
- Modify: `backend/app/services/database.py`
- Modify: `backend/app/models/schemas.py`
- Modify: `backend/app/api/routes.py`

**Steps:**
1. Add a bulk group loader that fetches complete items and evidence using bounded bulk queries rather than evidence-per-item queries.
2. Add `GET /storage-migrations/{migration_id}/groups` with `scope=runnable|applied`, `limit<=25`, and keyset `after` for applied groups.
3. Ensure runnable selection rejects dry runs, future retries, blocked/failed groups, and active leases; expired leases remain reclaimable.
4. Add `POST /storage-migrations/{migration_id}/groups/{group_id}/claim` with expected versions, run UUID, and lease duration; validate every item before any update and lease every nonterminal item atomically without manufacturing Telegram operation IDs.
5. Change commit/rollback to return `{group, job}` instead of a fully hydrated job.
6. Run focused backend and authorization tests.

## Task 4: Lock the bounded frontend runner with failing tests

**Files:**
- Add: `frontend/src/maintenance/migrateSavedMessagesToChannel.test.ts`
- Modify: `frontend/tests/isolated/storage-migration.spec.ts`

**Steps:**
1. Add unit tests for repeated `limit=25` runnable pulls, one-group-at-a-time claim, no full-job reload inside the loop, pause before the next claim, conflict summary refresh, and applied-group rollback pagination.
2. Update isolated API fakes to return job summaries plus bounded group pages/claim results.
3. Add a multi-page migration case and ensure the browser never requires a full `items` list.
4. Run Vitest/Playwright gates and confirm the new runner tests fail against the old implementation.

## Task 5: Implement bounded frontend API contracts and runner

**Files:**
- Modify: `frontend/src/api/client.ts`
- Modify: `frontend/src/maintenance/migrateSavedMessagesToChannel.ts`
- Modify: `frontend/src/maintenance/StorageMigrationPage.tsx`

**Steps:**
1. Replace `StorageMigrationJob` with a summary type containing totals, state counts, next retry, and timestamps; add bounded group/result types.
2. Add `listMigrationGroups` and `claimMigrationGroup`; change commit/rollback return types to `{group, job}`.
3. Generate one in-memory browser-run UUID per execution and claim a complete group before per-item Telegram work.
4. Process the claimed items sequentially with the existing frozen operation/random-ID recovery path and quorum evidence flow.
5. Refresh only the summary after each group, then pull the next runnable page; never rebuild a full job item snapshot.
6. Implement a pause controller that prevents new claims but does not abort an in-flight Telegram request.
7. Roll back through `scope=applied` keyset pages, one complete group at a time.
8. Render summary counts/current group/next retry instead of all item IDs.
9. Run TypeScript, unit, and isolated Playwright tests.

## Task 6: Verify regressions and repository invariants

**Files:**
- No production changes unless failures identify a defect.

**Steps:**
1. Run backend focused migration, linked-account, authz, schema, and partial rollback tests.
2. Run frontend TypeScript and migration unit tests.
3. Run isolated storage-migration Playwright coverage.
4. Confirm no request body contains file bytes, Telegram sessions, or peer credentials.
5. Confirm the 65,830-row regression test returns a bounded summary and group pages remain bounded.
6. Remove temporary patch/apply workflow files used only because this session cannot clone GitHub directly.
7. Run final CI on the cleaned implementation branch and open a pull request to `master`.
