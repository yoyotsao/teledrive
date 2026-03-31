from fastapi import APIRouter, HTTPException, Query, UploadFile, File, Request
from typing import Optional
from pydantic import BaseModel
from datetime import datetime

from app.models.schemas import FileListResponse, FileInfo, FileType
from app.services import get_file_service, get_bot_service
from app.services import get_telethon_service
from app.services.database import get_database
from loguru import logger
import os
import tempfile
import asyncio
import subprocess
import shutil
import base64


def find_ffmpeg() -> Optional[str]:
    """Find ffmpeg executable, checking PATH and known locations."""
    # Check PATH first
    ffmpeg_path = shutil.which("ffmpeg")
    if ffmpeg_path:
        return ffmpeg_path
    # Fallback to known Windows installation path
    known_path = "C:/Program Files/AI ExpertMeet/resources/bindings/FFmpeg/ffmpeg.exe"
    if os.path.exists(known_path):
        return known_path
    return None


async def extract_thumbnail_ffmpeg(video_path: str, thumb_path: str) -> None:
    """Extract thumbnail from video using ffmpeg. Runs in executor to avoid blocking."""
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        raise RuntimeError("FFmpeg not found. Please install FFmpeg.")

    cmd = [
        ffmpeg,
        "-y",
        "-i", video_path,
        "-ss", "00:00:01.000",
        "-vframes", "1",
        "-vf", "scale='min(400,iw)':min'(400,ih)':force_original_aspect_ratio=decrease",
        "-q:v", "2",
        thumb_path
    ]

    logger.info(f"Running ffmpeg: {' '.join(cmd)}")

    def run_ffmpeg():
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=30
        )
        if result.returncode != 0:
            raise RuntimeError(f"FFmpeg failed: {result.stderr}")
        return result

    await asyncio.to_thread(run_ffmpeg)

router = APIRouter(prefix="/api/v1", tags=["files"])


class RegisterFileRequest(BaseModel):
    filename: str
    filesize: int
    mime_type: Optional[str] = None
    message_id: int
    file_id: str
    access_hash: Optional[str] = None
    parent_id: Optional[str] = None
    thumbnail_message_id: Optional[int] = None
    is_split_file: bool = False
    original_name: Optional[str] = None
    part_index: Optional[int] = None
    total_parts: Optional[int] = None
    split_group_id: Optional[str] = None


class CreateFolderRequest(BaseModel):
    name: str
    parent_id: Optional[str] = None


class UpdateFileRequest(BaseModel):
    thumbnail_message_id: Optional[int] = None
    parent_id: Optional[str] = None


class VideoThumbnailRequest(BaseModel):
    message_id: int


@router.post("/files/register", response_model=FileInfo)
async def register_file(request: RegisterFileRequest):
    """
    Register a file uploaded directly via MTProto.
    Frontend uploads to Telegram, then registers metadata here.
    """
    try:
        file_service = get_file_service()
        file_info = await file_service.register_uploaded_file(
            filename=request.filename,
            filesize=request.filesize,
            mime_type=request.mime_type,
            message_id=request.message_id,
            file_id=request.file_id,
            access_hash=request.access_hash,
            parent_id=request.parent_id,
            thumbnail_message_id=request.thumbnail_message_id,
            is_split_file=request.is_split_file,
            original_name=request.original_name,
            part_index=request.part_index,
            total_parts=request.total_parts,
            split_group_id=request.split_group_id
        )
        return file_info
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/files/thumbnail/upload")
async def upload_thumbnail(file: UploadFile = File(...)):
    """
    DEPRECATED: This endpoint is no longer supported.
    
    The correct architecture is:
    1. Frontend uses GramJS to upload thumbnail directly to Telegram
    2. Frontend calls /files/register with thumbnail_message_id
    
    This approach avoids file transfer through the backend.
    """
    raise HTTPException(
        status_code=410,
        detail="This endpoint is deprecated. Use frontend to upload thumbnail to Telegram, then call /files/register with thumbnail_message_id."
    )


@router.post("/videos/thumbnail")
async def generate_video_thumbnail(request: VideoThumbnailRequest):
    """DEPRECATED: Use frontend FFmpeg WASM to generate thumbnail, upload to Telegram, then call /files/register with thumbnail_message_id."""
    raise HTTPException(
        status_code=410,
        detail="This endpoint is deprecated. Use frontend FFmpeg WASM to generate video thumbnail, upload to Telegram, then call /files/register with thumbnail_message_id."
    )


@router.post("/files/upload")
async def upload_file_endpoint(file: UploadFile = File(...)):
    """DEPRECATED: Use frontend GramJS to upload directly to Telegram, then call /files/register with metadata."""
    # This endpoint is deprecated. Frontend should use GramJS for direct Telegram uploads.
    # See AGENTS.md architecture: frontend -> Telegram (GramJS) -> backend (metadata only)
    raise HTTPException(
        status_code=410, 
        detail="This endpoint is deprecated. Use frontend GramJS to upload directly to Telegram, then call /files/register with metadata."
    )


@router.get("/files", response_model=FileListResponse)
async def list_files(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=100),
    parent_id: Optional[str] = Query(None),
    split_group_id: Optional[str] = Query(None, description="Filter files by split group ID")
):
    # Convert string "null" to Python None
    if parent_id == "null":
        parent_id = None
    try:
        file_service = get_file_service()
        files, total = await file_service.list_files(
            page, 
            page_size, 
            parent_id=parent_id,
            split_group_id=split_group_id
        )
        return FileListResponse(
            files=files,
            total=total,
            page=page,
            page_size=page_size
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/files/{file_id}", response_model=FileInfo)
async def get_file_info(file_id: str):
    try:
        file_service = get_file_service()
        file_info = await file_service.get_file_info(file_id)
        if not file_info:
            raise HTTPException(status_code=404, detail="File not found")
        return file_info
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/files/{file_id}")
async def delete_file(file_id: str):
    try:
        file_service = get_file_service()
        file_info = await file_service.get_file_info(file_id)
        
        if not file_info:
            raise HTTPException(status_code=404, detail="File not found")
        
        await file_service.delete_file(file_id)
        
        if file_info.telegram_message_id:
            try:
                bot_service = await get_bot_service()
                await bot_service.delete_file(file_info.telegram_message_id)
            except Exception:
                pass
        
        return {"message": "File deleted", "file_id": file_id}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/files")
async def delete_all_files():
    """Delete all files and folders."""
    try:
        file_service = get_file_service()
        count = await file_service.delete_all()
        return {"message": "All files deleted", "count": count}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.patch("/files/{file_id}")
async def update_file(file_id: str, request: UpdateFileRequest):
    """
    Update file metadata (e.g., thumbnail_message_id, parent_id for move).
    """
    try:
        logger.info(f"Update file request: file_id={file_id}, thumbnail_message_id={request.thumbnail_message_id}, parent_id={request.parent_id}")
        file_service = get_file_service()
        file_info = await file_service.get_file_info(file_id)
        
        if not file_info:
            logger.error(f"File not found: {file_id}")
            raise HTTPException(status_code=404, detail="File not found")
        
        updated_info = await file_service.update_file(
            file_id, 
            thumbnail_message_id=request.thumbnail_message_id,
            parent_id=request.parent_id
        )
        
        logger.info(f"File updated successfully: {file_id}, parent_id set={request.parent_id is not None}")
        return updated_info
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))




@router.get("/files/{file_id}/download")
async def get_download_info(file_id: str):
    """
    Get file metadata for download.
    Frontend downloads directly via MTProto using these details.
    """
    try:
        file_service = get_file_service()
        file_info = await file_service.get_file_info(file_id)
        
        if not file_info:
            raise HTTPException(status_code=404, detail="File not found")
        
        return {
            "file_id": file_info.file_id,
            "filename": file_info.filename,
            "filesize": file_info.filesize,
            "mime_type": file_info.mime_type,
            "message_id": file_info.telegram_message_id,
            "access_hash": file_info.access_hash
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/files/{file_id}/thumbnail")
async def get_file_thumbnail(file_id: str):
    """
    Get thumbnail for image/video files from Telegram.
    Returns base64 encoded thumbnail image.
    
    Priority: thumbnail_message_id > telegram_message_id (for backward compatibility)
    """
    from loguru import logger
    try:
        file_service = get_file_service()
        file_info = await file_service.get_file_info(file_id)
        
        if not file_info:
            logger.error(f"Thumbnail: File not found: {file_id}")
            raise HTTPException(status_code=404, detail="File not found")
        
        message_id = file_info.thumbnail_message_id or file_info.telegram_message_id
        if not message_id:
            logger.error(f"Thumbnail: No message ID for: {file_id}")
            raise HTTPException(status_code=400, detail="No Telegram message ID")
        
        mtproto_service = await get_bot_service()
        
        mime_type = file_info.mime_type or ""
        if not (mime_type.startswith('image/') or mime_type.startswith('video/')):
            logger.error(f"Thumbnail: Not image/video: {mime_type}")
            raise HTTPException(status_code=400, detail="Not an image or video file")
        
        logger.info(f"Getting thumbnail for message {message_id} (thumb_id={file_info.thumbnail_message_id}, file_id={file_info.telegram_message_id})")
        thumbnail_data = await mtproto_service.get_thumbnail(message_id)
        
        if not thumbnail_data:
            logger.error(f"Thumbnail: No data returned for message {message_id}")
            raise HTTPException(status_code=404, detail="No thumbnail available")
        
        logger.info(f"Thumbnail retrieved: {len(thumbnail_data)} chars")
        return {
            "thumbnail": thumbnail_data,
            "mime_type": "image/jpeg"
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Thumbnail error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/files/{file_id}/stream")
async def stream_file(file_id: str, request: Request):
    """
    Stream file content from Telegram with Range header support.
    Returns file bytes with proper content-type for display/playback.
    Supports HTTP Range requests for partial content (206) and full content (200).
    """
    from loguru import logger
    from fastapi.responses import StreamingResponse
    from starlette.status import HTTP_416_RANGE_NOT_SATISFIABLE
    import re
    import traceback
    
    logger.info(f"Stream endpoint called with file_id: {file_id}")
    
    def parse_range(range_header: str, file_size: int) -> tuple[int, int] | None:
        """Parse Range header and return (start, end) tuple or None if invalid."""
        if not range_header:
            return None
        
        # Only support bytes range (no multi-range)
        if ',' in range_header:
            return None
        
        # Match bytes=start-end or bytes=start- format
        match = re.match(r'^bytes=(\d+)-(\d*)$', range_header)
        if not match:
            return None
        
        start_str, end_str = match.groups()
        
        # Validate start is a non-negative integer
        try:
            start = int(start_str)
            if start < 0:
                return None
        except ValueError:
            return None
        
        # Parse end (empty string means to EOF)
        if end_str:
            try:
                end = int(end_str)
                if end < 0:
                    return None
                # end must be >= start
                if end < start:
                    return None
            except ValueError:
                return None
            return (start, end)
        else:
            # bytes=start- means from start to EOF
            return (start, file_size - 1)
    
    try:
        file_service = get_file_service()
        file_info = await file_service.get_file_info(file_id)
        
        if not file_info:
            raise HTTPException(status_code=404, detail="File not found")
        
        message_id = file_info.telegram_message_id
        
        if not message_id:
            raise HTTPException(status_code=400, detail="No Telegram message ID")
        
        file_size = file_info.filesize
        mime_type = file_info.mime_type or "application/octet-stream"
        
        # Parse Range header
        range_header = request.headers.get("range", "")
        range_result = parse_range(range_header, file_size)
        
        # If Range header is present but invalid format, return 416
        if range_header and range_result is None:
            logger.info(f"Invalid Range header: {range_header}")
            from fastapi.responses import Response
            return Response(
                status_code=HTTP_416_RANGE_NOT_SATISFIABLE,
                headers={
                    "Content-Range": f"bytes */{file_size}",
                    "Accept-Ranges": "bytes"
                }
            )
        
        mtproto_service = await get_telethon_service()
        
        if range_result is not None:
            # Range request
            start, end = range_result
            
            # Check if start is beyond file size
            if start >= file_size:
                logger.info(f"Range not satisfiable: start={start} >= file_size={file_size}")
                from fastapi.responses import Response
                return Response(
                    status_code=HTTP_416_RANGE_NOT_SATISFIABLE,
                    headers={
                        "Content-Range": f"bytes */{file_size}",
                        "Accept-Ranges": "bytes"
                    }
                )
            
            # Clamp end to file size
            actual_end = min(end, file_size - 1)
            content_length = actual_end - start + 1
            
            logger.info(f"Streaming range: {file_id}, bytes {start}-{actual_end}/{file_size}")
            
            async def generate_range():
                # Range request - download only the requested range
                try:
                    chunk = await mtproto_service.download_file(
                        message_id=message_id,
                        offset=start,
                        limit=content_length
                    )
                    if chunk:
                        yield chunk
                except Exception as chunk_err:
                    logger.error(f"Range download error: {chunk_err}")
            
            return StreamingResponse(
                generate_range(),
                status_code=206,
                media_type=mime_type,
                headers={
                    "Content-Range": f"bytes {start}-{actual_end}/{file_size}",
                    "Accept-Ranges": "bytes"
                }
            )
        else:
            # Full file request (no Range header)
            logger.info(f"Streaming full file: {file_id}, size={file_size}")
            
            async def generate_full():
                # For full file download, get everything in one request (or few large chunks)
                # Telegram requires minimum 512KB limit, so we request the full file at once
                try:
                    chunk = await mtproto_service.download_file(
                        message_id=message_id,
                        offset=0,
                        limit=file_size  # Request full file
                    )
                    if chunk:
                        yield chunk
                except Exception as chunk_err:
                    logger.error(f"Download error: {chunk_err}")
            
            return StreamingResponse(
                generate_full(),
                status_code=200,
                media_type=mime_type,
                headers={
                    "Accept-Ranges": "bytes"
                }
            )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Stream error: {e}")
        logger.error(f"Traceback: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.post("/folders", response_model=FileInfo)
async def create_folder(request: CreateFolderRequest):
    try:
        file_service = get_file_service()
        folder = await file_service.create_folder(request.name, request.parent_id)
        return folder
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/folders", response_model=FileListResponse)
async def list_folders(
    parent_id: Optional[str] = Query(None)
):
    if parent_id == "null":
        parent_id = None
    try:
        file_service = get_file_service()
        folders = await file_service.list_folders(parent_id=parent_id)
        return FileListResponse(
            files=folders,
            total=len(folders),
            page=1,
            page_size=len(folders)
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/folders/{folder_id}")
async def delete_folder(folder_id: str):
    try:
        file_service = get_file_service()
        file_info = await file_service.get_file_info(folder_id)
        
        if not file_info:
            raise HTTPException(status_code=404, detail="Folder not found")
        
        if not getattr(file_info, 'isDir', False):
            raise HTTPException(status_code=400, detail="Not a folder")
        
        await file_service.delete_folder(folder_id)
        return {"message": "Folder deleted", "folder_id": folder_id}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/files/by-split-group/{split_group_id}", response_model=FileListResponse)
async def get_files_by_split_group(split_group_id: str):
    """
    Get all file parts belonging to a split group.
    Returns files sorted by part_index for proper reassembly.
    """
    try:
        db = await get_database()
        rows = await db.get_files_by_split_group(split_group_id)
        
        if not rows:
            raise HTTPException(status_code=404, detail="No files found for this split group")
        
        # Convert to FileInfo objects
        files = []
        for row in rows:
            file_info = FileInfo(
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
            files.append(file_info)
        
        # Sort by part_index
        files.sort(key=lambda f: getattr(f, 'part_index', 0) or 0)
        
        return FileListResponse(
            files=files,
            total=len(files),
            page=1,
            page_size=len(files)
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
