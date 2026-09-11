"""Purge/tombstone regression for durable Telegram operation registration."""

import pytest

from conftest import OWNER_A


async def test_purge_tombstones_sent_operation_and_blocks_late_registration(db, file_service):
    await db.link_account(OWNER_A, OWNER_A, is_primary=True)
    await db.insert_file(
        "purge-race",
        "purge-race.bin",
        17,
        "application/octet-stream",
        "other",
        7,
        "2026-01-01T00:00:00+00:00",
        None,
        None,
        None,
        False,
        telegram_user_id=OWNER_A,
        owner_id=OWNER_A,
    )
    target = await db.get_storage_target(OWNER_A)
    payload = {
        "operation_id": "purge-race-op",
        "kind": "upload",
        "logical_file_id": "purge-race",
        "uploader_id": OWNER_A,
        "target_kind": "saved_messages",
        "target_channel_id": None,
        "target_peer_key": f"me:{OWNER_A}",
        "created_target_version": target["version"],
        "created_accounts_version": target["accounts_version"],
        "random_id": "1000000002999",
        "rpc_kind": "messages.sendMedia",
        "request_metadata": {"filename": "purge-race.bin", "filesize": 17},
    }
    operation = await db.create_or_get_telegram_operation(OWNER_A, payload)
    claimed = await db.claim_telegram_operation(OWNER_A, operation["operation_id"], "purge-tab")
    sent = await db.complete_operation_result(
        OWNER_A,
        operation["operation_id"],
        claimed["version"],
        {
            "uploader_id": OWNER_A,
            "random_id": payload["random_id"],
            "target_peer_key": payload["target_peer_key"],
            "destination_message_id": 42,
        },
        {
            "destination_media_kind": "document",
            "destination_media_id": "purge-destination",
            "destination_size": 17,
        },
    )
    assert sent["state"] == "sent"

    assert await file_service.purge_file("purge-race", OWNER_A) == 1
    assert await db.get_file("purge-race", OWNER_A) is None
    assert (await db.get_telegram_operation(OWNER_A, operation["operation_id"]))["state"] == "tombstoned"

    with pytest.raises(ValueError, match="tombstoned"):
        await db.register_telegram_operation(OWNER_A, operation["operation_id"])
    assert await db.get_file("purge-race", OWNER_A) is None
