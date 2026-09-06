from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import HTTPException, Header
import jwt
from app.services.config import get_settings

JWT_SECRET = get_settings().jwt_secret
JWT_ALGORITHM = "HS256"
JWT_EXPIRE_HOURS = 24
# An expired access token may be exchanged only during this bounded window.
# The browser keeps the token in IndexedDB, so a separate refresh token would
# have the same XSS exposure while adding another credential to manage.
JWT_REFRESH_GRACE_DAYS = 30


def create_jwt(owner_id: int, acting_account_id: Optional[int] = None) -> str:
    """user_id is the drive (owner). acting_account_id records which linked
    Telegram account actually logged in — for logs and the settings UI only;
    it grants nothing on its own."""
    payload = {
        "user_id": owner_id,
        "acting_account_id": acting_account_id if acting_account_id is not None else owner_id,
        "exp": datetime.now(timezone.utc) + timedelta(hours=JWT_EXPIRE_HOURS),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_jwt(token: str) -> int:
    try:
        payload = jwt.decode(
            token,
            JWT_SECRET,
            algorithms=[JWT_ALGORITHM],
            options={"require": ["exp", "user_id"]},
        )
        return int(payload["user_id"])
    except (jwt.PyJWTError, KeyError, ValueError):
        raise HTTPException(status_code=401, detail="Invalid or expired token")


def refresh_jwt(token: str) -> str:
    """Exchange a correctly signed, recently expired token for a new one.

    Signature verification always stays enabled. Expiry verification is
    deferred just long enough to enforce the explicit refresh grace period.
    Existing tokens already carry ``exp``, so this also works for tokens minted
    before the refresh endpoint was deployed.
    """
    try:
        payload = jwt.decode(
            token,
            JWT_SECRET,
            algorithms=[JWT_ALGORITHM],
            options={"require": ["exp", "user_id"], "verify_exp": False},
        )
        owner_id = int(payload["user_id"])
        acting_account_id = int(payload.get("acting_account_id", owner_id))
        expires_at = datetime.fromtimestamp(float(payload["exp"]), timezone.utc)
        if datetime.now(timezone.utc) > expires_at + timedelta(days=JWT_REFRESH_GRACE_DAYS):
            raise ValueError("Refresh window expired")
    except (jwt.PyJWTError, KeyError, TypeError, ValueError, OverflowError, OSError):
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    return create_jwt(owner_id, acting_account_id=acting_account_id)


async def get_current_user(authorization: Optional[str] = Header(None)) -> int:
    """FastAPI dependency: extracts the drive's owner_id from the Bearer token."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Authentication required")
    token = authorization.removeprefix("Bearer ")
    return decode_jwt(token)
