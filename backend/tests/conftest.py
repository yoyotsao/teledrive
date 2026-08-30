"""Shared test infrastructure for the TeleDrive backend.

Three things happen here, in this order, and the order matters:

1. **Environment is fixed before `app.*` is imported.** `database.DB_PATH` is a
   module-level constant read from `TELEDRIVE_DB_PATH` at import time, and
   `Settings` falls back to the real `../.env`. Get this wrong and a test run
   writes to the production SQLite file with production credentials loaded.

2. **Coroutines run on one shared event loop** owned by this module. aiosqlite
   binds each future to whatever loop makes the call (not to the loop that
   opened the connection), so a `Database` connected in a fixture is safely
   usable from the separate loop starlette's `TestClient` spins up per request.

3. **The network is unreachable.** The metadata backend has no Telegram user
   client, and an autouse fixture makes accidental outbound HTTP calls fail.
"""
import asyncio
import inspect
import os
import sys
import tempfile
from pathlib import Path
from typing import Optional

import pytest

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

# --- 1. environment, before any app import -----------------------------------
# A scratch path is only the safety net; every test gets its own DB from the
# `db` fixture below. This just guarantees that an accidental `get_database()`
# outside a fixture cannot land on backend/teledrive.db.
_SCRATCH_DB = Path(tempfile.gettempdir()) / "teledrive-pytest-scratch.db"
os.environ["TELEDRIVE_DB_PATH"] = str(_SCRATCH_DB)
# Environment wins over the `env_file="../.env"` that Settings would otherwise
# read, so the real API id/hash/bot token never reach the test process.
os.environ["TELEGRAM_BOT_TOKEN"] = ""
# Without this, app.auth mints a random secret per process — fine, but a fixed
# one keeps a hand-crafted token reproducible when debugging a failure.
os.environ["JWT_SECRET"] = "pytest-fixed-secret-at-least-32-bytes"

from fastapi.testclient import TestClient  # noqa: E402

from app.auth import create_jwt  # noqa: E402
from app.services import bot_challenge  # noqa: E402
from app.services import database as database_mod  # noqa: E402
from app.services import file_service as file_service_mod  # noqa: E402
from main import app  # noqa: E402

# Two drives. Every ownership/isolation test is "A must not see B's data".
OWNER_A = 1001
OWNER_B = 2002


# --- 2. one event loop for the whole session ---------------------------------
_LOOP: Optional[asyncio.AbstractEventLoop] = None


def _get_loop() -> asyncio.AbstractEventLoop:
    global _LOOP
    if _LOOP is None or _LOOP.is_closed():
        _LOOP = asyncio.new_event_loop()
        asyncio.set_event_loop(_LOOP)
    return _LOOP


@pytest.hookimpl(tryfirst=True)
def pytest_pyfunc_call(pyfuncitem):
    """Let tests be written as `async def test_...` without pytest-asyncio."""
    if inspect.iscoroutinefunction(pyfuncitem.obj):
        argnames = pyfuncitem._fixtureinfo.argnames
        kwargs = {name: pyfuncitem.funcargs[name] for name in argnames}
        _get_loop().run_until_complete(pyfuncitem.obj(**kwargs))
        return True
    return None


@pytest.fixture(scope="session", autouse=True)
def _close_loop_at_end():
    yield
    if _LOOP is not None and not _LOOP.is_closed():
        _LOOP.close()


@pytest.fixture
def run():
    """Drive a coroutine from a *synchronous* test or fixture.

    Inside an `async def` test just await the coroutine — asyncio forbids
    driving one loop from inside another, so `run` would raise there.
    """
    return _get_loop().run_until_complete


def _await_or_run(coro):
    """Return a helper's result whichever kind of test called it.

    Sync test: nothing is running, so drive the coroutine to completion and
    hand back the value. Async test: a loop is already running and nesting is
    illegal, so hand back the coroutine and let the caller `await` it. Helpers
    built on this are therefore used as `make_file(...)` in a sync test and
    `await make_file(...)` in an async one.
    """
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return _get_loop().run_until_complete(coro)
    return coro


@pytest.fixture(autouse=True)
def _no_network(monkeypatch):
    """Make every real outbound HTTP call fail loudly rather than silently succeed."""
    import httpx

    async def _blocked(*args, **kwargs):
        raise AssertionError(
            "A test attempted real network I/O. Fake the collaborator instead."
        )

    # starlette's TestClient is a *sync* httpx.Client, so blocking the async
    # client blocks bot_challenge's getUpdates without breaking the test client.
    monkeypatch.setattr(httpx.AsyncClient, "send", _blocked)
    yield


# --- database ----------------------------------------------------------------
@pytest.fixture
def db(tmp_path, run):
    """A fresh, schema-initialised SQLite file per test, wired into the singletons."""
    database = database_mod.Database(db_path=str(tmp_path / "teledrive-test.db"))
    run(database.connect())
    run(database.init_schema())

    database_mod._db = database
    file_service_mod._file_service = None  # rebuilt lazily against this db

    yield database

    run(database.close())
    database_mod._db = None
    file_service_mod._file_service = None


@pytest.fixture
def file_service(db):
    """The FileService singleton, bound to this test's database."""
    return file_service_mod.get_file_service()


@pytest.fixture
def make_file(db):
    """Insert a row straight into the DB — the setup shortcut for listing,
    trash, ownership and split-group tests that don't care how a row got there.

    Returns the file_id, so `f = make_file("a.txt")` in a sync test and
    `f = await make_file("a.txt")` in an async one (see `_await_or_run`).
    """
    seq = {"n": 0}

    def _make(
        file_id: str,
        *,
        filename: Optional[str] = None,
        parent_id: Optional[str] = None,
        is_dir: bool = False,
        owner_id: int = OWNER_A,
        telegram_message_id: Optional[int] = None,
        filesize: int = 0,
        mime_type: Optional[str] = None,
        file_type: str = "other",
        has_thumbnail: bool = False,
        is_split_file: bool = False,
        part_index: Optional[int] = None,
        total_parts: Optional[int] = None,
        split_group_id: Optional[str] = None,
        original_name: Optional[str] = None,
        telegram_user_id: Optional[int] = None,
        file_hash: Optional[str] = None,
        created_at: Optional[str] = None,
        trashed: bool = False,
    ) -> str:
        seq["n"] += 1
        # Distinct, ascending timestamps keep date-sorted assertions stable.
        stamp = created_at or "2026-01-01T00:00:%02d" % seq["n"]

        async def _insert():
            await db.insert_file(
                file_id=file_id,
                filename=filename if filename is not None else file_id,
                filesize=filesize,
                mime_type=mime_type,
                file_type=file_type,
                telegram_message_id=telegram_message_id,
                created_at=stamp,
                direct_url=None,
                access_hash=None,
                parent_id=parent_id,
                is_dir=is_dir,
                has_thumbnail=has_thumbnail,
                is_split_file=is_split_file,
                original_name=original_name,
                part_index=part_index,
                total_parts=total_parts,
                split_group_id=split_group_id,
                telegram_user_id=owner_id if telegram_user_id is None else telegram_user_id,
                file_hash=file_hash,
                owner_id=owner_id,
            )
            if trashed:
                await db.set_trashed([file_id], stamp, owner_id)
            return file_id

        return _await_or_run(_insert())

    return _make


# --- HTTP clients ------------------------------------------------------------
@pytest.fixture
def make_client(db):
    """Factory for TestClients. No `with` block: the app's lifespan would start
    bot polling and build its own database — the `db` fixture already installed
    the one these requests must see."""
    created = []

    def _make(owner_id: Optional[int] = None, acting_account_id: Optional[int] = None) -> TestClient:
        client = TestClient(app)
        if owner_id is not None:
            token = create_jwt(owner_id, acting_account_id=acting_account_id)
            client.headers["Authorization"] = "Bearer " + token
        created.append(client)
        return client

    yield _make

    for client in created:
        client.close()


@pytest.fixture
def anon_client(make_client) -> TestClient:
    """No Authorization header — for the 401 half of every authz test."""
    return make_client()


@pytest.fixture
def client(make_client) -> TestClient:
    """Signed in as drive A. The default client for feature tests."""
    return make_client(OWNER_A)


@pytest.fixture
def other_client(make_client) -> TestClient:
    """Signed in as drive B. Used to prove A's data is invisible to B."""
    return make_client(OWNER_B)


# --- bot-challenge login -----------------------------------------------------
@pytest.fixture
def bot_login(monkeypatch):
    """Control the login challenge lifecycle without a bot or a network.

    `bot_challenge` keeps its pending/verified nonces in module globals; leaking
    them between tests would make the auth suite order-dependent.
    """
    monkeypatch.setattr(bot_challenge, "bot_username", "teledrive_test_bot")
    monkeypatch.setattr(bot_challenge, "_pending", {})
    monkeypatch.setattr(bot_challenge, "_verified", {})

    class Helper:
        """Simulates 'the user DMed this nonce to the bot from account X'."""

        @staticmethod
        def deliver(nonce: str, user_id: int, username="tester", first_name="Test") -> None:
            bot_challenge.ingest_updates([
                {
                    "update_id": 1,
                    "message": {
                        "text": nonce,
                        "from": {"id": user_id, "username": username, "first_name": first_name},
                    },
                }
            ])

        @staticmethod
        def disable_bot() -> None:
            monkeypatch.setattr(bot_challenge, "bot_username", None)

    return Helper()
