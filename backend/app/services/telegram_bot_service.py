"""
Telegram MTProto Service

Uses Telethon for direct MTProto connections to Telegram.
No Docker or Bot API Server required - connects directly via WebSocket.
"""
import os
from typing import Optional
from datetime import datetime, timedelta
import asyncio
import hashlib

from telethon import TelegramClient
from telethon.sessions import StringSession
from telethon.tl.types import Document, Message
from telethon.tl.functions.upload import GetFileRequest
from loguru import logger

from app.services.config import get_settings


class TelegramMTProtoService:
    """
    Service for MTProto interactions - enables direct uploads/downloads.
    
    Connects directly to Telegram via WebSocket (MTProto).
    No Docker or Bot API Server required.
    """
    
    def __init__(self):
        settings = get_settings()
        self.api_id = settings.telegram_api_id
        self.api_hash = settings.telegram_api_hash
        self.session_string = settings.telegram_session_string
        
        self._client: Optional[TelegramClient] = None
        self._connected = False
        logger.info("MTProto service initialized (no Docker required)")
    
    async def connect(self) -> TelegramClient:
        """Establish MTProto connection."""
        if self._client is None:
            # Use session string if provided, otherwise create memory session
            if self.session_string:
                self._client = TelegramClient(
                    session=StringSession(self.session_string),
                    api_id=self.api_id,
                    api_hash=self.api_hash
                )
            else:
                # Memory session - requires manual auth
                self._client = TelegramClient(
                    session="memory",
                    api_id=self.api_id,
                    api_hash=self.api_hash
                )
        
        if not self._connected:
            await self._client.start()
            self._connected = True
            logger.info("MTProto connection established via WebSocket")
        
        return self._client
    
    async def disconnect(self):
        """Close MTProto connection."""
        if self._client and self._connected:
            await self._client.disconnect()
            self._connected = False
            self._client = None
            logger.info("MTProto connection closed")
    
    async def upload_file(
        self,
        file_content: bytes,
        filename: str,
        mime_type: Optional[str] = None
    ) -> dict:
        """
        Upload a file to Telegram using MTProto.
        Sends to "Saved Messages" (me).
        
        Args:
            file_content: File bytes
            filename: Original filename
            mime_type: MIME type (optional)
        
        Returns:
            dict with file_id, message_id, filesize, etc.
        """
        try:
            client = await self.connect()
            
            # Create file-like object
            from io import BytesIO
            file_stream = BytesIO(file_content)
            
            # Upload to Saved Messages
            message: Message = await client.send_file(
                entity='me',
                file=file_stream,
                filename=filename,
                caption=filename
            )
            
            # Extract file info from the message
            document: Optional[Document] = None
            if message.document:
                document = message.document
            elif message.media and hasattr(message.media, 'document'):
                document = message.media.document
            
            if not document:
                raise ValueError("Upload succeeded but no document in message")
            
            file_id = str(document.id)
            file_size = document.size
            
            logger.info(
                f"File uploaded via MTProto: {filename}, "
                f"file_id: {file_id}, size: {file_size}"
            )
            
            return {
                "file_id": file_id,
                "message_id": message.id,
                "filesize": file_size,
                "filename": filename,
                "mime_type": mime_type or (document.mime_type if document else None),
                "access_hash": str(document.access_hash) if document else None,
            }
            
        except Exception as e:
            logger.error(f"MTProto upload failed: {e}")
            raise
    
    async def get_file_info(self, message_id: int) -> dict:
        """Get detailed file info from a message."""
        try:
            client = await self.connect()
            
            message: Optional[Message] = await client.get_messages('me', ids=message_id)
            
            if not message:
                raise ValueError(f"Message {message_id} not found")
            
            document = message.document
            if not document:
                raise ValueError("No document in message")
            
            return {
                "file_id": str(document.id),
                "access_hash": str(document.access_hash),
                "file_size": document.size,
                "mime_type": document.mime_type,
                "filename": self._extract_filename(document),
            }
            
        except Exception as e:
            logger.error(f"Failed to get file info: {e}")
            raise
    
    def _extract_filename(self, document: Document) -> str:
        """Extract filename from document attributes."""
        for attr in document.attributes:
            if hasattr(attr, 'file_name') and attr.file_name:
                return attr.file_name
        return f"file_{document.id}"
    
    async def get_download_url(
        self,
        file_id: str,
        access_hash: str,
        size: int
    ) -> str:
        """
        Get a direct download URL for a file.
        
        Note: For MTProto, we don't get a CDN URL directly.
        Instead, we return a URL that the frontend can use with GetFile.
        For now, returns a placeholder - actual download uses stream.
        """
        # Generate a signed URL pattern
        # In practice, the frontend will use GetFile RPC
        token = hashlib.sha256(
            f"{file_id}:{access_hash}:{datetime.utcnow().timestamp()}".encode()
        ).hexdigest()[:16]
        
        # This will be resolved by the frontend using MTProto GetFile
        return f"/api/v1/download/stream/{file_id}"
    
    async def delete_file(self, message_id: int) -> bool:
        """Delete a message containing a file."""
        try:
            client = await self.connect()
            await client.delete_messages('me', [message_id])
            logger.info(f"File deleted: message_id={message_id}")
            return True
        except Exception as e:
            logger.error(f"Failed to delete file: {e}")
            return False
    
    async def download_file(self, file_id: str, access_hash: str, offset: int = 0, limit: int = 1024 * 1024) -> bytes:
        """
        Download a file chunk using MTProto.
        
        Args:
            file_id: Telegram file ID
            access_hash: File access hash
            offset: Byte offset
            limit: Max bytes to download
        
        Returns:
            File bytes
        """
        try:
            client = await self.connect()
            
            from telethon.tl.types import InputDocumentFileLocation
            
            location = InputDocumentFileLocation(
                id=int(file_id),
                access_hash=int(access_hash),
                file_reference=b'',
                thumb_size=''
            )
            
            result = await client.invoke(GetFileRequest(
                location=location,
                offset=offset,
                limit=limit
            ))
            
            if hasattr(result, 'bytes'):
                return bytes(result.bytes)
            elif isinstance(result, bytes):
                return result
            else:
                return b''
                
        except Exception as e:
            logger.error(f"Failed to download file: {e}")
            raise

    async def get_thumbnail(self, message_id: int) -> Optional[str]:
        """
        Get thumbnail for a message containing an image or video.
        Returns base64 encoded thumbnail.
        """
        try:
            import base64
            from telethon.tl.types import InputPhotoFileLocation, InputDocumentFileLocation
            client = await self.connect()
            
            message = await client.get_messages('me', ids=message_id)
            if not message:
                logger.error(f"Thumbnail: Message {message_id} not found")
                return None
            
            photo = getattr(message, 'photo', None)
            if photo:
                logger.info(f"Thumbnail: Found photo on message {message_id}")
                sizes = getattr(photo, 'sizes', [])
                photo_access_hash = getattr(photo, 'access_hash', 0) or 0
                photo_file_ref = getattr(photo, 'file_reference', b'') or b''
                logger.info(f"Thumbnail: Photo sizes count = {len(sizes)}, photo.id = {photo.id}, access_hash = {photo_access_hash}, file_ref = {photo_file_ref[:20] if photo_file_ref else 'empty'}")
                
                if sizes:
                    largest = None
                    for s in sizes:
                        stype = getattr(s, 'type', '')
                        size_val = getattr(s, 'size', 0)
                        logger.info(f"Thumbnail:   size type={stype}, size={size_val}")
                        if isinstance(stype, str) and stype.lower() in ['y', 'm']:
                            largest = s
                            if stype.lower() == 'y':
                                break
                    if not largest:
                        largest = sizes[-1]
                    
                    thumb_size = getattr(largest, 'type', '')
                    
                    input_loc = InputPhotoFileLocation(
                        id=photo.id,
                        access_hash=photo_access_hash,
                        file_reference=photo_file_ref,
                        thumb_size=thumb_size
                    )
                    
                    logger.info(f"Thumbnail: Invoking GetFileRequest with InputPhotoFileLocation")
                    result = await client.invoke(GetFileRequest(
                        location=input_loc,
                        offset=0,
                        limit=256 * 1024
                    ))
                    if hasattr(result, 'bytes') and result.bytes:
                        logger.info(f"Thumbnail: Successfully got {len(result.bytes)} bytes")
                        return base64.b64encode(bytes(result.bytes)).decode()
                    else:
                        logger.warning(f"Thumbnail: GetFileRequest returned no bytes")
            
            media = getattr(message, 'media', None)
            if media:
                if hasattr(media, 'photo') and media.photo:
                    photo = media.photo
                    sizes = getattr(photo, 'sizes', [])
                    if sizes:
                        largest = sizes[-1]
                        thumb_size = getattr(largest, 'type', '')
                        input_loc = InputPhotoFileLocation(
                            id=photo.id,
                            access_hash=getattr(photo, 'access_hash', 0) or 0,
                            file_reference=getattr(photo, 'file_reference', b'') or b'',
                            thumb_size=thumb_size
                        )
                        result = await client.invoke(GetFileRequest(
                            location=input_loc,
                            offset=0,
                            limit=256 * 1024
                        ))
                        if hasattr(result, 'bytes') and result.bytes:
                            return base64.b64encode(bytes(result.bytes)).decode()
                
                doc = getattr(media, 'document', None)
                if doc:
                    thumb = getattr(doc, 'thumb', None)
                    if thumb:
                        loc = getattr(thumb, 'location', None)
                        if loc:
                            result = await client.invoke(GetFileRequest(
                                location=loc,
                                offset=0,
                                limit=256 * 1024
                            ))
                            if hasattr(result, 'bytes') and result.bytes:
                                return base64.b64encode(bytes(result.bytes)).decode()
            
            logger.warning(f"Thumbnail: No thumbnail data found for message {message_id}")
            return None
            
        except Exception as e:
            logger.error(f"Failed to get thumbnail: {e}")
            import traceback
            traceback.print_exc()
            return None


# Singleton instance
_mtproto_service: Optional[TelegramMTProtoService] = None


async def get_bot_service() -> TelegramMTProtoService:
    """Get or create the MTProto service instance."""
    global _mtproto_service
    if _mtproto_service is None:
        _mtproto_service = TelegramMTProtoService()
    return _mtproto_service


async def close_bot_service():
    """Close the MTProto service."""
    global _mtproto_service
    if _mtproto_service:
        await _mtproto_service.disconnect()
        _mtproto_service = None
