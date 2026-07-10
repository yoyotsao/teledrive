"""
SQLite database module for persistent file metadata storage.
"""

import aiosqlite
import json
from datetime import datetime
from typing import Optional, List, Tuple
from pathlib import Path
from loguru import logger

# Database path (stored in backend folder)
DB_PATH = Path(__file__).parent.parent.parent / "teledrive.db"


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

        try:
            await self._conn.execute("ALTER TABLE files ADD COLUMN file_hash TEXT")
        except aiosqlite.OperationalError:
            pass

        # Indexes for the query patterns in get_files_paginated / find_by_hash /
        # find_file_by_name_and_parent (avoids full table scans as row count grows)
        await self._conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_files_user_parent ON files(telegram_user_id, isDir, parent_id)"
        )
        # find_by_hash/find_by_hashes always filter by (file_hash, telegram_user_id) together
        await self._conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_files_hash ON files(file_hash, telegram_user_id)"
        )
        await self._conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_files_split_group ON files(split_group_id)"
        )

        # Upload sessions table
        await self._conn.execute("""
            CREATE TABLE IF NOT EXISTS upload_sessions (
                file_id TEXT PRIMARY KEY,
                filename TEXT NOT NULL,
                filesize INTEGER NOT NULL,
                mime_type TEXT,
                total_chunks INTEGER NOT NULL,
                uploaded_chunks INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL,
                telegram_file_id TEXT,
                message_id INTEGER,
                created_at TEXT NOT NULL
            )
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
    ) -> None:
        """Insert a new file record."""
        if not self._conn:
            raise RuntimeError("Database not connected")

        await self._conn.execute("""
            INSERT OR REPLACE INTO files (
                file_id, filename, filesize, mime_type, file_type,
                telegram_message_id, has_thumbnail,
                created_at, direct_url, access_hash, parent_id, isDir,
                is_split_file, original_name, part_index, total_parts, split_group_id,
                telegram_user_id, file_hash
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            file_id, filename, filesize, mime_type, file_type,
            telegram_message_id, 1 if has_thumbnail else 0,
            created_at, direct_url, access_hash, parent_id, 1 if is_dir else 0,
            1 if is_split_file else 0, original_name, part_index, total_parts, split_group_id,
            telegram_user_id, file_hash,
        ))
        await self._conn.commit()

    async def find_by_hash(self, file_hash: str, telegram_user_id: int) -> List[dict]:
        """Find all file records with the given SHA-256 hash for this user."""
        if not self._conn:
            raise RuntimeError("Database not connected")
        cursor = await self._conn.execute(
            "SELECT * FROM files WHERE file_hash = ? AND telegram_user_id = ? AND isDir = 0 ORDER BY part_index ASC",
            (file_hash, telegram_user_id),
        )
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]

    async def find_by_hashes(self, hashes: List[str], telegram_user_id: int) -> dict[str, List[dict]]:
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
                f"AND telegram_user_id = ? AND isDir = 0 ORDER BY file_hash, part_index ASC",
                (*chunk, telegram_user_id),
            )
            rows = await cursor.fetchall()
            for row in rows:
                d = dict(row)
                result.setdefault(d["file_hash"], []).append(d)
        return result
    
    async def get_file(self, file_id: str, telegram_user_id: Optional[int] = None) -> Optional[dict]:
        """Get a file by ID, optionally filtered by telegram_user_id."""
        if not self._conn:
            raise RuntimeError("Database not connected")

        if telegram_user_id is not None:
            cursor = await self._conn.execute(
                "SELECT * FROM files WHERE file_id = ? AND telegram_user_id = ?",
                (file_id, telegram_user_id)
            )
        else:
            cursor = await self._conn.execute(
                "SELECT * FROM files WHERE file_id = ?", (file_id,)
            )
        row = await cursor.fetchone()

        if row:
            return dict(row)
        return None
    
    async def find_file_by_name_and_parent(self, filename: str, parent_id: Optional[str], telegram_user_id: int = 0) -> Optional[dict]:
        """Find a non-directory file by filename and parent_id (for replace-on-duplicate logic)."""
        if not self._conn:
            raise RuntimeError("Database not connected")
        if parent_id is None:
            cursor = await self._conn.execute(
                "SELECT * FROM files WHERE filename = ? AND parent_id IS NULL AND isDir = 0 AND telegram_user_id = ? LIMIT 1",
                (filename, telegram_user_id)
            )
        else:
            cursor = await self._conn.execute(
                "SELECT * FROM files WHERE filename = ? AND parent_id = ? AND isDir = 0 AND telegram_user_id = ? LIMIT 1",
                (filename, parent_id, telegram_user_id)
            )
        row = await cursor.fetchone()
        return dict(row) if row else None

    async def find_folder_by_name_and_parent(self, name: str, parent_id: Optional[str], telegram_user_id: int = 0) -> Optional[dict]:
        """Find a folder by name and parent_id (for reuse-on-duplicate logic)."""
        if not self._conn:
            raise RuntimeError("Database not connected")
        if parent_id is None:
            cursor = await self._conn.execute(
                "SELECT * FROM files WHERE filename = ? AND parent_id IS NULL AND isDir = 1 AND telegram_user_id = ? LIMIT 1",
                (name, telegram_user_id)
            )
        else:
            cursor = await self._conn.execute(
                "SELECT * FROM files WHERE filename = ? AND parent_id = ? AND isDir = 1 AND telegram_user_id = ? LIMIT 1",
                (name, parent_id, telegram_user_id)
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
        telegram_user_id: int = 0
    ) -> Tuple[List[dict], int]:
        """Get files with pagination, filtered by parent_id, isDir, split_group_id, and telegram_user_id."""
        if not self._conn:
            raise RuntimeError("Database not connected")

        # Build query
        where_clauses = ["isDir = ?", "telegram_user_id = ?"]
        params: list = [1 if is_dir else 0, telegram_user_id]

        if split_group_id is None:
            if parent_id is None:
                where_clauses.append("parent_id IS NULL")
            else:
                where_clauses.append("parent_id = ?")
                params.append(parent_id)

        if split_group_id is not None:
            where_clauses.append("split_group_id = ?")
            params.append(split_group_id)
        else:
            # Only show the primary part (part_index=0 or non-split) so multi-part files appear once
            where_clauses.append("(is_split_file = 0 OR part_index = 0 OR part_index IS NULL)")

        where_sql = " AND ".join(where_clauses)
        
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
            f"SELECT * FROM files WHERE {where_sql} ORDER BY created_at DESC LIMIT ? OFFSET ?",
            params + [page_size, offset]
        )
        rows = await cursor.fetchall()
        
        return [dict(row) for row in rows], total
    
    async def update_file(
        self,
        file_id: str,
        parent_id: Optional[str] = None,
        set_parent_id: bool = False
    ) -> Optional[dict]:
        """Update file metadata."""
        if not self._conn:
            raise RuntimeError("Database not connected")

        updates = []
        params = []

        if set_parent_id:
            updates.append("parent_id = ?")
            params.append(parent_id)
        
        if not updates:
            return await self.get_file(file_id)
        
        params.append(file_id)
        
        await self._conn.execute(
            f"UPDATE files SET {', '.join(updates)} WHERE file_id = ?",
            params
        )
        await self._conn.commit()
        
        return await self.get_file(file_id)
    
    async def delete_file(self, file_id: str) -> bool:
        """Delete a file."""
        if not self._conn:
            raise RuntimeError("Database not connected")
        
        cursor = await self._conn.execute(
            "DELETE FROM files WHERE file_id = ?", (file_id,)
        )
        await self._conn.commit()
        return cursor.rowcount > 0
    
    async def delete_all_files(self) -> int:
        """Delete all files."""
        if not self._conn:
            raise RuntimeError("Database not connected")

        cursor = await self._conn.execute("SELECT COUNT(*) FROM files")
        row = await cursor.fetchone()
        count = row[0] if row else 0

        await self._conn.execute("DELETE FROM files")
        await self._conn.commit()
        return count

    async def delete_user_files(self, telegram_user_id: int) -> int:
        """Delete all files belonging to a specific user."""
        if not self._conn:
            raise RuntimeError("Database not connected")
        cursor = await self._conn.execute(
            "SELECT COUNT(*) FROM files WHERE telegram_user_id = ?", (telegram_user_id,)
        )
        row = await cursor.fetchone()
        count = row[0] if row else 0
        await self._conn.execute("DELETE FROM files WHERE telegram_user_id = ?", (telegram_user_id,))
        await self._conn.commit()
        return count
    
    # ==================== Upload Session Operations ====================
    
    async def upsert_upload_session(
        self,
        file_id: str,
        filename: str,
        filesize: int,
        mime_type: Optional[str],
        total_chunks: int,
        uploaded_chunks: int,
        status: str,
        telegram_file_id: Optional[str],
        message_id: Optional[int],
        created_at: str
    ) -> None:
        """Insert or update an upload session."""
        if not self._conn:
            raise RuntimeError("Database not connected")
        
        await self._conn.execute("""
            INSERT OR REPLACE INTO upload_sessions (
                file_id, filename, filesize, mime_type, total_chunks,
                uploaded_chunks, status, telegram_file_id, message_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            file_id, filename, filesize, mime_type, total_chunks,
            uploaded_chunks, status, telegram_file_id, message_id, created_at
        ))
        await self._conn.commit()
    
    async def get_upload_session(self, file_id: str) -> Optional[dict]:
        """Get an upload session by file_id."""
        if not self._conn:
            raise RuntimeError("Database not connected")
        
        cursor = await self._conn.execute(
            "SELECT * FROM upload_sessions WHERE file_id = ?", (file_id,)
        )
        row = await cursor.fetchone()
        
        if row:
            return dict(row)
        return None
    
    async def delete_upload_session(self, file_id: str) -> bool:
        """Delete an upload session."""
        if not self._conn:
            raise RuntimeError("Database not connected")
        
        cursor = await self._conn.execute(
            "DELETE FROM upload_sessions WHERE file_id = ?", (file_id,)
        )
        await self._conn.commit()
        return cursor.rowcount > 0
    
    async def get_subtree(self, root_id: str) -> List[dict]:
        """Get a file/folder row and every descendant underneath it (recursive)."""
        if not self._conn:
            raise RuntimeError("Database not connected")

        cursor = await self._conn.execute("""
            WITH RECURSIVE subtree(file_id) AS (
                SELECT file_id FROM files WHERE file_id = ?
                UNION
                SELECT f.file_id FROM files f JOIN subtree s ON f.parent_id = s.file_id
            )
            SELECT * FROM files WHERE file_id IN (SELECT file_id FROM subtree)
        """, (root_id,))
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]

    async def delete_files_by_ids(self, file_ids: List[str]) -> int:
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
                f"DELETE FROM files WHERE file_id IN ({placeholders})", batch
            )
            deleted += cursor.rowcount
        await self._conn.commit()
        return deleted

    async def get_files_by_split_group(self, split_group_id: str, telegram_user_id: int = 0) -> List[dict]:
        """Get all files belonging to a split group, sorted by part_index."""
        if not self._conn:
            raise RuntimeError("Database not connected")

        cursor = await self._conn.execute(
            "SELECT * FROM files WHERE split_group_id = ? AND telegram_user_id = ? ORDER BY part_index ASC",
            (split_group_id, telegram_user_id)
        )
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]


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
