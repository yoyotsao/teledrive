from pathlib import Path

p = Path('backend/app/services/database.py')
text = p.read_text(encoding='utf-8')
marker = '\n\n# Singleton instance\n'
if marker not in text:
    raise SystemExit('database singleton marker not found')

methods = r'''

    # ==================== Storage migration metadata journal ====================

    async def create_migration_manifest(
        self, owner_id: int, expected_target_version: int,
        expected_accounts_version: int, dry_run: bool = False,
    ) -> dict:
        from app.services import storage_migration
        return await storage_migration.create_migration_manifest(
            self, owner_id, expected_target_version, expected_accounts_version, dry_run,
        )

    async def list_migration_jobs(self, owner_id: int) -> List[dict]:
        from app.services import storage_migration
        return await storage_migration.list_migration_jobs(self, owner_id)

    async def get_migration_job(self, owner_id: int, migration_id: str) -> Optional[dict]:
        from app.services import storage_migration
        return await storage_migration.get_migration_job(self, owner_id, migration_id)

    async def claim_migration_item(
        self, owner_id: int, migration_id: str, item_id: str,
        expected_version: int, lease_owner: str, lease_seconds: int,
        *, operation_id: Optional[str] = None, state: Optional[str] = None,
        error: Optional[str] = None,
    ) -> dict:
        from app.services import storage_migration
        return await storage_migration.claim_migration_item(
            self, owner_id, migration_id, item_id, expected_version,
            lease_owner, lease_seconds, operation_id=operation_id,
            state=state, error=error,
        )

    async def transition_reconciled_item(
        self, owner_id: int, migration_id: str, item_id: str,
        expected_item_version: int, operation_result_version: int,
    ) -> dict:
        from app.services import storage_migration
        return await storage_migration.transition_reconciled_item(
            self, owner_id, migration_id, item_id,
            expected_item_version, operation_result_version,
        )

    async def upsert_migration_evidence(
        self, owner_id: int, migration_id: str, item_id: str,
        telegram_user_id: int, **evidence: Any,
    ) -> dict:
        from app.services import storage_migration
        return await storage_migration.upsert_migration_evidence(
            self, owner_id, migration_id, item_id, telegram_user_id, **evidence,
        )

    async def validate_commit_quorum(
        self, owner_id: int, migration_id: str, item_id: str,
    ) -> bool:
        from app.services import storage_migration
        return await storage_migration.validate_commit_quorum(
            self, owner_id, migration_id, item_id,
        )

    async def commit_migration_group(
        self, owner_id: int, migration_id: str, group_id: str,
        expected_job_version: int, expected_item_versions: Dict[str, int],
    ) -> dict:
        from app.services import storage_migration
        return await storage_migration.commit_migration_group(
            self, owner_id, migration_id, group_id,
            expected_job_version, expected_item_versions,
        )

    async def rollback_migration_group(
        self, owner_id: int, migration_id: str, group_id: str,
        expected_location_versions: Dict[str, int],
    ) -> dict:
        from app.services import storage_migration
        return await storage_migration.rollback_migration_group(
            self, owner_id, migration_id, group_id, expected_location_versions,
        )
'''

if 'async def create_migration_manifest(' not in text:
    p.write_text(text.replace(marker, methods + marker, 1), encoding='utf-8')

# This assertion needs a metadata rename between apply and rollback. Use raw
# SQLite setup rather than inventing a Database helper that production does not
# expose; the rollback must preserve this non-location field.
test = Path('backend/tests/test_storage_migration.py')
test_text = test.read_text(encoding='utf-8')
old = '    await db.update_file_metadata(row["file_id"], OWNER_A, filename="renamed-after-migration.bin")\n'
new = '''    await db._conn.execute(\n        "UPDATE files SET filename = ? WHERE file_id = ? AND owner_id = ?",\n        ("renamed-after-migration.bin", row["file_id"], OWNER_A),\n    )\n    await db._conn.commit()\n'''
if old in test_text:
    test.write_text(test_text.replace(old, new, 1), encoding='utf-8')
elif 'renamed-after-migration.bin' not in test_text:
    raise SystemExit('Task 15 rollback rename assertion not found')
