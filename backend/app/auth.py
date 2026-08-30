from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import HTTPException, Header
import jwt
from app.services.config import get_settings

JWT_SECRET = get_settings().jwt_secret
JWT_ALGORITHM = "HS256"
JWT_EXPIRE_HOURS = 24


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


async def get_current_user(authorization: Optional[str] = Header(None)) -> int:
    """FastAPI dependency: extracts the drive's owner_id from the Bearer token."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Authentication required")
    token = authorization.removeprefix("Bearer ")
    return decode_jwt(token)
