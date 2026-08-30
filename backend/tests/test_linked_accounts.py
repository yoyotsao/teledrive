"""One drive, many Telegram accounts — and the walls between drives.

The properties encoded here are security ones, not conveniences:
  * A Telegram account belongs to exactly one drive. Without that, A could link
    B's account and read B's whole file listing.
  * A drive sees every file stored on any of its own linked accounts, and none
    stored on anyone else's.
  * Unlinking an account that still holds files is refused, because access_hash
    is account-scoped: those files would become permanently undownloadable.

These are the database-layer statements of the rules; test_api_accounts.py
checks that the endpoints actually enforce them.
"""
from conftest import OWNER_A, OWNER_B

A_SECOND = 3003  # second Telegram account linked to drive A


async def test_an_account_can_only_belong_to_one_drive(db):
    assert await db.link_account(OWNER_A, A_SECOND) is True

    # Drive B trying to claim the same account is what the unique index stops.
    assert await db.link_account(OWNER_B, A_SECOND) is False
    assert await db.get_owner_of(A_SECOND) == OWNER_A


async def test_a_drive_sees_files_on_all_its_accounts_and_nobody_elses(db, file_service, make_file):
    await db.link_account(OWNER_A, OWNER_A, is_primary=True)
    await db.link_account(OWNER_A, A_SECOND)
    await db.link_account(OWNER_B, OWNER_B, is_primary=True)
    await make_file("a_primary", owner_id=OWNER_A, telegram_user_id=OWNER_A)
    await make_file("a_second", owner_id=OWNER_A, telegram_user_id=A_SECOND)
    await make_file("b_file", owner_id=OWNER_B, telegram_user_id=OWNER_B)

    a_files, _ = await file_service.list_files(owner_id=OWNER_A)
    b_files, _ = await file_service.list_files(owner_id=OWNER_B)

    assert {f.file_id for f in a_files} == {"a_primary", "a_second"}
    # The storage account travels with the row — the frontend picks its
    # download client from it.
    assert {f.file_id: f.telegram_user_id for f in a_files} == {
        "a_primary": OWNER_A,
        "a_second": A_SECOND,
    }
    assert {f.file_id for f in b_files} == {"b_file"}


async def test_unlink_is_refused_while_the_account_still_stores_files(db, make_file):
    await db.link_account(OWNER_A, OWNER_A, is_primary=True)
    await db.link_account(OWNER_A, A_SECOND)
    await make_file("a_second", owner_id=OWNER_A, telegram_user_id=A_SECOND)

    assert await db.count_files_on_account(OWNER_A, A_SECOND) == 1
    assert (await db.get_linked_account(OWNER_A, OWNER_A))["is_primary"] == 1

    # Once its files are gone the account is safe to drop.
    await db.delete_files_by_ids(["a_second"], OWNER_A)
    assert await db.count_files_on_account(OWNER_A, A_SECOND) == 0
    assert await db.unlink_account(OWNER_A, A_SECOND) is True
    assert await db.get_owner_of(A_SECOND) is None


async def test_dedup_spans_every_account_in_the_drive(db, file_service, make_file):
    """A file uploaded via account 2 must still dedup against the drive's hash index."""
    await make_file("h1", owner_id=OWNER_A, telegram_user_id=A_SECOND, file_hash="deadbeef")

    assert [f.file_id for f in await file_service.find_by_hash("deadbeef", OWNER_A)] == ["h1"]
    assert await file_service.find_by_hash("deadbeef", OWNER_B) == []
