"""Second-pass Task 4-5 review regressions."""
import asyncio

import pytest

from conftest import OWNER_A


def _source_snapshot(row):
    return {
        key: row[key]
        for key in (
            "file_id",
            "telegram_user_id",
            "telegram_chat_id",
            "telegram_message_id",
            "telegram_media_kind",
            "telegram_media_id",
            "telegram_media_size",
            "telegram_photo_variant",
            "location_version",
            "access_hash",
        )
    }


async def _payload(
    db,
    operation_id: str,
    random_id: str,
    logical_file_id: str,
    *,
    group_id=None,
    part_index=None,
    source=None,
):
    target = await db.get_storage_target(OWNER_A)
    metadata = {"filename": f"{logical_file_id}.bin", "filesize": 17}
    if source is not None:
        metadata["source"] = source
    return {
        "operation_id": operation_id,
        "kind": "upload",
        "logical_file_id": logical_file_id,
        "group_id": group_id,
        "part_index": part_index,
        "uploader_id": OWNER_A,
        "target_kind": "saved_messages",
        "target_channel_id": None,
        "target_peer_key": f"me:{OWNER_A}",
        "created_target_version": target["version"],
        "created_accounts_version": target["accounts_version"],
        "random_id": random_id,
        "rpc_kind": "messages.sendMedia",
        "request_metadata": metadata,
    }


async def _sent_operation(
    db,
    operation_id: str,
    random_id: str,
    logical_file_id: str,
    *,
    group_id=None,
    part_index=None,
    source=None,
    message_id=42,
):
    payload = await _payload(
        db,
        operation_id,
        random_id,
        logical_file_id,
        group_id=group_id,
        part_index=part_index,
        source=source,
    )
    operation = await db.create_or_get_telegram_operation(OWNER_A, payload)
    claimed = await db.claim_telegram_operation(OWNER_A, operation_id, "task5-review")
    return await db.complete_operation_result(
        OWNER_A,
        operation_id,
        claimed["version"],
        {
            "uploader_id": OWNER_A,
            "random_id": random_id,
            "target_peer_key": f"me:{OWNER_A}",
            "destination_message_id": message_id,
        },
        {
            "destination_media_kind": "document",
            "destination_media_id": f"media-{message_id}",
            "destination_size": 17,
        },
    )


async def _insert_split_part(db, file_id: str, group_id: str, part_index: int, message_id: int):
    await db.insert_file(
        file_id,
        f"{file_id}.bin",
        17,
        "application/octet-stream",
        "other",
        message_id,
        "2026-01-01T00:00:00+00:00",
        None,
        "legacy-access",
        None,
        False,
        is_split_file=True,
        part_index=part_index,
        total_parts=2,
        split_group_id=group_id,
        telegram_user_id=OWNER_A,
        owner_id=OWNER_A,
    )
    return await db.get_file(file_id, OWNER_A)


@pytest.mark.parametrize(
    "media_identity",
    [
        {
            "destination_media_kind": "video",
            "destination_media_id": "invalid-kind",
            "destination_size": 17,
        },
        {
            "destination_media_kind": "photo",
            "destination_media_id": "photo-without-variant",
            "destination_size": 17,
        },
    ],
)
async def test_sent_result_rejects_invalid_canonical_media_identity(db, media_identity):
    await db.link_account(OWNER_A, OWNER_A, is_primary=True)
    payload = await _payload(db, "invalid-media", "1000000003001", "invalid-media")
    operation = await db.create_or_get_telegram_operation(OWNER_A, payload)
    claimed = await db.claim_telegram_operation(OWNER_A, operation["operation_id"], "task5-review")

    with pytest.raises(ValueError, match="media identity"):
        await db.complete_operation_result(
            OWNER_A,
            operation["operation_id"],
            claimed["version"],
            {
                "uploader_id": OWNER_A,
                "random_id": payload["random_id"],
                "target_peer_key": payload["target_peer_key"],
                "destination_message_id": 42,
            },
            media_identity,
        )

    current = await db.get_telegram_operation(OWNER_A, operation["operation_id"])
    assert current["state"] == "sending"
    assert current["result_version"] is None


async def test_sent_result_accepts_photo_only_with_a_variant(db):
    await db.link_account(OWNER_A, OWNER_A, is_primary=True)
    payload = await _payload(db, "valid-photo", "1000000003002", "valid-photo")
    operation = await db.create_or_get_telegram_operation(OWNER_A, payload)
    claimed = await db.claim_telegram_operation(OWNER_A, operation["operation_id"], "task5-review")

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
            "destination_media_kind": "photo",
            "destination_media_id": "photo-42",
            "destination_size": 17,
            "destination_photo_variant": "x",
        },
    )

    assert sent["state"] == "sent"
    assert sent["media_identity_json"]["destination_photo_variant"] == "x"


async def test_single_location_switch_cannot_partially_move_a_split_group(db):
    await db.link_account(OWNER_A, OWNER_A, is_primary=True)
    row = await _insert_split_part(db, "split-single-0", "split-single", 0, 70)
    operation = await _sent_operation(
        db,
        "split-single-op",
        "1000000003003",
        row["file_id"],
        group_id="split-single",
        part_index=0,
        source=_source_snapshot(row),
        message_id=80,
    )

    with pytest.raises(ValueError, match="split"):
        await db.switch_existing_file_location(
            OWNER_A,
            row["file_id"],
            0,
            operation["operation_id"],
            operation["result_version"],
        )

    current = await db.get_file(row["file_id"], OWNER_A)
    assert current["telegram_message_id"] == 70
    assert current["location_version"] == 0


async def test_split_group_switch_rolls_back_every_part_on_one_bad_result_version(db):
    await db.link_account(OWNER_A, OWNER_A, is_primary=True)
    first = await _insert_split_part(db, "split-rollback-0", "split-rollback", 0, 70)
    second = await _insert_split_part(db, "split-rollback-1", "split-rollback", 1, 71)
    first_op = await _sent_operation(
        db,
        "split-rollback-op-0",
        "1000000003004",
        first["file_id"],
        group_id="split-rollback",
        part_index=0,
        source=_source_snapshot(first),
        message_id=80,
    )
    second_op = await _sent_operation(
        db,
        "split-rollback-op-1",
        "1000000003005",
        second["file_id"],
        group_id="split-rollback",
        part_index=1,
        source=_source_snapshot(second),
        message_id=81,
    )

    with pytest.raises(ValueError, match="result version"):
        await db.switch_existing_file_location_group(
            OWNER_A,
            [
                {
                    "file_id": first["file_id"],
                    "expected_location_version": 0,
                    "operation_id": first_op["operation_id"],
                    "result_version": first_op["result_version"],
                },
                {
                    "file_id": second["file_id"],
                    "expected_location_version": 0,
                    "operation_id": second_op["operation_id"],
                    "result_version": second_op["result_version"] + 1,
                },
            ],
        )

    first_after = await db.get_file(first["file_id"], OWNER_A)
    second_after = await db.get_file(second["file_id"], OWNER_A)
    assert (first_after["telegram_message_id"], first_after["location_version"]) == (70, 0)
    assert (second_after["telegram_message_id"], second_after["location_version"]) == (71, 0)


async def test_shared_sqlite_connection_serializes_overlapping_transactions(db):
    await db.link_account(OWNER_A, OWNER_A, is_primary=True)
    first = await _payload(db, "concurrent-a", "1000000003006", "concurrent-a")
    second = await _payload(db, "concurrent-b", "1000000003007", "concurrent-b")

    results = await asyncio.gather(
        db.create_or_get_telegram_operation(OWNER_A, first),
        db.create_or_get_telegram_operation(OWNER_A, second),
        return_exceptions=True,
    )

    errors = [result for result in results if isinstance(result, BaseException)]
    assert errors == []
    assert {result["operation_id"] for result in results} == {"concurrent-a", "concurrent-b"}
