"""Per-user Telethon session store for multi-user support."""
from typing import Dict, Optional

from telethon import TelegramClient
from telethon.sessions import StringSession
from loguru import logger

from app.services.config import get_settings

_sessions: Dict[int, TelegramClient] = {}


async def store_user_session(telegram_user_id: int, session_string: str) -> None:
    """Create and connect a Telethon client for the given user, replacing any prior client."""
    if telegram_user_id in _sessions:
        try:
            await _sessions[telegram_user_id].disconnect()
        except Exception:
            pass

    settings = get_settings()
    client = TelegramClient(
        StringSession(session_string),
        settings.telegram_api_id,
        settings.telegram_api_hash,
    )
    await client.connect()
    _sessions[telegram_user_id] = client
    logger.info(f"Stored Telethon session for user {telegram_user_id}")


def get_user_client(telegram_user_id: int) -> Optional[TelegramClient]:
    return _sessions.get(telegram_user_id)


async def disconnect_all() -> None:
    for client in _sessions.values():
        try:
            await client.disconnect()
        except Exception:
            pass
    _sessions.clear()
