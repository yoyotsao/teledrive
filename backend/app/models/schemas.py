from datetime import datetime
from enum import Enum
from typing import Optional, List
from pydantic import BaseModel, Field


class FileType(str, Enum):
    DOCUMENT = "document"
    VIDEO = "video"
    AUDIO = "audio"
    PHOTO = "photo"
    ARCHIVE = "archive"
    OTHER = "other"


class UploadStatus(str, Enum):
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    FAILED = "failed"


# Request models
class UploadInitRequest(BaseModel):
    filename: str = Field(..., description="Original filename")
    filesize: int = Field(..., gt=0, description="File size in bytes")
    mime_type: Optional[str] = Field(None, description="MIME type of the file")


class ChunkUploadRequest(BaseModel):
    file_id: str = Field(..., description="Unique identifier for the file upload")
    chunk_index: int = Field(..., ge=0, description="Index of the chunk")
    total_chunks: int = Field(..., gt=0, description="Total number of chunks")
    is_final: bool = Field(False, description="Whether this is the final chunk")


class DeleteRequest(BaseModel):
    file_id: str = Field(..., description="Telegram file_id to delete")


# Response models
class FileInfo(BaseModel):
    file_id: str = Field(..., description="Telegram file_id")
    filename: str = Field(..., description="Original filename")
    filesize: int = Field(..., description="File size in bytes")
    mime_type: Optional[str] = Field(None, description="MIME type")
    file_type: FileType = Field(..., description="Categorized file type")
    telegram_message_id: Optional[int] = Field(None, description="Message ID in Telegram")
    thumbnail_message_id: Optional[int] = Field(default=None, description="Message ID for thumbnail in Telegram")
    thumbnail_data: Optional[str] = Field(default=None, description="Base64 encoded thumbnail data")
    created_at: datetime = Field(default_factory=datetime.utcnow, description="Upload timestamp")
    direct_url: Optional[str] = Field(None, description="Direct CDN URL (if available)")
    access_hash: Optional[str] = Field(None, description="File access hash for MTProto download")
    parent_id: Optional[str] = Field(None, description="Parent folder ID, if any")
    isDir: bool = Field(False, description="Is this item a directory?")


class UploadInitResponse(BaseModel):
    file_id: str = Field(..., description="Unique identifier for the file upload")
    upload_url: str = Field(..., description="URL to upload chunks to")
    chunk_size: int = Field(..., description="Recommended chunk size in bytes")
    requires_chunking: bool = Field(..., description="Whether file requires chunked upload")


class ChunkUploadResponse(BaseModel):
    file_id: str = Field(..., description="Unique identifier for the file upload")
    chunk_index: int = Field(..., description="Index of the uploaded chunk")
    bytes_uploaded: int = Field(..., description="Total bytes uploaded so far")
    is_complete: bool = Field(..., description="Whether upload is complete")
    file_info: Optional[FileInfo] = Field(None, description="File info when complete")


class DownloadResponse(BaseModel):
    file_id: str = Field(..., description="Telegram file_id")
    filename: str = Field(..., description="Original filename")
    filesize: int = Field(..., description="File size in bytes")
    mime_type: Optional[str] = Field(None, description="MIME type")
    direct_url: str = Field(..., description="Direct download URL from Telegram CDN")


class GatekeeperResponse(BaseModel):
    file_id: str = Field(..., description="Telegram file_id")
    filename: str = Field(..., description="Original filename")
    direct_url: str = Field(..., description="Redirect URL for direct download")
    expires_at: datetime = Field(..., description="URL expiration time")


class FileListResponse(BaseModel):
    files: List[FileInfo] = Field(default_factory=list, description="List of files")
    total: int = Field(..., description="Total number of files")
    page: int = Field(1, description="Current page")
    page_size: int = Field(50, description="Items per page")


class ErrorResponse(BaseModel):
    error: str = Field(..., description="Error message")
    detail: Optional[str] = Field(None, description="Detailed error information")
    code: Optional[str] = Field(None, description="Error code")


# Internal models for service layer
class UploadSession(BaseModel):
    file_id: str
    filename: str
    filesize: int
    mime_type: Optional[str]
    total_chunks: int
    uploaded_chunks: int = 0
    status: UploadStatus = UploadStatus.PENDING
    telegram_file_id: Optional[str] = None
    message_id: Optional[int] = None
    created_at: datetime = Field(default_factory=datetime.utcnow)
