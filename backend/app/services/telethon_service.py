from typing import Optional
import os
from datetime import datetime, timedelta
import hashlib

from telethon import TelegramClient, types
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

            if document is None:
                raise ValueError("Upload completed but no document found in Telegram message")

            file_id = str(document.id)
            access_hash = str(document.access_hash) if hasattr(document, 'access_hash') else None
            size = getattr(document, 'size', None)
            mime_type = getattr(document, 'mime_type', None)

            # Get filename from document attributes, fallback to provided name
            filename = None
            if hasattr(document, 'attributes'):
                for attr in document.attributes:
                    if hasattr(attr, 'file_name') and attr.file_name:
                        filename = attr.file_name
                        break

            message_id = getattr(message, 'id', None)

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


_telethon_service: Optional[TelethonService] = None


async def get_telethon_service() -> TelethonService:
    global _telethon_service
    settings = get_settings()
    
    if _telethon_service is None:
        _telethon_service = TelethonService(
            session_string=settings.telegram_session_string
        )
    return _telethon_service
