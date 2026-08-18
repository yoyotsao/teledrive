from fastapi import APIRouter, HTTPException, Query, UploadFile, File, Request, WebSocket, WebSocketDisconnect, Depends
from fastapi.responses import JSONResponse
from typing import Optional, Literal
from pydantic import BaseModel, Field
from datetime import datetime

from app.models.schemas import FileListResponse, FileInfo, FileType
from app.services import get_file_service, get_bot_service
from app.services.database import get_database
from app.auth import get_current_user, create_jwt
from app.services import bot_challenge
from loguru import logger
import asyncio

# Thumbnails are served entirely browser-side: the frontend downloads each
# file's embedded thumb via GramJS and caches it in IndexedDB (see
# frontend/src/lib/thumbnailCache.ts). The backend keeps no thumbnail cache and
# never proxies thumbnail bytes.

router = APIRouter(prefix="/api/v1", tags=["files"])


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
    telegram_user_id: Optional[int] = None  # which linked account stores the message


class CreateFolderRequest(BaseModel):
    name: str
    parent_id: Optional[str] = None


class UpdateFileRequest(BaseModel):
    parent_id: Optional[str] = None
    filename: Optional[str] = None


class ChallengeResponse(BaseModel):
    nonce: str
    bot_username: str
    expires_in: int


class VerifyRequest(BaseModel):
    nonce: str


@router.post("/auth/challenge", response_model=ChallengeResponse)
async def auth_challenge():
    """Hand out a one-time nonce for the caller to DM to our bot."""
    if not bot_challenge.bot_username:
        raise HTTPException(
            status_code=503,
            detail="Bot login unavailable — set TELEGRAM_BOT_TOKEN in .env (create a bot via @BotFather)",
        )
    return ChallengeResponse(
        nonce=bot_challenge.new_challenge(),
        bot_username=bot_challenge.bot_username,
        expires_in=bot_challenge.TTL_SECONDS,
    )


@router.post("/auth/verify")
async def auth_verify(request: VerifyRequest):
    """Trade a nonce we saw arrive at the bot for a JWT. 202 = keep polling."""
    entry = bot_challenge.take_verified(request.nonce)
    if entry is None:
        if bot_challenge.is_pending(request.nonce):
            return JSONResponse(status_code=202, content={"status": "waiting"})
        raise HTTPException(status_code=401, detail="Invalid or expired challenge")

    tg_user_id = entry["user_id"]
    db = await get_database()
    owner_id = await db.get_owner_of(tg_user_id)
    if owner_id is None:
        # First time we see this account — it becomes its own drive's primary.
        await db.link_account(tg_user_id, tg_user_id, is_primary=True,
                              label=entry["username"] or entry["first_name"])
        owner_id = tg_user_id

    logger.info(f"Account {tg_user_id} ({entry['username']}) logged in to drive {owner_id}")
    return LoginResponse(
        token=create_jwt(owner_id, acting_account_id=tg_user_id),
        user_id=tg_user_id,
        username=entry["username"],
        first_name=entry["first_name"],
    )


@router.get("/accounts")
async def list_accounts(current_user: int = Depends(get_current_user)):
    """Telegram accounts linked to this drive."""
    db = await get_database()
    return {"accounts": await db.list_linked_accounts(current_user)}


@router.post("/accounts/challenge", response_model=ChallengeResponse)
async def account_challenge(current_user: int = Depends(get_current_user)):
    """Same one-time nonce flow as login — the account to be linked DMs it to the bot."""
    if not bot_challenge.bot_username:
        raise HTTPException(status_code=503, detail="Bot linking unavailable — set TELEGRAM_BOT_TOKEN in .env")
    return ChallengeResponse(
        nonce=bot_challenge.new_challenge(),
        bot_username=bot_challenge.bot_username,
        expires_in=bot_challenge.TTL_SECONDS,
    )


@router.post("/accounts/verify")
async def account_verify(request: VerifyRequest, current_user: int = Depends(get_current_user)):
    """Link the account that answered this nonce to the caller's drive. 202 = keep polling."""
    entry = bot_challenge.take_verified(request.nonce)
    if entry is None:
        if bot_challenge.is_pending(request.nonce):
            return JSONResponse(status_code=202, content={"status": "waiting"})
        raise HTTPException(status_code=401, detail="Invalid or expired challenge")

    tg_user_id = entry["user_id"]
    db = await get_database()
    existing_owner = await db.get_owner_of(tg_user_id)
    if existing_owner == current_user:
        raise HTTPException(status_code=409, detail="This account is already linked to your drive")
    if existing_owner is not None:
        # One account, one drive — otherwise linking would expose the other drive's files.
        raise HTTPException(status_code=409, detail="This Telegram account already belongs to another drive")

    label = entry["username"] or entry["first_name"] or str(tg_user_id)
    if not await db.link_account(current_user, tg_user_id, is_primary=False, label=label):
        raise HTTPException(status_code=409, detail="This Telegram account already belongs to another drive")

    logger.info(f"Linked account {tg_user_id} ({label}) to drive {current_user}")
    return {"telegram_user_id": tg_user_id, "label": label, "is_primary": 0, "file_count": 0}


@router.delete("/accounts/{tg_user_id}")
async def unlink_account(tg_user_id: int, current_user: int = Depends(get_current_user)):
    """Unlink a storage account. Refused while it still holds files — access_hash is
    account-scoped, so unlinking would make those files permanently undownloadable."""
    db = await get_database()
    account = await db.get_linked_account(current_user, tg_user_id)
    if not account:
        raise HTTPException(status_code=404, detail="Account not linked to this drive")
    if account["is_primary"]:
        raise HTTPException(status_code=409, detail="Cannot unlink the primary account")

    file_count = await db.count_files_on_account(current_user, tg_user_id)
    if file_count:
        raise HTTPException(
            status_code=409,
            detail=f"This account still stores {file_count} file(s); they would become undownloadable",
        )

    await db.unlink_account(current_user, tg_user_id)
    return {"message": "Account unlinked", "telegram_user_id": tg_user_id}


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
    # Trust boundary: the client names the storage account, so verify it is actually
    # linked to this drive — otherwise a caller could attribute files to a stranger.
    storage_account = request.telegram_user_id or current_user
    db = await get_database()
    if storage_account != current_user:
        if not await db.get_linked_account(current_user, storage_account):
            raise HTTPException(status_code=403, detail="Account not linked to this drive")

    # Same trust boundary: file_id is a global primary key and insert_file is
    # INSERT OR REPLACE, so registering a file_id that already belongs to a
    # DIFFERENT drive would silently overwrite that drive's row — owner_id
    # included, i.e. steal it. Before chat import, file_id was always a
    # document id minted by the caller's own upload, so this collision was
    # essentially impossible; importing a public channel two drives both have
    # access to makes it near-certain.
    existing = await db.get_file(request.file_id)
    if existing and existing["owner_id"] != current_user:
        raise HTTPException(status_code=409, detail="File already registered to a different drive")

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
            owner_id=current_user,
            telegram_user_id=storage_account,
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
            owner_id=current_user,
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
        file_info = await file_service.get_file_info(file_id, owner_id=current_user)
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
        file_info = await file_service.get_file_info(file_id, owner_id=current_user)
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
        file_info = await file_service.get_file_info(file_id, owner_id=current_user)
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
        count = await file_service.delete_all(owner_id=current_user)
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
        file_info = await file_service.get_file_info(file_id, owner_id=current_user)

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
        file_info = await file_service.get_file_info(file_id, owner_id=current_user)
        
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


@router.post("/folders", response_model=FileInfo)
async def create_folder(request: CreateFolderRequest, current_user: int = Depends(get_current_user)):
    try:
        file_service = get_file_service()
        folder = await file_service.create_folder(request.name, request.parent_id, owner_id=current_user)
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
            owner_id=current_user,
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
        file_info = await file_service.get_file_info(folder_id, owner_id=current_user)

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
        rows = await db.get_files_by_split_group(split_group_id, owner_id=current_user)

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
