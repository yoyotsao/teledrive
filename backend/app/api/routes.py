from fastapi import APIRouter, HTTPException, Query, UploadFile, File, Request, WebSocket, WebSocketDisconnect, Depends
from typing import Optional, Literal
from pydantic import BaseModel, Field
from datetime import datetime

from app.models.schemas import FileListResponse, FileInfo, FileType
from app.services import get_file_service, get_bot_service
from app.services import get_telethon_service
from app.services.database import get_database
from app.auth import get_current_user, create_jwt
from app.services.user_sessions import store_user_session, get_user_client
from loguru import logger
import asyncio
import base64

# Thumbnails are served entirely browser-side: the frontend downloads each
# file's embedded thumb via GramJS and caches it in IndexedDB (see
# frontend/src/lib/thumbnailCache.ts). The backend keeps no thumbnail cache and
# never proxies thumbnail bytes.

router = APIRouter(prefix="/api/v1", tags=["files"])


_GRAMJS_DOMAIN_TO_IP = {
    'pluto.web.telegram.org': '149.154.175.53',
    'venus.web.telegram.org': '149.154.167.51',
    'aurora.web.telegram.org': '149.154.175.100',
    'vesta.web.telegram.org': '149.154.167.91',
    'flora.web.telegram.org': '91.108.56.130',
    'pluto-1.web.telegram.org': '149.154.175.53',
    'venus-1.web.telegram.org': '149.154.167.51',
    'aurora-1.web.telegram.org': '149.154.175.100',
    'vesta-1.web.telegram.org': '149.154.167.91',
    'flora-1.web.telegram.org': '91.108.56.130',
}


def _parse_gramjs_session(gramjs: str):
    """Convert a GramJS StringSession string to a Telethon MemorySession.

    GramJS format: '1' + base64(dc_id[1] + addr_len[2BE] + addr[N] + port[2BE] + auth_key[256])
    Telethon MemorySession is populated directly from these components.
    """
    import struct
    import ipaddress
    from telethon.sessions import MemorySession
    from telethon.crypto import AuthKey

    if not gramjs or gramjs[0] != '1':
        raise ValueError("Invalid GramJS session (expected version '1')")
    b64 = gramjs[1:]
    b64 += '=' * ((4 - len(b64) % 4) % 4)
    raw = base64.b64decode(b64)
    dc_id = raw[0]
    addr_len = struct.unpack('>H', raw[1:3])[0]
    addr = raw[3:3 + addr_len].decode('utf-8')
    port = struct.unpack('>H', raw[3 + addr_len:5 + addr_len])[0]
    auth_key_bytes = raw[5 + addr_len:5 + addr_len + 256]
    try:
        ipaddress.ip_address(addr)
        resolved = addr
    except ValueError:
        resolved = _GRAMJS_DOMAIN_TO_IP.get(addr) or addr
    session = MemorySession()
    session.set_dc(dc_id, resolved, port)
    session.auth_key = AuthKey(auth_key_bytes)
    return session


class LoginRequest(BaseModel):
    session_string: str


class LoginResponse(BaseModel):
    token: str
    user_id: int
    username: Optional[str] = None
    first_name: Optional[str] = None


class CheckHashesRequest(BaseModel):
    hashes: list[str] = Field(..., max_length=1000)


class RegisterFileRequest(BaseModel):
    filename: str
    filesize: int
    mime_type: Optional[str] = None
    message_id: int
    file_id: str
    access_hash: Optional[str] = None
    parent_id: Optional[str] = None
    has_thumbnail: bool = False
    is_split_file: bool = False
    original_name: Optional[str] = None
    part_index: Optional[int] = None
    total_parts: Optional[int] = None
    split_group_id: Optional[str] = None
    file_hash: Optional[str] = None


class CreateFolderRequest(BaseModel):
    name: str
    parent_id: Optional[str] = None


class UpdateFileRequest(BaseModel):
    parent_id: Optional[str] = None
    filename: Optional[str] = None


@router.post("/auth/login", response_model=LoginResponse)
async def login(request: LoginRequest):
    """Verify a GramJS or Telethon session via Telethon, store per-user client, return JWT."""
    from telethon import TelegramClient
    from telethon.sessions import StringSession
    from app.services.config import get_settings

    settings = get_settings()
    client = None
    try:
        # Browsers send a GramJS session string; non-browser clients (e.g. the
        # WebDAV bridge, generate_session.py) send a Telethon StringSession.
        try:
            session = _parse_gramjs_session(request.session_string)
        except Exception:
            session = StringSession(request.session_string)
            # StringSession accepts an empty/garbage string as a *blank* session, which
            # would otherwise cost a full Telegram handshake before failing on get_me().
            if not session.auth_key:
                raise HTTPException(status_code=401, detail="Invalid session")
        client = TelegramClient(session, settings.telegram_api_id, settings.telegram_api_hash)
        await client.connect()
        me = await client.get_me()
        if not me:
            raise HTTPException(status_code=401, detail="Invalid session")

        telegram_user_id = me.id
        await store_user_session(telegram_user_id, client)

        token = create_jwt(telegram_user_id)
        logger.info(f"User {telegram_user_id} ({me.username}) logged in")
        return LoginResponse(
            token=token,
            user_id=telegram_user_id,
            username=me.username,
            first_name=me.first_name,
        )
    except HTTPException:
        if client:
            await client.disconnect()
        raise
    except Exception as e:
        if client:
            await client.disconnect()
        logger.error(f"Login failed: {e}")
        raise HTTPException(status_code=401, detail=f"Login failed: {str(e)}")


@router.get("/files/check-hash")
async def check_file_hash(
    hash: str = Query(..., description="SHA-256 hex digest of the file"),
    current_user: int = Depends(get_current_user),
):
    """Check if a file with this SHA-256 hash already exists for the current user."""
    file_service = get_file_service()
    files = await file_service.find_by_hash(hash, current_user)
    if not files:
        return {"found": False, "files": []}
    return {"found": True, "files": [f.model_dump() for f in files]}


@router.post("/files/check-hashes")
async def check_file_hashes(
    request: CheckHashesRequest,
    current_user: int = Depends(get_current_user),
):
    """Batch-check multiple SHA-256 hashes at once, grouped by hash."""
    file_service = get_file_service()
    results = await file_service.find_by_hashes(request.hashes, current_user)
    return {"results": {h: [f.model_dump() for f in files] for h, files in results.items()}}


@router.post("/files/register", response_model=FileInfo)
async def register_file(
    request: RegisterFileRequest,
    current_user: int = Depends(get_current_user),
):
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
            has_thumbnail=request.has_thumbnail,
            is_split_file=request.is_split_file,
            original_name=request.original_name,
            part_index=request.part_index,
            total_parts=request.total_parts,
            split_group_id=request.split_group_id,
            telegram_user_id=current_user,
            file_hash=request.file_hash,
        )
        return file_info
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


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
    page_size: int = Query(50, ge=1, le=10000),
    parent_id: Optional[str] = Query(None),
    split_group_id: Optional[str] = Query(None, description="Filter files by split group ID"),
    sort_by: Literal["name", "size", "date"] = Query("date"),
    sort_order: Literal["asc", "desc"] = Query("desc"),
    search: Optional[str] = Query(None, description="Search filename across the whole drive"),
    trashed: bool = Query(False, description="List trashed items instead of live ones"),
    current_user: int = Depends(get_current_user),
):
    # Convert string "null" to Python None
    if parent_id == "null":
        parent_id = None
    if search is not None:
        search = search.strip() or None
    try:
        file_service = get_file_service()
        files, total = await file_service.list_files(
            page,
            page_size,
            parent_id=parent_id,
            split_group_id=split_group_id,
            telegram_user_id=current_user,
            sort_by=sort_by,
            sort_order=sort_order,
            search=search,
            trashed=trashed,
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
async def get_file_info(file_id: str, current_user: int = Depends(get_current_user)):
    try:
        file_service = get_file_service()
        file_info = await file_service.get_file_info(file_id, telegram_user_id=current_user)
        if not file_info:
            raise HTTPException(status_code=404, detail="File not found")
        return file_info
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


async def _delete_telegram_messages(message_ids: list) -> None:
    """Best-effort deletion of Telegram messages — never fails the request."""
    if not message_ids:
        return
    try:
        bot_service = await get_bot_service()
        await bot_service.delete_messages(message_ids)
    except Exception as e:
        logger.warning(f"Telegram message delete failed (non-fatal): {e}")


@router.delete("/files/{file_id}")
async def delete_file(file_id: str, current_user: int = Depends(get_current_user)):
    """Move a file or folder (and its whole subtree) to the trash. Telegram messages are kept."""
    try:
        file_service = get_file_service()
        file_info = await file_service.get_file_info(file_id, telegram_user_id=current_user)
        if not file_info:
            raise HTTPException(status_code=404, detail="File not found")

        items_trashed = await file_service.trash_file(file_id, current_user)
        return {"message": "Moved to trash", "file_id": file_id, "items_trashed": items_trashed}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/files/{file_id}/restore", response_model=FileInfo)
async def restore_file(file_id: str, current_user: int = Depends(get_current_user)):
    """Restore a trashed item (and its subtree) from the trash."""
    try:
        file_service = get_file_service()
        try:
            restored = await file_service.restore_file(file_id, current_user)
        except ValueError as ve:
            raise HTTPException(status_code=400, detail=str(ve))
        if not restored:
            raise HTTPException(status_code=404, detail="File not found")
        return restored
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/files/{file_id}/purge")
async def purge_file(file_id: str, current_user: int = Depends(get_current_user)):
    """Permanently delete a trashed item (and its subtree), including its Telegram messages."""
    try:
        file_service = get_file_service()
        file_info = await file_service.get_file_info(file_id, telegram_user_id=current_user)
        if not file_info:
            raise HTTPException(status_code=404, detail="File not found")

        deleted_count, message_ids = await file_service.purge_file(file_id, current_user)
        await _delete_telegram_messages(message_ids)
        return {"message": "Permanently deleted", "file_id": file_id, "records_deleted": deleted_count}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/files")
async def delete_all_files(current_user: int = Depends(get_current_user)):
    """Delete all files and folders belonging to the authenticated user."""
    try:
        file_service = get_file_service()
        count = await file_service.delete_all(telegram_user_id=current_user)
        return {"message": "All files deleted", "count": count}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.patch("/files/{file_id}")
async def update_file(file_id: str, request: UpdateFileRequest, current_user: int = Depends(get_current_user)):
    """
    Update file metadata (e.g., parent_id for move).
    """
    try:
        logger.info(f"Update file request: file_id={file_id}, parent_id={request.parent_id}")
        file_service = get_file_service()
        file_info = await file_service.get_file_info(file_id, telegram_user_id=current_user)

        if not file_info:
            logger.error(f"File not found: {file_id}")
            raise HTTPException(status_code=404, detail="File not found")

        new_filename = None
        if 'filename' in request.model_fields_set:
            new_filename = (request.filename or "").strip()
            if not new_filename:
                raise HTTPException(status_code=400, detail="Filename cannot be empty")
            if '/' in new_filename or '\\' in new_filename:
                raise HTTPException(status_code=400, detail="Filename cannot contain / or \\")

        updated_info = await file_service.update_file(
            file_id,
            parent_id=request.parent_id,
            set_parent_id='parent_id' in request.model_fields_set,
            filename=new_filename,
        )

        logger.info(f"File updated successfully: {file_id}, parent_id set={'parent_id' in request.model_fields_set}, parent_id={request.parent_id}, filename={new_filename}")
        return updated_info
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))




@router.get("/files/{file_id}/download")
async def get_download_info(file_id: str, current_user: int = Depends(get_current_user)):
    """
    Get file metadata for download.
    Frontend downloads directly via MTProto using these details.
    """
    try:
        file_service = get_file_service()
        file_info = await file_service.get_file_info(file_id, telegram_user_id=current_user)
        
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


@router.get("/files/{file_id}/stream")
async def stream_file(file_id: str, request: Request, current_user: int = Depends(get_current_user)):
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
        file_info = await file_service.get_file_info(file_id, telegram_user_id=current_user)

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
async def create_folder(request: CreateFolderRequest, current_user: int = Depends(get_current_user)):
    try:
        file_service = get_file_service()
        folder = await file_service.create_folder(request.name, request.parent_id, telegram_user_id=current_user)
        return folder
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/folders", response_model=FileListResponse)
async def list_folders(
    parent_id: Optional[str] = Query(None),
    sort_by: Literal["name", "size", "date"] = Query("date"),
    sort_order: Literal["asc", "desc"] = Query("desc"),
    current_user: int = Depends(get_current_user),
):
    if parent_id == "null":
        parent_id = None
    try:
        file_service = get_file_service()
        folders = await file_service.list_folders(
            parent_id=parent_id,
            telegram_user_id=current_user,
            sort_by=sort_by,
            sort_order=sort_order,
        )
        return FileListResponse(
            files=folders,
            total=len(folders),
            page=1,
            page_size=len(folders)
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/folders/{folder_id}")
async def delete_folder(folder_id: str, current_user: int = Depends(get_current_user)):
    try:
        file_service = get_file_service()
        file_info = await file_service.get_file_info(folder_id, telegram_user_id=current_user)

        if not file_info:
            raise HTTPException(status_code=404, detail="Folder not found")

        if not getattr(file_info, 'isDir', False):
            raise HTTPException(status_code=400, detail="Not a folder")

        items_trashed = await file_service.trash_file(folder_id, current_user)
        return {"message": "Moved to trash", "folder_id": folder_id, "items_trashed": items_trashed}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.websocket("/ws-proxy")
async def websocket_proxy(websocket: WebSocket, host: str, port: int = 80):
    """
    Proxy WebSocket connections to Telegram servers.
    Required when the app is served over HTTPS — browsers block ws:// from https:// pages.
    The browser connects here via wss:// (valid SSL via Cloudflare), we forward to Telegram
    via plain ws://.
    """
    import websockets as ws_lib

    # Echo back any requested subprotocol — required by WebSocket spec.
    # GramJS sends a non-empty Sec-WebSocket-Protocol; without echoing it the browser drops the connection.
    subprotocol_header = websocket.headers.get("sec-websocket-protocol")
    chosen_subprotocol = subprotocol_header.split(",")[0].strip() if subprotocol_header else None
    await websocket.accept(subprotocol=chosen_subprotocol)

    telegram_url = f"ws://{host}:{port}/apiws"
    logger.info(f"WS proxy: {websocket.client} → {telegram_url} (subprotocol={chosen_subprotocol})")

    tg_subprotocols = [chosen_subprotocol] if chosen_subprotocol else None
    try:
        async with ws_lib.connect(telegram_url, max_size=2**24, subprotocols=tg_subprotocols) as tg:
            async def browser_to_telegram():
                try:
                    while True:
                        data = await websocket.receive_bytes()
                        await tg.send(data)
                except (WebSocketDisconnect, Exception):
                    pass

            async def telegram_to_browser():
                try:
                    async for message in tg:
                        if isinstance(message, bytes):
                            await websocket.send_bytes(message)
                        else:
                            await websocket.send_text(message)
                except Exception:
                    pass

            await asyncio.gather(browser_to_telegram(), telegram_to_browser())
    except Exception as e:
        logger.warning(f"WS proxy closed: {e}")
    finally:
        try:
            await websocket.close()
        except Exception:
            pass


@router.get("/files/by-split-group/{split_group_id}", response_model=FileListResponse)
async def get_files_by_split_group(split_group_id: str, current_user: int = Depends(get_current_user)):
    """
    Get all file parts belonging to a split group.
    Returns files sorted by part_index for proper reassembly.
    """
    try:
        db = await get_database()
        rows = await db.get_files_by_split_group(split_group_id, telegram_user_id=current_user)

        if not rows:
            raise HTTPException(status_code=404, detail="No files found for this split group")
        
        file_service = get_file_service()
        files = [file_service._row_to_file_info(row) for row in rows]
        files.sort(key=lambda f: f.part_index or 0)
        
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
