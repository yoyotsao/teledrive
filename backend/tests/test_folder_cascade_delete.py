"""Regression test: deleting a folder must recursively delete all descendants.

Bug: deleting a folder from the web UI removed only the folder row itself,
leaving every file/subfolder underneath orphaned in SQLite (97k+ rows).
"""
import asyncio

from app.services.database import Database
from app.services.file_service import FileService

USER_ID = 1


async def _insert(db: Database, file_id: str, parent_id=None, is_dir=False,
                  msg_id=None, has_thumb=False):
    await db.insert_file(
        file_id=file_id,
        filename=file_id,
        filesize=0,
        mime_type=None,
        file_type="other",
        telegram_message_id=msg_id,
        has_thumbnail=has_thumb,
        created_at="2026-01-01T00:00:00",
        direct_url=None,
        access_hash=None,
        parent_id=parent_id,
        is_dir=is_dir,
        telegram_user_id=USER_ID,
    )


async def _build_tree(db: Database):
    """root_folder/ ├─ file_a (msg 11, embedded thumb) └─ sub_folder/ └─ file_b (msg 21)"""
    await _insert(db, "root_folder", is_dir=True)
    await _insert(db, "file_a", parent_id="root_folder", msg_id=11, has_thumb=True)
    await _insert(db, "sub_folder", parent_id="root_folder", is_dir=True)
    await _insert(db, "file_b", parent_id="sub_folder", msg_id=21)
    await _insert(db, "outside_file", msg_id=99)  # must survive the delete


async def _count_rows(db: Database) -> int:
    cursor = await db._conn.execute("SELECT COUNT(*) FROM files")
    row = await cursor.fetchone()
    return row[0]


def test_get_subtree_returns_folder_and_all_descendants(tmp_path):
    async def run():
        db = Database(db_path=str(tmp_path / "t.db"))
        await db.connect()
        await db.init_schema()
        await _build_tree(db)

        subtree = await db.get_subtree("root_folder")
        ids = {r["file_id"] for r in subtree}
        assert ids == {"root_folder", "file_a", "sub_folder", "file_b"}
        await db.close()

    asyncio.run(run())


def test_delete_folder_cascades_and_reports_telegram_messages(tmp_path):
    async def run():
        db = Database(db_path=str(tmp_path / "t.db"))
        await db.connect()
        await db.init_schema()
        await _build_tree(db)

        fs = FileService()
        fs._db = db  # inject isolated test database

        deleted_count, message_ids = await fs.delete_folder("root_folder")

        assert deleted_count == 4
        # embedded thumbs die with the file message — only file messages listed
        assert sorted(message_ids) == [11, 21]
        # only the unrelated root file remains
        assert await _count_rows(db) == 1
        remaining = await db.get_file("outside_file")
        assert remaining is not None
        await db.close()

    asyncio.run(run())


def test_delete_folder_refuses_plain_files(tmp_path):
    async def run():
        db = Database(db_path=str(tmp_path / "t.db"))
        await db.connect()
        await db.init_schema()
        await _build_tree(db)

        fs = FileService()
        fs._db = db

        deleted_count, message_ids = await fs.delete_folder("file_a")
        assert deleted_count == 0
        assert message_ids == []
        assert await _count_rows(db) == 5
        await db.close()

    asyncio.run(run())
