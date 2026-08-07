"""Bot-mediated login challenge — the backend never sees a user's session string.

The user's own Telegram client DMs a one-time nonce to our bot. A background
long-poll of the Bot API's getUpdates tells us which account sent it, and that
update's `from` object *is* the proof of identity. No auth_key on the wire.

Network I/O lives only in init()/poll_loop(); the challenge lifecycle below is
pure so the security properties can be tested without touching Telegram.
"""
import asyncio
import secrets
import time
from typing import Optional

import httpx
from loguru import logger

from app.services.config import get_settings

TTL_SECONDS = 120
_API = "https://api.telegram.org/bot{token}/{method}"

_pending: dict[str, float] = {}   # nonce -> expiry timestamp
_verified: dict[str, dict] = {}   # nonce -> {user_id, username, first_name, expires}

bot_username: Optional[str] = None


def new_challenge() -> str:
    now = time.time()
    for nonce, expiry in list(_pending.items()):
        if expiry < now:
            del _pending[nonce]
    nonce = secrets.token_urlsafe(16)
    _pending[nonce] = now + TTL_SECONDS
    return nonce


def is_pending(nonce: str) -> bool:
    """True while we're still waiting for this nonce's message to arrive."""
    return _pending.get(nonce, 0) > time.time()


def ingest_updates(updates: list) -> None:
    """Promote any pending nonce that arrived as a message text to verified."""
    for update in updates:
        msg = update.get("message") or {}
        text = (msg.get("text") or "").strip()
        sender = msg.get("from") or {}
        expiry = _pending.get(text)
        if expiry is None or not sender.get("id"):
            continue
        del _pending[text]
        _verified[text] = {
            "user_id": sender["id"],
            "username": sender.get("username"),
            "first_name": sender.get("first_name"),
            "expires": expiry,
        }


def take_verified(nonce: str) -> Optional[dict]:
    """Pop — a nonce buys exactly one JWT, and only inside its TTL."""
    entry = _verified.pop(nonce, None)
    if entry is None or entry["expires"] < time.time():
        return None
    return entry


async def init() -> None:
    """Resolve the bot's username and drop any webhook. Called once at startup.

    A bot that ever had a webhook set answers getUpdates with 409 forever, so
    deleteWebhook is not optional.
    """
    global bot_username
    token = get_settings().telegram_bot_token
    async with httpx.AsyncClient(timeout=20) as http:
        me = (await http.get(_API.format(token=token, method="getMe"))).json()
        bot_username = me["result"]["username"]
        await http.get(_API.format(token=token, method="deleteWebhook"))
    logger.info(f"Bot challenge login ready: @{bot_username}")


async def poll_loop() -> None:
    """Single global getUpdates cursor — see the plan: per-request polling would
    let concurrent logins eat each other's updates."""
    token = get_settings().telegram_bot_token
    offset = 0
    async with httpx.AsyncClient(timeout=40) as http:
        while True:
            try:
                resp = await http.get(
                    _API.format(token=token, method="getUpdates"),
                    params={"offset": offset, "timeout": 25},
                )
                updates = resp.json().get("result") or []
                if updates:
                    offset = updates[-1]["update_id"] + 1
                    ingest_updates(updates)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning(f"getUpdates failed: {e}")
                await asyncio.sleep(3)
