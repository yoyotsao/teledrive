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
            access_hash=request.access_hash
        )
        return file_info
    except Exception as e:
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
    page_size: int = Query(50, ge=1, le=100)
):
    try:
        file_service = get_file_service()
        files, total = await file_service.list_files(page, page_size)
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
