"""The ownership guard on POST /files/register.

Why this guard exists: before chat-media import, `file_id` was always a
Telegram document id minted by the caller's own upload, so two drives could
never collide. Importing a public channel two drives both have access to
forwards the same Telegram documents, so both drives can now produce the same
`file_id`. `files.file_id` is a global SQLite PRIMARY KEY and
`Database.insert_file` is INSERT OR REPLACE, so without a guard the second
drive's registration would silently overwrite the first drive's row --
owner_id included -- and that user's file would vanish with no error
anywhere.

Layer note: this suite (see test_linked_accounts.py) only ever reaches the
FileService/Database layer -- there is no TestClient/AsyncClient anywhere in
this backend, so there is no existing convention for exercising a route over
HTTP. The guard itself lives in the route function
(app.api.routes.register_file), not in FileService or Database, so the only
honest way to make a test that actually fails if the guard is removed is to
call that route function directly -- it's a plain async function, and
Depends() markers are only resolved by FastAPI at real request time, so
current_user can be passed straight through as a keyword argument. Its
get_database/get_file_service singletons are swapped for an isolated test
database for the duration of the call, the same way other tests in this
suite swap `fs._db`.
"""
import asyncio

from fastapi import HTTPException

import app.api.routes as routes_module
from app.api.routes import register_file, RegisterFileRequest
from app.services.database import Database
from app.services.file_service import FileService

OWNER_A = 111
OWNER_B = 222


async def _fresh(tmp_path):
    db = Database(db_path=str(tmp_path / "t.db"))
    await db.connect()
    await db.init_schema()
    fs = FileService()
    fs._db = db
    return db, fs


def _patch_singletons(db, fs):
    """Point routes.py's get_database/get_file_service at our isolated test db/fs.

    Returns a restore() callback that must be called to undo the patch.
    """
    orig_get_database = routes_module.get_database
    orig_get_file_service = routes_module.get_file_service

    async def fake_get_database():
        return db

    def fake_get_file_service():
        return fs

    routes_module.get_database = fake_get_database
    routes_module.get_file_service = fake_get_file_service

    def restore():
        routes_module.get_database = orig_get_database
        routes_module.get_file_service = orig_get_file_service

    return restore


def _register_request(file_id, filename="x", **overrides):
    fields = dict(
        filename=filename,
        filesize=1,
        mime_type=None,
        message_id=1,
        file_id=file_id,
        access_hash=None,
        parent_id=None,
        has_thumbnail=False,
        is_split_file=False,
        original_name=None,
        part_index=None,
        total_parts=None,
        split_group_id=None,
        file_hash=None,
        telegram_user_id=None,
    )
    fields.update(overrides)
    return RegisterFileRequest(**fields)


def test_drive_b_cannot_overwrite_drive_as_row(tmp_path):
    """The second drive's registration must be rejected, and drive A's row
    must still be intact and still owned by A afterwards -- the point is
    that the data survived, not merely that a status code came back."""
    async def run():
        db, fs = await _fresh(tmp_path)
        restore = _patch_singletons(db, fs)
        try:
            await register_file(
                _register_request("shared_doc", filename="a.jpg"), current_user=OWNER_A
            )

            try:
                await register_file(
                    _register_request("shared_doc", filename="stolen.jpg"), current_user=OWNER_B
                )
                assert False, "expected the ownership guard to reject drive B"
            except HTTPException as e:
                assert e.status_code == 409

            row = await db.get_file("shared_doc")
            assert row is not None
            assert row["owner_id"] == OWNER_A
            assert row["filename"] == "a.jpg"
        finally:
            restore()
            await db.close()

    asyncio.run(run())


def test_same_drive_can_reregister_its_own_file_id(tmp_path):
    """Upload retries / re-imports: the same drive registering a file_id it
    already owns must still succeed, not trip the guard."""
    async def run():
        db, fs = await _fresh(tmp_path)
        restore = _patch_singletons(db, fs)
        try:
            await register_file(
                _register_request("own_doc", filename="a.jpg"), current_user=OWNER_A
            )
            info = await register_file(
                _register_request("own_doc", filename="a.jpg"), current_user=OWNER_A
            )
            assert info.file_id == "own_doc"

            row = await db.get_file("own_doc")
            assert row["owner_id"] == OWNER_A
        finally:
            restore()
            await db.close()

    asyncio.run(run())


def test_same_drive_can_reregister_a_split_part(tmp_path):
    """Split-part re-registration by the same drive must also still succeed."""
    async def run():
        db, fs = await _fresh(tmp_path)
        restore = _patch_singletons(db, fs)
        try:
            part = _register_request(
                "split_doc_part0",
                filename="big.bin",
                is_split_file=True,
                part_index=0,
                total_parts=2,
                split_group_id="grp1",
            )
            await register_file(part, current_user=OWNER_A)
            info = await register_file(part, current_user=OWNER_A)
            assert info.file_id == "split_doc_part0"

            row = await db.get_file("split_doc_part0")
            assert row["owner_id"] == OWNER_A
        finally:
            restore()
            await db.close()

    asyncio.run(run())
