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
                thumbnail_message_id INTEGER,
                created_at TEXT NOT NULL,
                direct_url TEXT,
                access_hash TEXT,
                parent_id TEXT,
                isDir INTEGER NOT NULL DEFAULT 0
            )
        """)
        
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
        thumbnail_message_id: Optional[int],
        created_at: str,
        direct_url: Optional[str],
        access_hash: Optional[str],
        parent_id: Optional[str],
        is_dir: bool
    ) -> None:
        """Insert a new file record."""
        if not self._conn:
            raise RuntimeError("Database not connected")
        
        await self._conn.execute("""
            INSERT OR REPLACE INTO files (
                file_id, filename, filesize, mime_type, file_type,
                telegram_message_id, thumbnail_message_id,
                created_at, direct_url, access_hash, parent_id, isDir
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            file_id, filename, filesize, mime_type, file_type,
            telegram_message_id, thumbnail_message_id,
            created_at, direct_url, access_hash, parent_id, 1 if is_dir else 0
        ))
        await self._conn.commit()
    
    async def get_file(self, file_id: str) -> Optional[dict]:
        """Get a file by ID."""
        if not self._conn:
            raise RuntimeError("Database not connected")
        
        cursor = await self._conn.execute(
            "SELECT * FROM files WHERE file_id = ?", (file_id,)
        )
        row = await cursor.fetchone()
        
        if row:
            return dict(row)
        return None
    
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
        is_dir: bool = False
    ) -> Tuple[List[dict], int]:
        """Get files with pagination, filtered by parent_id and isDir."""
        if not self._conn:
            raise RuntimeError("Database not connected")
        
        # Build query
        where_clauses = ["isDir = ?"]
        params = [1 if is_dir else 0]
        
        if parent_id is None:
            where_clauses.append("parent_id IS NULL")
        else:
            where_clauses.append("parent_id = ?")
            params.append(parent_id)
        
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
        thumbnail_message_id: Optional[int] = None,
        parent_id: Optional[str] = None
    ) -> Optional[dict]:
        """Update file metadata."""
        if not self._conn:
            raise RuntimeError("Database not connected")
        
        updates = []
        params = []
        
        if thumbnail_message_id is not None:
            updates.append("thumbnail_message_id = ?")
            params.append(thumbnail_message_id)
        
        if parent_id is not None:
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
