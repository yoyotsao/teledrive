"""Rollback must refresh source-read evidence after a group has been applied."""

from conftest import OWNER_A
from test_storage_migration import _evidence, _saved_file, _sent_operation, _target_channel


async def test_applied_item_accepts_fresh_source_evidence_without_leaving_applied_state(db):
    target = await _target_channel(db)
    row = await _saved_file(db, "rollback-refresh")
    job = await db.create_migration_manifest(
        OWNER_A, target["version"], target["accounts_version"], dry_run=False,
    )
    page = await db.list_migration_groups(
        OWNER_A, job["migration_id"], scope="runnable", limit=25,
    )
    item = page["groups"][0]["items"][0]
    operation = await _sent_operation(db, row, "rollback-refresh-op")

    claimed = await db.claim_migration_item(
        OWNER_A, job["migration_id"], item["item_id"], item["version"],
        "rollback-refresh-test", 30,
        operation_id=operation["operation_id"], state="uncertain",
    )
    item = await db.transition_reconciled_item(
        OWNER_A, job["migration_id"], item["item_id"], claimed["version"],
        operation["result_version"],
    )
    item = await _evidence(db, job, item, operation, OWNER_A, source_ok=True)
    item = await _evidence(db, job, item, operation, 1102, source_ok=True)
    fresh_job = await db.get_migration_job(OWNER_A, job["migration_id"])
    applied = await db.commit_migration_group(
        OWNER_A, job["migration_id"], item["group_id"], fresh_job["version"],
        {item["item_id"]: item["version"]},
    )
    applied_item = applied["group"]["items"][0]
    assert applied_item["state"] == "applied"

    refreshed = await _evidence(
        db, applied["job"], applied_item, operation, OWNER_A, source_ok=True,
    )
    assert refreshed["state"] == "applied"
    assert refreshed["version"] == applied_item["version"] + 1

    rolled = await db.rollback_migration_group(
        OWNER_A, job["migration_id"], refreshed["group_id"],
        {refreshed["item_id"]: refreshed["applied_location_version"]},
    )
    assert rolled["group"]["items"][0]["state"] == "rolled_back"
