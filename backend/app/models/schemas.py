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


# Response models
class FileInfo(BaseModel):
    file_id: str = Field(..., description="Telegram file_id")
    filename: str = Field(..., description="Original filename")
    filesize: int = Field(..., description="File size in bytes")
    mime_type: Optional[str] = Field(None, description="MIME type")
    file_type: FileType = Field(..., description="Categorized file type")
    telegram_message_id: Optional[int] = Field(None, description="Message ID in Telegram")
    has_thumbnail: bool = Field(default=False, description="Whether a thumbnail is embedded in the file's own Telegram message")
    created_at: datetime = Field(default_factory=datetime.utcnow, description="Upload timestamp")
    direct_url: Optional[str] = Field(None, description="Direct CDN URL (if available)")
    access_hash: Optional[str] = Field(None, description="File access hash for MTProto download")
    parent_id: Optional[str] = Field(None, description="Parent folder ID, if any")
    isDir: bool = Field(False, description="Is this item a directory?")
    is_split_file: bool = Field(False, description="Whether this file is part of a split upload")
    split_group_id: Optional[str] = Field(None, description="Group ID shared by all parts of a split file")
    part_index: Optional[int] = Field(None, description="Zero-based index of this part within the split group")
    file_hash: Optional[str] = Field(None, description="SHA-256 hash of the original file for deduplication")
    telegram_user_id: int = Field(0, description="Linked account whose Saved Messages holds this message; picks the download client")
    trashed_at: Optional[datetime] = Field(None, description="Soft-delete timestamp; NULL means the item is live")


class FileListResponse(BaseModel):
    files: List[FileInfo] = Field(default_factory=list, description="List of files")
    total: int = Field(..., description="Total number of files")
    page: int = Field(1, description="Current page")
    page_size: int = Field(50, description="Items per page")


class ErrorResponse(BaseModel):
    error: str = Field(..., description="Error message")
    detail: Optional[str] = Field(None, description="Detailed error information")
    code: Optional[str] = Field(None, description="Error code")
