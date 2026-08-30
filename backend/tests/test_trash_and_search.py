"""Trash (soft-delete), restore, purge, sorting and search-escaping.

The service/database statements of these rules. test_api_trash.py and
test_api_files_listing.py check the endpoints on top of them.
"""
from conftest import OWNER_A


async def test_trash_restore_purge_subtree(db, file_service, make_file):
    # root_folder/ ├ file_a └ sub/ └ file_b   plus unrelated outside_file
    await make_file("root_folder", is_dir=True)
    await make_file("file_a", parent_id="root_folder")
    await make_file("sub", parent_id="root_folder", is_dir=True)
    await make_file("file_b", parent_id="sub", telegram_message_id=21)
    await make_file("outside_file", telegram_message_id=99)

    # Trash the folder → whole subtree gone from live listings, outside_file survives.
    assert await file_service.trash_file("root_folder", OWNER_A) == 4
    live, _ = await db.get_files_paginated(parent_id=None, is_dir=False, owner_id=OWNER_A)
    assert {r["file_id"] for r in live} == {"outside_file"}

    # Trash listing shows only the root, not its contents.
    trash, _ = await db.get_files_paginated(owner_id=OWNER_A, trashed=True)
    assert {r["file_id"] for r in trash} == {"root_folder"}

    # Restore brings the whole subtree back.
    restored = await file_service.restore_file("root_folder", OWNER_A)
    assert restored is not None and restored.trashed_at is None
    live_folders, _ = await db.get_files_paginated(parent_id=None, is_dir=True, owner_id=OWNER_A)
    assert "root_folder" in {r["file_id"] for r in live_folders}

    # Purge removes metadata only and deliberately does not report message ids.
    await file_service.trash_file("root_folder", OWNER_A)
    deleted = await file_service.purge_file("root_folder", OWNER_A)
    assert deleted == 4
    assert await db.get_file("outside_file") is not None


async def test_restore_to_root_when_parent_purged(db, file_service, make_file):
    await make_file("parent", is_dir=True)
    await make_file("child", parent_id="parent")
    await file_service.trash_file("child", OWNER_A)
    await db.delete_files_by_ids(["parent"], OWNER_A)  # parent gone entirely

    restored = await file_service.restore_file("child", OWNER_A)

    assert restored.parent_id is None  # bumped to drive root


async def test_restore_rejects_live_item(file_service, make_file):
    await make_file("live")

    raised = False
    try:
        await file_service.restore_file("live", OWNER_A)
    except ValueError:
        raised = True

    assert raised


async def test_search_escapes_like_metacharacters(db, make_file):
    await make_file("id1", filename="50% off.txt")
    await make_file("id2", filename="5000 off.txt")  # would match if % were a wildcard

    rows, _ = await db.get_files_paginated(owner_id=OWNER_A, search="50%")

    assert {r["file_id"] for r in rows} == {"id1"}


async def test_sort_by_name_asc(db, make_file):
    await make_file("id1", filename="banana")
    await make_file("id2", filename="Apple")
    await make_file("id3", filename="cherry")

    rows, _ = await db.get_files_paginated(
        parent_id=None, is_dir=False, owner_id=OWNER_A,
        sort_by="name", sort_order="asc",
    )

    assert [r["filename"] for r in rows] == ["Apple", "banana", "cherry"]
