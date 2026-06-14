"""Per-user Telethon session store for multi-user support."""
from typing import Dict, Optional

from telethon import TelegramClient
from loguru import logger

_sessions: Dict[int, TelegramClient] = {}


async def store_user_session(telegram_user_id: int, client: TelegramClient) -> None:
    """Store an already-connected Telethon client for the given user."""
    old = _sessions.get(telegram_user_id)
    if old is not None and old is not client:
        try:
            await old.disconnect()
        except Exception:
            pass
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
