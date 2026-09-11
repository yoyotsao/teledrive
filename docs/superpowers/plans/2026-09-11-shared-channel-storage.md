# Shared Channel Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow every owner to store and retrieve TeleDrive files through one configured private Telegram broadcast channel while preserving direct browser-to-Telegram transfers, durable recovery, and safe migration from Saved Messages.

**Architecture:** The Python service remains an owner-scoped SQLite metadata and concurrency authority; it never receives file bytes or Telegram credentials. The browser persists frozen Telegram operation intent before GramJS sends, then atomically records canonical Telegram locations after it has an authoritative result. A resolver in the main window selects an eligible linked Telegram account for every read, while a journaled maintenance flow migrates metadata only after independently verified channel copies exist.

**Tech Stack:** FastAPI, SQLite, Python pytest; React/TypeScript, GramJS, IndexedDB, Vitest, Playwright isolated tests.

**Spec:** `docs/superpowers/specs/2026-09-11-shared-channel-storage-design.md`

## Global Constraints

- Binary data MUST NOT touch the Python backend (port 8000); all transfer bytes travel Telegram CDN ↔ Browser through GramJS.
- Backend persists SQLite metadata only and all metadata endpoints are owner-scoped.
- Backend port is 8000 and frontend port is 3000. Product configuration exposed to Vite uses the `VITE_` prefix; Telegram test sessions, test-owner credentials, and CI-only auth material are secrets and MUST NOT use `VITE_`.
- A channel target is an existing private broadcast channel represented in SQLite/API by its canonical raw positive channel ID. The UI accepts a marked `-100…` channel ID and converts it with BigInt arithmetic before save; it must not reject that presentation form. Do not persist an invite link or an arbitrary entity object.
- The five-minute verification TTL is a save/enable precondition only: first enable requires primary and every linked account to pass fresh read/write verification. Runtime resolution and upload select from managers currently linked, locally available, and live at that moment; they never revive an expired enable summary. Account add/remove/relogin invalidates only the next save attempt.
- Runtime state is explicit: one or more live writers/readers permits the corresponding operation; zero writers retains the channel target and reports `UPLOAD_UNAVAILABLE` without falling back to `@me`; zero readers retains metadata/target and reports recoverable `READ_UNAVAILABLE` without `@me` fallback.
- Never send a normal upload, album, split part, chat import, or migration forward to `@me` when its frozen storage target is the channel. `@me` locations are readable only through their original storage account.
- Persist every Telegram-producing intent before its RPC with frozen uploader, target peer/channel, operation/manifest version, owner, source identity, and per-message `random_id`. `random_id` is a recovery key, not a promise of permanent Telegram-side deduplication: on `RANDOM_ID_DUPLICATE` reduce authoritative results/updates first and never blindly resend an `uncertain` operation.
- Store logical file ID separately from canonical location: chat ID, message ID, media kind, media ID, media size, optional photo variant, and monotonic `location_version`.
- Every direct reader (download, thumbnail, video preview, range/SW bridge) uses the one location resolver. A stale location reply must be rejected and an unavailable main window returns `CLIENT_UNAVAILABLE` without treating it as Telegram bytes.
- Purge deletes metadata only and writes tombstones. Unlink must reject only an account that remains the sole reader of an `@me` location, not accounts merely named by channel-backed rows.
- Current target/accounts versions are CAS preconditions only when creating an operation or migration manifest. After a Telegram side effect, registration/apply binds the immutable frozen operation/manifest, owner, tombstone and source/location CAS; a later global setting/account version alone must not reject it. Commit still requires currently linked authorized evidence and fresh reads, so unlink/evidence revocation can block quorum without making a settings switch block a completed send.
- Migration is metadata-journaled and supports dry-run, apply, resume, and rollback. Its source account forwards its own source message; every migration item and every split part needs evidence from two distinct linked accounts including one non-uploader before atomic apply. Telegram reconciliation is browser-owned: GramJS reads frozen identity, the browser persists JSON mapping/media metadata to the existing operation journal, then the backend performs a metadata-only CAS state transition.
- The migration UI is discoverable only when `VITE_ENABLE_STORAGE_MIGRATION` is enabled. It must never expose a backend proxy path.
- No secret may appear in `VITE_*`, a URL/query string, frontend API payload, bundle/build output, console/log output, Playwright trace/video/screenshot/artifact, or committed fixture. Missing real-Telegram configuration must fail closed before backend, frontend, Playwright, IndexedDB, session storage, or Telegram start.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `backend/app/services/database.py` | Additive schema, owner-scoped storage, operation and migration repositories, CAS transactions. |
| `backend/app/models/schemas.py`, `backend/app/services/file_service.py`, `backend/app/api/routes.py` | Typed owner-scoped metadata APIs and compatibility mapping. |
| `frontend/src/lib/storageLocation.ts` | Canonical IDs and serializable file-location contracts. |
| `frontend/src/lib/telegramOperationRecovery.ts` | Persistent operation reducer and recovery cursor. |
| `frontend/src/lib/channelStorage.ts`, `frontend/src/lib/fileLocationResolver.ts` | Channel verification and unified account/location read selection. |
| `frontend/src/lib/gramjs.ts` | Frozen-target sends/forwards and authoritative media identity extraction. |
| `frontend/src/lib/download.ts`, `frontend/src/components/ChonkyDrive.tsx`, `frontend/src/main.tsx` | Resolver consumers and main-window stream bridge. |
| `frontend/src/components/SettingsDialog.tsx` | Strict channel-target settings experience after actual upload/import/read paths are target-aware. |
| `frontend/src/maintenance/*` | Feature-gated journaled migration runner and maintenance page. |

### Task 1: Canonical storage-location contracts

**Files:**
- Create: `frontend/src/lib/storageLocation.ts`
- Create: `frontend/src/lib/storageLocation.test.ts`
- Modify: `frontend/src/types/index.ts: FileInfo`
- Modify: `frontend/tests/support/fakeDrive.ts: FakeDrive.Row`

**Interfaces:**
- Consumes: none.
- Produces: `parseChannelInput(input: string): CanonicalChannelId`, `parseCanonicalChannelId(raw: string): CanonicalChannelId`, `locationKey(location: FileLocation): string`.
- Produces: `StorageTarget`, `FileLocation`, `MediaIdentity`, and `StreamLocationRequest` with JSON-serializable IDs.

- [ ] **Step 1: Write failing unit tests** for accepting positive raw IDs and marked `-100…` IDs, including `-1001234567890 => "1234567890"` and `-1000000000001 => "1"`; reject links/zero/other negatives, reject marked IDs in `parseCanonicalChannelId`, and distinguish cache keys by `location_version`.
- [ ] **Step 2: Run the focused test.** Run: `cd frontend && npm run test:unit -- src/lib/storageLocation.test.ts`. Expected: FAIL because the module does not exist.
- [ ] **Step 3: Implement the smallest typed contract.** `parseChannelInput` accepts display syntax and, for a marked ID, returns `(-BigInt(marked) - 1000000000000n).toString()`; `parseCanonicalChannelId` accepts only a positive raw API value. Use `storage_mode: 'saved_messages' | 'channel'`; make `FileLocation` contain `telegram_chat_id`, `telegram_message_id`, `media_kind`, `media_id`, `media_size`, `photo_variant?`, and `location_version`. Extend `FileInfo` and FakeDrive rows with these fields while retaining legacy `telegram_user_id`, `message`, and `access_hash` compatibility.
- [ ] **Step 4: Run the focused test again.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add frontend/src/lib/storageLocation.ts frontend/src/lib/storageLocation.test.ts frontend/src/types/index.ts frontend/tests/support/fakeDrive.ts && git commit -m "feat: add canonical storage location contracts"`

### Task 2: Additive SQLite location and target schema

**Files:**
- Modify: `backend/app/services/database.py: Database.init_schema, insert_file, count_files_on_account`
- Modify: `backend/app/models/schemas.py: FileInfo, RegisterFileRequest`
- Modify: `backend/app/services/file_service.py: FileService.register_uploaded_file`
- Modify: `backend/tests/test_schema_migration.py`
- Modify: `backend/tests/test_linked_accounts.py`

**Interfaces:**
- Consumes: Task 1's canonical location fields and existing owner/link transactions.
- Produces: `Database.get_storage_target(owner_id)` and `Database.put_storage_target(owner_id, target, expected_version, expected_accounts_version, verifications)`; verification rows contain `channel_title`, normalized canonical `channel_id`, `can_read`, `can_write`, `status`, `checked_at`, and `accounts_version` for each account.
- Produces: location-aware FileInfo fields matching Task 1 exactly.

- [ ] **Step 1: Add failing legacy-schema/account tests** that initialize existing database fixtures, run `init_schema`, preserve legacy rows, and verify nullable/default location fields; include two owners to prove target isolation. Test successful link/unlink incrementing `accounts_version` in the same transaction, unlink rejection for trashed `@me` rows and each split part, and allowed unlink for channel-only historical uploader rows with another reader.
- [ ] **Step 2: Run:** `cd backend && python -m pytest tests/test_schema_migration.py -q`. Expected: FAIL on missing columns/tables.
- [ ] **Step 3: Add only additive migrations.** Add file location columns and `location_version`, an owner-scoped `storage_targets` row with `version`, and normalized per-account verification rows (`channel_title`, `channel_id`, `can_read`, `can_write`, `status`, `checked_at`, `accounts_version`). Add an owner `accounts_version`; link and unlink each increment it in their successful SQLite transaction. Do not use `INSERT OR REPLACE` for location writes; implement versioned updates.
- [ ] **Step 4: Replace `count_files_on_account` semantics** with a transactionally consistent dependency query that counts every non-purged `@me` location whose `telegram_user_id` equals the candidate account, including trashed rows and every split part; exclude channel rows. The unlink transaction must recheck this query immediately before delete and increment `accounts_version` only on success.
- [ ] **Step 5: Run the focused tests.** Run: `cd backend && python -m pytest tests/test_schema_migration.py tests/test_linked_accounts.py -q`. Expected: PASS. Commit with `git add backend/app/services/database.py backend/app/models/schemas.py backend/app/services/file_service.py backend/tests/test_schema_migration.py backend/tests/test_linked_accounts.py && git commit -m "feat: persist storage targets and file locations"`.

### Task 3: Owner-scoped storage target API with TTL/CAS

**Files:**
- Modify: `backend/app/api/routes.py` (the existing authenticated router containing account endpoints)
- Modify: `backend/app/models/schemas.py`
- Modify: `backend/app/services/database.py`
- Modify: `frontend/src/api/client.ts`
- Modify: `backend/tests/test_api_accounts.py`
- Create: `backend/tests/test_api_authz.py`

**Interfaces:**
- Consumes: Task 2 target/version storage and existing JWT owner middleware.
- Produces: `StorageTargetPutRequest { storage_mode, channel_id?, expected_version, expected_accounts_version, verifications }`.
- Produces: `api.getStorageTarget(): Promise<StorageTargetResponse>` and `api.putStorageTarget(request): Promise<StorageTargetResponse>`. These endpoints persist/return a target and enable-time audit summary only; no caller may use the returned verification rows as runtime authorization.

- [ ] **Step 1: Write failing API and authorization tests** for owner authorization, stale target version, stale account version, missing primary verification, missing linked verification, future timestamp, and a verification older than five minutes. Add the cross-owner GET/PUT cases to `tests/test_api_authz.py`.
- [ ] **Step 2: Run RED checks:** `cd backend && python -m pytest tests/test_api_accounts.py -q` and `cd backend && python -m pytest tests/test_api_authz.py -q`. Expected: both FAIL because endpoints/contracts are absent.
- [ ] **Step 3: Implement `GET`/`PUT` storage-target endpoints.** Accept only a canonical positive raw channel string, validated in Python to the same grammar as Task 1's `parseCanonicalChannelId` (the UI has already converted marked IDs), require a complete current linked-account set including primary, and inside one `BEGIN IMMEDIATE` transaction recheck owner, `expected_version`, `expected_accounts_version`, normalized per-account title/status/read/write records, and `checked_at >= now - 300 seconds` before updating. The backend never receives or validates `sessionGeneration`, session strings, access hashes, or bytes. Expiry makes a new save invalid; it does not disable a previously saved channel target.
- [ ] **Step 4: Add client methods and run GREEN checks:** `cd backend && python -m pytest tests/test_api_accounts.py -q` and `cd backend && python -m pytest tests/test_api_authz.py -q`. Expected: both PASS.
- [ ] **Step 5: Commit.** `git add backend/app/api/routes.py backend/app/models/schemas.py backend/app/services/database.py frontend/src/api/client.ts backend/tests/test_api_accounts.py backend/tests/test_api_authz.py && git commit -m "feat: add versioned storage target settings"`

### Task 4: Durable Telegram operation repository

**Files:**
- Modify: `backend/app/services/database.py`
- Create: `backend/tests/test_telegram_operations.py`

**Interfaces:**
- Consumes: Task 2 owner/location schema and target/account versions.
- Produces: `create_or_get_telegram_operation(owner_id, payload)`, `claim_telegram_operation(owner_id, operation_id, lease_owner)`, `record_operation_mapping(...)`, and `complete_operation_result(...)`.
- Produces states `planned`, `sending`, `recovering`, `retryable`, `uncertain`, `sent`, `registered`, `committed`, plus terminal `tombstoned`, with the shared-operation transition table in the spec.

- [ ] **Step 1: Write failing repository tests** for immutable frozen payloads, `(uploader_id, random_id)` uniqueness, duplicate idempotency, conflicting payload rejection, expired lease reclaim, cross-owner access rejection, and every `retryable`/`uncertain` transition. In particular, prove `uncertain` cannot become `sent` except through a later expected-version reconcile result with complete frozen mapping/media identity.
- [ ] **Step 2: Run:** `cd backend && python -m pytest tests/test_telegram_operations.py -q`. Expected: FAIL because the repository is absent.
- [ ] **Step 3: Add `telegram_operations` and mapping tables/indexes.** Persist random IDs as strings, immutable frozen target, owner, source identity, creation target/accounts versions, retries, lease, result mapping, and tombstone reason; allow only explicit state transitions. Creation performs target/accounts CAS; later post-send transitions use operation version/owner/tombstone/source/location CAS and must not compare a newly changed global setting/account version.
- [ ] **Step 4: Run the focused test.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add backend/app/services/database.py backend/tests/test_telegram_operations.py && git commit -m "feat: persist recoverable telegram operations"`

### Task 5: Operation registration and early metadata-only location-switch primitive

**Files:**
- Modify: `backend/app/api/routes.py`
- Modify: `backend/app/models/schemas.py`
- Modify: `backend/app/services/database.py`
- Modify: `backend/tests/test_api_files_register.py`
- Modify: `backend/tests/test_telegram_operations.py`
- Modify: `backend/tests/test_api_authz.py`

**Interfaces:**
- Consumes: Task 2 location/version schema and Task 4 immutable operation journal.
- Produces: `POST /telegram-operations`, `PATCH /telegram-operations/{operation_id}`, `POST /telegram-operations/{operation_id}/reconcile-result`, `POST /telegram-operations/{operation_id}/register`, `POST /telegram-operation-groups/{group_id}/register`, `POST /file-locations/{file_id}/switch`, and `POST /file-location-groups/switch`.
- Produces client contracts `createTelegramOperation`, `patchTelegramOperation`, `persistReconciledOperationResult({ operationId, expectedOperationVersion, mapping, mediaIdentity })`, `registerTelegramOperation`, `registerTelegramOperationGroup`, `switchExistingFileLocation`, and `switchExistingFileLocationGroup`.
- Produces `switchExistingFileLocation(owner_id, file_id, expected_location_version, operation_id, result_version)` and `switchExistingFileLocationGroup(owner_id, parts[{file_id, expected_location_version, operation_id, result_version}])`: journal-bound, owner-scoped transactions that verify persisted operation result/media identity, source/location/tombstone CAS, atomically switch only chat/message/media fields, increment `location_version`, and record durable switch bindings. The group route requires exactly every row in one split group and performs all part owner/tombstone/version/result checks and updates in one SQLite transaction; any mismatch creates zero changes. Neither route calls Telegram, accepts credential/binary, or overwrites latest name/parent/trash fields.

- [ ] **Step 1: Write failing endpoint tests** for owner scope, duplicate register retries, payload conflict, operation tombstone, individual split registration rejection, atomic group registration, and early existing-row relocation. Reconcile-result tests cover expected-operation-version conflict; incomplete, wrong or missing frozen mapping/media identity; `uncertain → sent` only after a complete match; and idempotent replay of the same sent result, while forbidding Telegram clients/RPC. Single and group switch tests prove wrong owner/result version/media identity/source version or a purge tombstone cannot update a row; group route requires all and only split parts, does zero updates on any failing part, and atomically updates every part; a retry returns stored bindings; and latest rename/move/trash fields survive. Cover `opA` register replacing a same-name row once, `opB` later uploading the same name, then an `opA` retry returning its stored result without deleting/replacing `opB`; also cover first registration rechecking tombstone and creating the row plus operation binding in one transaction.
- [ ] **Step 2: Run RED checks:** `cd backend && python -m pytest tests/test_api_files_register.py tests/test_telegram_operations.py -q` and `cd backend && python -m pytest tests/test_api_authz.py -q`. Expected: both FAIL.
- [ ] **Step 3: Implement transactions.** Keep `/files/register` compatible for legacy Saved Messages, including its original filename/folder replacement semantics. `reconcile-result` accepts an expected operation version plus only JSON mapping/message/media metadata obtained by a browser's frozen-identity read; it validates complete immutable operation identity, atomically writes the authoritative result/version and only then changes `uncertain → sent` (or idempotently returns an identical sent result). Missing, wrong, or stale input changes nothing; this endpoint makes zero Telegram RPCs and accepts no credential/binary. For first operation registration, lock immutable operation/owner/result, recheck its tombstone before creating the row and operation binding in one transaction; retry returns that stored binding before any filename replacement logic. Implement both single and all-parts group location-switch primitives now, bound to already persisted operation results/versions and without any migration manifest dependency. The group route rechecks every part owner/tombstone/location/result CAS and updates all parts or none in one SQLite transaction. Do not reject either post-side-effect commit solely because a later target/accounts version differs. The primitives perform no RPC and never invoke the replacement path.
- [ ] **Step 4: Run GREEN checks:** `cd backend && python -m pytest tests/test_api_files_register.py tests/test_telegram_operations.py -q` and `cd backend && python -m pytest tests/test_api_authz.py -q`. Expected: both PASS.
- [ ] **Step 5: Commit.** `git add backend/app/api/routes.py backend/app/models/schemas.py backend/app/services/database.py backend/tests/test_api_files_register.py backend/tests/test_telegram_operations.py backend/tests/test_api_authz.py && git commit -m "feat: register telegram operations idempotently"`

### Task 6: Browser operation reducer and crash recovery

**Files:**
- Create: `frontend/src/lib/telegramOperationRecovery.ts`
- Create: `frontend/src/lib/telegramOperationRecovery.test.ts`
- Modify: `frontend/src/api/client.ts`

**Interfaces:**
- Consumes: Tasks 4–5 durable operation APIs and browser IndexedDB; it does not require a later resolver or migration manifest.
- Produces: `OperationMappingReducer.apply(mapping): 'applied' | 'duplicate' | 'conflict'`, `RecoveryCursorStore.load()`, `RecoveryCursorStore.save(cursor)`, `recoverPendingOperations()`.

- [ ] **Step 1: Write failing Vitest cases** for an update arriving before an RPC response, replaying an equal mapping, a different mapping conflict, reload recovery, and `RANDOM_ID_DUPLICATE` reduction without a second send.
- [ ] **Step 2: Run:** `cd frontend && npm run test:unit -- src/lib/telegramOperationRecovery.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement IndexedDB-backed pending intent/cursor storage and a pure mapping reducer.** Write backend operation successfully, then atomically mirror the recovery cursor/intent to IndexedDB, and only then issue the RPC. On crash at any boundary reconcile backend operations with the IndexedDB mirror and Telegram update/result mappings. Expose the browser-owned first two steps for later migration use: its frozen uploader manager calls read-only `getMessages`/media read, then calls `persistReconciledOperationResult` with only JSON mapping/identity and receives an authoritative result version. Task 16, after Task 15 exists, attaches the third migration CAS step. Persist one random ID per actual Telegram message: album is one group plus N child operations/random IDs, not one operation per RPC. Partial album/split results remain recoverable children; group registration occurs only after every child has an authoritative result.
- [ ] **Step 4: Run focused tests.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add frontend/src/lib/telegramOperationRecovery.ts frontend/src/lib/telegramOperationRecovery.test.ts frontend/src/api/client.ts && git commit -m "feat: recover durable telegram operations"`

### Task 7: Target-aware GramJS sends and media identities

**Files:**
- Modify: `frontend/src/lib/gramjs.ts: TelegramClientManager.sendFileLocked, sendAlbum, forwardToSaved`
- Modify: `frontend/src/lib/forwardResult.test.ts`
- Modify: `frontend/src/lib/telegramMedia.test.ts`

**Interfaces:**
- Consumes: Task 1 canonical target/location contracts and Task 6 operation mapping contract.
- Produces: `sendFile(file, { targetPeer, randomId })`, `sendAlbum(prepared, { targetPeer, randomIds })`, `forwardToTarget(entity, messageId, targetPeer, randomId)`.
- Returns: `{ messageId, mediaKind, mediaId, size, accessHash }` from the destination message's `readMedia()` result.

- [ ] **Step 1: Write failing tests** that assert every send/album fallback/forward consumes the supplied peer and its persisted per-message random ID, album has one group plus N child operations, and media ID comes from the returned destination message rather than an upload handle or logical file ID.
- [ ] **Step 2: Run:** `cd frontend && npm run test:unit -- src/lib/forwardResult.test.ts src/lib/telegramMedia.test.ts`. Expected: FAIL.
- [ ] **Step 3: Refactor public send paths** to remove implicit `me` from target-aware methods, preserve explicit legacy wrappers only for Saved Messages, and emit enough response/update information for Task 6's reducer.
- [ ] **Step 4: Run focused tests.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add frontend/src/lib/gramjs.ts frontend/src/lib/forwardResult.test.ts frontend/src/lib/telegramMedia.test.ts && git commit -m "feat: send telegram media to frozen targets"`

### Task 8: Channel resolution and per-account verification

**Files:**
- Create: `frontend/src/lib/channelStorage.ts`
- Create: `frontend/src/lib/channelStorage.test.ts`
- Modify: `frontend/src/lib/gramjs.ts: TelegramClientManager session lifecycle`

**Interfaces:**
- Consumes: Task 1 canonical channel ID and existing browser account-manager lifecycle; it does not consume Task 3's persisted enable summary.
- Produces: `validateChannelForAccount(manager, canonicalChannelId): Promise<AccountChannelVerification>` and `manager.invalidateSessionGeneration()`.

- [ ] **Step 1: Write failing tests** for resolving an uncached private broadcast channel via each manager's own dialogs, rejecting group/public/non-broadcast entities, and emitting the complete normalized record `{ channel_title, channel_id, can_read, can_write, status, checked_at, accounts_version }`; cover read failure, write failure, stale frontend `sessionGeneration`, relogin invalidation, and page reload invalidation.
- [ ] **Step 2: Run:** `cd frontend && npm run test:unit -- src/lib/channelStorage.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement resolver/validator without posting a test message.** Normalize entity IDs, paginate dialogs only on that account's client, fetch its own channel entity/access hash, call `channels.getParticipant` for that account, and derive read/write eligibility from the returned participant/channel/admin rights fields. Cache by account plus frontend-only `sessionGeneration`, and expose distinct diagnostic reasons; backend receives no generation token.
- [ ] **Step 4: Run focused tests.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add frontend/src/lib/channelStorage.ts frontend/src/lib/channelStorage.test.ts frontend/src/lib/gramjs.ts && git commit -m "feat: validate channel storage per account"`

### Task 9: Unified main-window file-location resolver

**Files:**
- Create: `frontend/src/lib/fileLocationResolver.ts`
- Create: `frontend/src/lib/fileLocationResolver.test.ts`
- Modify: `frontend/src/lib/gramjs.ts`

**Interfaces:**
- Consumes: Tasks 1–2 location metadata and Task 8 live manager checks.
- Produces: `resolveFileLocation(fileOrPart, purpose): Promise<ResolvedFileLocation>` where `ResolvedFileLocation` contains `client`, `peer`, `message`, `media`, and `locationVersion`.

- [ ] **Step 1: Write failing tests** for `@me` using only its original account, channel failover to another eligible reader, zero readers returning `READ_UNAVAILABLE` with no `@me` attempt, and recovery when one manager becomes live after TTL expiry/reload/new browser; also cover flood cooldown, same message number in two chats, stale media-kind/ID/size/variant rejection, file-reference refresh, and finite retry diagnostics.
- [ ] **Step 2: Run:** `cd frontend && npm run test:unit -- src/lib/fileLocationResolver.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement selection.** Resolve channel candidates lazily from the browser's currently linked manager registry, use only a locally available manager with live channel access, and cache only account-local entity/readability observations. Do not consult the enable-time five-minute verification summary as runtime authority: reload, relogin, or a new browser with one linked account can resolve an already-saved channel target after it obtains live access. Choose a live reader with bounded retries/cooldowns, fetch the exact chat/message, validate stored media identity, and return no raw bytes. If none is live return recoverable `READ_UNAVAILABLE`, never `@me` fallback.
- [ ] **Step 4: Run focused tests.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add frontend/src/lib/fileLocationResolver.ts frontend/src/lib/fileLocationResolver.test.ts frontend/src/lib/gramjs.ts && git commit -m "feat: resolve file locations through eligible accounts"`

### Task 10: Convert every direct media consumer to the resolver

**Files:**
- Modify: `frontend/src/lib/download.ts`
- Modify: `frontend/src/components/ChonkyDrive.tsx`
- Modify: `frontend/src/lib/gramjs.ts`
- Modify: `frontend/src/lib/download.test.ts` (or create it if absent)

**Interfaces:**
- Consumes: Task 9 `resolveFileLocation`.
- Produces: resolver-based download, thumbnail, preview, and split-part reads whose cache key is `locationKey(location) + part/range`.

- [ ] **Step 1: Write failing tests** showing consumers do not select a client by `telegram_user_id` for channel rows, original-account Saved Message collisions remain distinct, and thumbnail/cache invalidation follows `location_version`.
- [ ] **Step 2: Run:** `cd frontend && npm run test:unit -- src/lib/download.test.ts`. Expected: FAIL.
- [ ] **Step 3: Replace direct message-ID/account calls** in download, thumbnail and preview paths with a resolved peer/message/media. Keep byte retrieval inside the browser client only.
- [ ] **Step 4: Run focused tests and existing media tests.** Run: `cd frontend && npm run test:unit -- src/lib/download.test.ts src/lib/telegramMedia.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add frontend/src/lib/download.ts frontend/src/components/ChonkyDrive.tsx frontend/src/lib/gramjs.ts frontend/src/lib/download.test.ts && git commit -m "feat: route media reads through location resolver"`

### Task 11: Versioned service-worker/main-window stream bridge

**Files:**
- Modify: `frontend/src/main.tsx: handleGetFileChunk, handleGetFileMetadata`
- Modify: `frontend/src/service-worker/index.ts`
- Modify: `frontend/src/components/ChonkyDrive.tsx: VideoPreviewLoader and preview URL construction`
- Create: `frontend/tests/isolated/stream-location-bridge.spec.ts`

**Interfaces:**
- Consumes: Tasks 2, 9, and 10 metadata/resolver readers plus `StreamLocationRequest { request_id, file_id, part_id?, location_version, offset, length }`.
- Produces: `MainWindowStreamBridge.handle(request)` and `CLIENT_UNAVAILABLE` for a disconnected window.

- [ ] **Step 1: Write isolated Playwright tests** for range/seek requests, stale `location_version` rejection after migration, bytes returned only through the window port, and deterministic `CLIENT_UNAVAILABLE` after main-window close.
- [ ] **Step 2: Run:** `cd frontend && npx playwright test --project=isolated tests/isolated/stream-location-bridge.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the serializable protocol.** Look up owner metadata through the normal API, resolve only in the main window, compare requested/current version before and after read, and never send peer objects, credentials, or bytes through Python.
- [ ] **Step 4: Run focused browser test.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add frontend/src/main.tsx frontend/src/service-worker/index.ts frontend/src/components/ChonkyDrive.tsx frontend/tests/isolated/stream-location-bridge.spec.ts && git commit -m "feat: stream versioned locations through main window"`

### Task 12: Frozen-target uploads, dedup relocation, and split registration

**Files:**
- Modify: `frontend/src/components/ChonkyDrive.tsx: uploadFileToTelegram, uploadFileSpread, registerUploadedParts`
- Modify: `frontend/src/lib/gramjs.ts`
- Create: `frontend/src/lib/uploadOperations.test.ts`

**Interfaces:**
- Consumes: Tasks 4–7 operation journal/reducer/GramJS sends, Task 5 `switchExistingFileLocation` and `switchExistingFileLocationGroup`, and Task 8 live manager verification. It has no dependency on migration Tasks 15–16.
- Produces: `freezeUploadTarget(target, accountSnapshot): FrozenUploadTarget`; each result carries operation/result identity before metadata commit.

- [ ] **Step 1: Write failing tests** for one frozen peer across normal, album fallback, and each split part; the precise race `freeze A → send A → settings switch B → register A succeeds`; persisted random IDs before every message send; album one group plus N child operations; group register only after all parts; same-channel dedup reuse; and an `@me` hash match using the early location-switch primitive after a browser-owned forward/result persistence. A split `@me` hit must call the all-parts group switch with every expected part version/result binding and prove partial switches cannot occur. Include zero live writers returning `UPLOAD_UNAVAILABLE`, retaining the channel target and issuing zero `@me` sends; then restore one manager and prove the same target uploads again after TTL expiry/reload/new browser.
- [ ] **Step 2: Run:** `cd frontend && npm run test:unit -- src/lib/uploadOperations.test.ts`. Expected: FAIL.
- [ ] **Step 3: Queue a frozen target and create an operation before each Telegram RPC.** Resolve writers lazily from currently available linked managers; choose only one with live channel write access. If none exists, return `UPLOAD_UNAVAILABLE` and preserve the channel target. Create backend intent → mirror IndexedDB cursor → send with Task 7 calls → reduce/persist the authoritative result → call operation register/group register. Do not call ordinary `/files/register` for split operations. For an `@me` hash match, its original account browser manager forwards to the frozen target with a durable operation and persists the authoritative result; it then invokes Task 5's single-row switch for a non-split row, or the all-parts group switch with all expected part versions/result bindings for a split group. This is the complete relocation contract and does not create a migration manifest, lease, or quorum dependency. Source failure returns `STORAGE_TARGET_MISMATCH` and keeps the work incomplete. A same-channel hash match reuses its location.
- [ ] **Step 4: Run focused tests.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add frontend/src/components/ChonkyDrive.tsx frontend/src/lib/gramjs.ts frontend/src/lib/uploadOperations.test.ts && git commit -m "feat: upload through durable frozen channel operations"`

### Task 13: Durable chat-import forwarding

**Files:**
- Modify: `frontend/src/lib/chatImport.ts`
- Modify: `frontend/src/lib/chatImportDeps.ts`
- Modify: `frontend/src/lib/gramjs.ts`
- Modify: `frontend/src/lib/chatImport.test.ts`
- Modify: `frontend/src/lib/forwardResult.test.ts`
- Modify: `backend/tests/test_api_authz.py`

**Interfaces:**
- Consumes: Task 12 `FrozenUploadTarget`, Task 7 `forwardToTarget`, and Tasks 5–6 operation APIs/recovery.
- Produces: `runChatImportOperation(...)` with normal idempotent registration.

- [ ] **Step 1: Write failing tests** proving imports freeze and use the configured channel, source/acting account performs its own forward, reload recovery reuses random ID, legacy Saved Messages imports retain original location semantics, and a failed primary manager leaves secondary managers connected. Add auth tests that secondary bot login preserves JWT `owner_id` and reports `acting_account_id`; legacy `telegram_user_id=0` migration is blocked; primary cannot be unlinked and this task creates neither primary retirement nor promotion.
- [ ] **Step 2: Run RED checks:** `cd frontend && npm run test:unit -- src/lib/chatImport.test.ts src/lib/forwardResult.test.ts` and `cd backend && python -m pytest tests/test_api_authz.py -q`. Expected: both FAIL because the import/auth contracts are absent.
- [ ] **Step 3: Create and recover import operations** before forwarding; replace `chatImportDeps`' `getPrimaryClient()`/first-local-account selection with the selected acting account/client, map returned destination media identity, and call normal operation registration after the reducer confirms it. Channel/import paths must never choose `getPrimaryClient()` implicitly.
- [ ] **Step 4: Run GREEN checks:** `cd frontend && npm run test:unit -- src/lib/chatImport.test.ts src/lib/forwardResult.test.ts` and `cd backend && python -m pytest tests/test_api_authz.py -q`. Expected: both PASS.
- [ ] **Step 5: Commit.** `git add frontend/src/lib/chatImport.ts frontend/src/lib/chatImportDeps.ts frontend/src/lib/gramjs.ts frontend/src/lib/chatImport.test.ts frontend/src/lib/forwardResult.test.ts backend/tests/test_api_authz.py && git commit -m "feat: import chats through durable storage targets"`

### Task 14: Strict storage-target settings UI

**Files:**
- Modify: `frontend/src/components/SettingsDialog.tsx`
- Create: `frontend/src/components/StorageTargetDialog.tsx`
- Create: `frontend/tests/isolated/storage-target-settings.spec.ts`

**Interfaces:**
- Consumes: Task 1 `parseChannelInput`, Task 3 target API, Task 8 live verification, and Tasks 9–13 target-aware read/upload/import paths.
- Produces: `saveVerifiedStorageTarget()` only after `allLinkedAccountsCanReadAndWrite()` returns a complete current account set.

- [ ] **Step 1: Write isolated Playwright tests** with fake clients/routes for disabled save while primary or any linked account fails, marked `-100…` ID canonical display, stale settings conflict, account-list change invalidation, post-enable degraded warning only while at least one reader/writer remains, separate `UPLOAD_UNAVAILABLE`/`READ_UNAVAILABLE` zero-state copy, and restoration without changing the channel target.
- [ ] **Step 2: Run:** `cd frontend && npx playwright test --project=isolated tests/isolated/storage-target-settings.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the settings panel.** Use Task 1's `parseChannelInput` for display input and send only its canonical raw output to Task 3's API. Fetch versions on open, retry each named account with Task 8's readonly verification, require complete five-minute fresh verification only to save/enable, submit expected versions, and refetch/revalidate on 409. Post-enable status is derived from live managers: show degraded only when at least one live reader or writer remains; show `UPLOAD_UNAVAILABLE` for zero writers and `READ_UNAVAILABLE` for zero readers, retaining target/metadata and never substituting `@me`. Never pass session strings or access hashes to backend.
- [ ] **Step 4: Run focused browser test.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add frontend/src/components/SettingsDialog.tsx frontend/src/components/StorageTargetDialog.tsx frontend/tests/isolated/storage-target-settings.spec.ts && git commit -m "feat: configure verified shared channel storage"`

### Task 15: Migration manifest, leases, quorum, and metadata-only CAS backend

**Files:**
- Modify: `backend/app/services/database.py`
- Modify: `backend/app/api/routes.py`
- Modify: `backend/app/models/schemas.py`
- Modify: `frontend/src/api/client.ts`
- Create: `backend/tests/test_storage_migration.py`
- Modify: `backend/tests/test_linked_accounts.py`
- Modify: `backend/tests/test_api_authz.py`

**Interfaces:**
- Consumes: Task 5's journal-bound location-switch primitive; it adds manifest snapshotting, leases, resume orchestration metadata, evidence/quorum, and group rollback around that primitive. It never owns a GramJS client or Telegram RPC.
- Produces: `createMigrationManifest`, `getMigrationJob`, `claimMigrationItem`, `transitionReconciledItem`, `upsertMigrationEvidence`, `commitMigrationGroup`, `rollbackMigrationGroup`, and `validateCommitQuorum`.
- Produces owner-scoped API contracts: `POST /storage-migrations` (`CreateMigrationRequest` → `MigrationResponse`), `GET /storage-migrations` and `GET /storage-migrations/{migration_id}`, `PATCH /storage-migrations/{migration_id}/items/{item_id}` (`ItemPatchRequest { expected_version, lease_owner, lease_seconds, operation_id?, error? }` → `MigrationItemResponse`), `POST /storage-migrations/{migration_id}/items/{item_id}/reconcile` (`ReconcileTransitionRequest { expected_item_version, operation_result_version }` → `MigrationItemResponse`), `PUT /storage-migrations/{migration_id}/items/{item_id}/verifications/{telegram_user_id}` (`EvidenceRequest { expected_item_version, result_version, target_channel_id, destination_message_id, media_kind, media_id, size_bytes, photo_variant?, read_probe_ok, checked_at }` → `EvidenceResponse`), `POST /storage-migrations/{migration_id}/groups/{group_id}/commit` (`CommitGroupRequest { expected_job_version, expected_item_versions }`), and `POST /storage-migrations/{migration_id}/groups/{group_id}/rollback` (`RollbackGroupRequest { expected_location_versions }`). Evidence is uniquely keyed by `(item_id, telegram_user_id)`; `part_id` is derived from the item/operation manifest, never supplied as an evidence URL key.

| Migration item state | Allowed next state | Guard / effect |
| --- | --- | --- |
| `planned` | `sending`, `blocked`, `failed` | Claim and frozen operation exist; source/read/write preflight fails only into named `blocked`/`failed` reason. |
| `sending` | `forwarded`, `recovering`, `retryable`, `uncertain` | Persist authoritative result before `forwarded`; timeout/reload is `recovering`; rate-limit is `retryable`; only unrecoverable missing recovery data becomes `uncertain`. |
| `recovering` | `forwarded`, `retryable`, `uncertain` | Reduce updates/result or retry original identity; no new random ID or blind resend. |
| `uncertain` | `forwarded` | Only the metadata-only reconcile transition may perform this after the browser has persisted a frozen-identity read result to the operation journal. It checks that immutable journal result/version; it performs no Telegram RPC, no send/forward mutation, and accepts no credential/binary. Missing/mismatched persisted data leaves `uncertain`. |
| `retryable` | `sending`, `recovering`, `failed` | `retry_at` elapsed and lease CAS; retains operation/uploader/peer/random ID. |
| `forwarded` | `pending_quorum`, `verified`, `retryable`, `failed` | Result immutable; verification begins. |
| `pending_quorum` | `verified`, `retryable`, `failed` | Fresh currently-linked evidence may advance it; never re-forward merely to regain quorum. |
| `verified` | `applied`, `pending_quorum`, `retryable`, `failed` | Commit transaction recomputes every part quorum; expiry/unlink returns it to `pending_quorum`. |
| `applied` | `rolled_back` | Fresh source-read evidence and applied-location CAS only. |
| `blocked`, `failed`, `rolled_back` | terminal | Explicit user/new manifest action is required; no automatic Telegram send. `uncertain` is terminal except for the explicit read-only reconcile transition above. |

- [ ] **Step 1: Write failing tests** for dry-run producing no Telegram-producing command, owner isolation, every transition in the complete enum/table below, lease/retry/resume, expired or duplicate evidence, wrong media result, two distinct accounts including a non-uploader per part, split all-or-nothing, purge tombstone race, unlink race, and rollback expected-`location_version` conflict. Add every migration route's cross-owner denial to `tests/test_api_authz.py`. Cover the explicit three-step uncertain recovery: browser readonly GramJS mapping/media read; Task 5 `reconcile-result` journal persistence; this task's metadata-only CAS transition using its result version. The backend test monkeypatches/forbids Telegram clients/RPC and proves zero Telegram calls. Missing/mismatched persisted mapping remains uncertain. Include the races `manifest A → forward A → settings switch B → apply A succeeds`; an unrelated account link does not alone reject apply; and an evidence account unlinked before commit no longer counts, requiring fresh currently-linked quorum without retransmitting.
- [ ] **Step 2: Run RED checks:** `cd backend && python -m pytest tests/test_storage_migration.py tests/test_linked_accounts.py -q` and `cd backend && python -m pytest tests/test_api_authz.py -q`. Expected: both FAIL.
- [ ] **Step 3: Add job/item/evidence/rollback tables, API client contracts, and owner-scoped APIs.** `POST /storage-migrations` CAS-checks the then-current target/accounts versions and snapshots immutable target, owner, source locations/groups and source `location_version`; list/get expose no other owner's job. Item PATCH claims/releases only by item version/lease and permits only the complete transition table in the spec; expired leases become claimable without replacing its operation/random ID. The reconcile endpoint accepts only item CAS plus a previously persisted operation result version, verifies immutable mapping/media fields in SQLite, and transitions `uncertain → forwarded`; it imports no GramJS/Telethon code and performs zero Telegram RPC. Evidence PUT derives the reader identity from `{telegram_user_id}`, verifies it is currently linked to the same owner, upserts the unique `(item_id, telegram_user_id)` row, validates the immutable operation result/version/media fields, and increments item version. In `commitMigrationGroup` begin one transaction and invoke the Task 5 location-switch transaction for every ready part under the same SQLite transaction, checking immutable manifest target/owner, each source/live file owner/tombstone/location CAS, and every part's fresh two-reader/non-uploader quorum from accounts currently linked at commit. Do not compare subsequently changed global target/accounts versions.
- [ ] **Step 4: Implement rollback with the same CAS guard.** Before rollback accept fresh browser source-read evidence for every part, tied to the immutable source location and current owner; then restore only when the current row still has the migration's applied location/version. Otherwise report conflict without overwriting; the location-only rollback never invokes filename/folder replacement.
- [ ] **Step 5: Run GREEN checks:** `cd backend && python -m pytest tests/test_storage_migration.py tests/test_linked_accounts.py -q` and `cd backend && python -m pytest tests/test_api_authz.py -q`. Expected: both PASS. Commit with `git add backend/app/services/database.py backend/app/api/routes.py backend/app/models/schemas.py frontend/src/api/client.ts backend/tests/test_storage_migration.py backend/tests/test_linked_accounts.py backend/tests/test_api_authz.py && git commit -m "feat: journal quorum-verified storage migration"`.

### Task 16: Feature-gated maintenance migration runner and acceptance suite

**Files:**
- Create: `frontend/src/maintenance/migrateSavedMessagesToChannel.ts`
- Create: `frontend/src/maintenance/StorageMigrationPage.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/api/client.ts`
- Modify: `frontend/tests/support/fakeDrive.ts`
- Create: `frontend/tests/isolated/storage-migration.spec.ts`

**Interfaces:**
- Consumes: Tasks 4–9 durable operations/GramJS/recovery/resolver and Task 15 manifest/lease/quorum metadata APIs.
- Produces: `runMigrationJob(jobId)`, `resumeMigrationJob(jobId)`, `rollbackMigrationJob(jobId)`, and `StorageMigrationPage`.
- Produces client methods `api.createMigrationManifest`, `api.listMigrationJobs`, `api.getMigrationJob`, `api.claimMigrationItem`, `api.reconcileMigrationItem`, `api.putMigrationEvidence`, `api.commitMigrationGroup`, and `api.rollbackMigrationGroup`, each carrying the response version required by the next CAS call.

- [ ] **Step 1: Write isolated Playwright tests** for `VITE_ENABLE_STORAGE_MIGRATION` discoverability, owner-scoped routes, dry-run with no Telegram write, source-account-only forward, persistent random-ID recovery after reload, per-part two-account evidence, apply/resume/rollback controls, and no backend byte transfer.
- [ ] **Step 2: Run:** `cd frontend && npx playwright test --project=isolated tests/isolated/storage-migration.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the pathname-gated page, API client, and runner.** Build/list/get a manifest and claim items with a lease. Only the item's source account browser manager forwards to the frozen channel target using persisted operation/random-ID recovery; the shared resolver gathers independent reader evidence and PUTs only JSON evidence metadata. For `uncertain`, the runner makes a frozen-identity read-only GramJS `getMessages`/media read, calls `api.persistReconciledOperationResult`, then calls `api.reconcileMigrationItem` with the returned result version; the latter is metadata-only. Commit each ready group by manifest/item/location CAS, and let the backend perform the location-only apply/rollback transaction. On 409 reload the job rather than retrying stale state; `uncertain` never triggers a blind send. Hide all entry points unless `VITE_ENABLE_STORAGE_MIGRATION` is true.
- [ ] **Step 4: Run focused browser test.** Expected: PASS.
- [ ] **Step 5: Run completion checks.** Run independently: `(cd backend && python -m pytest tests/test_schema_migration.py tests/test_linked_accounts.py tests/test_api_accounts.py tests/test_api_files_register.py tests/test_api_authz.py tests/test_telegram_operations.py tests/test_storage_migration.py -q)`; `(cd frontend && npm run test:unit -- src/lib/telegramMedia.test.ts src/lib/chatImport.test.ts src/lib/forwardResult.test.ts src/lib/storageLocation.test.ts src/lib/telegramOperationRecovery.test.ts src/lib/channelStorage.test.ts src/lib/fileLocationResolver.test.ts src/lib/uploadOperations.test.ts)`; `(cd frontend && npx tsc --noEmit && npm run build)`; `(cd frontend && npx playwright test --project=isolated)`; `(cd frontend && node scripts/run-tests.mjs)`. All expected PASS.
- [ ] **Step 6: Run repository checks only.** The commands above verify fakes, SQLite and browser-isolated behavior. They do not constitute product acceptance or real Telegram verification.
- [ ] **Step 7: Commit.** `git add frontend/src/maintenance frontend/src/App.tsx frontend/src/api/client.ts frontend/tests/support/fakeDrive.ts frontend/tests/isolated/storage-migration.spec.ts && git commit -m "feat: add shared channel storage migration maintenance"`

### Task 17: Automated real-Telegram acceptance delivery gate

**Files:**
- Create: `frontend/tests/e2e/real-telegram-shared-channel.spec.ts`
- Create: `frontend/scripts/run-real-telegram-shared-channel.mjs`
- Create: `frontend/playwright.real-telegram.config.ts`
- Modify: `frontend/package.json`
- Modify: `.github/workflows/real-telegram-shared-channel.yml`
- Create: `frontend/scripts/real-telegram-global-setup.mjs`
- Create: `frontend/scripts/real-telegram-runner.test.mjs`

**Interfaces:**
- Consumes: completed Tasks 1–16 and no existing Playwright web server, auth setup, developer IndexedDB, or storage state. It owns the processes it starts.
- Produces: `npm run test:real-telegram-shared-channel`, a non-interactive runner using dedicated test accounts/channel supplied only through CI process secrets, and a required CI delivery gate. The dedicated config selects only this suite with `testDir: './tests/e2e'`, `testMatch: 'real-telegram-shared-channel.spec.ts'`, `baseURL: 'http://127.0.0.1:3000'`, one worker, `retries: 0`, `trace: 'off'`, `screenshot: 'off'`, `video: 'off'`, and no reused server.

- [ ] **Step 1: Write runner/configuration failing tests.** `real-telegram-runner.test.mjs` invokes the runner with each required value absent and asserts exactly `REAL_TELEGRAM_TEST_CONFIG_MISSING`, non-zero exit, no child process, no IndexedDB/session-storage access, no Telegram RPC, and no secret echo. Required values are three dedicated session secrets, test-owner auth, and canonical channel ID. Separately occupy 8000 and 3000 with foreign listeners: each preflight must fail closed before its own child, Playwright, IndexedDB/session-storage, or Telegram starts, must not reuse/kill the listener, and must not create a test DB. Also test readiness timeout and child failure: spawn failure or recorded-child exit immediately stops the runner; readiness proceeds only while that child remains live, and an authenticated owner-scoped metadata probe containing the run nonce proves the fresh isolated DB rather than accepting a bare health 200. Cleanup terminates only recorded backend/frontend PIDs and deletes its unique temp SQLite database plus `-wal`/`-shm`; it must not kill an unrelated listener. Add `npx playwright test --config playwright.real-telegram.config.ts --list` as a discovery-only check with zero secrets/side effects.
- [ ] **Step 2: Run:** `cd frontend && node scripts/real-telegram-runner.test.mjs`; then `cd frontend && npm run test:real-telegram-shared-channel`. Expected: runner tests PASS; locally absent secrets emit only `REAL_TELEGRAM_TEST_CONFIG_MISSING`, non-zero, and start no backend/frontend/Playwright. `--list` discovers exactly the real suite without Telegram effects.
- [ ] **Step 3: Implement the isolated non-interactive runner, config, setup, package script, and CI workflow.** Before creating a DB or spawning anything, Node reads CI-only process secrets into memory, validates them without logging values, checks that both 8000 and 3000 are unoccupied, and fails closed if either has a foreign listener; it neither kills nor reuses it. It creates a unique temp DB, starts `cd backend && python main.py` with `TELEDRIVE_DB_PATH=<temp db>`, test `JWT_SECRET`, and empty `TELEGRAM_BOT_TOKEN`; spawn failure or recorded-child exit immediately stops the runner, and readiness is attempted only while that child remains live. After health, an authenticated owner-scoped metadata request containing a per-run nonce proves this run's isolated SQLite DB instead of treating a bare health 200 as sufficient. It next starts `cd frontend && npm run dev -- --port 3000 --strictPort`; frontend spawn failure or recorded-child exit likewise stops the runner, and 3000 readiness is attempted only while that child remains live. The Playwright config never reuses the existing 5173/auth-setup configuration. Global setup passes sessions only from Node memory into each fresh Playwright context's `addInitScript` to seed its IndexedDB/session storage before app code; it writes no storage-state file, does not expose secret values to browser URLs, Vite env, API payloads, build output, or logs, and clears contexts after use. Disable traces/video/screenshots and ensure reporters/artifacts redact or omit session-bearing data. On every exit path, terminate only recorded child PIDs and delete only that runner's explicitly named temp DB, WAL, and SHM. CI creates uniquely prefixed fixtures and verifies cross-account channel read/failover, lost-response recovery with unchanged random ID, split per-part quorum, unlink evidence invalidation, and cleanup through test-channel policy.
- [ ] **Step 4: Run in protected CI with dedicated test credentials.** Expected: PASS and attach only redacted structured evidence (run ID and assertion names; no session, auth token, access hash, or unredacted Telegram identifier). Missing config, readiness failure, or unavailable channel leaves this gate incomplete.
- [ ] **Step 5: Do not mark feature acceptance complete until Step 4 passes.** Commit the runner, `frontend/playwright.real-telegram.config.ts`, package script, suite, and CI workflow together. Playwright MCP validation is also required by `AGENTS.md` when a callable MCP is supplied; this document records no self-certified substitute.

## Plan Review Record

- [x] The specification is mapped to Tasks 1–17. The dependency graph is acyclic: 1 → 2 → {3,4} → 5 → 6 → 7; 1 → 8 → 9 → 10 → 11; {4,5,6,7,8} → 12 → 13 → 14; 5 → 15 → 16 → 17. Task 12 explicitly consumes Task 5's early relocation primitive and has no Task 15/16 dependency.
- [x] Browser/metadata execution boundary is mapped: Tasks 6/7/16 own frozen-identity GramJS reads/forwards; Tasks 5/15 own only persisted JSON/result/version and SQLite CAS, with zero Telegram RPC.
- [x] Runtime target behavior is mapped: Tasks 8/9/12/14 cover enable-only TTL, live lazy resolution, reload/relogin/new-browser use, zero-reader/zero-writer states, and recovery.
- [x] File/API references were checked against this workspace; the Axios client is `frontend/src/api/client.ts`.
- [ ] Implementation verification and real-Telegram acceptance are not complete. Task 17 and a callable Playwright MCP gate remain required before any delivery claim.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-11-shared-channel-storage.md`. Two execution options:

1. Subagent-Driven (recommended) — dispatch a fresh subagent per task and review between tasks.
2. Inline Execution — execute tasks in this session using `superpowers:executing-plans`, with review checkpoints.
