# Task 2 report: additive SQLite location and target schema

## Result

Implemented the additive owner-scoped storage target repository, physical Telegram file-location columns, and account-version/unlink dependency protections. The backend remains metadata-only; no Telegram bytes or client operations were added.

## Test-driven record

1. Added migration, target-isolation, physical-location wire contract, account-version, and unlink dependency regression tests.
2. Ran the required RED command before production changes:

   ```text
   /tmp/teledrive-stats-venv/bin/python -m pytest tests/test_schema_migration.py -q
   ..FFF
   AttributeError: Database has no attribute get_storage_target / put_storage_target
   TypeError: FileService.register_uploaded_file() got an unexpected keyword argument telegram_chat_id
   ```

3. Implemented the minimal additive schema and repository behavior.
4. The first GREEN attempt exposed SQLite's `INSERT ... SELECT ... ON CONFLICT` parsing ambiguity (`near "DO": syntax error`); adding an unambiguous `WHERE` to the backfill query fixed the migration.

## Changes

- `files` now has nullable `telegram_chat_id`, `telegram_media_kind`, `telegram_media_id`, `telegram_media_size`, `telegram_photo_variant`, plus `location_version INTEGER NOT NULL DEFAULT 0`. Legacy rows retain unknown media/location values.
- `FileInfo`, database registration, and `FileService.register_uploaded_file` carry the Task 1 wire fields unchanged.
- Added owner-scoped `storage_targets` (`storage_mode`, canonical channel storage fields, target `version`, `accounts_version`) and normalized `storage_target_verifications` rows.
- Added `get_storage_target` and CAS `put_storage_target`; target persistence uses explicit conflict updates and does not use `INSERT OR REPLACE` for locations.
- Successful account link and unlink increment `accounts_version` in their SQLite transaction.
- `count_files_on_account` now counts only retained Saved Messages locations, including trash and all split parts. Unlink repeats the dependency check in its delete transaction. Channel-only historical uploader rows may unlink when another linked account has persisted read evidence for each relevant channel; this record is dependency protection, never runtime authorization.

## Verification

```text
cd backend && /tmp/teledrive-stats-venv/bin/python -m pytest tests/test_schema_migration.py tests/test_linked_accounts.py -q
12 passed

cd backend && /tmp/teledrive-stats-venv/bin/python -m pytest tests/test_api_accounts.py -q
10 passed
```

Both commands emitted the pre-existing Starlette/httpx deprecation warning only.

## Scope note

The repository deliberately does not enforce channel canonicalization, five-minute TTL, or complete linked-account verification sets. Those authenticated API policy checks are Task 3. The retained fixtures use current UTC timestamps to ease that integration.

## Review fix round 1

- Added typed nullable Task 1 location fields and `location_version` to the actual `RegisterFileRequest` model in `routes.py`, then forwarded them to `FileService`. Endpoint regression coverage proves the response and SQLite row preserve those fields.
- Made `Database.insert_file` location-aware under `BEGIN IMMEDIATE`: a retry with no location payload retains the stored physical location; a changed location requires the current `expected_location_version` and exactly the next version. This prevents stale default version `0` from downgrading a newer row.
- A same-ID retry previously entered the filename-replacement sweep before the database upsert. The sweep now excludes its own logical row, and the service returns the persisted row so a retry response reports the retained location.

Review-fix verification:

```text
cd backend && /tmp/teledrive-stats-venv/bin/python -m pytest tests/test_schema_migration.py tests/test_linked_accounts.py tests/test_api_files_register.py -q
34 passed
```

The existing Starlette/httpx deprecation warning was the only warning.
