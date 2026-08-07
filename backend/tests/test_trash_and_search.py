"""Trash (soft-delete), restore, purge, sorting, and search-escaping coverage."""
import asyncio

from app.services.database import Database
from app.services.file_service import FileService

USER_ID = 1


async def _insert(db, file_id, filename=None, parent_id=None, is_dir=False, msg_id=None):
    await db.insert_file(
        file_id=file_id,
        filename=filename or file_id,
        filesize=0,
        mime_type=None,
        file_type="other",
        telegram_message_id=msg_id,
        has_thumbnail=False,
        created_at="2026-01-01T00:00:00",
        direct_url=None,
        access_hash=None,
        parent_id=parent_id,
        is_dir=is_dir,
        telegram_user_id=USER_ID,
        owner_id=USER_ID,
    )


async def _fresh(tmp_path):
    db = Database(db_path=str(tmp_path / "t.db"))
    await db.connect()
    await db.init_schema()
    fs = FileService()
    fs._db = db
    return db, fs


def test_trash_restore_purge_subtree(tmp_path):
    async def run():
        db, fs = await _fresh(tmp_path)
        # root_folder/ ├ file_a └ sub/ └ file_b   plus unrelated outside_file
        await _insert(db, "root_folder", is_dir=True)
        await _insert(db, "file_a", parent_id="root_folder")
        await _insert(db, "sub", parent_id="root_folder", is_dir=True)
        await _insert(db, "file_b", parent_id="sub", msg_id=21)
        await _insert(db, "outside_file", msg_id=99)

        # Trash the folder → whole subtree gone from live listings, outside_file survives.
        n = await fs.trash_file("root_folder", USER_ID)
        assert n == 4
        live, total = await db.get_files_paginated(parent_id=None, is_dir=False, owner_id=USER_ID)
        assert {r["file_id"] for r in live} == {"outside_file"}

        # Trash listing shows only the root, not its contents.
        trash, _ = await db.get_files_paginated(owner_id=USER_ID, trashed=True)
        assert {r["file_id"] for r in trash} == {"root_folder"}

        # Restore brings the whole subtree back.
        restored = await fs.restore_file("root_folder", USER_ID)
        assert restored is not None and restored.trashed_at is None
        live_folders, _ = await db.get_files_paginated(parent_id=None, is_dir=True, owner_id=USER_ID)
        assert "root_folder" in {r["file_id"] for r in live_folders}

        # Purge removes rows and reports Telegram message ids.
        await fs.trash_file("root_folder", USER_ID)
        deleted, msg_ids = await fs.purge_file("root_folder", USER_ID)
        assert deleted == 4
        assert sorted(msg_ids) == [21]
        assert await db.get_file("outside_file") is not None
        await db.close()

    asyncio.run(run())


def test_restore_to_root_when_parent_purged(tmp_path):
    async def run():
        db, fs = await _fresh(tmp_path)
        await _insert(db, "parent", is_dir=True)
        await _insert(db, "child", parent_id="parent")

        await fs.trash_file("child", USER_ID)
        await db.delete_files_by_ids(["parent"])  # parent gone entirely

        restored = await fs.restore_file("child", USER_ID)
        assert restored.parent_id is None  # bumped to drive root
        await db.close()

    asyncio.run(run())


def test_restore_rejects_live_item(tmp_path):
    async def run():
        db, fs = await _fresh(tmp_path)
        await _insert(db, "live")
        raised = False
        try:
            await fs.restore_file("live", USER_ID)
        except ValueError:
            raised = True
        assert raised
        await db.close()

    asyncio.run(run())


def test_search_escapes_like_metacharacters(tmp_path):
    async def run():
        db, fs = await _fresh(tmp_path)
        await _insert(db, "id1", filename="50% off.txt")
        await _insert(db, "id2", filename="5000 off.txt")  # would match if % were a wildcard

        rows, _ = await db.get_files_paginated(owner_id=USER_ID, search="50%")
        assert {r["file_id"] for r in rows} == {"id1"}
        await db.close()

    asyncio.run(run())


def test_sort_by_name_asc(tmp_path):
    async def run():
        db, fs = await _fresh(tmp_path)
        await _insert(db, "id1", filename="banana")
        await _insert(db, "id2", filename="Apple")
        await _insert(db, "id3", filename="cherry")

        rows, _ = await db.get_files_paginated(
            parent_id=None, is_dir=False, owner_id=USER_ID,
            sort_by="name", sort_order="asc",
        )
        assert [r["filename"] for r in rows] == ["Apple", "banana", "cherry"]
        await db.close()

    asyncio.run(run())
