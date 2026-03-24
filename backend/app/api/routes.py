from fastapi import APIRouter, HTTPException, Query, UploadFile, File
from typing import Optional
from pydantic import BaseModel

from app.models.schemas import FileListResponse, FileInfo
from app.services import get_file_service, get_bot_service
from app.services import get_telethon_service
from loguru import logger
import os
import tempfile

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


class CreateFolderRequest(BaseModel):
    name: str
    parent_id: Optional[str] = None


class UpdateFileRequest(BaseModel):
    thumbnail_message_id: Optional[int] = None
    thumbnail_data: Optional[str] = None
    parent_id: Optional[str] = None


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
            thumbnail_message_id=request.thumbnail_message_id
        )
        return file_info
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/files/thumbnail/upload")
async def upload_thumbnail(file: UploadFile = File(...)):
    """
    Upload a thumbnail image. 
    Returns the message_id for the uploaded thumbnail AND stores thumbnail data.
    """
    logger.info("=== THUMBNAIL UPLOAD ENDPOINT HIT ===")
    temp_path: Optional[str] = None
    try:
        import base64
        
        logger.info(f"Thumbnail upload started: filename={file.filename}, content_type={file.content_type}")
        
        with tempfile.NamedTemporaryFile(delete=False) as tmp:
            temp_path = tmp.name
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                tmp.write(chunk)

        file_size = os.path.getsize(temp_path) if temp_path and os.path.exists(temp_path) else 0
        logger.info(f"Thumbnail saved to temp: {temp_path}, size={file_size}")

        telethon_svc = await get_telethon_service()

        def progress_callback(current: int, total: int):
            try:
                pct = int((current / total) * 100) if total else 0
            except Exception:
                pct = 0
            logger.info(f"Thumbnail upload progress: {pct}% ({current}/{total} bytes)")

        upload_result = await telethon_svc.upload_thumbnail(temp_path, original_filename=file.filename or "thumbnail.jpg", progress_callback=progress_callback)
        logger.info(f"Thumbnail uploaded to Telegram: {upload_result}")

        with open(temp_path, 'rb') as f:
            thumbnail_bytes = f.read()
        thumbnail_base64 = base64.b64encode(thumbnail_bytes).decode('utf-8')
        logger.info(f"Thumbnail base64 encoded: length={len(thumbnail_base64)}")
        
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)

        return {
            "message_id": upload_result.get("message_id"),
            "file_id": upload_result.get("file_id"),
            "thumbnail_data": thumbnail_base64,
        }
    except Exception as e:
        import traceback
        traceback.print_exc()
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/files/upload")
async def upload_file_endpoint(file: UploadFile = File(...)):
    """Upload a file from multipart form data (field name 'file') and store metadata."""
    temp_path: Optional[str] = None
    try:
        # Save to a temporary file on disk (streaming to avoid memory pressure)
        with tempfile.NamedTemporaryFile(delete=False) as tmp:
            temp_path = tmp.name
            while True:
                chunk = await file.read(1024 * 1024)  # 1MB chunks
                if not chunk:
                    break
                tmp.write(chunk)

        # Upload to Telegram Saved Messages via Telethon service
        telethon_svc = await get_telethon_service()

        def progress_callback(current: int, total: int):
            try:
                pct = int((current / total) * 100) if total else 0
            except Exception:
                pct = 0
            logger.info(f"Telegram upload progress: {pct}% ({current}/{total} bytes)")

        upload_result = await telethon_svc.upload_file(temp_path, original_filename=file.filename, progress_callback=progress_callback)

        # Persist metadata via FileService
        file_service = get_file_service()
        mime_type = file.content_type or upload_result.get("mime_type")
        filename = upload_result.get("filename") or file.filename or "uploaded_file"
        size = upload_result.get("size") or 0
        message_id = upload_result.get("message_id")
        file_id = upload_result.get("file_id")
        access_hash = upload_result.get("access_hash")

        # Normalize types for the service layer
        message_id_int = int(message_id) if message_id is not None else 0
        file_id_str = str(file_id) if file_id is not None else ""
        await file_service.register_uploaded_file(
            filename=filename,
            filesize=size,
            mime_type=mime_type,
            message_id=message_id_int,
            file_id=file_id_str,
            access_hash=access_hash,
            parent_id=None,
        )

        # Cleanup temporary file
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)

        return {
            "message_id": message_id,
            "file_id": file_id,
            "access_hash": access_hash,
            "size": size,
            "mime_type": mime_type,
            "filename": filename,
        }
    except Exception as e:
        import traceback
        traceback.print_exc()
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/files", response_model=FileListResponse)
async def list_files(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=100),
    parent_id: Optional[str] = Query(None)
):
    # Convert string "null" to Python None
    if parent_id == "null":
        parent_id = None
    try:
        file_service = get_file_service()
        files, total = await file_service.list_files(page, page_size, parent_id=parent_id)
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
    Update file metadata (e.g., thumbnail_message_id, thumbnail_data, parent_id for move).
    """
    try:
        logger.info(f"Update file request: file_id={file_id}, thumbnail_message_id={request.thumbnail_message_id}, thumbnail_data_len={len(request.thumbnail_data) if request.thumbnail_data else 0}, parent_id={request.parent_id}")
        file_service = get_file_service()
        file_info = await file_service.get_file_info(file_id)
        
        if not file_info:
            logger.error(f"File not found: {file_id}")
            raise HTTPException(status_code=404, detail="File not found")
        
        updated_info = await file_service.update_file(
            file_id, 
            thumbnail_message_id=request.thumbnail_message_id,
            thumbnail_data=request.thumbnail_data,
            parent_id=request.parent_id
        )
        
        logger.info(f"File updated successfully: {file_id}, thumbnail_data set={request.thumbnail_data is not None}, parent_id set={request.parent_id is not None}")
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
async def stream_file(file_id: str):
    """
    Stream file content from Telegram.
    Returns file bytes with proper content-type for display/playback.
    """
    from loguru import logger
    from fastapi.responses import StreamingResponse
    import io
    import traceback
    
    logger.info(f"Stream endpoint called with file_id: {file_id}")
    try:
        file_service = get_file_service()
        file_info = await file_service.get_file_info(file_id)
        
        if not file_info:
            raise HTTPException(status_code=404, detail="File not found")
        
        message_id = file_info.telegram_message_id
        if not message_id:
            raise HTTPException(status_code=400, detail="No Telegram message ID")
        
        mtproto_service = await get_telethon_service()
        
        # Download file content
        logger.info(f"Streaming file: {file_id}, message_id: {message_id}")
        try:
            file_bytes = await mtproto_service.download_file(message_id)
            logger.info(f"Downloaded {len(file_bytes)} bytes")
        except Exception as download_err:
            logger.error(f"Download error: {download_err}")
            import traceback
            logger.error(f"Traceback: {traceback.format_exc()}")
            raise HTTPException(status_code=500, detail=f"Download failed: {str(download_err)}")
        
        mime_type = file_info.mime_type or "application/octet-stream"
        
        # Return as streaming response
        return StreamingResponse(
            io.BytesIO(file_bytes),
            media_type=mime_type,
            headers={
                "Content-Length": str(len(file_bytes))
            }
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Stream error: {e}")
        logger.error(f"Traceback: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/folders", response_model=FileInfo)
async def create_folder(request: CreateFolderRequest):
    try:
        file_service = get_file_service()
        folder = file_service.create_folder(request.name, request.parent_id)
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


@router.delete("/folders/{folder_id}")
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
