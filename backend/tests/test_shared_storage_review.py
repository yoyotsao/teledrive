"""Regression tests for the Task 1-5 shared-channel storage review.

These cases pin trust boundaries and location-CAS behavior that are easy to
miss when the operation journal and legacy registration paths evolve in
parallel.  They deliberately exercise only SQLite/HTTP metadata paths; no
Telegram client or binary data is involved.
"""
from datetime import datetime, timezone

import pytest

from conftest import OWNER_A, OWNER_B

A_SECOND = 3003
CHANNEL_ID = "1234567890"


def _register_payload(file_id: str, **overrides):
    payload = {
        "filename": f"{file_id}.bin",
        "filesize": 17,
        "mime_type": "application/octet-stream",
        "message_id": 11,
        "file_id": file_id,
        "access_hash": "legacy-access-hash",
    }
    payload.update(overrides)
    return payload


async def _operation_payload(
    db,
    operation_id: str,
    logical_file_id: str,
    random_id: str,
    *,
    uploader_id: int = OWNER_A,
    group_id=None,
    part_index=None,
    source=None,
):
    target = await db.get_storage_target(OWNER_A)
    request_metadata = {
        "filename": f"{logical_file_id}.bin",
        "filesize": 17,
    }
    if source is not None:
        request_metadata["source"] = source
    return {
        "operation_id": operation_id,
        "kind": "upload",
        "logical_file_id": logical_file_id,
        "group_id": group_id,
        "part_index": part_index,
        "uploader_id": uploader_id,
        "target_kind": target["storage_mode"],
        "target_channel_id": target["channel_id"],
        "target_peer_key": (
            target["channel_id"]
            if target["storage_mode"] == "channel"
            else f"me:{uploader_id}"
        ),
        "created_target_version": target["version"],
        "created_accounts_version": target["accounts_version"],
        "random_id": random_id,
        "rpc_kind": "messages.sendMedia",
        "request_metadata": request_metadata,
    }


async def _sent_operation(
    db,
    operation_id: str,
    logical_file_id: str,
    random_id: str,
    *,
    uploader_id: int = OWNER_A,
    group_id=None,
    part_index=None,
    source=None,
    message_id: int = 42,
):
    payload = await _operation_payload(
        db,
        operation_id,
        logical_file_id,
        random_id,
        uploader_id=uploader_id,
        group_id=group_id,
        part_index=part_index,
        source=source,
    )
    operation = await db.create_or_get_telegram_operation(OWNER_A, payload)
    claimed = await db.claim_telegram_operation(OWNER_A, operation_id, "review-tab")
    return await db.complete_operation_result(
        OWNER_A,
        operation_id,
        claimed["version"],
        {
            "uploader_id": uploader_id,
            "random_id": random_id,
            "target_peer_key": payload["target_peer_key"],
            "destination_message_id": message_id,
        },
        {
            "destination_media_kind": "document",
            "destination_media_id": f"media-{message_id}",
            "destination_size": 17,
        },
    )


async def _insert_location_file(
    db,
    file_id: str,
    *,
    owner_id: int = OWNER_A,
    uploader_id: int = OWNER_A,
    message_id: int = 7,
    split_group_id=None,
    part_index=None,
    total_parts=None,
):
    await db.insert_file(
        file_id=file_id,
        filename=f"{file_id}.bin",
        filesize=17,
        mime_type="application/octet-stream",
        file_type="other",
        telegram_message_id=message_id,
        created_at="2026-01-01T00:00:00+00:00",
        direct_url=None,
        access_hash="source-access-hash",
        parent_id=None,
        is_dir=False,
        is_split_file=split_group_id is not None,
        part_index=part_index,
        total_parts=total_parts,
        split_group_id=split_group_id,
        telegram_user_id=uploader_id,
        owner_id=owner_id,
        telegram_chat_id=None,
        telegram_media_kind="document",
        telegram_media_id=f"source-media-{message_id}",
        telegram_media_size=17,
        location_version=0,
    )
    return await db.get_file(file_id, owner_id)


def _source_snapshot(row):
    return {
        "file_id": row["file_id"],
        "telegram_user_id": row["telegram_user_id"],
        "telegram_chat_id": row["telegram_chat_id"],
        "telegram_message_id": row["telegram_message_id"],
        "telegram_media_kind": row["telegram_media_kind"],
        "telegram_media_id": row["telegram_media_id"],
        "telegram_media_size": row["telegram_media_size"],
        "telegram_photo_variant": row["telegram_photo_variant"],
        "location_version": row["location_version"],
    }


async def _enable_channel(db):
    await db.link_account(OWNER_A, OWNER_A, is_primary=True)
    await db.link_account(OWNER_A, A_SECOND)
    target = await db.get_storage_target(OWNER_A)
    now = datetime.now(timezone.utc).isoformat()
    verifications = [
        {
            "telegram_user_id": account_id,
            "channel_id": CHANNEL_ID,
            "channel_title": "Review channel",
            "can_read": True,
            "can_write": True,
            "status": "verified",
            "checked_at": now,
            "accounts_version": target["accounts_version"],
        }
        for account_id in (OWNER_A, A_SECOND)
    ]
    return await db.put_storage_target(
        OWNER_A,
        {
            "storage_mode": "channel",
            "channel_id": CHANNEL_ID,
            "channel_title": "Review channel",
        },
        target["version"],
        target["accounts_version"],
        verifications,
    )


def test_legacy_reregister_without_location_cannot_change_message_id(client, db, run):
    first = client.post(
        "/api/v1/files/register",
        json=_register_payload(
            "stable-location",
            telegram_chat_id=CHANNEL_ID,
            telegram_media_kind="document",
            telegram_media_id="9001",
            telegram_media_size=17,
            location_version=3,
        ),
    )
    assert first.status_code == 200, first.text

    retry = client.post(
        "/api/v1/files/register",
        json=_register_payload("stable-location", message_id=12),
    )

    assert retry.status_code == 200, retry.text
    row = run(db.get_file("stable-location", OWNER_A))
    assert row["telegram_message_id"] == 11
    assert row["telegram_chat_id"] == CHANNEL_ID
    assert row["location_version"] == 3


@pytest.mark.parametrize(
    "overrides",
    [
        {"telegram_chat_id": "-1001234567890", "telegram_media_kind": "document", "telegram_media_id": "1", "telegram_media_size": 17},
        {"telegram_chat_id": "001", "telegram_media_kind": "document", "telegram_media_id": "1", "telegram_media_size": 17},
        {"telegram_chat_id": CHANNEL_ID, "telegram_media_kind": "document"},
        {"telegram_chat_id": CHANNEL_ID, "telegram_media_id": "1", "telegram_media_size": 17},
    ],
)
def test_legacy_register_rejects_noncanonical_or_partial_locations(client, overrides):
    response = client.post(
        "/api/v1/files/register",
        json=_register_payload("invalid-location", **overrides),
    )
    assert response.status_code in {400, 422}, response.text


def test_unlink_http_rejects_channel_uploader_without_another_reader(client, db, run):
    run(db.link_account(OWNER_A, OWNER_A, is_primary=True))
    run(db.link_account(OWNER_A, A_SECOND))
    run(
        db.insert_file(
            "channel-only",
            "channel-only.bin",
            17,
            "application/octet-stream",
            "other",
            9,
            "2026-01-01T00:00:00+00:00",
            None,
            None,
            None,
            False,
            telegram_user_id=A_SECOND,
            owner_id=OWNER_A,
            telegram_chat_id=CHANNEL_ID,
            telegram_media_kind="document",
            telegram_media_id="9009",
            telegram_media_size=17,
        )
    )

    response = client.delete(f"/api/v1/accounts/{A_SECOND}")

    assert response.status_code == 409, response.text
    assert run(db.get_owner_of(A_SECOND)) == OWNER_A


async def test_operation_creation_rejects_an_unlinked_uploader(db):
    await db.link_account(OWNER_A, OWNER_A, is_primary=True)
    payload = await _operation_payload(
        db,
        "unlinked-uploader",
        "logical-unlinked",
        "1000000002001",
        uploader_id=999999,
    )

    with pytest.raises(ValueError, match="linked"):
        await db.create_or_get_telegram_operation(OWNER_A, payload)


async def test_operation_registration_cannot_take_another_owners_file_id(db):
    await db.link_account(OWNER_A, OWNER_A, is_primary=True)
    await _insert_location_file(db, "shared-logical-id", owner_id=OWNER_B, uploader_id=OWNER_B)
    operation = await _sent_operation(
        db,
        "cross-owner-register",
        "shared-logical-id",
        "1000000002002",
    )

    with pytest.raises(PermissionError):
        await db.register_telegram_operation(OWNER_A, operation["operation_id"])

    row = await db.get_file("shared-logical-id")
    assert row["owner_id"] == OWNER_B


async def test_location_switch_requires_a_complete_source_snapshot(db):
    await db.link_account(OWNER_A, OWNER_A, is_primary=True)
    row = await _insert_location_file(db, "missing-source")
    operation = await _sent_operation(
        db,
        "missing-source-switch",
        row["file_id"],
        "1000000002003",
        source=None,
    )

    with pytest.raises(ValueError, match="source"):
        await db.switch_existing_file_location(
            OWNER_A,
            row["file_id"],
            row["location_version"],
            operation["operation_id"],
            operation["result_version"],
        )

    unchanged = await db.get_file(row["file_id"], OWNER_A)
    assert unchanged["telegram_message_id"] == row["telegram_message_id"]
    assert unchanged["location_version"] == 0


async def test_location_switch_preserves_soft_trash_state(db):
    await db.link_account(OWNER_A, OWNER_A, is_primary=True)
    row = await _insert_location_file(db, "trashed-switch")
    await db.set_trashed([row["file_id"]], "2026-01-02T00:00:00+00:00", OWNER_A)
    row = await db.get_file(row["file_id"], OWNER_A)
    operation = await _sent_operation(
        db,
        "trashed-switch-op",
        row["file_id"],
        "1000000002004",
        source=_source_snapshot(row),
    )

    binding = await db.switch_existing_file_location(
        OWNER_A,
        row["file_id"],
        row["location_version"],
        operation["operation_id"],
        operation["result_version"],
    )

    switched = await db.get_file(row["file_id"], OWNER_A)
    assert binding["location_version"] == 1
    assert switched["telegram_message_id"] == 42
    assert switched["trashed_at"] == "2026-01-02T00:00:00+00:00"


async def test_split_switch_allows_different_uploaders_for_one_frozen_channel(db):
    await _enable_channel(db)
    first = await _insert_location_file(
        db,
        "split-0",
        uploader_id=OWNER_A,
        split_group_id="split-review",
        part_index=0,
        total_parts=2,
        message_id=70,
    )
    second = await _insert_location_file(
        db,
        "split-1",
        uploader_id=A_SECOND,
        split_group_id="split-review",
        part_index=1,
        total_parts=2,
        message_id=71,
    )
    first_op = await _sent_operation(
        db,
        "split-op-0",
        first["file_id"],
        "1000000002005",
        uploader_id=OWNER_A,
        group_id="split-review",
        part_index=0,
        source=_source_snapshot(first),
        message_id=80,
    )
    second_op = await _sent_operation(
        db,
        "split-op-1",
        second["file_id"],
        "1000000002006",
        uploader_id=A_SECOND,
        group_id="split-review",
        part_index=1,
        source=_source_snapshot(second),
        message_id=81,
    )

    bindings = await db.switch_existing_file_location_group(
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
                "result_version": second_op["result_version"],
            },
        ],
    )

    assert [binding["location_version"] for binding in bindings] == [1, 1]
    assert (await db.get_file(first["file_id"], OWNER_A))["telegram_chat_id"] == CHANNEL_ID
    assert (await db.get_file(second["file_id"], OWNER_A))["telegram_chat_id"] == CHANNEL_ID
