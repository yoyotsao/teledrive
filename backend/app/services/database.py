"""
SQLite database module for persistent file metadata storage.
"""

import asyncio
import inspect
from functools import wraps

import aiosqlite
import json
import os
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional, List, Tuple
from pathlib import Path
from loguru import logger
from app.models.schemas import is_canonical_channel_id

# Database path. Under Docker this MUST point at a named volume (see
# TELEDRIVE_DB_PATH in docker-compose.yml), never at the ./backend bind mount:
# SQLite on Docker Desktop's Windows→Linux file-sharing layer dies with
# `sqlite3.OperationalError: disk I/O error` during bulk-upload write bursts,
# taking every DB-backed endpoint down until Docker Desktop is restarted.
# The fallback keeps host-side tooling (generate_session.py, backend/scripts/)
# working unchanged.
DB_PATH = Path(
    os.environ.get("TELEDRIVE_DB_PATH")
    or Path(__file__).parent.parent.parent / "teledrive.db"
)

# Whitelist mapping API sort keys → SQL columns. NEVER interpolate user input
# into SQL; only values from this dict reach the query string.
_SORT_COLUMNS = {
    "name": "filename COLLATE NOCASE",
    "size": "filesize",
    "date": "created_at",
}


def _validate_storage_location(
    telegram_chat_id: Optional[str],
    telegram_media_kind: Optional[str],
    telegram_media_id: Optional[str],
    telegram_media_size: Optional[int],
    telegram_photo_variant: Optional[str],
) -> None:
    """Validate the canonical, JSON-serializable physical-location identity."""
    if telegram_chat_id is not None and not is_canonical_channel_id(telegram_chat_id):
        raise ValueError("telegram_chat_id must be a canonical positive raw channel ID")

    has_media_identity = any((
        telegram_media_kind is not None,
        telegram_media_id is not None,
        telegram_media_size is not None,
        telegram_photo_variant is not None,
    ))
    if not has_media_identity:
        if telegram_chat_id is not None:
            raise ValueError("channel locations require a complete Telegram media identity")
        return

    if telegram_media_kind not in {"document", "photo"}:
        raise ValueError("telegram_media_kind must be document or photo")
    if not isinstance(telegram_media_id, str) or not telegram_media_id:
        raise ValueError("telegram_media_id is required with a media identity")
    if isinstance(telegram_media_size, bool) or not isinstance(telegram_media_size, int) or telegram_media_size < 0:
        raise ValueError("telegram_media_size must be a non-negative integer")
    if telegram_media_kind == "photo":
        if not isinstance(telegram_photo_variant, str) or not telegram_photo_variant:
            raise ValueError("photo locations require telegram_photo_variant")
    elif telegram_photo_variant is not None:
        raise ValueError("document locations cannot have telegram_photo_variant")


class _ReentrantAsyncLock:
    """Serialize repository calls while allowing nested Database helpers."""

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._owner: Optional[asyncio.Task] = None
        self._depth = 0

    async def __aenter__(self):
        task = asyncio.current_task()
        if task is None:
            raise RuntimeError("Database calls require an asyncio task")
        if self._owner is task:
            self._depth += 1
            return self
        await self._lock.acquire()
        self._owner = task
        self._depth = 1
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        task = asyncio.current_task()
        if self._owner is not task:
            raise RuntimeError("Database serialization lock released by non-owner")
        self._depth -= 1
        if self._depth == 0:
            self._owner = None
            self._lock.release()


def _serialized_database_method(method):
    @wraps(method)
    async def wrapped(self, *args, **kwargs):
        async with self._operation_lock:
            return await method(self, *args, **kwargs)

    return wrapped


def _serialize_database_methods(cls):
    # aiosqlite serializes individual statements, not multi-statement transaction
    # boundaries.  This per-instance re-entrant lock makes repository calls atomic
    # with respect to one shared connection without deadlocking nested helpers.
    for name, member in list(vars(cls).items()):
        if inspect.iscoroutinefunction(member):
            setattr(cls, name, _serialized_database_method(member))
    return cls


@_serialize_database_methods
class Database:
    """SQLite database for file metadata persistence."""
    
    def __init__(self, db_path: str = None):
        self.db_path = db_path or str(DB_PATH)
        self._conn: Optional[aiosqlite.Connection] = None
        self._operation_lock = _ReentrantAsyncLock()
    
    async def connect(self) -> None:
        """Initialize database connection."""
        self._conn = await aiosqlite.connect(self.db_path)
        self._conn.row_factory = aiosqlite.Row
        logger.info(f"Database connected: {self.db_path}")
    
    async def close(self) -> None:
        """Close database connection."""
        if self._conn:
            await self._conn.close()
            self._conn = None
            logger.info("Database connection closed")
    
    async def init_schema(self) -> None:
        """Create database tables if they don't exist."""
        if not self._conn:
            raise RuntimeError("Database not connected")
        
        # Files metadata table
        await self._conn.execute("""
            CREATE TABLE IF NOT EXISTS files (
                file_id TEXT PRIMARY KEY,
                filename TEXT NOT NULL,
                filesize INTEGER NOT NULL,
                mime_type TEXT,
                file_type TEXT NOT NULL,
                telegram_message_id INTEGER,
                has_thumbnail INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                direct_url TEXT,
                access_hash TEXT,
                parent_id TEXT,
                isDir INTEGER NOT NULL DEFAULT 0,
                is_split_file INTEGER NOT NULL DEFAULT 0,
                original_name TEXT,
                part_index INTEGER,
                total_parts INTEGER,
                split_group_id TEXT,
                telegram_chat_id TEXT,
                telegram_media_kind TEXT,
                telegram_media_id TEXT,
                telegram_media_size INTEGER,
                telegram_photo_variant TEXT,
                location_version INTEGER NOT NULL DEFAULT 0
            )
        """)
        
        # Add new columns if they don't exist (migration for existing databases)
        try:
            await self._conn.execute("ALTER TABLE files ADD COLUMN has_thumbnail INTEGER NOT NULL DEFAULT 0")
        except aiosqlite.OperationalError:
            pass  # Column already exists

        try:
            await self._conn.execute("ALTER TABLE files ADD COLUMN is_split_file INTEGER NOT NULL DEFAULT 0")
        except aiosqlite.OperationalError:
            pass  # Column already exists
        
        try:
            await self._conn.execute("ALTER TABLE files ADD COLUMN original_name TEXT")
        except aiosqlite.OperationalError:
            pass
        
        try:
            await self._conn.execute("ALTER TABLE files ADD COLUMN part_index INTEGER")
        except aiosqlite.OperationalError:
            pass
        
        try:
            await self._conn.execute("ALTER TABLE files ADD COLUMN total_parts INTEGER")
        except aiosqlite.OperationalError:
            pass
        
        try:
            await self._conn.execute("ALTER TABLE files ADD COLUMN split_group_id TEXT")
        except aiosqlite.OperationalError:
            pass

        try:
            await self._conn.execute("ALTER TABLE files ADD COLUMN telegram_user_id INTEGER NOT NULL DEFAULT 0")
        except aiosqlite.OperationalError:
            pass

        # owner_id = whose drive this belongs to (tenant key).
        # telegram_user_id = which Telegram account's Saved Messages holds the message.
        # They were one and the same before multi-account, hence the backfill — which
        # only runs on the migration pass, never again (the ALTER raises after that).
        try:
            await self._conn.execute("ALTER TABLE files ADD COLUMN owner_id INTEGER NOT NULL DEFAULT 0")
            await self._conn.execute("UPDATE files SET owner_id = telegram_user_id")
        except aiosqlite.OperationalError:
            pass

        try:
            await self._conn.execute("ALTER TABLE files ADD COLUMN file_hash TEXT")
        except aiosqlite.OperationalError:
            pass

        # Soft-delete: NULL = live, ISO timestamp string = in trash
        try:
            await self._conn.execute("ALTER TABLE files ADD COLUMN trashed_at TEXT")
        except aiosqlite.OperationalError:
            pass

        # NULL location fields preserve legacy Saved Messages rows without
        # guessing a Telegram media identity for them.
        for column, definition in (
            ("telegram_chat_id", "TEXT"),
            ("telegram_media_kind", "TEXT"),
            ("telegram_media_id", "TEXT"),
            ("telegram_media_size", "INTEGER"),
            ("telegram_photo_variant", "TEXT"),
            ("location_version", "INTEGER NOT NULL DEFAULT 0"),
        ):
            try:
                await self._conn.execute(f"ALTER TABLE files ADD COLUMN {column} {definition}")
            except aiosqlite.OperationalError:
                pass

        # Indexes for the query patterns in get_files_paginated / find_by_hash /
        # find_file_by_name_and_parent (avoids full table scans as row count grows).
        # The old telegram_user_id-keyed pair is dropped: tenant filtering moved to owner_id.
        await self._conn.execute("DROP INDEX IF EXISTS idx_files_user_parent")
        await self._conn.execute("DROP INDEX IF EXISTS idx_files_hash")
        await self._conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_files_owner_parent ON files(owner_id, isDir, parent_id)"
        )
        # find_by_hash/find_by_hashes always filter by (file_hash, owner_id) together,
        # so dedup now spans every account linked to the drive.
        await self._conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_files_hash_owner ON files(file_hash, owner_id)"
        )
        await self._conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_files_split_group ON files(split_group_id)"
        )

        # One drive, many Telegram accounts. The UNIQUE index on telegram_user_id is a
        # security boundary, not a perf tweak: without it A could link B's account into
        # A's drive and read B's file listing.
        await self._conn.execute("""
            CREATE TABLE IF NOT EXISTS linked_accounts (
                owner_id          INTEGER NOT NULL,
                telegram_user_id  INTEGER NOT NULL,
                label             TEXT,
                is_primary        INTEGER NOT NULL DEFAULT 0,
                added_at          TEXT NOT NULL,
                PRIMARY KEY (owner_id, telegram_user_id)
            )
        """)
        await self._conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_linked_unique ON linked_accounts(telegram_user_id)"
        )
        # Backfill: pre-multi-account, every distinct account was its own drive's primary.
        await self._conn.execute("""
            INSERT OR IGNORE INTO linked_accounts (owner_id, telegram_user_id, is_primary, added_at)
            SELECT DISTINCT telegram_user_id, telegram_user_id, 1, datetime('now')
            FROM files WHERE telegram_user_id != 0
        """)

        await self._conn.execute("""
            CREATE TABLE IF NOT EXISTS storage_targets (
                owner_id INTEGER PRIMARY KEY,
                storage_mode TEXT NOT NULL DEFAULT 'saved_messages',
                channel_id TEXT,
                channel_title TEXT,
                version INTEGER NOT NULL DEFAULT 0,
                accounts_version INTEGER NOT NULL DEFAULT 0
            )
        """)
        await self._conn.execute("""
            CREATE TABLE IF NOT EXISTS storage_target_verifications (
                owner_id INTEGER NOT NULL,
                channel_id TEXT NOT NULL,
                telegram_user_id INTEGER NOT NULL,
                channel_title TEXT,
                can_read INTEGER NOT NULL,
                can_write INTEGER NOT NULL,
                status TEXT NOT NULL,
                checked_at TEXT NOT NULL,
                accounts_version INTEGER NOT NULL,
                PRIMARY KEY (owner_id, channel_id, telegram_user_id)
            )
        """)
        await self._conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_target_verifications_reader "
            "ON storage_target_verifications(owner_id, channel_id, telegram_user_id, can_read)"
        )
        await self._conn.execute("""
            INSERT INTO storage_targets (owner_id)
            SELECT DISTINCT owner_id FROM linked_accounts WHERE owner_id IS NOT NULL
            ON CONFLICT(owner_id) DO NOTHING
        """)

        # Cumulative counters per browser stream, account and Taipei calendar day.
        # MAX on upsert makes response-loss retries and concurrent tab recovery
        # idempotent. Keep history even if an account is later unlinked.
        await self._conn.execute("""
            CREATE TABLE IF NOT EXISTS upload_statistics (
                owner_id INTEGER NOT NULL,
                stream_id TEXT NOT NULL,
                telegram_user_id INTEGER NOT NULL,
                day TEXT NOT NULL,
                bytes INTEGER NOT NULL CHECK (bytes >= 0),
                PRIMARY KEY (owner_id, stream_id, telegram_user_id, day)
            )
        """)
        await self._conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_upload_statistics_day ON upload_statistics(owner_id, day)"
        )

        # A Telegram-producing action is durable before the browser issues its
        # RPC.  This table deliberately stores only intent/result metadata: the
        # browser remains the only process that sees Telegram bytes or sessions.
        await self._conn.execute("""
            CREATE TABLE IF NOT EXISTS telegram_operations (
                operation_id TEXT PRIMARY KEY,
                owner_id INTEGER NOT NULL,
                kind TEXT NOT NULL CHECK (kind IN ('upload', 'chat_import', 'migration')),
                logical_file_id TEXT NOT NULL,
                group_id TEXT,
                part_index INTEGER,
                uploader_id INTEGER NOT NULL,
                target_kind TEXT NOT NULL CHECK (target_kind IN ('saved_messages', 'channel')),
                target_channel_id TEXT,
                target_peer_key TEXT NOT NULL,
                created_target_version INTEGER NOT NULL,
                created_accounts_version INTEGER NOT NULL,
                random_id TEXT NOT NULL,
                rpc_kind TEXT NOT NULL,
                request_metadata TEXT NOT NULL,
                frozen_payload TEXT NOT NULL,
                state TEXT NOT NULL CHECK (state IN (
                    'planned', 'sending', 'recovering', 'retryable', 'uncertain',
                    'sent', 'registered', 'committed', 'tombstoned'
                )),
                version INTEGER NOT NULL DEFAULT 0,
                lease_owner TEXT,
                lease_expires_at TEXT,
                retry_at TEXT,
                error_code TEXT,
                registered_file_id TEXT,
                tombstone_reason TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """)
        # Result mappings are separate from frozen intent so an update can
        # arrive before the RPC response without rewriting request metadata.
        await self._conn.execute("""
            CREATE TABLE IF NOT EXISTS telegram_operation_results (
                operation_id TEXT PRIMARY KEY,
                owner_id INTEGER NOT NULL,
                uploader_id INTEGER NOT NULL,
                random_id TEXT NOT NULL,
                target_peer_key TEXT NOT NULL,
                destination_message_id INTEGER,
                destination_media_kind TEXT,
                destination_media_id TEXT,
                destination_size INTEGER,
                destination_access_hash TEXT,
                mapping_json TEXT,
                media_identity_json TEXT,
                result_version INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL,
                FOREIGN KEY (operation_id) REFERENCES telegram_operations(operation_id)
            )
        """)
        # updateMessageID carries no peer, so this must be account-scoped.
        await self._conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_operations_uploader_random "
            "ON telegram_operations(uploader_id, random_id)"
        )
        await self._conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_telegram_operations_owner_pending "
            "ON telegram_operations(owner_id, state, updated_at)"
        )
        await self._conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_telegram_operations_group "
            "ON telegram_operations(owner_id, group_id, part_index)"
        )
        # These bindings are the durable idempotency proof for metadata commits.
        # They are intentionally separate from `files`: a later name replacement
        # or purge must not make an earlier operation retry run replacement logic.
        await self._conn.execute("""
            CREATE TABLE IF NOT EXISTS telegram_operation_file_bindings (
                operation_id TEXT PRIMARY KEY,
                owner_id INTEGER NOT NULL,
                file_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (operation_id) REFERENCES telegram_operations(operation_id)
            )
        """)
        await self._conn.execute("""
            CREATE TABLE IF NOT EXISTS file_location_switch_bindings (
                owner_id INTEGER NOT NULL,
                file_id TEXT NOT NULL,
                operation_id TEXT NOT NULL,
                result_version INTEGER NOT NULL,
                location_version INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY (owner_id, file_id, operation_id),
                FOREIGN KEY (operation_id) REFERENCES telegram_operations(operation_id)
            )
        """)

        # Force commit, then install the metadata-only migration journal.
        await self._conn.commit()
        from app.services import storage_migration
        await storage_migration.ensure_schema(self)
        
        # Verify tables were created
        cursor = await self._conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        tables = await cursor.fetchall()
        logger.info(f"Tables created: {[t[0] for t in tables]}")
        
        logger.info("Database schema initialized")
    
    async def record_upload_statistics(self, owner_id: int, stream_id: str,
                                       telegram_user_id: int, day: str, size: int) -> None:
        await self._conn.execute("""
            INSERT INTO upload_statistics (owner_id, stream_id, telegram_user_id, day, bytes)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(owner_id, stream_id, telegram_user_id, day)
            DO UPDATE SET bytes = MAX(upload_statistics.bytes, excluded.bytes)
        """, (owner_id, stream_id, telegram_user_id, day, size))
        await self._conn.commit()

    async def get_upload_statistics(self, owner_id: int, start: str, end: str) -> dict:
        cursor = await self._conn.execute("""
            SELECT day, SUM(bytes) AS bytes FROM upload_statistics
            WHERE owner_id = ? AND day BETWEEN ? AND ? GROUP BY day
        """, (owner_id, start, end))
        days = [dict(row) for row in await cursor.fetchall()]
        cursor = await self._conn.execute("""
            SELECT ids.telegram_user_id, la.label, COALESCE(SUM(s.bytes), 0) AS bytes
            FROM (
                SELECT telegram_user_id FROM linked_accounts WHERE owner_id = ?
                UNION
                SELECT telegram_user_id FROM upload_statistics WHERE owner_id = ? AND day = ?
            ) ids
            LEFT JOIN linked_accounts la ON la.owner_id = ? AND la.telegram_user_id = ids.telegram_user_id
            LEFT JOIN upload_statistics s ON s.owner_id = ? AND s.telegram_user_id = ids.telegram_user_id AND s.day = ?
            GROUP BY ids.telegram_user_id, la.label
            ORDER BY bytes DESC, ids.telegram_user_id
        """, (owner_id, owner_id, end, owner_id, owner_id, end))
        accounts = [dict(row) for row in await cursor.fetchall()]
        cursor = await self._conn.execute(
            "SELECT MIN(day) FROM upload_statistics WHERE owner_id = ?", (owner_id,)
        )
        first_day = (await cursor.fetchone())[0]
        return {"days": days, "accounts": accounts, "first_day": first_day}

    # ==================== File Operations ====================
    
    async def insert_file(
        self,
        file_id: str,
        filename: str,
        filesize: int,
        mime_type: Optional[str],
        file_type: str,
        telegram_message_id: Optional[int],
        created_at: str,
        direct_url: Optional[str],
        access_hash: Optional[str],
        parent_id: Optional[str],
        is_dir: bool,
        has_thumbnail: bool = False,
        is_split_file: bool = False,
        original_name: Optional[str] = None,
        part_index: Optional[int] = None,
        total_parts: Optional[int] = None,
        split_group_id: Optional[str] = None,
        telegram_user_id: int = 0,
        file_hash: Optional[str] = None,
        owner_id: Optional[int] = None,
        telegram_chat_id: Optional[str] = None,
        telegram_media_kind: Optional[str] = None,
        telegram_media_id: Optional[str] = None,
        telegram_media_size: Optional[int] = None,
        telegram_photo_variant: Optional[str] = None,
        location_version: int = 0,
        expected_location_version: Optional[int] = None,
    ) -> None:
        """Insert a new file record.

        owner_id is the drive; telegram_user_id is the account storing the message.
        Callers that predate multi-account pass only the latter — same value for both.
        """
        if not self._conn:
            raise RuntimeError("Database not connected")

        _validate_storage_location(
            telegram_chat_id, telegram_media_kind, telegram_media_id,
            telegram_media_size, telegram_photo_variant,
        )

        await self._conn.execute("BEGIN IMMEDIATE")
        try:
            cursor = await self._conn.execute(
                "SELECT telegram_message_id, telegram_chat_id, telegram_media_kind, telegram_media_id, "
                "telegram_media_size, telegram_photo_variant, location_version "
                "FROM files WHERE file_id = ?",
                (file_id,),
            )
            existing = await cursor.fetchone()
            location_supplied = any((
                telegram_chat_id is not None,
                telegram_media_kind is not None,
                telegram_media_id is not None,
                telegram_media_size is not None,
                telegram_photo_variant is not None,
                expected_location_version is not None,
            ))
            if existing:
                current_location = (
                    existing["telegram_message_id"], existing["telegram_chat_id"],
                    existing["telegram_media_kind"], existing["telegram_media_id"],
                    existing["telegram_media_size"], existing["telegram_photo_variant"],
                    existing["location_version"],
                )
                incoming_location = (
                    telegram_message_id, telegram_chat_id, telegram_media_kind,
                    telegram_media_id, telegram_media_size, telegram_photo_variant,
                    location_version,
                )
                if not location_supplied:
                    current_has_canonical_location = (
                        existing["location_version"] != 0
                        or any(existing[name] is not None for name in (
                            "telegram_chat_id", "telegram_media_kind", "telegram_media_id",
                            "telegram_media_size", "telegram_photo_variant",
                        ))
                    )
                    if current_has_canonical_location:
                        telegram_message_id = existing["telegram_message_id"]
                    (
                        telegram_chat_id, telegram_media_kind, telegram_media_id,
                        telegram_media_size, telegram_photo_variant, location_version,
                    ) = current_location[1:]
                elif incoming_location != current_location:
                    if (
                        expected_location_version != existing["location_version"]
                        or location_version != existing["location_version"] + 1
                    ):
                        raise ValueError("Location version conflict")

            await self._conn.execute("""
                INSERT INTO files (
                file_id, filename, filesize, mime_type, file_type,
                telegram_message_id, has_thumbnail,
                created_at, direct_url, access_hash, parent_id, isDir,
                is_split_file, original_name, part_index, total_parts, split_group_id,
                telegram_user_id, file_hash, owner_id,
                telegram_chat_id, telegram_media_kind, telegram_media_id,
                telegram_media_size, telegram_photo_variant, location_version
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(file_id) DO UPDATE SET
                filename = excluded.filename,
                filesize = excluded.filesize,
                mime_type = excluded.mime_type,
                file_type = excluded.file_type,
                telegram_message_id = excluded.telegram_message_id,
                has_thumbnail = excluded.has_thumbnail,
                created_at = excluded.created_at,
                direct_url = excluded.direct_url,
                access_hash = excluded.access_hash,
                parent_id = excluded.parent_id,
                isDir = excluded.isDir,
                is_split_file = excluded.is_split_file,
                original_name = excluded.original_name,
                part_index = excluded.part_index,
                total_parts = excluded.total_parts,
                split_group_id = excluded.split_group_id,
                telegram_user_id = excluded.telegram_user_id,
                file_hash = excluded.file_hash,
                owner_id = excluded.owner_id,
                telegram_chat_id = excluded.telegram_chat_id,
                telegram_media_kind = excluded.telegram_media_kind,
                telegram_media_id = excluded.telegram_media_id,
                telegram_media_size = excluded.telegram_media_size,
                telegram_photo_variant = excluded.telegram_photo_variant,
                location_version = excluded.location_version
            """, (
                file_id, filename, filesize, mime_type, file_type,
                telegram_message_id, 1 if has_thumbnail else 0,
                created_at, direct_url, access_hash, parent_id, 1 if is_dir else 0,
                1 if is_split_file else 0, original_name, part_index, total_parts, split_group_id,
                telegram_user_id, file_hash,
                telegram_user_id if owner_id is None else owner_id,
                telegram_chat_id, telegram_media_kind, telegram_media_id,
                telegram_media_size, telegram_photo_variant, location_version,
            ))
            await self._conn.commit()
        except Exception:
            await self._conn.rollback()
            raise

    async def find_by_hash(self, file_hash: str, owner_id: int) -> List[dict]:
        """Find all file records with the given SHA-256 hash in this drive."""
        if not self._conn:
            raise RuntimeError("Database not connected")
        cursor = await self._conn.execute(
            "SELECT * FROM files WHERE file_hash = ? AND owner_id = ? AND isDir = 0 AND trashed_at IS NULL ORDER BY part_index ASC",
            (file_hash, owner_id),
        )
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]

    async def find_by_hashes(self, hashes: List[str], owner_id: int) -> dict[str, List[dict]]:
        """Find file records for multiple SHA-256 hashes at once, grouped by hash."""
        if not self._conn:
            raise RuntimeError("Database not connected")
        if not hashes:
            return {}

        result: dict[str, List[dict]] = {}
        # SQLite has a bound-variable limit (~999-32766 depending on build); chunk to stay safe.
        CHUNK = 500
        for i in range(0, len(hashes), CHUNK):
            chunk = hashes[i:i + CHUNK]
            placeholders = ",".join("?" for _ in chunk)
            cursor = await self._conn.execute(
                f"SELECT * FROM files WHERE file_hash IN ({placeholders}) "
                f"AND owner_id = ? AND isDir = 0 AND trashed_at IS NULL ORDER BY file_hash, part_index ASC",
                (*chunk, owner_id),
            )
            rows = await cursor.fetchall()
            for row in rows:
                d = dict(row)
                result.setdefault(d["file_hash"], []).append(d)
        return result
    
    async def get_file(self, file_id: str, owner_id: Optional[int] = None) -> Optional[dict]:
        """Get a file by ID, optionally scoped to a drive."""
        if not self._conn:
            raise RuntimeError("Database not connected")

        if owner_id is not None:
            cursor = await self._conn.execute(
                "SELECT * FROM files WHERE file_id = ? AND owner_id = ?",
                (file_id, owner_id)
            )
        else:
            cursor = await self._conn.execute(
                "SELECT * FROM files WHERE file_id = ?", (file_id,)
            )
        row = await cursor.fetchone()

        if row:
            return dict(row)
        return None
    
    async def find_file_by_name_and_parent(self, filename: str, parent_id: Optional[str], owner_id: int = 0) -> Optional[dict]:
        """Find a non-directory file by filename and parent_id (for replace-on-duplicate logic).

        Drive-scoped, not account-scoped: the same name in the same folder is one
        logical file no matter which linked account happens to store it.
        """
        if not self._conn:
            raise RuntimeError("Database not connected")
        if parent_id is None:
            cursor = await self._conn.execute(
                "SELECT * FROM files WHERE filename = ? AND parent_id IS NULL AND isDir = 0 AND owner_id = ? AND trashed_at IS NULL LIMIT 1",
                (filename, owner_id)
            )
        else:
            cursor = await self._conn.execute(
                "SELECT * FROM files WHERE filename = ? AND parent_id = ? AND isDir = 0 AND owner_id = ? AND trashed_at IS NULL LIMIT 1",
                (filename, parent_id, owner_id)
            )
        row = await cursor.fetchone()
        return dict(row) if row else None

    async def find_files_by_name_and_parent(
        self,
        filename: str,
        parent_id: Optional[str],
        owner_id: int = 0,
        exclude_split_group_id: Optional[str] = None,
    ) -> List[dict]:
        """Find EVERY live non-directory row with this filename+parent (for replace-on-duplicate).

        Unlike find_file_by_name_and_parent this returns all matches, because a split
        upload occupies one row per part and replacing it means removing the whole group.
        `exclude_split_group_id` keeps the caller's own in-flight group out of the result —
        without it, part 2 of an upload would delete part 1. Rows with a NULL
        split_group_id are never excluded; they always belong to an earlier upload.
        """
        if not self._conn:
            raise RuntimeError("Database not connected")

        clauses = ["filename = ?", "isDir = 0", "owner_id = ?", "trashed_at IS NULL"]
        params: List[object] = [filename, owner_id]
        if parent_id is None:
            clauses.append("parent_id IS NULL")
        else:
            clauses.append("parent_id = ?")
            params.append(parent_id)
        if exclude_split_group_id is not None:
            clauses.append("(split_group_id IS NULL OR split_group_id != ?)")
            params.append(exclude_split_group_id)

        cursor = await self._conn.execute(
            f"SELECT * FROM files WHERE {' AND '.join(clauses)}", params
        )
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]

    async def find_folder_by_name_and_parent(self, name: str, parent_id: Optional[str], owner_id: int = 0) -> Optional[dict]:
        """Find a folder by name and parent_id (for reuse-on-duplicate logic)."""
        if not self._conn:
            raise RuntimeError("Database not connected")
        if parent_id is None:
            cursor = await self._conn.execute(
                "SELECT * FROM files WHERE filename = ? AND parent_id IS NULL AND isDir = 1 AND owner_id = ? AND trashed_at IS NULL LIMIT 1",
                (name, owner_id)
            )
        else:
            cursor = await self._conn.execute(
                "SELECT * FROM files WHERE filename = ? AND parent_id = ? AND isDir = 1 AND owner_id = ? AND trashed_at IS NULL LIMIT 1",
                (name, parent_id, owner_id)
            )
        row = await cursor.fetchone()
        return dict(row) if row else None

    async def get_all_files(self) -> List[dict]:
        """Get all files."""
        if not self._conn:
            raise RuntimeError("Database not connected")

        cursor = await self._conn.execute("SELECT * FROM files")
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]
    
    async def get_files_paginated(
        self,
        page: int = 1,
        page_size: int = 50,
        parent_id: Optional[str] = None,
        is_dir: bool = False,
        split_group_id: Optional[str] = None,
        owner_id: int = 0,
        sort_by: str = "date",
        sort_order: str = "desc",
        search: Optional[str] = None,
        trashed: bool = False,
    ) -> Tuple[List[dict], int]:
        """Get files with pagination, sorting, optional search, and trash filtering.

        In search mode the parent_id/isDir filters are ignored so the query spans
        the whole drive and returns both files and folders (callers use the isDir
        flag to tell them apart).
        """
        if not self._conn:
            raise RuntimeError("Database not connected")

        where_clauses = ["owner_id = ?"]
        params: list = [owner_id]

        # "spanning" modes (search / trash) ignore parent_id + isDir and return
        # both files and folders in one result set.
        spanning = bool(search) or trashed

        if trashed:
            where_clauses.append("trashed_at IS NOT NULL")
            # Only trash "roots" — items whose parent isn't itself trashed — so a
            # trashed folder's contents don't flood the trash listing.
            where_clauses.append(
                "(parent_id IS NULL OR parent_id NOT IN "
                "(SELECT file_id FROM files WHERE trashed_at IS NOT NULL AND owner_id = ?))"
            )
            params.append(owner_id)
        else:
            where_clauses.append("trashed_at IS NULL")

        if search:
            # Escape LIKE metacharacters so a search for "50%" matches literally.
            esc = search.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            where_clauses.append("filename LIKE ? ESCAPE '\\'")
            params.append(f"%{esc}%")

        if spanning:
            # Collapse split parts to the primary part.
            where_clauses.append("(is_split_file = 0 OR part_index = 0 OR part_index IS NULL)")
        else:
            where_clauses.append("isDir = ?")
            params.append(1 if is_dir else 0)

            if split_group_id is not None:
                where_clauses.append("split_group_id = ?")
                params.append(split_group_id)
            else:
                if parent_id is None:
                    where_clauses.append("parent_id IS NULL")
                else:
                    where_clauses.append("parent_id = ?")
                    params.append(parent_id)
                # Only show the primary part so multi-part files appear once
                where_clauses.append("(is_split_file = 0 OR part_index = 0 OR part_index IS NULL)")

        where_sql = " AND ".join(where_clauses)

        # ORDER BY — column comes from a whitelist, direction is a literal string.
        sort_col = _SORT_COLUMNS.get(sort_by, _SORT_COLUMNS["date"])
        direction = "ASC" if str(sort_order).lower() == "asc" else "DESC"
        # Folders first in spanning views; file_id tiebreak keeps pagination stable.
        prefix = "isDir DESC, " if spanning else ""
        order_sql = f"{prefix}{sort_col} {direction}, file_id ASC"

        # Get total count
        cursor = await self._conn.execute(
            f"SELECT COUNT(*) FROM files WHERE {where_sql}",
            params
        )
        row = await cursor.fetchone()
        total = row[0] if row else 0

        # Get paginated results
        offset = (page - 1) * page_size
        cursor = await self._conn.execute(
            f"SELECT * FROM files WHERE {where_sql} ORDER BY {order_sql} LIMIT ? OFFSET ?",
            params + [page_size, offset]
        )
        rows = await cursor.fetchall()

        return [dict(row) for row in rows], total
    
    async def update_file(
        self,
        file_id: str,
        owner_id: int,
        parent_id: Optional[str] = None,
        set_parent_id: bool = False,
        filename: Optional[str] = None,
    ) -> Optional[dict]:
        """Update file metadata."""
        if not self._conn:
            raise RuntimeError("Database not connected")

        updates = []
        params = []

        if set_parent_id:
            updates.append("parent_id = ?")
            params.append(parent_id)

        if filename is not None:
            updates.append("filename = ?")
            params.append(filename)

        if not updates:
            return await self.get_file(file_id, owner_id=owner_id)
        
        params.extend([file_id, owner_id])
        
        await self._conn.execute(
            f"UPDATE files SET {', '.join(updates)} WHERE file_id = ? AND owner_id = ?",
            params
        )
        await self._conn.commit()
        
        return await self.get_file(file_id, owner_id=owner_id)

    async def delete_user_files(self, owner_id: int) -> int:
        """Delete every file in a drive, across all its linked accounts."""
        if not self._conn:
            raise RuntimeError("Database not connected")
        cursor = await self._conn.execute(
            "SELECT COUNT(*) FROM files WHERE owner_id = ?", (owner_id,)
        )
        row = await cursor.fetchone()
        count = row[0] if row else 0
        await self._conn.execute("DELETE FROM files WHERE owner_id = ?", (owner_id,))
        await self._conn.commit()
        return count
    
    async def get_subtree(self, root_id: str, owner_id: int) -> List[dict]:
        """Get one drive's root row and descendants underneath it.

        The owner predicate is part of both branches of the recursive CTE so a
        corrupt or attacker-supplied cross-drive parent_id cannot make a trash
        or purge operation cross the tenant boundary.
        """
        if not self._conn:
            raise RuntimeError("Database not connected")

        cursor = await self._conn.execute("""
            WITH RECURSIVE subtree(file_id) AS (
                SELECT file_id FROM files WHERE file_id = ? AND owner_id = ?
                UNION
                SELECT f.file_id FROM files f JOIN subtree s ON f.parent_id = s.file_id
                WHERE f.owner_id = ?
            )
            SELECT * FROM files
            WHERE owner_id = ? AND file_id IN (SELECT file_id FROM subtree)
        """, (root_id, owner_id, owner_id, owner_id))
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]

    async def set_trashed(
        self, file_ids: List[str], trashed_at: Optional[str], owner_id: int
    ) -> int:
        """Set (or clear, if trashed_at is None) trashed_at on many rows. Returns rows changed."""
        if not self._conn:
            raise RuntimeError("Database not connected")
        if not file_ids:
            return 0

        changed = 0
        batch_size = 500  # stay under SQLite's variable limit
        for i in range(0, len(file_ids), batch_size):
            batch = file_ids[i:i + batch_size]
            placeholders = ",".join("?" * len(batch))
            cursor = await self._conn.execute(
                f"UPDATE files SET trashed_at = ? WHERE owner_id = ? AND file_id IN ({placeholders})",
                [trashed_at, owner_id, *batch],
            )
            changed += cursor.rowcount
        await self._conn.commit()
        return changed

    async def delete_files_by_ids(self, file_ids: List[str], owner_id: int) -> int:
        """Delete multiple file records in one transaction. Returns rows deleted."""
        if not self._conn:
            raise RuntimeError("Database not connected")
        if not file_ids:
            return 0

        deleted = 0
        batch_size = 500  # stay well under SQLite's variable limit
        for i in range(0, len(file_ids), batch_size):
            batch = file_ids[i:i + batch_size]
            placeholders = ",".join("?" * len(batch))
            cursor = await self._conn.execute(
                f"DELETE FROM files WHERE owner_id = ? AND file_id IN ({placeholders})",
                [owner_id, *batch],
            )
            deleted += cursor.rowcount
        await self._conn.commit()
        return deleted

    async def purge_files_by_ids(self, file_ids: List[str], owner_id: int) -> int:
        """Permanently delete rows and tombstone in-flight operations atomically."""
        if not self._conn:
            raise RuntimeError("Database not connected")
        if not file_ids:
            return 0

        await self._conn.execute("BEGIN IMMEDIATE")
        try:
            deleted = 0
            stamp = self._operation_now().isoformat()
            for offset in range(0, len(file_ids), 400):
                batch = file_ids[offset:offset + 400]
                marks = ",".join("?" for _ in batch)
                await self._conn.execute(
                    f"UPDATE telegram_operations SET state = 'tombstoned', "
                    f"tombstone_reason = 'file purged', lease_owner = NULL, lease_expires_at = NULL, "
                    f"version = version + 1, updated_at = ? "
                    f"WHERE owner_id = ? AND logical_file_id IN ({marks}) AND state != 'tombstoned'",
                    (stamp, owner_id, *batch),
                )
                cursor = await self._conn.execute(
                    f"DELETE FROM files WHERE owner_id = ? AND file_id IN ({marks})",
                    (owner_id, *batch),
                )
                deleted += cursor.rowcount
            await self._conn.commit()
            return deleted
        except Exception:
            await self._conn.rollback()
            raise

    async def get_files_by_split_group(self, split_group_id: str, owner_id: int = 0) -> List[dict]:
        """Get all parts of a split group, sorted by part_index.

        Drive-scoped: a split file's parts may live in different linked accounts.
        """
        if not self._conn:
            raise RuntimeError("Database not connected")

        cursor = await self._conn.execute(
            "SELECT * FROM files WHERE split_group_id = ? AND owner_id = ? ORDER BY part_index ASC",
            (split_group_id, owner_id)
        )
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]

    # ==================== Durable Telegram Operations ====================

    @staticmethod
    def _operation_json(value: Any, field: str) -> str:
        """Canonical JSON makes retries compare frozen payloads byte-for-byte."""
        if not isinstance(value, (dict, list)):
            raise ValueError(f"{field} must be JSON object or array")
        try:
            return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{field} must be JSON serializable") from exc

    @staticmethod
    def _operation_now(now: Optional[datetime] = None) -> datetime:
        value = now or datetime.now(timezone.utc)
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)

    @staticmethod
    def _operation_time(value: Optional[str]) -> Optional[datetime]:
        if value is None:
            return None
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)

    @staticmethod
    def _normalise_operation_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
        """Validate the immutable fields which name one Telegram send intent."""
        if not isinstance(payload, dict):
            raise ValueError("operation payload must be an object")
        required = (
            "operation_id", "kind", "logical_file_id", "uploader_id", "target_kind",
            "target_peer_key", "created_target_version", "created_accounts_version",
            "random_id", "rpc_kind", "request_metadata",
        )
        missing = [name for name in required if payload.get(name) is None]
        if missing:
            raise ValueError(f"operation payload missing {', '.join(missing)}")
        if payload["kind"] not in {"upload", "chat_import", "migration"}:
            raise ValueError("unknown Telegram operation kind")
        target_kind = payload["target_kind"]
        if target_kind == "@me":
            target_kind = "saved_messages"
        if target_kind not in {"saved_messages", "channel"}:
            raise ValueError("unknown frozen target kind")
        random_id = payload["random_id"]
        if not isinstance(random_id, str) or not random_id or not random_id.lstrip("-").isdigit():
            raise ValueError("random_id must be a decimal string")
        if not isinstance(payload["uploader_id"], int):
            raise ValueError("uploader_id must be an integer")
        if not isinstance(payload["target_peer_key"], str) or not payload["target_peer_key"]:
            raise ValueError("target_peer_key is required")
        if not isinstance(payload["created_target_version"], int) or not isinstance(payload["created_accounts_version"], int):
            raise ValueError("creation target/account versions must be integers")
        if not isinstance(payload["operation_id"], str) or not payload["operation_id"]:
            raise ValueError("operation_id is required")
        if not isinstance(payload["logical_file_id"], str) or not payload["logical_file_id"]:
            raise ValueError("logical_file_id is required")
        if not isinstance(payload["rpc_kind"], str) or not payload["rpc_kind"]:
            raise ValueError("rpc_kind is required")
        channel_id = payload.get("target_channel_id")
        if target_kind == "channel":
            if not is_canonical_channel_id(channel_id):
                raise ValueError("channel operation requires canonical target_channel_id")
        elif channel_id is not None:
            raise ValueError("Saved Messages operation cannot have target_channel_id")
        normalised = dict(payload)
        normalised["target_kind"] = target_kind
        normalised["target_channel_id"] = channel_id
        # Make a defensive JSON round-trip so callers cannot mutate nested intent
        # data after this method has accepted it.
        normalised["request_metadata"] = json.loads(
            Database._operation_json(payload["request_metadata"], "request_metadata")
        )
        return normalised

    @staticmethod
    def _operation_result_complete(mapping: Dict[str, Any], media_identity: Dict[str, Any]) -> bool:
        message_id = mapping.get("destination_message_id")
        kind = media_identity.get("destination_media_kind")
        media_id = media_identity.get("destination_media_id")
        size = media_identity.get("destination_size")
        variant = media_identity.get("destination_photo_variant")
        if not isinstance(message_id, int) or isinstance(message_id, bool) or message_id <= 0:
            return False
        if kind not in {"document", "photo"}:
            return False
        if not isinstance(media_id, str) or not media_id:
            return False
        if not isinstance(size, int) or isinstance(size, bool) or size < 0:
            return False
        if kind == "photo":
            return isinstance(variant, str) and bool(variant)
        return variant is None

    @staticmethod
    def _normalise_result_mapping(mapping: Dict[str, Any], media_identity: Optional[Dict[str, Any]] = None) -> Tuple[Dict[str, Any], Dict[str, Any]]:
        if not isinstance(mapping, dict):
            raise ValueError("mapping must be an object")
        if media_identity is not None and not isinstance(media_identity, dict):
            raise ValueError("media_identity must be an object")
        if "destination_access_hash" in mapping or "access_hash" in mapping or (
            media_identity is not None and (
                "destination_access_hash" in media_identity or "access_hash" in media_identity
            )
        ):
            raise ValueError("operation result must not contain an access hash")
        normal_mapping = dict(mapping)
        if "destination_message_id" not in normal_mapping and "message_id" in normal_mapping:
            normal_mapping["destination_message_id"] = normal_mapping["message_id"]
        normal_media = dict(media_identity or {})
        aliases = {
            "media_kind": "destination_media_kind",
            "media_id": "destination_media_id",
            "size": "destination_size",
        }
        for old, new in aliases.items():
            if new not in normal_media and old in normal_media:
                normal_media[new] = normal_media[old]
        return normal_mapping, normal_media

    @staticmethod
    def _operation_record(row: aiosqlite.Row) -> dict:
        """Expose JSON as JSON while retaining the persisted scalar result fields."""
        record = dict(row)
        for key in ("request_metadata", "frozen_payload", "mapping_json", "media_identity_json"):
            if record.get(key) is not None:
                record[key] = json.loads(record[key])
        return record

    async def _select_telegram_operation(self, operation_id: str) -> Optional[aiosqlite.Row]:
        cursor = await self._conn.execute("""
            SELECT o.*, r.destination_message_id, r.destination_media_kind,
                   r.destination_media_id, r.destination_size,
                   r.destination_access_hash, r.mapping_json,
                   r.media_identity_json, r.result_version
            FROM telegram_operations o
            LEFT JOIN telegram_operation_results r ON r.operation_id = o.operation_id
            WHERE o.operation_id = ?
        """, (operation_id,))
        return await cursor.fetchone()

    async def _owned_telegram_operation(self, owner_id: int, operation_id: str) -> aiosqlite.Row:
        row = await self._select_telegram_operation(operation_id)
        if row is None:
            raise KeyError("Telegram operation not found")
        if row["owner_id"] != owner_id:
            raise PermissionError("Telegram operation belongs to another owner")
        return row

    async def create_or_get_telegram_operation(self, owner_id: int, payload: Dict[str, Any]) -> dict:
        """Persist an immutable send intent, or return its exact idempotent retry."""
        if not self._conn:
            raise RuntimeError("Database not connected")
        frozen = self._normalise_operation_payload(payload)
        frozen_json = self._operation_json(frozen, "operation payload")
        request_json = self._operation_json(frozen["request_metadata"], "request_metadata")
        await self._conn.execute("BEGIN IMMEDIATE")
        try:
            existing = await self._select_telegram_operation(frozen["operation_id"])
            if existing is not None:
                if existing["owner_id"] != owner_id:
                    raise PermissionError("Telegram operation belongs to another owner")
                if existing["frozen_payload"] != frozen_json:
                    raise ValueError("conflicting payload for existing Telegram operation")
                await self._conn.rollback()
                return self._operation_record(existing)

            await self._ensure_storage_target(owner_id)
            cursor = await self._conn.execute(
                "SELECT storage_mode, channel_id, version, accounts_version FROM storage_targets WHERE owner_id = ?",
                (owner_id,),
            )
            target = await cursor.fetchone()
            if (
                target["version"] != frozen["created_target_version"]
                or target["accounts_version"] != frozen["created_accounts_version"]
                or target["storage_mode"] != frozen["target_kind"]
                or target["channel_id"] != frozen["target_channel_id"]
            ):
                await self._conn.rollback()
                return None

            cursor = await self._conn.execute(
                "SELECT 1 FROM linked_accounts WHERE owner_id = ? AND telegram_user_id = ?",
                (owner_id, frozen["uploader_id"]),
            )
            if await cursor.fetchone() is None:
                raise ValueError("Telegram operation uploader must be linked to this drive")
            expected_peer_key = (
                frozen["target_channel_id"]
                if frozen["target_kind"] == "channel"
                else f"me:{frozen['uploader_id']}"
            )
            if frozen["target_peer_key"] != expected_peer_key:
                raise ValueError("target_peer_key does not match the frozen storage target")

            cursor = await self._conn.execute(
                "SELECT operation_id FROM telegram_operations WHERE uploader_id = ? AND random_id = ?",
                (frozen["uploader_id"], frozen["random_id"]),
            )
            if await cursor.fetchone() is not None:
                raise ValueError("random_id is already bound to another Telegram operation")
            stamp = self._operation_now().isoformat()
            await self._conn.execute("""
                INSERT INTO telegram_operations (
                    operation_id, owner_id, kind, logical_file_id, group_id, part_index,
                    uploader_id, target_kind, target_channel_id, target_peer_key,
                    created_target_version, created_accounts_version, random_id, rpc_kind,
                    request_metadata, frozen_payload, state, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?)
            """, (
                frozen["operation_id"], owner_id, frozen["kind"], frozen["logical_file_id"],
                frozen.get("group_id"), frozen.get("part_index"), frozen["uploader_id"],
                frozen["target_kind"], frozen["target_channel_id"], frozen["target_peer_key"],
                frozen["created_target_version"], frozen["created_accounts_version"],
                frozen["random_id"], frozen["rpc_kind"], request_json, frozen_json, stamp, stamp,
            ))
            await self._conn.commit()
        except Exception:
            await self._conn.rollback()
            raise
        return self._operation_record(await self._owned_telegram_operation(owner_id, frozen["operation_id"]))

    async def get_telegram_operation(self, owner_id: int, operation_id: str) -> Optional[dict]:
        """Return one owner-scoped journal row for reload recovery."""
        if not self._conn:
            raise RuntimeError("Database not connected")
        row = await self._select_telegram_operation(operation_id)
        if row is None or row["owner_id"] != owner_id:
            return None
        return self._operation_record(row)

    async def list_telegram_operations(self, owner_id: int, include_terminal: bool = False) -> List[dict]:
        """List one drive's pending operations; terminal history is opt-in."""
        if not self._conn:
            raise RuntimeError("Database not connected")
        terminal = ("registered", "committed", "tombstoned")
        query = """
            SELECT o.*, r.destination_message_id, r.destination_media_kind,
                   r.destination_media_id, r.destination_size,
                   r.destination_access_hash, r.mapping_json,
                   r.media_identity_json, r.result_version
            FROM telegram_operations o
            LEFT JOIN telegram_operation_results r ON r.operation_id = o.operation_id
            WHERE o.owner_id = ?
        """
        params: List[Any] = [owner_id]
        if not include_terminal:
            query += " AND o.state NOT IN (?, ?, ?)"
            params.extend(terminal)
        query += " ORDER BY o.created_at ASC, o.operation_id ASC"
        cursor = await self._conn.execute(query, params)
        return [self._operation_record(row) for row in await cursor.fetchall()]

    async def claim_telegram_operation(
        self,
        owner_id: int,
        operation_id: str,
        lease_owner: str,
        lease_seconds: int = 30,
        now: Optional[datetime] = None,
    ) -> Optional[dict]:
        """Conditionally claim a pending intent; expired sends resume as recovery."""
        if not self._conn:
            raise RuntimeError("Database not connected")
        if not lease_owner or lease_seconds <= 0:
            raise ValueError("lease_owner and positive lease_seconds are required")
        moment = self._operation_now(now)
        await self._conn.execute("BEGIN IMMEDIATE")
        try:
            row = await self._owned_telegram_operation(owner_id, operation_id)
            expiry = self._operation_time(row["lease_expires_at"])
            active_elsewhere = expiry is not None and expiry > moment and row["lease_owner"] != lease_owner
            retry_at = self._operation_time(row["retry_at"])
            if active_elsewhere or row["state"] in {"sent", "registered", "committed", "tombstoned", "uncertain"}:
                await self._conn.rollback()
                return None
            if row["state"] == "retryable" and retry_at is not None and retry_at > moment:
                await self._conn.rollback()
                return None
            if row["state"] not in {"planned", "sending", "recovering", "retryable"}:
                await self._conn.rollback()
                return None
            state = row["state"]
            if state == "planned" or state == "retryable":
                state = "sending"
            elif state == "sending" and expiry is not None and expiry <= moment:
                state = "recovering"
            lease_expires = (moment + timedelta(seconds=lease_seconds)).isoformat()
            await self._conn.execute("""
                UPDATE telegram_operations
                SET state = ?, lease_owner = ?, lease_expires_at = ?,
                    version = version + 1, updated_at = ?
                WHERE operation_id = ? AND version = ?
            """, (state, lease_owner, lease_expires, moment.isoformat(), operation_id, row["version"]))
            await self._conn.commit()
        except Exception:
            await self._conn.rollback()
            raise
        return await self.get_telegram_operation(owner_id, operation_id)

    async def transition_telegram_operation(
        self,
        owner_id: int,
        operation_id: str,
        expected_version: int,
        state: str,
        *,
        retry_at: Optional[str] = None,
        error_code: Optional[str] = None,
        tombstone_reason: Optional[str] = None,
    ) -> Optional[dict]:
        """Apply the closed state graph without changing frozen send identity."""
        allowed = {
            "planned": {"sending", "tombstoned"},
            "sending": {"recovering", "retryable", "uncertain", "tombstoned"},
            "recovering": {"retryable", "uncertain", "tombstoned"},
            "retryable": {"sending", "recovering", "tombstoned"},
            "sent": {"registered", "committed", "tombstoned"},
            "registered": set(), "committed": set(), "tombstoned": set(), "uncertain": set(),
        }
        if state not in {item for values in allowed.values() for item in values}:
            raise ValueError("unknown Telegram operation state")
        if not self._conn:
            raise RuntimeError("Database not connected")
        await self._conn.execute("BEGIN IMMEDIATE")
        try:
            row = await self._owned_telegram_operation(owner_id, operation_id)
            if row["version"] != expected_version:
                await self._conn.rollback()
                return None
            if state not in allowed[row["state"]]:
                raise ValueError(f"cannot transition {row['state']} to {state}")
            if state == "sent":
                # uncertain -> sent is intentionally unavailable here; only the
                # reconcile-result transaction below may make that transition.
                raise ValueError("sent requires a complete persisted operation result")
            if state == "retryable" and retry_at is None:
                raise ValueError("retryable operations require retry_at")
            await self._conn.execute("""
                UPDATE telegram_operations
                SET state = ?, retry_at = ?, error_code = ?, tombstone_reason = ?,
                    lease_owner = NULL, lease_expires_at = NULL,
                    version = version + 1, updated_at = ?
                WHERE operation_id = ?
            """, (state, retry_at, error_code, tombstone_reason, self._operation_now().isoformat(), operation_id))
            await self._conn.commit()
        except Exception:
            await self._conn.rollback()
            raise
        return await self.get_telegram_operation(owner_id, operation_id)

    async def record_operation_mapping(
        self,
        owner_id: int,
        operation_id: str,
        expected_version: int,
        mapping: Dict[str, Any],
        media_identity: Optional[Dict[str, Any]] = None,
    ) -> Optional[dict]:
        """Persist a partial response/update mapping without publishing it as sent."""
        if not self._conn:
            raise RuntimeError("Database not connected")
        mapping, media_identity = self._normalise_result_mapping(mapping, media_identity)
        await self._conn.execute("BEGIN IMMEDIATE")
        try:
            row = await self._owned_telegram_operation(owner_id, operation_id)
            if row["version"] != expected_version:
                await self._conn.rollback()
                return None
            if row["state"] not in {"sending", "recovering"}:
                raise ValueError("operation mapping may only be recorded while sending or recovering")
            self._validate_result_identity(row, mapping)
            old_mapping = json.loads(row["mapping_json"]) if row["mapping_json"] else {}
            old_media = json.loads(row["media_identity_json"]) if row["media_identity_json"] else {}
            self._merge_operation_result(old_mapping, mapping)
            self._merge_operation_result(old_media, media_identity)
            await self._write_operation_result(row, old_mapping, old_media)
            await self._conn.execute(
                "UPDATE telegram_operations SET version = version + 1, updated_at = ? WHERE operation_id = ?",
                (self._operation_now().isoformat(), operation_id),
            )
            await self._conn.commit()
        except Exception:
            await self._conn.rollback()
            raise
        return await self.get_telegram_operation(owner_id, operation_id)

    @staticmethod
    def _merge_operation_result(existing: Dict[str, Any], incoming: Dict[str, Any]) -> None:
        for key, value in incoming.items():
            if key in existing and existing[key] != value:
                raise ValueError("conflicting Telegram operation result mapping")
            existing[key] = value

    @staticmethod
    def _validate_result_identity(row: aiosqlite.Row, mapping: Dict[str, Any], require_complete_identity: bool = False) -> None:
        identity = {
            "uploader_id": row["uploader_id"],
            "random_id": row["random_id"],
            "target_peer_key": row["target_peer_key"],
        }
        for key, value in identity.items():
            if key in mapping and mapping[key] != value:
                raise ValueError(f"mapping {key} does not match frozen operation identity")
            if require_complete_identity and key not in mapping:
                raise ValueError(f"mapping missing frozen {key}")

    async def _write_operation_result(self, row: aiosqlite.Row, mapping: Dict[str, Any], media_identity: Dict[str, Any]) -> None:
        """Upsert one result while retaining its immutable owner/uploader identity."""
        await self._conn.execute("""
            INSERT INTO telegram_operation_results (
                operation_id, owner_id, uploader_id, random_id, target_peer_key,
                destination_message_id, destination_media_kind, destination_media_id,
                destination_size, destination_access_hash, mapping_json,
                media_identity_json, result_version, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
            ON CONFLICT(operation_id) DO UPDATE SET
                destination_message_id = excluded.destination_message_id,
                destination_media_kind = excluded.destination_media_kind,
                destination_media_id = excluded.destination_media_id,
                destination_size = excluded.destination_size,
                destination_access_hash = excluded.destination_access_hash,
                mapping_json = excluded.mapping_json,
                media_identity_json = excluded.media_identity_json,
                result_version = telegram_operation_results.result_version + 1,
                updated_at = excluded.updated_at
        """, (
            row["operation_id"], row["owner_id"], row["uploader_id"], row["random_id"],
            row["target_peer_key"], mapping.get("destination_message_id"),
            media_identity.get("destination_media_kind"), media_identity.get("destination_media_id"),
            media_identity.get("destination_size"), media_identity.get("destination_access_hash"),
            self._operation_json(mapping, "mapping"),
            self._operation_json(media_identity, "media_identity"), self._operation_now().isoformat(),
        ))

    async def complete_operation_result(
        self,
        owner_id: int,
        operation_id: str,
        expected_version: int,
        mapping: Dict[str, Any],
        media_identity: Dict[str, Any],
    ) -> Optional[dict]:
        """Atomically persist a complete result and transition to sent.

        This is the only path from uncertain to sent.  It performs no Telegram
        work; callers supply the browser's frozen-identity read result.
        """
        if not self._conn:
            raise RuntimeError("Database not connected")
        mapping, media_identity = self._normalise_result_mapping(mapping, media_identity)
        await self._conn.execute("BEGIN IMMEDIATE")
        try:
            row = await self._owned_telegram_operation(owner_id, operation_id)
            self._validate_result_identity(row, mapping, require_complete_identity=True)
            old_mapping = json.loads(row["mapping_json"]) if row["mapping_json"] else {}
            old_media = json.loads(row["media_identity_json"]) if row["media_identity_json"] else {}
            self._merge_operation_result(old_mapping, mapping)
            self._merge_operation_result(old_media, media_identity)
            if not self._operation_result_complete(old_mapping, old_media):
                raise ValueError("sent result requires complete mapping and media identity")
            # Response-loss retry: identical already-sent result is safe even
            # though the caller still has the version from before the commit.
            if row["state"] == "sent":
                if row["mapping_json"] == self._operation_json(old_mapping, "mapping") and row["media_identity_json"] == self._operation_json(old_media, "media_identity"):
                    await self._conn.rollback()
                    return self._operation_record(row)
                raise ValueError("sent operation result cannot be changed")
            if row["version"] != expected_version:
                await self._conn.rollback()
                return None
            if row["state"] not in {"sending", "recovering", "uncertain"}:
                raise ValueError("only sending, recovering, or uncertain operations may become sent")
            await self._write_operation_result(row, old_mapping, old_media)
            await self._conn.execute("""
                UPDATE telegram_operations
                SET state = 'sent', lease_owner = NULL, lease_expires_at = NULL,
                    retry_at = NULL, error_code = NULL, version = version + 1, updated_at = ?
                WHERE operation_id = ?
            """, (self._operation_now().isoformat(), operation_id))
            await self._conn.commit()
        except Exception:
            await self._conn.rollback()
            raise
        return await self.get_telegram_operation(owner_id, operation_id)

    # ==================== Operation registration and location switches ====================

    @staticmethod
    def _registration_metadata(operation: aiosqlite.Row) -> Dict[str, Any]:
        """Turn frozen request metadata into the file metadata it authorizes.

        The operation payload is the only registration input.  This keeps a
        response-loss retry from accepting a newer filename, parent or source.
        Older callers used both a flat shape and a `file` object, so accept the
        two equivalent frozen representations while storing one canonical row.
        """
        metadata = json.loads(operation["request_metadata"])
        for key in ("file", "file_metadata", "registration"):
            if isinstance(metadata.get(key), dict):
                metadata = {**metadata, **metadata[key]}
        filename = metadata.get("filename", metadata.get("file_name"))
        if not isinstance(filename, str) or not filename.strip():
            raise ValueError("operation request_metadata missing filename")
        size = metadata.get("filesize", metadata.get("size"))
        if not isinstance(size, int) or size < 0:
            raise ValueError("operation request_metadata missing filesize")
        return {
            "filename": filename.strip(),
            "filesize": size,
            "mime_type": metadata.get("mime_type"),
            "parent_id": metadata.get("parent_id"),
            "has_thumbnail": bool(metadata.get("has_thumbnail", False)),
            "original_name": metadata.get("original_name"),
            "total_parts": metadata.get("total_parts"),
            "file_hash": metadata.get("file_hash"),
        }

    @staticmethod
    def _registration_file_type(mime_type: Optional[str], filename: str) -> str:
        if isinstance(mime_type, str):
            if mime_type.startswith("image/"):
                return "photo"
            if mime_type.startswith("video/"):
                return "video"
            if mime_type.startswith("audio/"):
                return "audio"
            if mime_type in {"application/pdf", "application/msword"}:
                return "document"
        suffix = Path(filename).suffix.lower()
        if suffix in {".jpg", ".jpeg", ".png", ".gif"}:
            return "photo"
        if suffix in {".mp4", ".avi", ".mkv", ".mov"}:
            return "video"
        if suffix in {".mp3", ".wav", ".flac"}:
            return "audio"
        return "other"

    async def _operation_registration_binding(self, owner_id: int, operation_id: str) -> Optional[dict]:
        cursor = await self._conn.execute(
            "SELECT operation_id, owner_id, file_id FROM telegram_operation_file_bindings "
            "WHERE operation_id = ? AND owner_id = ?",
            (operation_id, owner_id),
        )
        row = await cursor.fetchone()
        return dict(row) if row else None

    async def _register_operation_row(self, owner_id: int, operation: aiosqlite.Row) -> dict:
        """Create one registered file and its operation binding inside a transaction."""
        existing_binding = await self._operation_registration_binding(owner_id, operation["operation_id"])
        if existing_binding is not None:
            return existing_binding
        if operation["state"] == "tombstoned":
            raise ValueError("tombstoned operation cannot register a file")
        if operation["state"] != "sent" or operation["result_version"] is None:
            raise ValueError("only sent operations with a complete result may register")
        mapping = json.loads(operation["mapping_json"] or "{}")
        media = json.loads(operation["media_identity_json"] or "{}")
        if not self._operation_result_complete(mapping, media):
            raise ValueError("operation result is incomplete")
        metadata = self._registration_metadata(operation)
        file_id = operation["logical_file_id"]
        parent_id = metadata["parent_id"]

        cursor = await self._conn.execute(
            "SELECT owner_id FROM files WHERE file_id = ?", (file_id,)
        )
        existing_file = await cursor.fetchone()
        if existing_file is not None and existing_file["owner_id"] != owner_id:
            raise PermissionError("logical file belongs to another owner")

        if parent_id:
            cursor = await self._conn.execute(
                "SELECT isDir, trashed_at, owner_id FROM files WHERE file_id = ?", (parent_id,)
            )
            parent = await cursor.fetchone()
            if parent is None or parent["owner_id"] != owner_id or not parent["isDir"] or parent["trashed_at"]:
                raise ValueError("Parent folder not found")

        # Preserve the legacy replace-on-name behavior for the *first* commit.
        # Subsequent retries returned above never reach this destructive sweep.
        if operation["part_index"] in (None, 0):
            clauses = ["owner_id = ?", "isDir = 0", "filename = ?", "trashed_at IS NULL", "file_id != ?"]
            params: List[Any] = [owner_id, metadata["filename"], file_id]
            if parent_id is None:
                clauses.append("parent_id IS NULL")
            else:
                clauses.append("parent_id = ?")
                params.append(parent_id)
            if operation["group_id"]:
                clauses.append("(split_group_id IS NULL OR split_group_id != ?)")
                params.append(operation["group_id"])
            cursor = await self._conn.execute(
                f"SELECT file_id FROM files WHERE {' AND '.join(clauses)}", params
            )
            stale_ids = [row[0] for row in await cursor.fetchall()]
            if stale_ids:
                marks = ",".join("?" for _ in stale_ids)
                await self._conn.execute(
                    f"DELETE FROM files WHERE owner_id = ? AND file_id IN ({marks})",
                    (owner_id, *stale_ids),
                )

        stamp = self._operation_now().isoformat()
        await self._conn.execute("""
            INSERT INTO files (
                file_id, filename, filesize, mime_type, file_type,
                telegram_message_id, has_thumbnail, created_at, direct_url,
                access_hash, parent_id, isDir, is_split_file, original_name,
                part_index, total_parts, split_group_id, telegram_user_id,
                file_hash, owner_id, telegram_chat_id, telegram_media_kind,
                telegram_media_id, telegram_media_size, telegram_photo_variant,
                location_version
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
            ON CONFLICT(file_id) DO UPDATE SET
                filename=excluded.filename, filesize=excluded.filesize,
                mime_type=excluded.mime_type, file_type=excluded.file_type,
                telegram_message_id=excluded.telegram_message_id,
                has_thumbnail=excluded.has_thumbnail, created_at=excluded.created_at,
                access_hash=excluded.access_hash, parent_id=excluded.parent_id,
                is_split_file=excluded.is_split_file, original_name=excluded.original_name,
                part_index=excluded.part_index, total_parts=excluded.total_parts,
                split_group_id=excluded.split_group_id, telegram_user_id=excluded.telegram_user_id,
                file_hash=excluded.file_hash, owner_id=excluded.owner_id,
                telegram_chat_id=excluded.telegram_chat_id,
                telegram_media_kind=excluded.telegram_media_kind,
                telegram_media_id=excluded.telegram_media_id,
                telegram_media_size=excluded.telegram_media_size,
                telegram_photo_variant=excluded.telegram_photo_variant,
                location_version=excluded.location_version, trashed_at=NULL
        """, (
            file_id, metadata["filename"], metadata["filesize"], metadata["mime_type"],
            self._registration_file_type(metadata["mime_type"], metadata["filename"]),
            mapping["destination_message_id"], 1 if metadata["has_thumbnail"] else 0, stamp,
            media.get("destination_access_hash"), parent_id,
            1 if operation["group_id"] else 0, metadata["original_name"], operation["part_index"],
            metadata["total_parts"], operation["group_id"], operation["uploader_id"],
            metadata["file_hash"], owner_id,
            operation["target_channel_id"] if operation["target_kind"] == "channel" else None,
            media["destination_media_kind"], media["destination_media_id"], media["destination_size"],
            media.get("destination_photo_variant"),
        ))
        await self._conn.execute(
            "INSERT INTO telegram_operation_file_bindings (operation_id, owner_id, file_id, created_at) VALUES (?, ?, ?, ?)",
            (operation["operation_id"], owner_id, file_id, stamp),
        )
        await self._conn.execute(
            "UPDATE telegram_operations SET state = 'registered', registered_file_id = ?, version = version + 1, updated_at = ? WHERE operation_id = ?",
            (file_id, stamp, operation["operation_id"]),
        )
        return {"operation_id": operation["operation_id"], "owner_id": owner_id, "file_id": file_id}

    async def register_telegram_operation(self, owner_id: int, operation_id: str) -> Optional[dict]:
        if not self._conn:
            raise RuntimeError("Database not connected")
        await self._conn.execute("BEGIN IMMEDIATE")
        try:
            operation = await self._owned_telegram_operation(owner_id, operation_id)
            if operation["group_id"]:
                raise ValueError("split operation must be registered through its group")
            binding = await self._register_operation_row(owner_id, operation)
            await self._conn.commit()
            return binding
        except Exception:
            await self._conn.rollback()
            raise

    async def register_telegram_operation_group(self, owner_id: int, group_id: str) -> List[dict]:
        if not self._conn:
            raise RuntimeError("Database not connected")
        await self._conn.execute("BEGIN IMMEDIATE")
        try:
            cursor = await self._conn.execute("""
                SELECT o.*, r.destination_message_id, r.destination_media_kind,
                       r.destination_media_id, r.destination_size, r.destination_access_hash,
                       r.mapping_json, r.media_identity_json, r.result_version
                FROM telegram_operations o LEFT JOIN telegram_operation_results r ON r.operation_id = o.operation_id
                WHERE o.owner_id = ? AND o.group_id = ? ORDER BY o.part_index ASC
            """, (owner_id, group_id))
            operations = await cursor.fetchall()
            if not operations:
                raise KeyError("Telegram operation group not found")
            totals = {self._registration_metadata(row)["total_parts"] for row in operations}
            if len(totals) != 1 or not isinstance(next(iter(totals)), int) or next(iter(totals)) <= 0:
                raise ValueError("split group must declare one positive total_parts")
            total = next(iter(totals))
            if [row["part_index"] for row in operations] != list(range(total)):
                raise ValueError("split group is incomplete")
            bindings = [await self._register_operation_row(owner_id, row) for row in operations]
            await self._conn.commit()
            return bindings
        except Exception:
            await self._conn.rollback()
            raise

    async def _switch_binding(self, owner_id: int, file_id: str, operation_id: str) -> Optional[dict]:
        cursor = await self._conn.execute(
            "SELECT owner_id, file_id, operation_id, result_version, location_version "
            "FROM file_location_switch_bindings WHERE owner_id = ? AND file_id = ? AND operation_id = ?",
            (owner_id, file_id, operation_id),
        )
        row = await cursor.fetchone()
        return dict(row) if row else None

    async def _validate_and_switch_file(
        self, owner_id: int, file_id: str, expected_location_version: int,
        operation_id: str, result_version: int,
    ) -> dict:
        binding = await self._switch_binding(owner_id, file_id, operation_id)
        if binding is not None:
            if binding["result_version"] != result_version:
                raise ValueError("switch binding result version conflicts")
            return binding
        file_row = await self.get_file(file_id, owner_id)
        if file_row is None:
            raise KeyError("File not found")
        if file_row["location_version"] != expected_location_version:
            raise ValueError("file location version conflict")
        operation = await self._owned_telegram_operation(owner_id, operation_id)
        if operation["logical_file_id"] != file_id:
            raise ValueError("operation is not bound to this logical file")
        source = json.loads(operation["request_metadata"]).get("source")
        source_fields = {
            "file_id": "file_id",
            "telegram_user_id": "telegram_user_id",
            "telegram_chat_id": "telegram_chat_id",
            "telegram_message_id": "telegram_message_id",
            "telegram_media_kind": "telegram_media_kind",
            "telegram_media_id": "telegram_media_id",
            "telegram_media_size": "telegram_media_size",
            "telegram_photo_variant": "telegram_photo_variant",
            "location_version": "location_version",
        }
        if not isinstance(source, dict) or any(key not in source for key in source_fields):
            raise ValueError("location switch requires a complete frozen source snapshot")
        for source_key, file_key in source_fields.items():
            if source[source_key] != file_row[file_key]:
                raise ValueError("operation source location no longer matches file")
        if "access_hash" in source and source["access_hash"] != file_row["access_hash"]:
            raise ValueError("operation source location no longer matches file")
        if operation["state"] not in {"sent", "registered", "committed"}:
            raise ValueError("operation has no committed destination result")
        if operation["result_version"] != result_version:
            raise ValueError("operation result version conflict")
        mapping = json.loads(operation["mapping_json"] or "{}")
        media = json.loads(operation["media_identity_json"] or "{}")
        if not self._operation_result_complete(mapping, media):
            raise ValueError("operation result is incomplete")
        new_version = expected_location_version + 1
        cursor = await self._conn.execute("""
            UPDATE files SET telegram_user_id = ?, telegram_chat_id = ?,
                telegram_message_id = ?, access_hash = ?, telegram_media_kind = ?,
                telegram_media_id = ?, telegram_media_size = ?, telegram_photo_variant = ?,
                location_version = ?
            WHERE file_id = ? AND owner_id = ? AND location_version = ?
        """, (
            operation["uploader_id"], operation["target_channel_id"] if operation["target_kind"] == "channel" else None,
            mapping["destination_message_id"], media.get("destination_access_hash"),
            media["destination_media_kind"], media["destination_media_id"], media["destination_size"],
            media.get("destination_photo_variant"), new_version, file_id, owner_id, expected_location_version,
        ))
        if cursor.rowcount != 1:
            raise ValueError("file location version conflict")
        await self._conn.execute(
            "INSERT INTO file_location_switch_bindings (owner_id, file_id, operation_id, result_version, location_version, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (owner_id, file_id, operation_id, result_version, new_version, self._operation_now().isoformat()),
        )
        return {"owner_id": owner_id, "file_id": file_id, "operation_id": operation_id,
                "result_version": result_version, "location_version": new_version}

    async def switch_existing_file_location(self, owner_id: int, file_id: str, expected_location_version: int,
                                            operation_id: str, result_version: int) -> dict:
        if not self._conn:
            raise RuntimeError("Database not connected")
        file_row = await self.get_file(file_id, owner_id)
        if file_row is None:
            raise KeyError("File not found")
        if file_row["is_split_file"] or file_row["split_group_id"]:
            raise ValueError("split file location must be switched through its group")
        await self._conn.execute("BEGIN IMMEDIATE")
        try:
            binding = await self._validate_and_switch_file(owner_id, file_id, expected_location_version, operation_id, result_version)
            await self._conn.commit()
            return binding
        except Exception:
            await self._conn.rollback()
            raise

    async def switch_existing_file_location_group(self, owner_id: int, parts: List[Dict[str, Any]]) -> List[dict]:
        if not self._conn:
            raise RuntimeError("Database not connected")
        if not parts or len({part.get("file_id") for part in parts}) != len(parts):
            raise ValueError("a switch group requires unique parts")
        await self._conn.execute("BEGIN IMMEDIATE")
        try:
            ids = [part["file_id"] for part in parts]
            marks = ",".join("?" for _ in ids)
            cursor = await self._conn.execute(
                f"SELECT * FROM files WHERE owner_id = ? AND file_id IN ({marks})", (owner_id, *ids)
            )
            files = {row["file_id"]: dict(row) for row in await cursor.fetchall()}
            if len(files) != len(ids) or any(not row["is_split_file"] or not row["split_group_id"] for row in files.values()):
                raise ValueError("switch group requires owned split files")
            group_ids = {row["split_group_id"] for row in files.values()}
            if len(group_ids) != 1:
                raise ValueError("switch parts must be one split group")
            split_group_id = next(iter(group_ids))
            cursor = await self._conn.execute(
                "SELECT file_id FROM files WHERE owner_id = ? AND split_group_id = ? ORDER BY part_index", (owner_id, split_group_id)
            )
            if [row[0] for row in await cursor.fetchall()] != sorted(ids, key=lambda item: files[item]["part_index"]):
                raise ValueError("switch request must contain every split part exactly once")
            # Check frozen destination agreement before making any location change.
            operations = []
            for part in parts:
                op = await self._owned_telegram_operation(owner_id, part["operation_id"])
                if op["group_id"] != split_group_id or op["logical_file_id"] != part["file_id"]:
                    raise ValueError("switch operation does not match split part")
                operations.append(op)
            targets = {(op["target_kind"], op["target_channel_id"], op["target_peer_key"]) for op in operations}
            if len(targets) != 1:
                raise ValueError("split switches require one frozen destination target")
            bindings = [await self._validate_and_switch_file(
                owner_id, part["file_id"], part["expected_location_version"], part["operation_id"], part["result_version"],
            ) for part in parts]
            await self._conn.commit()
            return bindings
        except Exception:
            await self._conn.rollback()
            raise

    # ==================== Linked Account Operations ====================

    async def get_owner_of(self, telegram_user_id: int) -> Optional[int]:
        """Which drive owns this Telegram account? None = not linked anywhere."""
        if not self._conn:
            raise RuntimeError("Database not connected")
        cursor = await self._conn.execute(
            "SELECT owner_id FROM linked_accounts WHERE telegram_user_id = ?", (telegram_user_id,)
        )
        row = await cursor.fetchone()
        return row[0] if row else None

    async def link_account(
        self,
        owner_id: int,
        telegram_user_id: int,
        is_primary: bool = False,
        label: Optional[str] = None,
    ) -> bool:
        """Link an account to a drive. False if it already belongs to some drive."""
        if not self._conn:
            raise RuntimeError("Database not connected")
        await self._conn.execute("BEGIN IMMEDIATE")
        try:
            await self._conn.execute(
                "INSERT INTO linked_accounts (owner_id, telegram_user_id, label, is_primary, added_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (owner_id, telegram_user_id, label, 1 if is_primary else 0,
                 datetime.utcnow().isoformat()),
            )
        except aiosqlite.IntegrityError:
            await self._conn.rollback()
            return False  # idx_linked_unique — already claimed by a drive
        await self._ensure_storage_target(owner_id)
        await self._conn.execute(
            "UPDATE storage_targets SET accounts_version = accounts_version + 1 WHERE owner_id = ?",
            (owner_id,),
        )
        await self._conn.commit()
        return True

    async def list_linked_accounts(self, owner_id: int) -> List[dict]:
        """Accounts in this drive, each with how many live files it stores."""
        if not self._conn:
            raise RuntimeError("Database not connected")
        cursor = await self._conn.execute("""
            SELECT la.telegram_user_id, la.label, la.is_primary, la.added_at,
                   (SELECT COUNT(*) FROM files f
                    WHERE f.telegram_user_id = la.telegram_user_id
                      AND f.owner_id = la.owner_id AND f.isDir = 0) AS file_count
            FROM linked_accounts la
            WHERE la.owner_id = ?
            ORDER BY la.is_primary DESC, la.added_at ASC
        """, (owner_id,))
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]

    async def get_linked_account(self, owner_id: int, telegram_user_id: int) -> Optional[dict]:
        if not self._conn:
            raise RuntimeError("Database not connected")
        cursor = await self._conn.execute(
            "SELECT * FROM linked_accounts WHERE owner_id = ? AND telegram_user_id = ?",
            (owner_id, telegram_user_id),
        )
        row = await cursor.fetchone()
        return dict(row) if row else None

    async def count_files_on_account(self, owner_id: int, telegram_user_id: int) -> int:
        """Count retained Saved Messages dependencies, including trash and split parts."""
        if not self._conn:
            raise RuntimeError("Database not connected")
        cursor = await self._conn.execute(
            "SELECT COUNT(*) FROM files WHERE owner_id = ? AND telegram_user_id = ? "
            "AND telegram_chat_id IS NULL AND isDir = 0",
            (owner_id, telegram_user_id),
        )
        row = await cursor.fetchone()
        return row[0] if row else 0

    async def unlink_account(self, owner_id: int, telegram_user_id: int) -> bool:
        if not self._conn:
            raise RuntimeError("Database not connected")
        # Recheck dependencies under the same write transaction as the delete;
        # an endpoint's earlier preview count cannot protect against a race.
        await self._conn.execute("BEGIN IMMEDIATE")
        try:
            account = await self.get_linked_account(owner_id, telegram_user_id)
            if not account:
                await self._conn.rollback()
                return False

            cursor = await self._conn.execute(
                "SELECT COUNT(*) FROM files WHERE owner_id = ? AND telegram_user_id = ? "
                "AND telegram_chat_id IS NULL AND isDir = 0",
                (owner_id, telegram_user_id),
            )
            if (await cursor.fetchone())[0]:
                await self._conn.rollback()
                return False

            # Channel rows retain a historical uploader only.  They may survive
            # its unlink when another currently linked account has persisted
            # read evidence for each affected channel.  This is dependency
            # protection, never runtime Telegram authorization.
            cursor = await self._conn.execute("""
                SELECT DISTINCT telegram_chat_id
                FROM files
                WHERE owner_id = ? AND telegram_user_id = ?
                  AND telegram_chat_id IS NOT NULL AND isDir = 0
            """, (owner_id, telegram_user_id))
            for (channel_id,) in await cursor.fetchall():
                cursor = await self._conn.execute("""
                    SELECT 1
                    FROM linked_accounts account
                    JOIN storage_target_verifications verification
                      ON verification.owner_id = account.owner_id
                     AND verification.telegram_user_id = account.telegram_user_id
                    WHERE account.owner_id = ?
                      AND account.telegram_user_id != ?
                      AND verification.channel_id = ?
                      AND verification.can_read = 1
                    LIMIT 1
                """, (owner_id, telegram_user_id, channel_id))
                if await cursor.fetchone() is None:
                    await self._conn.rollback()
                    return False

            cursor = await self._conn.execute(
                "DELETE FROM linked_accounts WHERE owner_id = ? AND telegram_user_id = ?",
                (owner_id, telegram_user_id),
            )
            await self._ensure_storage_target(owner_id)
            await self._conn.execute(
                "UPDATE storage_targets SET accounts_version = accounts_version + 1 WHERE owner_id = ?",
                (owner_id,),
            )
            await self._conn.commit()
            return cursor.rowcount > 0
        except Exception:
            await self._conn.rollback()
            raise

    async def _ensure_storage_target(self, owner_id: int) -> None:
        """Provision an owner-scoped Saved Messages target without replacing one."""
        await self._conn.execute(
            "INSERT INTO storage_targets (owner_id) VALUES (?) ON CONFLICT(owner_id) DO NOTHING",
            (owner_id,),
        )

    async def get_storage_target(self, owner_id: int) -> dict:
        """Return one owner's target and the persisted verification summary."""
        if not self._conn:
            raise RuntimeError("Database not connected")
        await self._ensure_storage_target(owner_id)
        await self._conn.commit()
        cursor = await self._conn.execute(
            "SELECT * FROM storage_targets WHERE owner_id = ?", (owner_id,)
        )
        target = dict(await cursor.fetchone())
        cursor = await self._conn.execute("""
            SELECT telegram_user_id, channel_id, channel_title, can_read, can_write,
                   status, checked_at, accounts_version
            FROM storage_target_verifications
            WHERE owner_id = ? AND channel_id = ?
            ORDER BY telegram_user_id ASC
        """, (owner_id, target["channel_id"]))
        verifications = []
        for row in await cursor.fetchall():
            verification = dict(row)
            verification["can_read"] = bool(verification["can_read"])
            verification["can_write"] = bool(verification["can_write"])
            verifications.append(verification)
        target["verifications"] = verifications
        return target

    async def put_storage_target(
        self,
        owner_id: int,
        target: dict,
        expected_version: int,
        expected_accounts_version: int,
        verifications: List[dict],
    ) -> Optional[dict]:
        """CAS-write one target and its current-account audit in one transaction."""
        if not self._conn:
            raise RuntimeError("Database not connected")
        await self._conn.execute("BEGIN IMMEDIATE")
        try:
            await self._ensure_storage_target(owner_id)
            cursor = await self._conn.execute(
                "SELECT version, accounts_version FROM storage_targets WHERE owner_id = ?", (owner_id,)
            )
            current = await cursor.fetchone()
            if current["version"] != expected_version or current["accounts_version"] != expected_accounts_version:
                await self._conn.rollback()
                return None

            channel_id = target.get("channel_id")
            if target["storage_mode"] == "channel":
                if not is_canonical_channel_id(channel_id):
                    raise ValueError("channel_id must be a canonical positive raw channel ID")
                await self._validate_storage_target_verifications(
                    owner_id=owner_id,
                    channel_id=channel_id,
                    accounts_version=current["accounts_version"],
                    verifications=verifications,
                )
            elif channel_id is not None or verifications:
                raise ValueError("Saved Messages does not accept channel verification evidence")

            await self._conn.execute("""
                UPDATE storage_targets
                SET storage_mode = ?, channel_id = ?, channel_title = ?, version = version + 1
                WHERE owner_id = ?
            """, (target["storage_mode"], channel_id, target.get("channel_title"), owner_id))
            await self._conn.execute(
                "DELETE FROM storage_target_verifications WHERE owner_id = ?", (owner_id,)
            )
            for verification in verifications:
                await self._conn.execute("""
                    INSERT INTO storage_target_verifications (
                        owner_id, channel_id, telegram_user_id, channel_title,
                        can_read, can_write, status, checked_at, accounts_version
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(owner_id, channel_id, telegram_user_id) DO UPDATE SET
                        channel_title = excluded.channel_title,
                        can_read = excluded.can_read,
                        can_write = excluded.can_write,
                        status = excluded.status,
                        checked_at = excluded.checked_at,
                        accounts_version = excluded.accounts_version
                """, (
                    owner_id, verification["channel_id"], verification["telegram_user_id"],
                    verification.get("channel_title"), 1 if verification["can_read"] else 0,
                    1 if verification["can_write"] else 0, verification["status"],
                    verification["checked_at"], verification["accounts_version"],
                ))
            await self._conn.commit()
        except Exception:
            await self._conn.rollback()
            raise
        return await self.get_storage_target(owner_id)

    async def _validate_storage_target_verifications(
        self,
        *,
        owner_id: int,
        channel_id: Optional[str],
        accounts_version: int,
        verifications: List[dict],
    ) -> None:
        """Check enable-only evidence after BEGIN IMMEDIATE has frozen account state."""
        if not channel_id:
            raise ValueError("A channel target requires channel_id")

        cursor = await self._conn.execute(
            "SELECT telegram_user_id, is_primary FROM linked_accounts WHERE owner_id = ?",
            (owner_id,),
        )
        linked_accounts = await cursor.fetchall()
        linked_ids = {row["telegram_user_id"] for row in linked_accounts}
        if not linked_ids or not any(row["is_primary"] for row in linked_accounts):
            raise ValueError("A channel target requires a linked primary account")

        verified_ids = [verification["telegram_user_id"] for verification in verifications]
        if len(verified_ids) != len(set(verified_ids)) or set(verified_ids) != linked_ids:
            raise ValueError("Verification evidence must cover every currently linked account")

        now = datetime.now(timezone.utc)
        oldest_allowed = now - timedelta(seconds=300)
        for verification in verifications:
            if verification.get("channel_id") != channel_id:
                raise ValueError("Verification channel does not match the target")
            if verification.get("accounts_version") != accounts_version:
                raise ValueError("Verification account version does not match the target")
            if not verification.get("can_read") or not verification.get("can_write"):
                raise ValueError("Every linked account needs read and write access")
            if verification.get("status") != "verified":
                raise ValueError("Every linked account needs verified status")
            checked_at = self._parse_verification_time(verification.get("checked_at"))
            if checked_at < oldest_allowed or checked_at > now:
                raise ValueError("Verification evidence must be fresh and not from the future")

    @staticmethod
    def _parse_verification_time(value: object) -> datetime:
        if not isinstance(value, str):
            raise ValueError("Verification checked_at must be an ISO timestamp")
        try:
            checked_at = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise ValueError("Verification checked_at must be an ISO timestamp") from exc
        if checked_at.tzinfo is None or checked_at.utcoffset() is None:
            raise ValueError("Verification checked_at must include a timezone")
        return checked_at.astimezone(timezone.utc)


    # ==================== Storage migration metadata journal ====================

    async def create_migration_manifest(
        self, owner_id: int, expected_target_version: int,
        expected_accounts_version: int, dry_run: bool = False,
    ) -> dict:
        from app.services import storage_migration
        return await storage_migration.create_migration_manifest(
            self, owner_id, expected_target_version, expected_accounts_version, dry_run,
        )

    async def list_migration_jobs(self, owner_id: int) -> List[dict]:
        from app.services import storage_migration
        return await storage_migration.list_migration_jobs(self, owner_id)

    async def get_migration_job(self, owner_id: int, migration_id: str) -> Optional[dict]:
        from app.services import storage_migration
        return await storage_migration.get_migration_job(self, owner_id, migration_id)

    async def list_migration_groups(
        self, owner_id: int, migration_id: str, *, scope: str = "runnable",
        limit: int = 25, after: Optional[str] = None,
    ) -> Optional[dict]:
        from app.services import storage_migration
        return await storage_migration.list_migration_groups(
            self, owner_id, migration_id, scope=scope, limit=limit, after=after,
        )

    async def get_migration_group(
        self, owner_id: int, migration_id: str, group_id: str,
    ) -> Optional[dict]:
        from app.services import storage_migration
        return await storage_migration.get_migration_group(
            self, owner_id, migration_id, group_id,
        )

    async def claim_migration_group(
        self, owner_id: int, migration_id: str, group_id: str,
        expected_item_versions: Dict[str, int], *, lease_owner: str, lease_seconds: int,
    ) -> dict:
        from app.services import storage_migration
        return await storage_migration.claim_migration_group(
            self, owner_id, migration_id, group_id, expected_item_versions,
            lease_owner=lease_owner, lease_seconds=lease_seconds,
        )

    async def claim_migration_item(
        self, owner_id: int, migration_id: str, item_id: str,
        expected_version: int, lease_owner: str, lease_seconds: int,
        *, operation_id: Optional[str] = None, state: Optional[str] = None,
        error: Optional[str] = None,
    ) -> dict:
        from app.services import storage_migration
        return await storage_migration.claim_migration_item(
            self, owner_id, migration_id, item_id, expected_version,
            lease_owner, lease_seconds, operation_id=operation_id,
            state=state, error=error,
        )

    async def transition_reconciled_item(
        self, owner_id: int, migration_id: str, item_id: str,
        expected_item_version: int, operation_result_version: int,
    ) -> dict:
        from app.services import storage_migration
        return await storage_migration.transition_reconciled_item(
            self, owner_id, migration_id, item_id,
            expected_item_version, operation_result_version,
        )

    async def upsert_migration_evidence(
        self, owner_id: int, migration_id: str, item_id: str,
        telegram_user_id: int, **evidence: Any,
    ) -> dict:
        from app.services import storage_migration
        return await storage_migration.upsert_migration_evidence(
            self, owner_id, migration_id, item_id, telegram_user_id, **evidence,
        )

    async def validate_commit_quorum(
        self, owner_id: int, migration_id: str, item_id: str,
    ) -> bool:
        from app.services import storage_migration
        return await storage_migration.validate_commit_quorum(
            self, owner_id, migration_id, item_id,
        )

    async def commit_migration_group(
        self, owner_id: int, migration_id: str, group_id: str,
        expected_job_version: int, expected_item_versions: Dict[str, int],
    ) -> dict:
        from app.services import storage_migration
        return await storage_migration.commit_migration_group(
            self, owner_id, migration_id, group_id,
            expected_job_version, expected_item_versions,
        )

    async def rollback_migration_group(
        self, owner_id: int, migration_id: str, group_id: str,
        expected_location_versions: Dict[str, int],
    ) -> dict:
        from app.services import storage_migration
        return await storage_migration.rollback_migration_group(
            self, owner_id, migration_id, group_id, expected_location_versions,
        )


# Singleton instance
_db: Optional[Database] = None


async def get_database() -> Database:
    """Get or create the database instance."""
    global _db
    if _db is None:
        _db = Database()
        await _db.connect()
        await _db.init_schema()
    return _db


async def close_database() -> None:
    """Close the database connection."""
    global _db
    if _db is not None:
        await _db.close()
        _db = None
