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
from datetime import datetime, timezone

from app.models.schemas import FileType
from app.services.file_service import FileService
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


async def test_shared_storage_migration_keeps_legacy_locations_unknown(tmp_path):
    """A migration must not invent a channel or Telegram media identity for old rows."""
    path = legacy_database(
        tmp_path,
        "legacy_locations.db",
        [
            "ALTER TABLE files ADD COLUMN telegram_user_id INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE files ADD COLUMN owner_id INTEGER NOT NULL DEFAULT 0",
            (
                "INSERT INTO files (file_id, filename, filesize, file_type, created_at, isDir, telegram_user_id, owner_id) "
                "VALUES (?, ?, 1, 'other', '2026-01-01T00:00:00', 0, ?, ?)",
                ("old-file", "old-file", 111, 111),
            ),
        ],
    )

    db = Database(path)
    await db.connect()
    try:
        await db.init_schema()
        row = await db.get_file("old-file", owner_id=111)
        target = await db.get_storage_target(111)
    finally:
        await db.close()

    assert row["telegram_chat_id"] is None
    assert row["telegram_media_kind"] is None
    assert row["telegram_media_id"] is None
    assert row["telegram_media_size"] is None
    assert row["telegram_photo_variant"] is None
    assert row["location_version"] == 0
    assert target == {
        "owner_id": 111,
        "storage_mode": "saved_messages",
        "channel_id": None,
        "channel_title": None,
        "version": 0,
        "accounts_version": 0,
        "verifications": [],
    }


async def test_storage_target_is_owner_scoped_and_keeps_location_verifications(tmp_path):
    """Changing drive A's target must not expose or overwrite drive B's target."""
    db = Database(str(tmp_path / "targets.db"))
    await db.connect()
    checked_at = datetime.now(timezone.utc).isoformat()
    try:
        await db.init_schema()
        assert await db.link_account(101, 101, is_primary=True)
        assert await db.link_account(202, 202, is_primary=True)

        saved = await db.put_storage_target(
            101,
            {"storage_mode": "channel", "channel_id": "1234567890", "channel_title": "Drive A"},
            expected_version=0,
            expected_accounts_version=1,
            verifications=[{
                "telegram_user_id": 101,
                "channel_id": "1234567890",
                "channel_title": "Drive A",
                "can_read": True,
                "can_write": True,
                "status": "verified",
                "checked_at": checked_at,
                "accounts_version": 1,
            }],
        )
        other = await db.get_storage_target(202)
    finally:
        await db.close()

    assert saved == {
        "owner_id": 101,
        "storage_mode": "channel",
        "channel_id": "1234567890",
        "channel_title": "Drive A",
        "version": 1,
        "accounts_version": 1,
        "verifications": [{
            "telegram_user_id": 101,
            "channel_id": "1234567890",
            "channel_title": "Drive A",
            "can_read": True,
            "can_write": True,
            "status": "verified",
            "checked_at": checked_at,
            "accounts_version": 1,
        }],
    }
    assert other["storage_mode"] == "saved_messages"
    assert other["channel_id"] is None
    assert other["verifications"] == []


async def test_file_service_returns_physical_location_wire_fields(tmp_path):
    """Replacing a location field with a legacy logical file ID would break direct readers."""
    db = Database(str(tmp_path / "location_wire.db"))
    await db.connect()
    try:
        await db.init_schema()
        service = FileService()
        service._db = db
        registered = await service.register_uploaded_file(
            filename="clip.jpg",
            filesize=4096,
            mime_type="image/jpeg",
            message_id=77,
            file_id="logical-file-id",
            telegram_user_id=101,
            owner_id=101,
            telegram_chat_id="1234567890",
            telegram_media_kind="photo",
            telegram_media_id="9876543210",
            telegram_media_size=4096,
            telegram_photo_variant="w:1280:h:720",
            location_version=3,
        )
    finally:
        await db.close()

    assert registered.file_type is FileType.PHOTO
    assert registered.telegram_chat_id == "1234567890"
    assert registered.telegram_media_kind == "photo"
    assert registered.telegram_media_id == "9876543210"
    assert registered.telegram_media_size == 4096
    assert registered.telegram_photo_variant == "w:1280:h:720"
    assert registered.location_version == 3


async def test_reregistering_with_default_location_cannot_downgrade_a_newer_location(tmp_path):
    """A retry without a location CAS must preserve a location written by a later operation."""
    db = Database(str(tmp_path / "location_version.db"))
    await db.connect()
    try:
        await db.init_schema()
        kwargs = {
            "file_id": "same-file",
            "filename": "same-file",
            "filesize": 4096,
            "mime_type": "image/jpeg",
            "file_type": "photo",
            "telegram_message_id": 77,
            "created_at": "2026-09-11T00:00:00",
            "direct_url": None,
            "access_hash": None,
            "parent_id": None,
            "is_dir": False,
            "telegram_user_id": 101,
            "owner_id": 101,
        }
        await db.insert_file(
            **kwargs,
            telegram_chat_id="1234567890",
            telegram_media_kind="photo",
            telegram_media_id="9876543210",
            telegram_media_size=4096,
            telegram_photo_variant="w:1280:h:720",
            location_version=3,
        )
        await db.insert_file(**kwargs)
        row = await db.get_file("same-file", owner_id=101)
    finally:
        await db.close()

    assert row["telegram_chat_id"] == "1234567890"
    assert row["telegram_media_id"] == "9876543210"
    assert row["location_version"] == 3


async def test_location_update_requires_current_version_and_advances_it(tmp_path):
    """A physical-location switch must name the row's current version and advance it."""
    db = Database(str(tmp_path / "location_cas.db"))
    await db.connect()
    try:
        await db.init_schema()
        kwargs = {
            "file_id": "same-file",
            "filename": "same-file",
            "filesize": 4096,
            "mime_type": "image/jpeg",
            "file_type": "photo",
            "telegram_message_id": 77,
            "created_at": "2026-09-11T00:00:00",
            "direct_url": None,
            "access_hash": None,
            "parent_id": None,
            "is_dir": False,
            "telegram_user_id": 101,
            "owner_id": 101,
        }
        await db.insert_file(
            **kwargs,
            telegram_chat_id="1234567890",
            telegram_media_kind="photo",
            telegram_media_id="9876543210",
            telegram_media_size=4096,
            telegram_photo_variant="w:1280:h:720",
            location_version=3,
        )
        await db.insert_file(
            **kwargs,
            telegram_chat_id="1234567891",
            telegram_media_kind="photo",
            telegram_media_id="9876543211",
            telegram_media_size=4096,
            telegram_photo_variant="w:1280:h:720",
            expected_location_version=3,
            location_version=4,
        )
        row = await db.get_file("same-file", owner_id=101)
    finally:
        await db.close()

    assert row["telegram_chat_id"] == "1234567891"
    assert row["telegram_media_id"] == "9876543211"
    assert row["location_version"] == 4
