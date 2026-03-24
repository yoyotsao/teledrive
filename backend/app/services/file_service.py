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


class FileService:
    """Service for file operations, chunking, and metadata storage."""
    
    def __init__(self):
        settings = get_settings()
        self.chunk_size = settings.chunk_size
        self.max_file_size = settings.max_file_size
        
        # In-memory storage for upload sessions and file metadata
        # In production, use a database (PostgreSQL, MongoDB, etc.)
        self._upload_sessions: Dict[str, UploadSession] = {}
        self._files_metadata: Dict[str, FileInfo] = {}
        
        logger.info("File service initialized")
    
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
            
            self._files_metadata[file_info.file_id] = file_info
            
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
        file_type = self._detect_file_type(mime_type, filename)
        
        file_info = FileInfo(
            file_id=file_id,
            filename=filename,
            filesize=filesize,
            mime_type=mime_type,
            file_type=file_type,
            telegram_message_id=message_id,
            thumbnail_message_id=thumbnail_message_id,
            created_at=datetime.utcnow(),
            direct_url=None,
            access_hash=None,
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
            created_at=datetime.utcnow()
        )
        self._upload_sessions[file_id] = session
        self._files_metadata[file_id] = file_info
        
        logger.info(f"Registered MTProto upload: {filename}, file_id: {file_id}, thumbnail: {thumbnail_message_id}")
        
        return file_info
    
    async def finalize_upload(
        self,
        file_id: str,
        telegram_file_id: str,
        message_id: int
    ) -> FileInfo:
        """Finalize an upload and create file metadata."""
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
        
        self._files_metadata[telegram_file_id] = file_info
        
        # Clean up session
        del self._upload_sessions[file_id]
        
        logger.info(f"Upload finalized: {file_id}, telegram_file_id: {telegram_file_id}")
        
        return file_info
    
    async def get_file_info(self, file_id: str) -> Optional[FileInfo]:
        """Get file metadata."""
        return self._files_metadata.get(file_id)
    
    async def list_files(
        self,
        page: int = 1,
        page_size: int = 50,
        parent_id: Optional[str] = None
    ) -> tuple[List[FileInfo], int]:
        """List all stored files (excluding folders)."""
        files = list(self._files_metadata.values())
        # Only return actual files, not folders
        files = [f for f in files if getattr(f, 'isDir', False) == False]
        # If a parent_id is provided, filter to that folder
        if parent_id is not None:
            files = [f for f in files if getattr(f, 'parent_id', None) == parent_id]
        total = len(files)
        
        # Sort by creation date, newest first
        files.sort(key=lambda f: f.created_at, reverse=True)
        
        # Paginate
        start = (page - 1) * page_size
        end = start + page_size
        paginated_files = files[start:end]
        
        return paginated_files, total

    async def list_folders(
        self,
        parent_id: Optional[str] = None
    ) -> List[FileInfo]:
        """List all stored folders (isDir == True). Optional parent_id filter."""
        entries = list(self._files_metadata.values())
        # Filter to folders
        folders = [f for f in entries if getattr(f, "isDir", False)]
        if parent_id is not None:
            folders = [f for f in folders if getattr(f, "parent_id", None) == parent_id]
        # Sort by creation date, newest first for consistency with list_files
        folders.sort(key=lambda f: f.created_at, reverse=True)
        return folders
    def create_folder(self, name: str, parent_id: Optional[str] = None) -> FileInfo:
        """Create an in-memory folder entry. No Telegram ops in MVP."""
        file_id = self._generate_file_id(name, 0)
        folder_info = FileInfo(
            file_id=file_id,
            filename=name,
            filesize=0,
            mime_type=None,
            file_type=FileType.OTHER,
            telegram_message_id=None,
            created_at=datetime.utcnow(),
            direct_url=None,
            access_hash=None,
            parent_id=parent_id,
            isDir=True,
        )
        self._files_metadata[file_id] = folder_info
        logger.info(f"Folder created: {name}, id: {file_id}")
        return folder_info

    async def delete_file(self, file_id: str) -> bool:
        """Delete a file from metadata."""
        if file_id in self._files_metadata:
            del self._files_metadata[file_id]
            logger.info(f"File deleted: {file_id}")
            return True
        return False

    async def delete_folder(self, folder_id: str) -> bool:
        """Delete a folder from metadata only if it is a directory."""
        info = self._files_metadata.get(folder_id)
        if info and getattr(info, "isDir", False):
            del self._files_metadata[folder_id]
            logger.info(f"Folder deleted: {folder_id}")
            return True
        return False

    async def update_file(self, file_id: str, thumbnail_message_id: Optional[int] = None, thumbnail_data: Optional[str] = None) -> Optional[FileInfo]:
        """Update file metadata."""
        logger.info(f"update_file called: file_id={file_id}, thumbnail_message_id={thumbnail_message_id}, thumbnail_data_len={len(thumbnail_data) if thumbnail_data else 0}")
        file_info = self._files_metadata.get(file_id)
        if not file_info:
            logger.error(f"File not found in metadata: {file_id}")
            return None
        
        if thumbnail_message_id is not None:
            file_info.thumbnail_message_id = thumbnail_message_id
            logger.info(f"File updated: {file_id}, thumbnail_message_id: {thumbnail_message_id}")
        
        if thumbnail_data is not None:
            file_info.thumbnail_data = thumbnail_data
            logger.info(f"File updated: {file_id}, thumbnail_data length: {len(thumbnail_data)}")
        
        self._files_metadata[file_id] = file_info
        logger.info(f"File stored in metadata: {file_id}, thumbnail_data present: {file_info.thumbnail_data is not None}")
        return file_info
    
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
