"""login() must accept both session formats: browsers send GramJS strings, non-browser
clients (generate_session.py, the WebDAV bridge) send Telethon StringSessions.

Both formats start with '1', so the GramJS parser cannot be trusted to reject a Telethon
string by prefix alone — it has to actually fail and fall through. These tests pin that
fall-through, and that a keyless session is rejected before any Telegram handshake.
"""
import base64
import struct

from telethon.crypto import AuthKey
from telethon.sessions import MemorySession, StringSession

from app.api.routes import _parse_gramjs_session

AUTH_KEY = bytes(range(256))
DC, ADDR, PORT = 2, "149.154.167.51", 443


def _parse_like_login(session_string):
    """Mirror of the session-parsing branch in routes.login()."""
    try:
        return _parse_gramjs_session(session_string), "gramjs"
    except Exception:
        session = StringSession(session_string)
        if not session.auth_key:
            raise ValueError("Invalid session")  # login() raises HTTP 401 here
        return session, "telethon"


def _gramjs_string():
    addr = ADDR.encode()
    raw = bytes([DC]) + struct.pack(">H", len(addr)) + addr + struct.pack(">H", PORT) + AUTH_KEY
    return "1" + base64.b64encode(raw).decode().rstrip("=")


def _telethon_string():
    s = StringSession()
    s.set_dc(DC, ADDR, PORT)
    s.auth_key = AuthKey(AUTH_KEY)
    return s.save()


def test_gramjs_session_still_uses_the_gramjs_branch():
    session, branch = _parse_like_login(_gramjs_string())
    assert branch == "gramjs"
    assert isinstance(session, MemorySession)
    assert session.auth_key.key == AUTH_KEY
    assert (session.dc_id, session.server_address, session.port) == (DC, ADDR, PORT)


def test_telethon_session_falls_through_to_stringsession():
    session, branch = _parse_like_login(_telethon_string())
    assert branch == "telethon"
    assert session.auth_key.key == AUTH_KEY
    assert (session.dc_id, session.server_address, session.port) == (DC, ADDR, PORT)


def test_keyless_or_garbage_session_is_rejected_without_connecting():
    for bad in ("", "nonsense", "1!!!!"):
        try:
            _parse_like_login(bad)
        except Exception:
            continue
        raise AssertionError(f"garbage accepted: {bad!r}")
