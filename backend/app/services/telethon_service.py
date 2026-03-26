from typing import Optional
import os
import io
from datetime import datetime, timedelta
import hashlib

from telethon import TelegramClient, types
from telethon.tl.functions.upload import GetFileRequest
from telethon.sessions import StringSession
from loguru import logger

from app.services.config import get_settings


class TelethonService:
    def __init__(self, session_string: Optional[str] = None):
        settings = get_settings()
        
        if session_string:
            self.client = TelegramClient(
                session=StringSession(session_string),
                api_id=settings.telegram_api_id,
                api_hash=settings.telegram_api_hash
            )
        else:
            self.client = TelegramClient(
                session="memory",
                api_id=settings.telegram_api_id,
                api_hash=settings.telegram_api_hash
            )
        
        self._connected = False
        logger.info("Telethon service initialized")
    
    async def connect(self):
        if not self._connected:
            await self.client.start()
            self._connected = True
            logger.info("Telethon MTProto connection established")
    
    async def disconnect(self):
        if self._connected:
            await self.client.disconnect()
            self._connected = False
    
    async def get_file_info(self, message_id: int) -> dict:
        try:
            if not self._connected:
                await self.connect()
            
            message = await self.client.get_messages("me", ids=message_id)
            
            if not message:
                raise ValueError(f"Message {message_id} not found")
            
            document = getattr(message, 'document', None)
            if not document:
                raise ValueError("No document in message")
            
            attrs = {"file_id": str(document.id)}
            
            for attr in document.attributes:
                if hasattr(attr, 'file_name') and attr.file_name:
                    attrs['filename'] = attr.file_name
                    break
            
            return attrs
            
        except Exception as e:
            logger.error(f"Failed to get file info: {e}")
            raise
    
    async def delete_message(self, message_id: int) -> bool:
        try:
            if not self._connected:
                await self.connect()
            await self.client.delete_messages('me', [message_id])
            return True
        except Exception as e:
            logger.error(f"Failed to delete message: {e}")
            return False

    async def upload_file(self, file_path: str, original_filename: str = None, progress_callback=None) -> dict:
        """Upload a local file to Telegram Saved Messages via Telethon.
        Returns: dict with message_id, file_id, access_hash, size, mime_type, filename
        """
        try:
            if not self._connected:
                await self.connect()

            filename_to_use = original_filename or os.path.basename(file_path)
            
            ext = os.path.splitext(file_path)[1].lower()
            mime_map = {
                '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
                '.gif': 'image/gif', '.webp': 'image/webp',
                '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
            }
            mime = mime_map.get(ext, '')
            is_image = mime.startswith('image/')
            is_video = mime.startswith('video/')
            
            if is_image:
                message = await self.client.send_file(
                    entity='me',
                    file=file_path,
                    force_document=False,
                    progress_callback=progress_callback
                )
            elif is_video:
                message = await self.client.send_file(
                    entity='me',
                    file=file_path,
                    force_document=False,
                    progress_callback=progress_callback
                )
            else:
                message = await self.client.send_file(
                    entity='me',
                    file=file_path,
                    force_document=True,
                    attributes=[
                        types.DocumentAttributeFilename(file_name=filename_to_use)
                    ],
                    progress_callback=progress_callback
                )

            document = getattr(message, 'document', None)
            if document is None and getattr(message, 'media', None) is not None:
                document = getattr(message.media, 'document', None)

            photo = getattr(message, 'photo', None)

            if document is None and photo is None:
                raise ValueError("Upload completed but no document or photo found in Telegram message")

            if photo:
                file_id = str(photo.id)
                access_hash = None
                size = getattr(photo.sizes[-1], 'size', None) if hasattr(photo, 'sizes') and photo.sizes else None
                mime_type = mime or 'image/jpeg'
                message_id = getattr(message, 'id', None)
            else:
                file_id = str(document.id)
                access_hash = str(document.access_hash) if hasattr(document, 'access_hash') else None
                size = getattr(document, 'size', None)
                mime_type = getattr(document, 'mime_type', None)
                message_id = getattr(message, 'id', None)
                filename = None
                if hasattr(document, 'attributes'):
                    for attr in document.attributes:
                        if hasattr(attr, 'file_name') and attr.file_name:
                            filename = attr.file_name
                            break

            return {
                "message_id": int(message_id) if message_id is not None else None,
                "file_id": file_id,
                "access_hash": access_hash,
                "size": size,
                "mime_type": mime_type,
                "filename": filename if filename else filename_to_use,
            }
        except Exception as e:
            logger.error(f"MTProto upload failed: {e}")
            raise

    async def upload_thumbnail(self, file_path: str, original_filename: str = "thumbnail.jpg", progress_callback=None) -> dict:
        """Upload a thumbnail image to Telegram Saved Messages.
        Returns: dict with message_id, file_id
        """
        try:
            if not self._connected:
                await self.connect()

            message = await self.client.send_file(
                entity='me',
                file=file_path,
                force_document=False,
                progress_callback=progress_callback
            )

            photo = getattr(message, 'photo', None)
            if photo:
                file_id = str(photo.id)
                message_id = getattr(message, 'id', None)
            else:
                document = getattr(message, 'document', None)
                if document is None and getattr(message, 'media', None) is not None:
                    document = getattr(message.media, 'document', None)
                file_id = str(document.id) if document else None
                message_id = getattr(message, 'id', None)

            logger.info(f"Thumbnail uploaded: message_id={message_id}, file_id={file_id}")

            return {
                "message_id": int(message_id) if message_id is not None else None,
                "file_id": file_id,
            }
        except Exception as e:
            logger.error(f"Thumbnail upload failed: {e}")
            raise

    async def download_file(self, message_id: int, offset: int = 0, limit: Optional[int] = None) -> bytes:
        """Download file content from Telegram message.
        
        Args:
            message_id: Telegram message ID
            offset: Byte offset to start from (default 0)
            limit: Max bytes to download. None means from offset to EOF.
        
        Returns:
            File bytes (full file if no offset/limit, or partial chunk)
        """
        try:
            if not self._connected:
                await self.connect()

            message = await self.client.get_messages("me", ids=message_id)
            
            if not message:
                raise ValueError(f"Message {message_id} not found")
            
            # Determine the file size
            size = 0
            if getattr(message, 'document', None):
                size = getattr(message.document, 'size', 0) or 0
            elif getattr(message, 'photo', None):
                size = getattr(message.photo, 'size', 0) or 0
            
            # Handle offset beyond file size
            if offset >= size:
                return b''
            
            # Use GetFileRequest for partial downloads (offset != 0 or limit is set)
            if offset > 0 or limit is not None:
                remaining_bytes = size - offset
                
                # For small files (< 512KB), use download_media instead
                if remaining_bytes < 512 * 1024:
                    buffer = io.BytesIO()
                    await self.client.download_media(message, file=buffer)
                    data = buffer.getvalue()
                    return data[offset:] if offset > 0 else data
                
                # Telegram rejects GetFileRequest when limit >= remaining bytes
                # So we request one less byte to bypass this restriction
                if limit is None or limit >= remaining_bytes:
                    chunk_size = remaining_bytes - 1
                else:
                    # Telegram requires minimum 512KB limit for GetFileRequest
                    chunk_size = max(limit, 512 * 1024)
                
                # Determine location type based on message content
                if getattr(message, 'document', None):
                    from telethon.tl.types import InputDocumentFileLocation
                    doc = message.document
                    file_ref = bytes(doc.file_reference) if hasattr(doc, 'file_reference') and doc.file_reference else b''
                    location = InputDocumentFileLocation(
                        id=doc.id,
                        access_hash=doc.access_hash,
                        file_reference=file_ref,
                        thumb_size=''
                    )
                elif getattr(message, 'photo', None):
                    from telethon.tl.types import InputPhotoFileLocation
                    photo = message.photo
                    file_ref = bytes(photo.file_reference) if hasattr(photo, 'file_reference') and photo.file_reference else b''
                    location = InputPhotoFileLocation(
                        id=photo.id,
                        access_hash=photo.access_hash,
                        file_reference=file_ref,
                        thumb_size=''
                    )
                else:
                    raise ValueError("Message has no document or photo")
                
                result = await self.client(GetFileRequest(
                    location=location,
                    offset=offset,
                    limit=chunk_size
                ))
                
                if hasattr(result, 'bytes'):
                    return bytes(result.bytes)
                elif isinstance(result, bytes):
                    return result
                else:
                    return b''
            
            # Default: full file download via download_media
            buffer = io.BytesIO()
            await self.client.download_media(message, file=buffer)
            return buffer.getvalue()
            
        except Exception as e:
            logger.error(f"Failed to download file: {e}")
            raise


_telethon_service: Optional[TelethonService] = None


async def get_telethon_service() -> TelethonService:
    global _telethon_service
    settings = get_settings()
    
    if _telethon_service is None:
        _telethon_service = TelethonService(
            session_string=settings.telegram_session_string
        )
    return _telethon_service
