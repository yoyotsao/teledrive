"""Regression test: init_schema must upgrade databases created by older versions.

Bug: commit a2f2510 added `has_thumbnail` to CREATE TABLE and to the INSERT,
but never added the matching ALTER TABLE. New databases were fine; every
pre-existing one (15k+ rows in the wild) failed every upload with
"table files has no column named has_thumbnail".

The property this encodes: a user who upgrades TeleDrive keeps working. A test
that only checks a freshly-created schema cannot catch that — so unlike the
rest of the suite these tests build their own legacy database by hand instead
of using the `db` fixture.
"""
import sqlite3

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


def legacy_database(tmp_path, name, extra_sql=()):
    """Write a pre-upgrade SQLite file and hand back its path."""
    path = str(tmp_path / name)
    legacy = sqlite3.connect(path)
    legacy.execute(PRE_MIGRATION_SCHEMA)
    for statement in extra_sql:
        legacy.execute(*statement) if isinstance(statement, tuple) else legacy.execute(statement)
    legacy.commit()
    legacy.close()
    return path


async def test_upload_still_works_on_a_database_from_before_has_thumbnail(tmp_path):
    db = Database(legacy_database(tmp_path, "old.db"))
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
        row = await db.get_file("f1")
    finally:
        # aiosqlite's worker thread is non-daemon — leaking it on the failure
        # path hangs pytest at exit instead of reporting the failure.
        await db.close()

    assert row["has_thumbnail"] == 1


async def test_multi_account_migration_keeps_existing_files_visible(tmp_path):
    """owner_id splits off from telegram_user_id — an upgrade must not orphan files.

    Tenant filtering moved from telegram_user_id to owner_id. If the backfill
    misses, every pre-upgrade file silently vanishes from its owner's drive.
    """
    rows_sql = [
        (
            "INSERT INTO files (file_id, filename, filesize, file_type, created_at, isDir, telegram_user_id) "
            "VALUES (?, ?, 1, 'other', '2026-01-01T00:00:00', 0, ?)",
            (file_id, file_id, user),
        )
        for file_id, user in (("f1", 111), ("f2", 111), ("f3", 222))
    ]
    path = legacy_database(
        tmp_path,
        "single_account.db",
        ["ALTER TABLE files ADD COLUMN telegram_user_id INTEGER NOT NULL DEFAULT 0"] + rows_sql,
    )

    db = Database(path)
    await db.connect()
    try:
        await db.init_schema()
        rows = await db.get_all_files()
        accounts = await db.list_linked_accounts(111)
        # Run it twice: init_schema runs on every boot and must not re-backfill
        # over owner_id once accounts have diverged from storage accounts.
        await db.init_schema()
        owner_of_222 = await db.get_owner_of(222)
    finally:
        await db.close()

    assert {r["file_id"]: r["owner_id"] for r in rows} == {"f1": 111, "f2": 111, "f3": 222}
    # Each pre-existing account becomes its own drive's primary.
    assert [(a["telegram_user_id"], a["is_primary"], a["file_count"]) for a in accounts] == [(111, 1, 2)]
    assert owner_of_222 == 222
