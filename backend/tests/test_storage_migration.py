"""Migration metadata is durable and Telegram-free.

These tests exercise only SQLite metadata. The browser owns every Telegram RPC.
"""
from datetime import datetime, timezone

import pytest

from conftest import OWNER_A, OWNER_B

CHANNEL_ID = "123456789"


async def _target_channel(db):
    for account_id, primary in ((OWNER_A, True), (1102, False), (1103, False)):
        if await db.get_linked_account(OWNER_A, account_id) is None:
            await db.link_account(OWNER_A, account_id, is_primary=primary)
    target = await db.get_storage_target(OWNER_A)
    now = datetime.now(timezone.utc).isoformat()
    saved = await db.put_storage_target(
        OWNER_A,
        {"storage_mode": "channel", "channel_id": CHANNEL_ID, "channel_title": "Storage"},
        target["version"], target["accounts_version"],
        [
            {"telegram_user_id": account_id, "channel_id": CHANNEL_ID, "channel_title": "Storage",
             "can_read": True, "can_write": True, "status": "verified", "checked_at": now,
             "accounts_version": target["accounts_version"]}
            for account_id in (OWNER_A, 1102, 1103)
        ],
    )
    return saved


async def _saved_file(db, file_id="legacy", *, split_group_id=None, part_index=None, total_parts=None):
    await db.insert_file(
        file_id, f"{file_id}.bin", 17, "application/octet-stream", "other", 70 + (part_index or 0),
        datetime.now(timezone.utc).isoformat(), None, "old-access", None, False,
        is_split_file=split_group_id is not None,
        original_name=f"{file_id}.bin",
        part_index=part_index,
        total_parts=total_parts,
        split_group_id=split_group_id,
        telegram_user_id=OWNER_A,
        owner_id=OWNER_A,
        telegram_chat_id=None,
        telegram_media_kind="document",
        telegram_media_id=f"source-{file_id}",
        telegram_media_size=17,
        location_version=0,
    )
    return await db.get_file(file_id, OWNER_A)


def _source(row):
    return {key: row[key] for key in (
        "file_id", "telegram_user_id", "telegram_chat_id", "telegram_message_id",
        "telegram_media_kind", "telegram_media_id", "telegram_media_size",
        "telegram_photo_variant", "location_version", "access_hash",
    )}


async def _sent_operation(db, row, operation_id, *, group_id=None, part_index=None, uploader=OWNER_A):
    target = await db.get_storage_target(OWNER_A)
    request = {
        "operation_id": operation_id,
        "kind": "migration",
        "logical_file_id": row["file_id"],
        "group_id": group_id,
        "part_index": part_index,
        "uploader_id": uploader,
        "target_kind": "channel",
        "target_channel_id": CHANNEL_ID,
        "target_peer_key": CHANNEL_ID,
        "created_target_version": target["version"],
        "created_accounts_version": target["accounts_version"],
        "random_id": str(900000 + row["telegram_message_id"]),
        "rpc_kind": "messages.forwardMessages",
        "request_metadata": {"source": _source(row)},
    }
    op = await db.create_or_get_telegram_operation(OWNER_A, request)
    sending = await db.claim_telegram_operation(OWNER_A, operation_id, "migration-test")
    uncertain = await db.transition_telegram_operation(
        OWNER_A, operation_id, sending["version"], "uncertain", error_code="RESULT_LOST"
    )
    mapping = {
        "uploader_id": uploader,
        "random_id": request["random_id"],
        "target_peer_key": CHANNEL_ID,
        "destination_message_id": 900 + row["telegram_message_id"],
    }
    media = {
        "destination_media_kind": "document",
        "destination_media_id": f"dest-{row['file_id']}",
        "destination_size": row["filesize"],
    }
    sent = await db.complete_operation_result(
        OWNER_A, operation_id, uncertain["version"], mapping, media
    )
    return sent


async def _evidence(db, job, item, operation, reader_id, *, source_ok=False):
    return await db.upsert_migration_evidence(
        OWNER_A, job["migration_id"], item["item_id"], reader_id,
        expected_item_version=item["version"],
        result_version=operation["result_version"],
        target_channel_id=CHANNEL_ID,
        destination_message_id=operation["destination_message_id"],
        media_kind=operation["destination_media_kind"],
        media_id=operation["destination_media_id"],
        size_bytes=operation["destination_size"],
        photo_variant=None,
        read_probe_ok=True,
        checked_at=datetime.now(timezone.utc).isoformat(),
        source_read_probe_ok=source_ok,
    )


async def test_manifest_is_owner_scoped_and_snapshots_source_location(db):
    target = await _target_channel(db)
    row = await _saved_file(db)
    job = await db.create_migration_manifest(
        OWNER_A, target["version"], target["accounts_version"], dry_run=True,
    )

    assert job["dry_run"] is True
    assert len(job["items"]) == 1
    assert job["items"][0]["source_location"]["telegram_message_id"] == row["telegram_message_id"]
    assert await db.get_migration_job(OWNER_B, job["migration_id"]) is None
    assert await db.list_migration_jobs(OWNER_B) == []


async def test_uncertain_item_only_reconciles_against_persisted_operation_result(db):
    target = await _target_channel(db)
    row = await _saved_file(db)
    job = await db.create_migration_manifest(OWNER_A, target["version"], target["accounts_version"])
    item = job["items"][0]
    operation = await _sent_operation(db, row, "migration-op")

    claimed = await db.claim_migration_item(
        OWNER_A, job["migration_id"], item["item_id"], item["version"],
        "tab-a", 30, operation_id=operation["operation_id"], state="uncertain",
    )
    with pytest.raises(ValueError, match="result version"):
        await db.transition_reconciled_item(
            OWNER_A, job["migration_id"], item["item_id"], claimed["version"],
            operation["result_version"] + 1,
        )
    reconciled = await db.transition_reconciled_item(
        OWNER_A, job["migration_id"], item["item_id"], claimed["version"],
        operation["result_version"],
    )
    assert reconciled["state"] == "forwarded"


async def test_commit_requires_two_current_readers_including_non_uploader(db):
    target = await _target_channel(db)
    row = await _saved_file(db)
    job = await db.create_migration_manifest(OWNER_A, target["version"], target["accounts_version"])
    item = job["items"][0]
    operation = await _sent_operation(db, row, "migration-quorum")
    claimed = await db.claim_migration_item(
        OWNER_A, job["migration_id"], item["item_id"], item["version"],
        "tab", 30, operation_id=operation["operation_id"], state="uncertain",
    )
    item = await db.transition_reconciled_item(
        OWNER_A, job["migration_id"], item["item_id"], claimed["version"], operation["result_version"]
    )
    item = await _evidence(db, job, item, operation, OWNER_A)

    job = await db.get_migration_job(OWNER_A, job["migration_id"])
    with pytest.raises(ValueError, match="quorum"):
        await db.commit_migration_group(
            OWNER_A, job["migration_id"], item["group_id"], job["version"],
            {item["item_id"]: item["version"]},
        )

    item = await _evidence(db, job, item, operation, 1102)
    job = await db.get_migration_job(OWNER_A, job["migration_id"])
    result = await db.commit_migration_group(
        OWNER_A, job["migration_id"], item["group_id"], job["version"],
        {item["item_id"]: item["version"]},
    )
    assert result["items"][0]["state"] == "applied"
    moved = await db.get_file(row["file_id"], OWNER_A)
    assert moved["telegram_chat_id"] == CHANNEL_ID
    assert moved["location_version"] == 1


async def test_unlinked_evidence_account_stops_counting_without_retransmit(db):
    target = await _target_channel(db)
    row = await _saved_file(db)
    job = await db.create_migration_manifest(OWNER_A, target["version"], target["accounts_version"])
    item = job["items"][0]
    operation = await _sent_operation(db, row, "migration-unlink")
    claimed = await db.claim_migration_item(OWNER_A, job["migration_id"], item["item_id"], item["version"], "tab", 30, operation_id=operation["operation_id"], state="uncertain")
    item = await db.transition_reconciled_item(OWNER_A, job["migration_id"], item["item_id"], claimed["version"], operation["result_version"])
    item = await _evidence(db, job, item, operation, OWNER_A)
    item = await _evidence(db, job, item, operation, 1102)
    assert await db.unlink_account(OWNER_A, 1102) is True

    job = await db.get_migration_job(OWNER_A, job["migration_id"])
    with pytest.raises(ValueError, match="quorum"):
        await db.commit_migration_group(OWNER_A, job["migration_id"], item["group_id"], job["version"], {item["item_id"]: item["version"]})


async def test_rollback_uses_applied_location_cas_and_restores_only_location(db):
    target = await _target_channel(db)
    row = await _saved_file(db)
    job = await db.create_migration_manifest(OWNER_A, target["version"], target["accounts_version"])
    item = job["items"][0]
    operation = await _sent_operation(db, row, "migration-rollback")
    claimed = await db.claim_migration_item(OWNER_A, job["migration_id"], item["item_id"], item["version"], "tab", 30, operation_id=operation["operation_id"], state="uncertain")
    item = await db.transition_reconciled_item(OWNER_A, job["migration_id"], item["item_id"], claimed["version"], operation["result_version"])
    item = await _evidence(db, job, item, operation, OWNER_A, source_ok=True)
    item = await _evidence(db, job, item, operation, 1102, source_ok=True)
    job = await db.get_migration_job(OWNER_A, job["migration_id"])
    applied = await db.commit_migration_group(OWNER_A, job["migration_id"], item["group_id"], job["version"], {item["item_id"]: item["version"]})
    applied_item = applied["items"][0]

    await db._conn.execute(
        "UPDATE files SET filename = ? WHERE file_id = ? AND owner_id = ?",
        ("renamed-after-migration.bin", row["file_id"], OWNER_A),
    )
    await db._conn.commit()
    with pytest.raises(ValueError, match="location version"):
        await db.rollback_migration_group(OWNER_A, job["migration_id"], item["group_id"], {item["item_id"]: applied_item["applied_location_version"] + 1})

    rolled = await db.rollback_migration_group(OWNER_A, job["migration_id"], item["group_id"], {item["item_id"]: applied_item["applied_location_version"]})
    restored = await db.get_file(row["file_id"], OWNER_A)
    assert rolled["items"][0]["state"] == "rolled_back"
    assert restored["telegram_chat_id"] is None
    assert restored["telegram_message_id"] == row["telegram_message_id"]
    assert restored["filename"] == "renamed-after-migration.bin"
    assert restored["location_version"] == 2
