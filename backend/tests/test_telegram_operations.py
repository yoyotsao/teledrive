"""Durable send intents survive reloads without creating a second message.

The repository is deliberately tested without Telegram clients: all it owns is
SQLite intent/result metadata and its closed transition graph.
"""
from datetime import datetime, timedelta, timezone

import pytest

from conftest import OWNER_A, OWNER_B


async def _payload(db, operation_id="operation-a", random_id="1000000000001"):
    if await db.get_linked_account(OWNER_A, OWNER_A) is None:
        await db.link_account(OWNER_A, OWNER_A, is_primary=True)
    target = await db.get_storage_target(OWNER_A)
    return {
        "operation_id": operation_id,
        "kind": "upload",
        "logical_file_id": f"logical-{operation_id}",
        "uploader_id": OWNER_A,
        "target_kind": "saved_messages",
        "target_channel_id": None,
        "target_peer_key": f"me:{OWNER_A}",
        "created_target_version": target["version"],
        "created_accounts_version": target["accounts_version"],
        "random_id": random_id,
        "rpc_kind": "messages.sendMedia",
        "request_metadata": {
            "source": {"file_hash": "a" * 64, "size": 17},
            "caption": "frozen intent",
        },
    }


def _result(operation):
    return (
        {
            "uploader_id": operation["uploader_id"],
            "random_id": operation["random_id"],
            "target_peer_key": operation["target_peer_key"],
            "destination_message_id": 42,
        },
        {
            "destination_media_kind": "document",
            "destination_media_id": "9001",
            "destination_size": 17,
        },
    )


async def test_create_freezes_payload_and_idempotently_returns_the_same_operation(db):
    payload = await _payload(db)
    created = await db.create_or_get_telegram_operation(OWNER_A, payload)
    payload["request_metadata"]["caption"] = "mutated after persistence"

    stored = await db.get_telegram_operation(OWNER_A, created["operation_id"])
    retry = await db.create_or_get_telegram_operation(OWNER_A, await _payload(db))

    assert stored["request_metadata"]["caption"] == "frozen intent"
    assert retry["operation_id"] == created["operation_id"]
    assert retry["state"] == "planned"


async def test_same_operation_id_with_a_conflicting_frozen_payload_is_rejected(db):
    await db.create_or_get_telegram_operation(OWNER_A, await _payload(db))
    changed = await _payload(db)
    changed["request_metadata"]["source"]["size"] = 18

    with pytest.raises(ValueError, match="conflicting payload"):
        await db.create_or_get_telegram_operation(OWNER_A, changed)


async def test_uploader_random_id_is_unique_across_operations(db):
    await db.create_or_get_telegram_operation(OWNER_A, await _payload(db))

    with pytest.raises(ValueError, match="random_id"):
        await db.create_or_get_telegram_operation(
            OWNER_A, await _payload(db, "operation-b", "1000000000001")
        )


async def test_expired_lease_is_reclaimed_as_recovering(db):
    operation = await db.create_or_get_telegram_operation(OWNER_A, await _payload(db))
    claimed = await db.claim_telegram_operation(
        OWNER_A, operation["operation_id"], "tab-one", lease_seconds=1,
        now=datetime(2026, 1, 1, tzinfo=timezone.utc),
    )

    reclaimed = await db.claim_telegram_operation(
        OWNER_A, operation["operation_id"], "tab-two", lease_seconds=30,
        now=datetime(2026, 1, 1, tzinfo=timezone.utc) + timedelta(seconds=2),
    )

    assert claimed["state"] == "sending"
    assert reclaimed["state"] == "recovering"
    assert reclaimed["lease_owner"] == "tab-two"


async def test_owner_scoped_get_list_and_mutations_reject_other_drives(db):
    operation = await db.create_or_get_telegram_operation(OWNER_A, await _payload(db))

    assert await db.get_telegram_operation(OWNER_B, operation["operation_id"]) is None
    assert await db.list_telegram_operations(OWNER_B) == []
    with pytest.raises(PermissionError, match="another owner"):
        await db.claim_telegram_operation(OWNER_B, operation["operation_id"], "foreign-tab")


async def test_retryable_state_can_resume_sending_or_recovery_but_keeps_identity(db):
    operation = await db.create_or_get_telegram_operation(OWNER_A, await _payload(db))
    sending = await db.claim_telegram_operation(OWNER_A, operation["operation_id"], "tab")
    retryable = await db.transition_telegram_operation(
        OWNER_A, operation["operation_id"], sending["version"], "retryable",
        retry_at=(datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat(),
        error_code="TIMEOUT",
    )
    resumed = await db.claim_telegram_operation(OWNER_A, operation["operation_id"], "next-tab")
    retryable_again = await db.transition_telegram_operation(
        OWNER_A, operation["operation_id"], resumed["version"], "retryable",
        retry_at=(datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat(),
    )
    recovering = await db.transition_telegram_operation(
        OWNER_A, operation["operation_id"], retryable_again["version"], "recovering"
    )

    assert retryable["state"] == "retryable"
    assert resumed["state"] == "sending"
    assert recovering["state"] == "recovering"
    assert recovering["random_id"] == operation["random_id"]
    assert recovering["target_peer_key"] == operation["target_peer_key"]


async def test_uncertain_cannot_become_sent_without_expected_version_and_complete_identity(db):
    operation = await db.create_or_get_telegram_operation(OWNER_A, await _payload(db))
    sending = await db.claim_telegram_operation(OWNER_A, operation["operation_id"], "tab")
    uncertain = await db.transition_telegram_operation(
        OWNER_A, operation["operation_id"], sending["version"], "uncertain", error_code="RESULT_LOST"
    )
    mapping, media = _result(operation)

    with pytest.raises(ValueError, match="complete mapping"):
        await db.complete_operation_result(
            OWNER_A, operation["operation_id"], uncertain["version"], mapping,
            {"destination_media_kind": "document"},
        )
    assert (await db.get_telegram_operation(OWNER_A, operation["operation_id"]))["state"] == "uncertain"

    stale = await db.complete_operation_result(
        OWNER_A, operation["operation_id"], uncertain["version"] - 1, mapping, media
    )
    assert stale is None
    assert (await db.get_telegram_operation(OWNER_A, operation["operation_id"]))["state"] == "uncertain"

    sent = await db.complete_operation_result(
        OWNER_A, operation["operation_id"], uncertain["version"], mapping, media
    )
    replay = await db.complete_operation_result(
        OWNER_A, operation["operation_id"], uncertain["version"], mapping, media
    )
    assert sent["state"] == "sent"
    assert replay["state"] == "sent"
    assert replay["destination_message_id"] == 42


async def test_uncertain_rejects_a_mapping_for_another_frozen_identity(db):
    operation = await db.create_or_get_telegram_operation(OWNER_A, await _payload(db))
    sending = await db.claim_telegram_operation(OWNER_A, operation["operation_id"], "tab")
    uncertain = await db.transition_telegram_operation(
        OWNER_A, operation["operation_id"], sending["version"], "uncertain"
    )
    mapping, media = _result(operation)
    mapping["random_id"] = "999999"

    with pytest.raises(ValueError, match="frozen operation identity"):
        await db.complete_operation_result(
            OWNER_A, operation["operation_id"], uncertain["version"], mapping, media
        )
    assert (await db.get_telegram_operation(OWNER_A, operation["operation_id"]))["state"] == "uncertain"


async def test_retryable_can_be_tombstoned_and_uncertain_has_no_generic_exit(db):
    operation = await db.create_or_get_telegram_operation(OWNER_A, await _payload(db))
    sending = await db.claim_telegram_operation(OWNER_A, operation["operation_id"], "tab")
    retryable = await db.transition_telegram_operation(
        OWNER_A, operation["operation_id"], sending["version"], "retryable",
        retry_at=(datetime.now(timezone.utc) + timedelta(minutes=1)).isoformat(),
    )
    tombstoned = await db.transition_telegram_operation(
        OWNER_A, operation["operation_id"], retryable["version"], "tombstoned",
        tombstone_reason="user cancelled",
    )

    assert tombstoned["state"] == "tombstoned"
    assert tombstoned["tombstone_reason"] == "user cancelled"

    another = await db.create_or_get_telegram_operation(
        OWNER_A, await _payload(db, "operation-uncertain", "1000000000002")
    )
    sending = await db.claim_telegram_operation(OWNER_A, another["operation_id"], "tab")
    uncertain = await db.transition_telegram_operation(
        OWNER_A, another["operation_id"], sending["version"], "uncertain"
    )
    with pytest.raises(ValueError, match="cannot transition uncertain"):
        await db.transition_telegram_operation(
            OWNER_A, another["operation_id"], uncertain["version"], "tombstoned"
        )


async def _sent_operation(
    db, operation_id, file_id, random_id, *, group_id=None, part_index=None,
    total_parts=None, source=None,
):
    payload = await _payload(db, operation_id, random_id)
    payload.update({"logical_file_id": file_id, "group_id": group_id, "part_index": part_index})
    payload["request_metadata"].update({"filename": "one.bin", "filesize": 17})
    if source is not None:
        payload["request_metadata"]["source"] = source
    if total_parts is not None:
        payload["request_metadata"]["total_parts"] = total_parts
    operation = await db.create_or_get_telegram_operation(OWNER_A, payload)
    sending = await db.claim_telegram_operation(OWNER_A, operation_id, "tab")
    uncertain = await db.transition_telegram_operation(OWNER_A, operation_id, sending["version"], "uncertain")
    mapping, media = _result(operation)
    return await db.complete_operation_result(OWNER_A, operation_id, uncertain["version"], mapping, media)


async def test_registration_is_bound_before_a_retry_can_run_name_replacement(db):
    first = await _sent_operation(db, "op-a", "first", "1000000001001")
    binding = await db.register_telegram_operation(OWNER_A, first["operation_id"])
    later = await _sent_operation(db, "op-b", "later", "1000000001002")
    await db.register_telegram_operation(OWNER_A, later["operation_id"])

    retry = await db.register_telegram_operation(OWNER_A, first["operation_id"])

    assert retry == binding
    assert (await db.get_file("later", OWNER_A))["filename"] == "one.bin"
    assert await db.get_file("first", OWNER_A) is None


async def test_single_location_switch_preserves_logical_metadata_and_is_idempotent(db):
    await db.insert_file(
        "existing", "renamed.bin", 17, "application/octet-stream", "other", 7,
        "2026-01-01T00:00:00+00:00", None, "old-hash", "folder", False,
        owner_id=OWNER_A, telegram_user_id=OWNER_A,
    )
    current = await db.get_file("existing", OWNER_A)
    source = {
        key: current[key]
        for key in (
            "file_id", "telegram_user_id", "telegram_chat_id", "telegram_message_id",
            "telegram_media_kind", "telegram_media_id", "telegram_media_size",
            "telegram_photo_variant", "location_version", "access_hash",
        )
    }
    operation = await _sent_operation(
        db, "move", "existing", "1000000001003", source=source,
    )
    switched = await db.switch_existing_file_location(
        OWNER_A, "existing", 0, operation["operation_id"], operation["result_version"],
    )
    replay = await db.switch_existing_file_location(
        OWNER_A, "existing", 0, operation["operation_id"], operation["result_version"],
    )
    row = await db.get_file("existing", OWNER_A)

    assert replay == switched
    assert row["filename"] == "renamed.bin"
    assert row["parent_id"] == "folder"
    assert row["telegram_message_id"] == 42
    assert row["location_version"] == 1


async def test_single_location_switch_accepts_legacy_single_part_group_id(db):
    await db.insert_file(
        "legacy-single", "legacy.bin", 17, "application/octet-stream", "other", 7,
        "2026-01-01T00:00:00+00:00", None, "old-hash", "folder", False,
        is_split_file=False, part_index=0, total_parts=1, split_group_id="legacy-group",
        owner_id=OWNER_A, telegram_user_id=OWNER_A,
    )
    current = await db.get_file("legacy-single", OWNER_A)
    source = {
        key: current[key]
        for key in (
            "file_id", "telegram_user_id", "telegram_chat_id", "telegram_message_id",
            "telegram_media_kind", "telegram_media_id", "telegram_media_size",
            "telegram_photo_variant", "location_version", "access_hash",
        )
    }
    operation = await _sent_operation(
        db, "move-legacy-single", "legacy-single", "1000000001004", source=source,
    )

    switched = await db.switch_existing_file_location(
        OWNER_A, "legacy-single", 0, operation["operation_id"], operation["result_version"],
    )

    row = await db.get_file("legacy-single", OWNER_A)
    assert switched["location_version"] == 1
    assert row["telegram_message_id"] == 42
    assert row["location_version"] == 1
