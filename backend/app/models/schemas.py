from datetime import datetime, timezone
from enum import Enum
from typing import Dict, Literal, Optional, List
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


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
    telegram_chat_id: Optional[str] = Field(None, description="Raw channel ID, or NULL for the uploader's Saved Messages")
    telegram_media_kind: Optional[Literal["document", "photo"]] = Field(None, description="Telegram media constructor kind")
    telegram_media_id: Optional[str] = Field(None, description="Telegram document or photo ID, distinct from file_id")
    telegram_media_size: Optional[int] = Field(None, description="Verified Telegram media byte size")
    telegram_photo_variant: Optional[str] = Field(None, description="Selected largest photo variant, when applicable")
    location_version: int = Field(0, ge=0, description="Monotonic physical location version")
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


MAX_CHANNEL_ID = 997852516352


def is_canonical_channel_id(value: object) -> bool:
    """Match the browser's raw-only positive Telegram channel-ID grammar."""
    return (
        isinstance(value, str)
        and value.isascii()
        and value.isdecimal()
        and value[0] != "0"
        and int(value) <= MAX_CHANNEL_ID
    )


class StorageTargetVerification(BaseModel):
    """A browser-produced enable-time audit record, never runtime authority."""

    model_config = ConfigDict(extra="forbid")

    telegram_user_id: int = Field(..., gt=0)
    channel_title: Optional[str] = Field(None, max_length=255)
    can_read: bool
    can_write: bool
    status: Literal["verified"]
    checked_at: datetime

    @field_validator("channel_title")
    @classmethod
    def normalize_channel_title(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        return value.strip() or None

    @field_validator("checked_at")
    @classmethod
    def require_timezone(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("checked_at must include a timezone")
        return value.astimezone(timezone.utc)


class StorageTargetPutRequest(BaseModel):
    """Versioned channel storage selection and its one-time audit evidence."""

    model_config = ConfigDict(extra="forbid")

    storage_mode: Literal["saved_messages", "channel"]
    channel_id: Optional[str] = Field(None, max_length=12)
    channel_title: Optional[str] = Field(None, max_length=255)
    expected_version: int = Field(..., ge=0)
    expected_accounts_version: int = Field(..., ge=0)
    verifications: List[StorageTargetVerification] = Field(default_factory=list, max_length=100)

    @field_validator("channel_id")
    @classmethod
    def validate_canonical_channel_id(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        if not is_canonical_channel_id(value):
            raise ValueError("channel_id must be a canonical positive raw channel ID")
        return value

    @field_validator("channel_title")
    @classmethod
    def normalize_target_title(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        return value.strip() or None

    @model_validator(mode="after")
    def validate_mode(self):
        if self.storage_mode == "channel" and self.channel_id is None:
            raise ValueError("A channel target requires channel_id")
        if self.storage_mode == "saved_messages" and (
            self.channel_id is not None or self.verifications
        ):
            raise ValueError("Saved Messages does not accept channel verification evidence")
        return self


class StorageTargetResponse(BaseModel):
    storage_mode: Literal["saved_messages", "channel"]
    channel_id: Optional[str] = None
    channel_title: Optional[str] = None
    version: int = Field(..., ge=0)
    accounts_version: int = Field(..., ge=0)
    verifications: List[dict] = Field(default_factory=list)


# Telegram operation endpoints deliberately describe metadata only.  In
# particular these models have no session, peer access-hash or binary fields.
class TelegramOperationCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    operation_id: str = Field(..., min_length=1, max_length=128)
    kind: Literal["upload", "chat_import", "migration"]
    logical_file_id: str = Field(..., min_length=1, max_length=512)
    group_id: Optional[str] = Field(None, max_length=512)
    part_index: Optional[int] = Field(None, ge=0)
    uploader_id: int = Field(..., gt=0)
    target_kind: Literal["saved_messages", "channel", "@me"]
    target_channel_id: Optional[str] = Field(None, max_length=12)
    target_peer_key: str = Field(..., min_length=1, max_length=512)
    created_target_version: int = Field(..., ge=0)
    created_accounts_version: int = Field(..., ge=0)
    random_id: str = Field(..., min_length=1, max_length=32)
    rpc_kind: str = Field(..., min_length=1, max_length=128)
    request_metadata: dict


class TelegramOperationPatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_operation_version: int = Field(..., ge=0)
    state: Optional[Literal[
        "sending", "recovering", "retryable", "uncertain", "tombstoned",
    ]] = None
    retry_at: Optional[str] = None
    error_code: Optional[str] = Field(None, max_length=128)
    tombstone_reason: Optional[str] = Field(None, max_length=512)
    mapping: Optional[dict] = None
    media_identity: Optional[dict] = None

    @model_validator(mode="after")
    def require_a_patch(self):
        if self.state is None and self.mapping is None:
            raise ValueError("state or mapping is required")
        if self.mapping is None and self.media_identity is not None:
            raise ValueError("media_identity requires mapping")
        return self


class ReconcileTelegramOperationResultRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_operation_version: int = Field(..., ge=0)
    mapping: dict
    media_identity: dict


class FileLocationSwitchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_location_version: int = Field(..., ge=0)
    operation_id: str = Field(..., min_length=1, max_length=128)
    result_version: int = Field(..., ge=1)


class FileLocationSwitchPart(FileLocationSwitchRequest):
    file_id: str = Field(..., min_length=1, max_length=512)


class FileLocationGroupSwitchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    parts: List[FileLocationSwitchPart] = Field(..., min_length=1, max_length=1000)

    @model_validator(mode="after")
    def require_unique_files(self):
        if len({part.file_id for part in self.parts}) != len(self.parts):
            raise ValueError("each file may appear only once")
        return self



# Storage migration endpoints carry metadata/CAS versions only. Telegram
# sessions, peer access hashes and file bytes are intentionally absent.
class CreateMigrationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_target_version: int = Field(..., ge=0)
    expected_accounts_version: int = Field(..., ge=0)
    dry_run: bool = False


class ItemPatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_version: int = Field(..., ge=1)
    lease_owner: str = Field(..., min_length=1, max_length=128)
    lease_seconds: int = Field(..., ge=1, le=300)
    operation_id: Optional[str] = Field(None, min_length=1, max_length=128)
    state: Optional[str] = Field(None, min_length=1, max_length=32)
    error: Optional[str] = Field(None, max_length=1024)


class ReconcileTransitionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_item_version: int = Field(..., ge=1)
    operation_result_version: int = Field(..., ge=1)


class EvidenceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_item_version: int = Field(..., ge=1)
    result_version: int = Field(..., ge=1)
    target_channel_id: str = Field(..., min_length=1, max_length=12)
    destination_message_id: int = Field(..., gt=0)
    media_kind: Literal["document", "photo"]
    media_id: str = Field(..., min_length=1, max_length=64)
    size_bytes: int = Field(..., ge=0)
    photo_variant: Optional[str] = Field(None, max_length=255)
    read_probe_ok: bool
    checked_at: datetime
    source_read_probe_ok: bool = False

    @field_validator("target_channel_id")
    @classmethod
    def validate_target_channel(cls, value: str) -> str:
        if not is_canonical_channel_id(value):
            raise ValueError("target_channel_id must be canonical")
        return value

    @field_validator("checked_at")
    @classmethod
    def validate_checked_at(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("checked_at must include a timezone")
        return value.astimezone(timezone.utc)


class ClaimGroupRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_item_versions: Dict[str, int] = Field(..., min_length=1)
    lease_owner: str = Field(..., min_length=1, max_length=128)
    lease_seconds: int = Field(..., ge=1, le=300)


class CommitGroupRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_job_version: int = Field(..., ge=1)
    expected_item_versions: Dict[str, int] = Field(..., min_length=1)


class RollbackGroupRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_location_versions: Dict[str, int] = Field(..., min_length=1)


class MigrationItemResponse(BaseModel):
    model_config = ConfigDict(extra="allow")
    migration_id: str
    item_id: str
    file_id: str
    group_id: str
    state: str
    version: int


class MigrationResponse(BaseModel):
    model_config = ConfigDict(extra="allow")
    migration_id: str
    state: str
    version: int
    dry_run: bool
    target_channel_id: str
    items: List[dict] = Field(default_factory=list)


class EvidenceResponse(BaseModel):
    model_config = ConfigDict(extra="allow")
    telegram_user_id: int
    result_version: int
    target_channel_id: str
