"""
SQLite database module for persistent file metadata storage.
"""

import aiosqlite
import json
import os
from datetime import datetime
from typing import Optional, List, Tuple
from pathlib import Path
from loguru import logger

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


class Database:
    """SQLite database for file metadata persistence."""
    
    def __init__(self, db_path: str = None):
        self.db_path = db_path or str(DB_PATH)
        self._conn: Optional[aiosqlite.Connection] = None
    
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
                split_group_id TEXT
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

        # Force commit and verify
        await self._conn.commit()
        
        # Verify tables were created
        cursor = await self._conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        tables = await cursor.fetchall()
        logger.info(f"Tables created: {[t[0] for t in tables]}")
        
        logger.info("Database schema initialized")
    
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
    ) -> None:
        """Insert a new file record.

        owner_id is the drive; telegram_user_id is the account storing the message.
        Callers that predate multi-account pass only the latter — same value for both.
        """
        if not self._conn:
            raise RuntimeError("Database not connected")

        await self._conn.execute("""
            INSERT OR REPLACE INTO files (
                file_id, filename, filesize, mime_type, file_type,
                telegram_message_id, has_thumbnail,
                created_at, direct_url, access_hash, parent_id, isDir,
                is_split_file, original_name, part_index, total_parts, split_group_id,
                telegram_user_id, file_hash, owner_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            file_id, filename, filesize, mime_type, file_type,
            telegram_message_id, 1 if has_thumbnail else 0,
            created_at, direct_url, access_hash, parent_id, 1 if is_dir else 0,
            1 if is_split_file else 0, original_name, part_index, total_parts, split_group_id,
            telegram_user_id, file_hash,
            telegram_user_id if owner_id is None else owner_id,
        ))
        await self._conn.commit()

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
        try:
            await self._conn.execute(
                "INSERT INTO linked_accounts (owner_id, telegram_user_id, label, is_primary, added_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (owner_id, telegram_user_id, label, 1 if is_primary else 0,
                 datetime.utcnow().isoformat()),
            )
        except aiosqlite.IntegrityError:
            return False  # idx_linked_unique — already claimed by a drive
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
        """How many file records (incl. trashed) still point at this account's messages."""
        if not self._conn:
            raise RuntimeError("Database not connected")
        cursor = await self._conn.execute(
            "SELECT COUNT(*) FROM files WHERE owner_id = ? AND telegram_user_id = ? AND isDir = 0",
            (owner_id, telegram_user_id),
        )
        row = await cursor.fetchone()
        return row[0] if row else 0

    async def unlink_account(self, owner_id: int, telegram_user_id: int) -> bool:
        if not self._conn:
            raise RuntimeError("Database not connected")
        cursor = await self._conn.execute(
            "DELETE FROM linked_accounts WHERE owner_id = ? AND telegram_user_id = ?",
            (owner_id, telegram_user_id),
        )
        await self._conn.commit()
        return cursor.rowcount > 0


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
