"""Bounded storage-migration contracts for large Saved Messages manifests."""

import pytest

from conftest import OWNER_A, OWNER_B
from test_storage_migration import _saved_file, _target_channel


async def test_manifest_returns_summary_and_runnable_groups_are_complete(db):
    target = await _target_channel(db)
    await _saved_file(db, "solo")
    await _saved_file(db, "split-0", split_group_id="split", part_index=0, total_parts=2)
    await _saved_file(db, "split-1", split_group_id="split", part_index=1, total_parts=2)

    job = await db.create_migration_manifest(
        OWNER_A, target["version"], target["accounts_version"], dry_run=False,
    )

    assert "items" not in job
    assert job["total_items"] == 3
    assert job["total_groups"] == 2
    assert job["item_counts"]["planned"] == 3
    assert job["next_retry_at"] is None

    page = await db.list_migration_groups(
        OWNER_A, job["migration_id"], scope="runnable", limit=25,
    )
    assert [group["group_id"] for group in page["groups"]] == ["solo", "split"]
    split = page["groups"][1]
    assert [item["part_index"] for item in split["items"]] == [0, 1]
    assert {item["file_id"] for item in split["items"]} == {"split-0", "split-1"}
    assert await db.list_migration_groups(
        OWNER_B, job["migration_id"], scope="runnable", limit=25,
    ) is None


async def test_group_claim_is_atomic_on_stale_item_version_and_competing_lease(db):
    target = await _target_channel(db)
    await _saved_file(db, "split-0", split_group_id="split", part_index=0, total_parts=2)
    await _saved_file(db, "split-1", split_group_id="split", part_index=1, total_parts=2)
    job = await db.create_migration_manifest(
        OWNER_A, target["version"], target["accounts_version"], dry_run=False,
    )
    page = await db.list_migration_groups(
        OWNER_A, job["migration_id"], scope="runnable", limit=25,
    )
    group = page["groups"][0]
    versions = {item["item_id"]: item["version"] for item in group["items"]}

    stale = dict(versions)
    first_item = next(iter(stale))
    stale[first_item] += 1
    with pytest.raises(ValueError, match="version conflict"):
        await db.claim_migration_group(
            OWNER_A, job["migration_id"], group["group_id"], stale,
            lease_owner="browser:stale", lease_seconds=60,
        )

    unchanged = await db.list_migration_groups(
        OWNER_A, job["migration_id"], scope="runnable", limit=25,
    )
    assert all(item["lease_owner"] is None for item in unchanged["groups"][0]["items"])

    claimed = await db.claim_migration_group(
        OWNER_A, job["migration_id"], group["group_id"], versions,
        lease_owner="browser:one", lease_seconds=60,
    )
    assert claimed["group"]["group_id"] == "split"
    assert all(item["lease_owner"] == "browser:one" for item in claimed["group"]["items"])

    claimed_versions = {item["item_id"]: item["version"] for item in claimed["group"]["items"]}
    with pytest.raises(ValueError, match="lease is active"):
        await db.claim_migration_group(
            OWNER_A, job["migration_id"], group["group_id"], claimed_versions,
            lease_owner="browser:two", lease_seconds=60,
        )

    after_conflict = await db.get_migration_group(
        OWNER_A, job["migration_id"], group["group_id"],
    )
    assert after_conflict is not None
    assert all(item["lease_owner"] == "browser:one" for item in after_conflict["items"])
