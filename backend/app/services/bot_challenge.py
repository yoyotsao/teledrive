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
MAX_PENDING_CHALLENGES = 1000
MAX_VERIFIED_CHALLENGES = 1000
_API = "https://api.telegram.org/bot{token}/{method}"

_pending: dict[str, float] = {}   # nonce -> expiry timestamp
_verified: dict[str, dict] = {}   # nonce -> {user_id, username, first_name, expires}

bot_username: Optional[str] = None


class ChallengeCapacityError(RuntimeError):
    """The bounded in-memory challenge store is temporarily full."""


def _prune_expired(now: Optional[float] = None) -> None:
    """Remove expired entries from both stores before enforcing their caps."""
    current = time.time() if now is None else now
    for nonce, expiry in list(_pending.items()):
        if expiry <= current:
            del _pending[nonce]
    for nonce, entry in list(_verified.items()):
        if entry["expires"] <= current:
            del _verified[nonce]


def new_challenge() -> str:
    now = time.time()
    _prune_expired(now)
    if len(_pending) >= MAX_PENDING_CHALLENGES:
        raise ChallengeCapacityError("Too many active login challenges")
    nonce = secrets.token_urlsafe(16)
    _pending[nonce] = now + TTL_SECONDS
    return nonce


def is_pending(nonce: str) -> bool:
    """True while we're still waiting for this nonce's message to arrive."""
    _prune_expired()
    return nonce in _pending


def ingest_updates(updates: list) -> None:
    """Promote any pending nonce that arrived as a message text to verified."""
    _prune_expired()
    for update in updates:
        msg = update.get("message") or {}
        text = (msg.get("text") or "").strip()
        sender = msg.get("from") or {}
        expiry = _pending.get(text)
        if expiry is None or not sender.get("id"):
            continue
        if len(_verified) >= MAX_VERIFIED_CHALLENGES:
            logger.warning("Verified login challenge capacity reached; update ignored")
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
    _prune_expired()
    entry = _verified.pop(nonce, None)
    if entry is None:
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
