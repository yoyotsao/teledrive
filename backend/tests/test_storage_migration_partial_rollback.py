from conftest import OWNER_A
from test_storage_migration import _evidence, _saved_file, _sent_operation, _target_channel


async def _apply_group(db, job, item, row, operation_id):
    operation = await _sent_operation(db, row, operation_id)
    claimed = await db.claim_migration_item(
        OWNER_A,
        job["migration_id"],
        item["item_id"],
        item["version"],
        "partial-rollback-test",
        30,
        operation_id=operation["operation_id"],
        state="uncertain",
    )
    item = await db.transition_reconciled_item(
        OWNER_A,
        job["migration_id"],
        item["item_id"],
        claimed["version"],
        operation["result_version"],
    )
    item = await _evidence(db, job, item, operation, OWNER_A, source_ok=True)
    item = await _evidence(db, job, item, operation, 1102, source_ok=True)
    fresh_job = await db.get_migration_job(OWNER_A, job["migration_id"])
    return await db.commit_migration_group(
        OWNER_A,
        job["migration_id"],
        item["group_id"],
        fresh_job["version"],
        {item["item_id"]: item["version"]},
    )


async def test_partial_group_rollback_keeps_job_resumable_until_all_applied_groups_are_rolled_back(db):
    target = await _target_channel(db)
    first = await _saved_file(db, "first")
    second = await _saved_file(db, "second", part_index=1)
    job = await db.create_migration_manifest(
        OWNER_A,
        target["version"],
        target["accounts_version"],
    )

    first_item = next(item for item in job["items"] if item["file_id"] == "first")
    job = await _apply_group(db, job, first_item, first, "migration-first")

    second_item = next(item for item in job["items"] if item["file_id"] == "second")
    job = await _apply_group(db, job, second_item, second, "migration-second")
    assert job["state"] == "completed"

    first_applied = next(item for item in job["items"] if item["file_id"] == "first")
    partial = await db.rollback_migration_group(
        OWNER_A,
        job["migration_id"],
        first_applied["group_id"],
        {first_applied["item_id"]: first_applied["applied_location_version"]},
    )

    assert partial["state"] == "running"
    assert next(item for item in partial["items"] if item["file_id"] == "first")["state"] == "rolled_back"
    assert next(item for item in partial["items"] if item["file_id"] == "second")["state"] == "applied"

    second_applied = next(item for item in partial["items"] if item["file_id"] == "second")
    final = await db.rollback_migration_group(
        OWNER_A,
        job["migration_id"],
        second_applied["group_id"],
        {second_applied["item_id"]: second_applied["applied_location_version"]},
    )
    assert final["state"] == "rolled_back"
