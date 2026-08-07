"""Regression test: init_schema must upgrade databases created by older versions.

Bug: commit a2f2510 added `has_thumbnail` to CREATE TABLE and to the INSERT,
but never added the matching ALTER TABLE. New databases were fine; every
pre-existing one (15k+ rows in the wild) failed every upload with
"table files has no column named has_thumbnail".

The property this encodes: a user who upgrades TeleDrive keeps working. A test
that only checks a freshly-created schema cannot catch that.
"""
import asyncio
import os
import sqlite3
import tempfile

from app.services.database import Database

# The `files` table exactly as it stood before a2f2510.
PRE_MIGRATION_SCHEMA = """
    CREATE TABLE files (
        file_id TEXT PRIMARY KEY,
        filename TEXT NOT NULL,
        filesize INTEGER NOT NULL,
        mime_type TEXT,
        file_type TEXT NOT NULL,
        telegram_message_id INTEGER,
        thumbnail_message_id INTEGER,
        created_at TEXT NOT NULL,
        direct_url TEXT,
        access_hash TEXT,
        parent_id TEXT,
        isDir INTEGER NOT NULL DEFAULT 0
    )
"""


def test_upload_still_works_on_a_database_from_before_has_thumbnail():
    db_path = os.path.join(tempfile.mkdtemp(), "old.db")
    legacy = sqlite3.connect(db_path)
    legacy.execute(PRE_MIGRATION_SCHEMA)
    legacy.commit()
    legacy.close()

    async def run():
        db = Database(db_path)
        await db.connect()
        try:
            await db.init_schema()
            # This is the exact call every upload makes.
            await db.insert_file(
                file_id="f1",
                filename="clip.mp4",
                filesize=1,
                mime_type="video/mp4",
                file_type="video",
                telegram_message_id=1,
                has_thumbnail=True,
                created_at="2026-01-01T00:00:00",
                direct_url=None,
                access_hash=None,
                parent_id=None,
                is_dir=False,
                telegram_user_id=1,
            )
            return await db.get_file("f1")
        finally:
            # aiosqlite's worker thread is non-daemon — leaking it on the
            # failure path hangs pytest at exit instead of reporting the failure.
            await db.close()

    row = asyncio.run(run())
    assert row["has_thumbnail"] == 1
