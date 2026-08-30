"""Regression test: deleting a folder must recursively reach all descendants.

Bug: deleting a folder from the web UI removed only the folder row itself,
leaving every file/subfolder underneath orphaned in SQLite (97k+ rows).

The UI's delete goes through `trash_file`; permanent deletion goes through
`purge_file`. Both use the same owner-scoped subtree walk pinned here.
"""
from conftest import OWNER_A


async def build_tree(make_file):
    """root_folder/ ├─ file_a (msg 11, embedded thumb) └─ sub_folder/ └─ file_b (msg 21)"""
    await make_file("root_folder", is_dir=True)
    await make_file("file_a", parent_id="root_folder", telegram_message_id=11, has_thumbnail=True)
    await make_file("sub_folder", parent_id="root_folder", is_dir=True)
    await make_file("file_b", parent_id="sub_folder", telegram_message_id=21)
    await make_file("outside_file", telegram_message_id=99)  # must survive the delete


async def count_rows(db) -> int:
    cursor = await db._conn.execute("SELECT COUNT(*) FROM files")
    row = await cursor.fetchone()
    return row[0]


async def test_get_subtree_returns_the_folder_and_all_descendants(db, make_file):
    await build_tree(make_file)

    subtree = await db.get_subtree("root_folder", OWNER_A)

    assert {r["file_id"] for r in subtree} == {"root_folder", "file_a", "sub_folder", "file_b"}


async def test_purge_folder_cascades_metadata_only(db, file_service, make_file):
    await build_tree(make_file)

    deleted_count = await file_service.purge_file("root_folder", OWNER_A)

    assert deleted_count == 4
    assert await count_rows(db) == 1
    assert await db.get_file("outside_file") is not None


async def test_purge_plain_file_removes_its_metadata(db, file_service, make_file):
    await build_tree(make_file)

    deleted_count = await file_service.purge_file("file_a", OWNER_A)

    assert deleted_count == 1
    assert await count_rows(db) == 4


async def test_the_subtree_walk_is_owner_scoped(db, file_service, make_file):
    await make_file("their_folder", is_dir=True, owner_id=2002)
    await make_file("their_file", parent_id="their_folder", owner_id=2002)

    trashed = await file_service.trash_file("their_folder", OWNER_A)

    assert trashed == 0
    assert (await db.get_file("their_folder"))["trashed_at"] is None
