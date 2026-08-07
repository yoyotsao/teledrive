"""One drive, many Telegram accounts — and the walls between drives.

The properties encoded here are security ones, not conveniences:
  * A Telegram account belongs to exactly one drive. Without that, A could link
    B's account and read B's whole file listing.
  * A drive sees every file stored on any of its own linked accounts, and none
    stored on anyone else's.
  * Unlinking an account that still holds files is refused, because access_hash
    is account-scoped: those files would become permanently undownloadable.
"""
import asyncio

from app.services.database import Database
from app.services.file_service import FileService

OWNER_A = 111
OWNER_B = 222
A_SECOND = 333  # second Telegram account linked to drive A


async def _fresh(tmp_path):
    db = Database(db_path=str(tmp_path / "t.db"))
    await db.connect()
    await db.init_schema()
    fs = FileService()
    fs._db = db
    return db, fs


async def _insert(db, file_id, owner_id, storage_account):
    await db.insert_file(
        file_id=file_id,
        filename=file_id,
        filesize=1,
        mime_type=None,
        file_type="other",
        telegram_message_id=1,
        has_thumbnail=False,
        created_at="2026-01-01T00:00:00",
        direct_url=None,
        access_hash=None,
        parent_id=None,
        is_dir=False,
        telegram_user_id=storage_account,
        owner_id=owner_id,
    )


def test_an_account_can_only_belong_to_one_drive(tmp_path):
    async def run():
        db, _ = await _fresh(tmp_path)
        try:
            assert await db.link_account(OWNER_A, A_SECOND) is True
            # Drive B trying to claim the same account is what the unique index stops.
            assert await db.link_account(OWNER_B, A_SECOND) is False
            assert await db.get_owner_of(A_SECOND) == OWNER_A
        finally:
            await db.close()

    asyncio.run(run())


def test_drive_sees_files_on_all_its_accounts_and_nobody_elses(tmp_path):
    async def run():
        db, fs = await _fresh(tmp_path)
        try:
            await db.link_account(OWNER_A, OWNER_A, is_primary=True)
            await db.link_account(OWNER_A, A_SECOND)
            await db.link_account(OWNER_B, OWNER_B, is_primary=True)

            await _insert(db, "a_primary", OWNER_A, OWNER_A)
            await _insert(db, "a_second", OWNER_A, A_SECOND)
            await _insert(db, "b_file", OWNER_B, OWNER_B)

            a_files, _ = await fs.list_files(owner_id=OWNER_A)
            assert {f.file_id for f in a_files} == {"a_primary", "a_second"}
            # The storage account travels with the row — the frontend picks its
            # download client from it.
            assert {f.file_id: f.telegram_user_id for f in a_files} == {
                "a_primary": OWNER_A,
                "a_second": A_SECOND,
            }

            b_files, _ = await fs.list_files(owner_id=OWNER_B)
            assert {f.file_id for f in b_files} == {"b_file"}
        finally:
            await db.close()

    asyncio.run(run())


def test_unlink_is_refused_while_the_account_still_stores_files(tmp_path):
    async def run():
        db, _ = await _fresh(tmp_path)
        try:
            await db.link_account(OWNER_A, OWNER_A, is_primary=True)
            await db.link_account(OWNER_A, A_SECOND)
            await _insert(db, "a_second", OWNER_A, A_SECOND)

            assert await db.count_files_on_account(OWNER_A, A_SECOND) == 1
            assert (await db.get_linked_account(OWNER_A, OWNER_A))["is_primary"] == 1

            # Once its files are gone the account is safe to drop.
            await db.delete_files_by_ids(["a_second"])
            assert await db.count_files_on_account(OWNER_A, A_SECOND) == 0
            assert await db.unlink_account(OWNER_A, A_SECOND) is True
            assert await db.get_owner_of(A_SECOND) is None
        finally:
            await db.close()

    asyncio.run(run())


def test_dedup_spans_every_account_in_the_drive(tmp_path):
    """A file uploaded via account 2 must still dedup against the drive's hash index."""
    async def run():
        db, fs = await _fresh(tmp_path)
        try:
            await db.insert_file(
                file_id="h1", filename="x", filesize=1, mime_type=None, file_type="other",
                telegram_message_id=1, has_thumbnail=False, created_at="2026-01-01T00:00:00",
                direct_url=None, access_hash=None, parent_id=None, is_dir=False,
                telegram_user_id=A_SECOND, owner_id=OWNER_A, file_hash="deadbeef",
            )
            assert [f.file_id for f in await fs.find_by_hash("deadbeef", OWNER_A)] == ["h1"]
            assert await fs.find_by_hash("deadbeef", OWNER_B) == []
        finally:
            await db.close()

    asyncio.run(run())
