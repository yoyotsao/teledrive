import os
import hashlib
from typing import Optional, List, Dict
from datetime import datetime
from pathlib import Path
from loguru import logger

from app.models.schemas import (
    FileInfo, FileType, UploadSession, 
    UploadStatus, UploadInitRequest
)
from app.services.config import get_settings
from app.services.database import get_database, Database


class FileService:
    """Service for file operations, chunking, and metadata storage."""
    
    def __init__(self):
        settings = get_settings()
        self.chunk_size = settings.chunk_size
        self.max_file_size = settings.max_file_size
        
        # In-memory cache for upload sessions (short-lived, no need to persist)
        self._upload_sessions: Dict[str, UploadSession] = {}
        
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
            thumbnail_message_id=row['thumbnail_message_id'],
            created_at=datetime.fromisoformat(row['created_at']) if isinstance(row['created_at'], str) else row['created_at'],
            direct_url=row.get('direct_url'),
            access_hash=row.get('access_hash'),
            parent_id=row.get('parent_id'),
            isDir=bool(row['isDir']) if row.get('isDir') is not None else False
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
    
    async def init_upload(
        self, 
        request: UploadInitRequest
    ) -> tuple[str, bool]:
        """
        Initialize an upload session.
        Returns (file_id, requires_chunking).
        """
        file_id = self._generate_file_id(request.filename, request.filesize)
        
        # Check if chunking is required
        requires_chunking = request.filesize > self.chunk_size
        total_chunks = (request.filesize + self.chunk_size - 1) // self.chunk_size
        
        session = UploadSession(
            file_id=file_id,
            filename=request.filename,
            filesize=request.filesize,
            mime_type=request.mime_type,
            total_chunks=total_chunks if requires_chunking else 1,
            status=UploadStatus.PENDING
        )
        
        self._upload_sessions[file_id] = session
        
        logger.info(
            f"Upload initialized: {file_id}, "
            f"filename: {request.filename}, "
            f"size: {request.filesize}, "
            f"requires_chunking: {requires_chunking}"
        )
        
        return file_id, requires_chunking
    
    async def process_chunk(
        self,
        file_id: str,
        chunk_data: bytes,
        chunk_index: int,
        is_final: bool
    ) -> dict:
        """
        Process an uploaded chunk.
        Returns progress info.
        """
        if file_id not in self._upload_sessions:
            raise ValueError(f"Upload session not found: {file_id}")
        
        session = self._upload_sessions[file_id]
        
        # In a real implementation, you'd store chunks to disk or memory
        # and assemble them. Here we track progress.
        session.uploaded_chunks += 1
        
        if is_final:
            session.status = UploadStatus.COMPLETED
            
            # Create file metadata
            db = await self._get_db()
            file_type = self._detect_file_type(session.mime_type, session.filename)
            
            file_info = FileInfo(
                file_id=session.telegram_file_id or file_id,
                filename=session.filename,
                filesize=session.filesize,
                mime_type=session.mime_type,
                file_type=file_type,
                telegram_message_id=session.message_id,
                created_at=session.created_at,
                direct_url=None,
                access_hash=None,
                parent_id=None,
                isDir=False
            )
            
            # Store in SQLite
            await db.insert_file(
                file_id=file_info.file_id,
                filename=file_info.filename,
                filesize=file_info.filesize,
                mime_type=file_info.mime_type,
                file_type=file_info.file_type.value,
            telegram_message_id=file_info.telegram_message_id,
            thumbnail_message_id=file_info.thumbnail_message_id,
            created_at=file_info.created_at.isoformat(),
            direct_url=file_info.direct_url,
                access_hash=file_info.access_hash,
                parent_id=file_info.parent_id,
                is_dir=file_info.isDir
            )
            
            logger.info(f"Upload completed: {file_id}")
        
        return {
            "file_id": file_id,
            "chunk_index": chunk_index,
            "uploaded_chunks": session.uploaded_chunks,
            "total_chunks": session.total_chunks,
            "is_complete": is_final
        }
    
    async def register_uploaded_file(
        self,
        filename: str,
        filesize: int,
        mime_type: Optional[str],
        message_id: int,
        file_id: str,
        access_hash: Optional[str] = None,
        parent_id: Optional[str] = None,
        thumbnail_message_id: Optional[int] = None,
    ) -> FileInfo:
        """
        Register a file that was uploaded directly via MTProto.
        
        This is called by the frontend after uploading directly to Telegram.
        Only metadata is stored on the server.
        """
        db = await self._get_db()
        file_type = self._detect_file_type(mime_type, filename)
        created_at = datetime.utcnow()
        
        file_info = FileInfo(
            file_id=file_id,
            filename=filename,
            filesize=filesize,
            mime_type=mime_type,
            file_type=file_type,
            telegram_message_id=message_id,
            thumbnail_message_id=thumbnail_message_id,
            created_at=created_at,
            direct_url=None,
            access_hash=access_hash,
            parent_id=parent_id,
            isDir=False
        )
        
        session = UploadSession(
            file_id=file_id,
            filename=filename,
            filesize=filesize,
            mime_type=mime_type,
            total_chunks=1,
            uploaded_chunks=1,
            status=UploadStatus.COMPLETED,
            telegram_file_id=file_id,
            message_id=message_id,
            created_at=created_at
        )
        self._upload_sessions[file_id] = session
        
        # Store in SQLite instead of memory
        await db.insert_file(
            file_id=file_info.file_id,
            filename=file_info.filename,
            filesize=file_info.filesize,
            mime_type=file_info.mime_type,
            file_type=file_info.file_type.value,
            telegram_message_id=file_info.telegram_message_id,
                thumbnail_message_id=file_info.thumbnail_message_id,
                created_at=file_info.created_at.isoformat(),
            direct_url=file_info.direct_url,
            access_hash=file_info.access_hash,
            parent_id=file_info.parent_id,
            is_dir=file_info.isDir
        )
        
        logger.info(f"Registered MTProto upload: {filename}, file_id: {file_id}, thumbnail: {thumbnail_message_id}")
        
        return file_info
    
    async def finalize_upload(
        self,
        file_id: str,
        telegram_file_id: str,
        message_id: int
    ) -> FileInfo:
        """Finalize an upload and create file metadata."""
        db = await self._get_db()
        session = self._upload_sessions.get(file_id)
        
        if not session:
            raise ValueError(f"Upload session not found: {file_id}")
        
        session.status = UploadStatus.COMPLETED
        session.telegram_file_id = telegram_file_id
        session.message_id = message_id
        
        file_type = self._detect_file_type(session.mime_type, session.filename)
        
        file_info = FileInfo(
            file_id=telegram_file_id,
            filename=session.filename,
            filesize=session.filesize,
            mime_type=session.mime_type,
            file_type=file_type,
            telegram_message_id=message_id,
            created_at=session.created_at,
            direct_url=None,
            access_hash=None,
            parent_id=None,
            isDir=False
        )
        
        # Store in SQLite
        await db.insert_file(
            file_id=file_info.file_id,
            filename=file_info.filename,
            filesize=file_info.filesize,
            mime_type=file_info.mime_type,
            file_type=file_info.file_type.value,
            telegram_message_id=file_info.telegram_message_id,
                thumbnail_message_id=file_info.thumbnail_message_id,
                created_at=file_info.created_at.isoformat(),
            direct_url=file_info.direct_url,
            access_hash=file_info.access_hash,
            parent_id=file_info.parent_id,
            is_dir=file_info.isDir
        )
        
        # Clean up session
        del self._upload_sessions[file_id]
        
        logger.info(f"Upload finalized: {file_id}, telegram_file_id: {telegram_file_id}")
        
        return file_info
    
    async def get_file_info(self, file_id: str) -> Optional[FileInfo]:
        """Get file metadata."""
        db = await self._get_db()
        row = await db.get_file(file_id)
        if row:
            return self._row_to_file_info(row)
        return None
    
    async def list_files(
        self,
        page: int = 1,
        page_size: int = 50,
        parent_id: Optional[str] = None
    ) -> tuple[List[FileInfo], int]:
        """List all stored files (excluding folders)."""
        db = await self._get_db()
        rows, total = await db.get_files_paginated(
            page=page,
            page_size=page_size,
            parent_id=parent_id,
            is_dir=False
        )
        files = [self._row_to_file_info(row) for row in rows]
        return files, total

    async def list_folders(
        self,
        parent_id: Optional[str] = None
    ) -> List[FileInfo]:
        """List all stored folders (isDir == True). Filter by parent_id."""
        db = await self._get_db()
        rows, _ = await db.get_files_paginated(
            page=1,
            page_size=10000,  # Get all folders
            parent_id=parent_id,
            is_dir=True
        )
        folders = [self._row_to_file_info(row) for row in rows]
        return folders

    async def create_folder(self, name: str, parent_id: Optional[str] = None) -> FileInfo:
        """Create a folder entry in the database. No Telegram ops in MVP."""
        logger.info(f"create_folder called: name={name}, parent_id={parent_id}")
        db = await self._get_db()
        logger.info(f"Got database: {db.db_path}")
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
            thumbnail_message_id=folder_info.thumbnail_message_id,
            created_at=folder_info.created_at.isoformat(),
            direct_url=folder_info.direct_url,
            access_hash=folder_info.access_hash,
            parent_id=folder_info.parent_id,
            is_dir=folder_info.isDir
        )
        logger.info(f"Folder inserted: {name}, id: {file_id}")
        
        return folder_info

    async def delete_file(self, file_id: str) -> bool:
        """Delete a file from metadata."""
        db = await self._get_db()
        result = await db.delete_file(file_id)
        if result:
            logger.info(f"File deleted: {file_id}")
        return result

    async def delete_folder(self, folder_id: str) -> bool:
        """Delete a folder from metadata only if it is a directory."""
        db = await self._get_db()
        # First check if it's a folder
        row = await db.get_file(folder_id)
        if row and row.get('isDir'):
            result = await db.delete_file(folder_id)
            if result:
                logger.info(f"Folder deleted: {folder_id}")
            return result
        return False

    async def delete_all(self) -> int:
        """Delete all files and folders from metadata."""
        db = await self._get_db()
        count = await db.delete_all_files()
        logger.info(f"All files deleted: {count} items")
        return count

    async def update_file(self, file_id: str, thumbnail_message_id: Optional[int] = None, parent_id: Optional[str] = None) -> Optional[FileInfo]:
        """Update file metadata."""
        db = await self._get_db()
        logger.info(f"update_file called: file_id={file_id}, thumbnail_message_id={thumbnail_message_id}, parent_id={parent_id}")
        
        updated_row = await db.update_file(
            file_id,
            thumbnail_message_id=thumbnail_message_id,
            parent_id=parent_id
        )
        
        if not updated_row:
            logger.error(f"File not found in metadata: {file_id}")
            return None
        
        logger.info(f"File updated in database: {file_id}")
        return self._row_to_file_info(updated_row)
    
    def get_chunk_size(self) -> int:
        """Get the configured chunk size."""
        return self.chunk_size


# Singleton instance
_file_service: Optional[FileService] = None


def get_file_service() -> FileService:
    """Get or create the file service instance."""
    global _file_service
    if _file_service is None:
        _file_service = FileService()
    return _file_service
