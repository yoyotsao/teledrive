import hashlib
from typing import Optional, List, Dict
from datetime import datetime
from pathlib import Path
from loguru import logger

from app.models.schemas import FileInfo, FileType
from app.services.database import get_database, Database


class FileService:
    """SQLite metadata operations for browser-managed Telegram files."""
    
    def __init__(self):
        # Database instance for persistent file metadata
        self._db: Optional[Database] = None
        
        logger.info("File service initialized")
    
    async def _get_db(self) -> Database:
        """Get database instance."""
        if self._db is None:
            self._db = await get_database()
        return self._db
    
    def _row_to_file_info(self, row: dict) -> FileInfo:
        """Convert database row to FileInfo model."""
        return FileInfo(
            file_id=row['file_id'],
            filename=row['filename'],
            filesize=row['filesize'],
            mime_type=row['mime_type'],
            file_type=FileType(row['file_type']),
            telegram_message_id=row['telegram_message_id'],
            has_thumbnail=bool(row.get('has_thumbnail') or 0),
            created_at=datetime.fromisoformat(row['created_at']) if isinstance(row['created_at'], str) else row['created_at'],
            direct_url=row.get('direct_url'),
            access_hash=row.get('access_hash'),
            parent_id=row.get('parent_id'),
            isDir=bool(row['isDir']) if row.get('isDir') is not None else False,
            is_split_file=bool(row.get('is_split_file', 0)),
            split_group_id=row.get('split_group_id'),
            part_index=row.get('part_index'),
            file_hash=row.get('file_hash'),
            # Which linked account stores this message — the frontend picks its
            # GramJS client by this field. access_hash is only valid for that account.
            telegram_user_id=row.get('telegram_user_id') or 0,
            trashed_at=(
                datetime.fromisoformat(row['trashed_at'])
                if row.get('trashed_at') else None
            ),
        )
    
    def _detect_file_type(self, mime_type: Optional[str], filename: str) -> FileType:
        """Detect file type from mime type or extension."""
        if not mime_type:
            # Try to detect from extension
            ext = Path(filename).suffix.lower()
            mime_map = {
                '.pdf': FileType.DOCUMENT,
                '.doc': FileType.DOCUMENT,
                '.docx': FileType.DOCUMENT,
                '.txt': FileType.DOCUMENT,
                '.md': FileType.DOCUMENT,
                '.mp4': FileType.VIDEO,
                '.avi': FileType.VIDEO,
                '.mkv': FileType.VIDEO,
                '.mov': FileType.VIDEO,
                '.mp3': FileType.AUDIO,
                '.wav': FileType.AUDIO,
                '.flac': FileType.AUDIO,
                '.jpg': FileType.PHOTO,
                '.jpeg': FileType.PHOTO,
                '.png': FileType.PHOTO,
                '.gif': FileType.PHOTO,
                '.zip': FileType.ARCHIVE,
                '.rar': FileType.ARCHIVE,
                '.7z': FileType.ARCHIVE,
                '.tar': FileType.ARCHIVE,
                '.gz': FileType.ARCHIVE,
            }
            return mime_map.get(ext, FileType.OTHER)
        
        # Detect from mime type
        if mime_type.startswith('video/'):
            return FileType.VIDEO
        elif mime_type.startswith('audio/'):
            return FileType.AUDIO
        elif mime_type.startswith('image/'):
            return FileType.PHOTO
        elif mime_type in ['application/pdf', 'application/msword',
                           'application/vnd.openxmlformats-officedocument.wordprocessingml.document']:
            return FileType.DOCUMENT
        elif mime_type in ['application/zip', 'application/x-zip-compressed',
                          'application/x-rar-compressed', 'application/x-tar',
                          'application/gzip']:
            return FileType.ARCHIVE
        else:
            return FileType.OTHER
    
    def _generate_file_id(self, filename: str, filesize: int) -> str:
        """Generate a unique file ID."""
        unique_str = f"{filename}:{filesize}:{datetime.utcnow().timestamp()}"
        return hashlib.sha256(unique_str.encode()).hexdigest()[:16]
    
    async def register_uploaded_file(
        self,
        filename: str,
        filesize: int,
        mime_type: Optional[str],
        message_id: int,
        file_id: str,
        access_hash: Optional[str] = None,
        parent_id: Optional[str] = None,
        has_thumbnail: bool = False,
        is_split_file: bool = False,
        original_name: Optional[str] = None,
        part_index: Optional[int] = None,
        total_parts: Optional[int] = None,
        split_group_id: Optional[str] = None,
        telegram_user_id: int = 0,
        file_hash: Optional[str] = None,
        owner_id: int = 0,
    ) -> FileInfo:
        """
        Register a file that was uploaded directly via MTProto.
        
        This is called by the frontend after uploading directly to Telegram.
        Only metadata is stored on the server.
        """
        db = await self._get_db()
        file_type = self._detect_file_type(mime_type, filename)
        created_at = datetime.utcnow()

        if parent_id:
            parent = await db.get_file(parent_id, owner_id=owner_id)
            if not parent or not parent.get("isDir") or parent.get("trashed_at"):
                raise ValueError("Parent folder not found")

        # Replace any live file with the same name+parent — split uploads included.
        # Split files used to be skipped here, which is how one folder accumulated the
        # same multi-GB video five or six times: every re-upload appended a whole new
        # part group instead of replacing the old one. The incoming group is excluded so
        # sibling parts don't delete each other, and only the first part runs the sweep
        # (one query per upload instead of one per part; the result is the same either way).
        # find_files_by_name_and_parent excludes trashed rows, so a same-named file sitting
        # in the trash is left alone here and stays restorable.
        if part_index in (None, 0):
            stale = await db.find_files_by_name_and_parent(
                filename,
                parent_id,
                owner_id=owner_id,
                exclude_split_group_id=split_group_id,
            )
            if stale:
                old_groups = sorted({r.get('split_group_id') or r['file_id'] for r in stale})
                logger.info(
                    f"Replacing existing file: {filename}, {len(stale)} row(s) "
                    f"in {len(old_groups)} group(s): {old_groups}"
                )
                await db.delete_files_by_ids(
                    [r['file_id'] for r in stale], owner_id=owner_id
                )

        file_info = FileInfo(
            file_id=file_id,
            filename=filename,
            filesize=filesize,
            mime_type=mime_type,
            file_type=file_type,
            telegram_message_id=message_id,
            has_thumbnail=has_thumbnail,
            created_at=created_at,
            direct_url=None,
            access_hash=access_hash,
            parent_id=parent_id,
            isDir=False
        )

        # Store in SQLite instead of memory
        await db.insert_file(
            file_id=file_info.file_id,
            filename=file_info.filename,
            filesize=file_info.filesize,
            mime_type=file_info.mime_type,
            file_type=file_info.file_type.value,
            telegram_message_id=file_info.telegram_message_id,
            has_thumbnail=file_info.has_thumbnail,
            created_at=file_info.created_at.isoformat(),
            direct_url=file_info.direct_url,
            access_hash=file_info.access_hash,
            parent_id=file_info.parent_id,
            is_dir=file_info.isDir,
            is_split_file=is_split_file,
            original_name=original_name,
            part_index=part_index,
            total_parts=total_parts,
            split_group_id=split_group_id,
            telegram_user_id=telegram_user_id,
            file_hash=file_hash,
            owner_id=owner_id,
        )

        logger.info(
            f"Registered MTProto upload: {filename}, file_id: {file_id}, "
            f"has_thumbnail: {has_thumbnail}, stored on account {telegram_user_id}"
        )
        
        return file_info
    
    async def get_file_info(self, file_id: str, owner_id: Optional[int] = None) -> Optional[FileInfo]:
        """Get file metadata, optionally scoped to a drive."""
        db = await self._get_db()
        row = await db.get_file(file_id, owner_id=owner_id)
        if row:
            return self._row_to_file_info(row)
        return None
    
    async def list_files(
        self,
        page: int = 1,
        page_size: int = 50,
        parent_id: Optional[str] = None,
        split_group_id: Optional[str] = None,
        owner_id: int = 0,
        sort_by: str = "date",
        sort_order: str = "desc",
        search: Optional[str] = None,
        trashed: bool = False,
    ) -> tuple[List[FileInfo], int]:
        """List stored files. Search mode spans the drive and includes folders; trashed=True lists the trash."""
        db = await self._get_db()
        rows, total = await db.get_files_paginated(
            page=page,
            page_size=page_size,
            parent_id=parent_id,
            is_dir=False,
            split_group_id=split_group_id,
            owner_id=owner_id,
            sort_by=sort_by,
            sort_order=sort_order,
            search=search,
            trashed=trashed,
        )
        files = [self._row_to_file_info(row) for row in rows]
        # Sort by part_index if filtering by split_group_id
        if split_group_id is not None:
            files.sort(key=lambda f: getattr(f, 'part_index', 0) or 0)
        return files, total

    async def find_by_hash(self, file_hash: str, owner_id: int) -> List[FileInfo]:
        """Return all file records matching this SHA-256 hash in the drive."""
        db = await self._get_db()
        rows = await db.find_by_hash(file_hash, owner_id)
        return [self._row_to_file_info(r) for r in rows]

    async def find_by_hashes(self, hashes: List[str], owner_id: int) -> Dict[str, List[FileInfo]]:
        """Return file records for multiple SHA-256 hashes at once, grouped by hash."""
        db = await self._get_db()
        rows_by_hash = await db.find_by_hashes(hashes, owner_id)
        return {
            file_hash: [self._row_to_file_info(r) for r in rows]
            for file_hash, rows in rows_by_hash.items()
        }

    async def list_folders(
        self,
        parent_id: Optional[str] = None,
        owner_id: int = 0,
        sort_by: str = "date",
        sort_order: str = "desc",
    ) -> List[FileInfo]:
        """List all stored folders (isDir == True). Filter by parent_id."""
        db = await self._get_db()
        rows, _ = await db.get_files_paginated(
            page=1,
            page_size=10000,
            parent_id=parent_id,
            is_dir=True,
            owner_id=owner_id,
            sort_by=sort_by,
            sort_order=sort_order,
        )
        folders = [self._row_to_file_info(row) for row in rows]
        return folders

    async def create_folder(self, name: str, parent_id: Optional[str] = None, owner_id: int = 0) -> FileInfo:
        """Create a folder entry in the database, reusing existing record if same name+parent already exists."""
        logger.info(f"create_folder called: name={name}, parent_id={parent_id}")
        db = await self._get_db()
        if parent_id:
            parent = await db.get_file(parent_id, owner_id=owner_id)
            if not parent or not parent.get("isDir") or parent.get("trashed_at"):
                raise ValueError("Parent folder not found")

        existing = await db.find_folder_by_name_and_parent(name, parent_id, owner_id=owner_id)
        if existing:
            logger.info(f"Folder already exists, reusing: {existing['file_id']}")
            return self._row_to_file_info(existing)
        file_id = self._generate_file_id(name, 0)
        created_at = datetime.utcnow()
        
        folder_info = FileInfo(
            file_id=file_id,
            filename=name,
            filesize=0,
            mime_type=None,
            file_type=FileType.OTHER,
            telegram_message_id=None,
            created_at=created_at,
            direct_url=None,
            access_hash=None,
            parent_id=parent_id,
            isDir=True,
        )
        
        # Store in SQLite
        logger.info(f"Inserting folder into database: {folder_info.file_id}")
        await db.insert_file(
            file_id=folder_info.file_id,
            filename=folder_info.filename,
            filesize=folder_info.filesize,
            mime_type=folder_info.mime_type,
            file_type=folder_info.file_type.value,
            telegram_message_id=folder_info.telegram_message_id,
            has_thumbnail=folder_info.has_thumbnail,
            created_at=folder_info.created_at.isoformat(),
            direct_url=folder_info.direct_url,
            access_hash=folder_info.access_hash,
            parent_id=folder_info.parent_id,
            is_dir=folder_info.isDir,
            # A folder is metadata only — no Telegram message, so no storage account.
            telegram_user_id=0,
            owner_id=owner_id,
        )
        logger.info(f"Folder inserted: {name}, id: {file_id}")
        
        return folder_info

    async def _collect_subtree_rows(self, root_id: str, owner_id: int) -> List[dict]:
        """Root row + all descendants, with every split part expanded in."""
        db = await self._get_db()
        rows = await db.get_subtree(root_id, owner_id)
        seen = {r['file_id'] for r in rows}
        group_ids = {r.get('split_group_id') for r in rows if r.get('split_group_id')}
        for gid in group_ids:
            for part in await db.get_files_by_split_group(gid, owner_id=owner_id):
                if part['file_id'] not in seen:
                    seen.add(part['file_id'])
                    rows.append(part)
        return rows

    async def trash_file(self, file_id: str, owner_id: int) -> int:
        """Soft-delete an item and its whole subtree. Telegram messages untouched (restore is free)."""
        db = await self._get_db()
        rows = await self._collect_subtree_rows(file_id, owner_id)
        ids = [r['file_id'] for r in rows]
        await db.set_trashed(ids, datetime.utcnow().isoformat(), owner_id)
        logger.info(f"Trashed {len(ids)} item(s) under {file_id}")
        return len(ids)

    async def restore_file(self, file_id: str, owner_id: int) -> Optional[FileInfo]:
        """Restore a trashed subtree. If the original parent is gone/trashed, restore to the drive root."""
        db = await self._get_db()
        row = await db.get_file(file_id, owner_id=owner_id)
        if not row:
            return None
        if not row.get('trashed_at'):
            raise ValueError("Item is not in the trash")

        rows = await self._collect_subtree_rows(file_id, owner_id)
        await db.set_trashed([r['file_id'] for r in rows], None, owner_id)

        parent_id = row.get('parent_id')
        if parent_id:
            parent = await db.get_file(parent_id, owner_id=owner_id)
            if not parent or parent.get('trashed_at'):
                await db.update_file(
                    file_id, owner_id, parent_id=None, set_parent_id=True
                )

        restored = await db.get_file(file_id, owner_id=owner_id)
        logger.info(f"Restored {len(rows)} item(s) under {file_id}")
        return self._row_to_file_info(restored)

    async def purge_file(self, file_id: str, owner_id: int) -> int:
        """Permanently delete a subtree's metadata for one drive.

        Telegram messages are deliberately retained.  Returning message IDs
        would invite callers to reintroduce a Telegram deletion side effect,
        so this boundary returns only the number of metadata rows removed.
        """
        db = await self._get_db()
        rows = await self._collect_subtree_rows(file_id, owner_id)
        ids = [r['file_id'] for r in rows]
        deleted = await db.delete_files_by_ids(ids, owner_id)
        logger.info(f"Purged {deleted} metadata record(s) under {file_id}; Telegram messages retained")
        return deleted

    async def delete_all(self, owner_id: int) -> int:
        """Delete every metadata row in one drive."""
        db = await self._get_db()
        count = await db.delete_user_files(owner_id)
        logger.info(f"Deleted {count} metadata record(s); Telegram messages retained")
        return count

    async def update_file(self, file_id: str, owner_id: int, parent_id: Optional[str] = None, set_parent_id: bool = False, filename: Optional[str] = None) -> Optional[FileInfo]:
        """Update file metadata."""
        db = await self._get_db()
        logger.info(f"update_file called: file_id={file_id}, parent_id={parent_id}, set_parent_id={set_parent_id}, filename={filename}")

        current = await db.get_file(file_id, owner_id=owner_id)
        if not current:
            return None
        if set_parent_id and parent_id is not None:
            parent = await db.get_file(parent_id, owner_id=owner_id)
            if not parent or not parent.get("isDir") or parent.get("trashed_at"):
                raise ValueError("Parent folder not found")
            if parent_id == file_id:
                raise ValueError("An item cannot be its own parent")
            if current.get("isDir"):
                descendants = await db.get_subtree(file_id, owner_id)
                if parent_id in {row["file_id"] for row in descendants}:
                    raise ValueError("A folder cannot be moved into its descendant")

        updated_row = await db.update_file(
            file_id,
            owner_id,
            parent_id=parent_id,
            set_parent_id=set_parent_id,
            filename=filename,
        )
        
        if not updated_row:
            logger.error(f"File not found in metadata: {file_id}")
            return None
        
        logger.info(f"File updated in database: {file_id}")
        return self._row_to_file_info(updated_row)
    
# Singleton instance
_file_service: Optional[FileService] = None


def get_file_service() -> FileService:
    """Get or create the file service instance."""
    global _file_service
    if _file_service is None:
        _file_service = FileService()
    return _file_service
