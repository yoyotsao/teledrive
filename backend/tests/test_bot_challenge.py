"""Each test here pins one security property of the login challenge.

If any of them starts passing for the wrong reason, someone can log in as
someone else — so they assert intent, not just mechanics.
"""
import time

import pytest

from app.services import bot_challenge


@pytest.fixture(autouse=True)
def clean_state():
    bot_challenge._pending.clear()
    bot_challenge._verified.clear()
    yield
    bot_challenge._pending.clear()
    bot_challenge._verified.clear()


def update(nonce, user_id=42, username="alice", first_name="Alice"):
    return {
        "update_id": 1,
        "message": {
            "message_id": 7,
            "text": nonce,
            "from": {"id": user_id, "username": username, "first_name": first_name},
        },
    }


def test_verified_nonce_carries_the_senders_identity():
    """The JWT must be bound to whoever sent the message, not to anyone else."""
    nonce = bot_challenge.new_challenge()
    bot_challenge.ingest_updates([update(nonce, user_id=12345, username="bob", first_name="Bob")])

    entry = bot_challenge.take_verified(nonce)
    assert entry["user_id"] == 12345
    assert entry["username"] == "bob"
    assert entry["first_name"] == "Bob"


def test_nonce_can_only_be_redeemed_once():
    """Replaying a nonce must not mint a second JWT."""
    nonce = bot_challenge.new_challenge()
    bot_challenge.ingest_updates([update(nonce)])

    assert bot_challenge.take_verified(nonce) is not None
    assert bot_challenge.take_verified(nonce) is None


def test_expired_nonce_is_not_redeemable():
    """A nonce overheard in transit must not stay usable indefinitely."""
    nonce = bot_challenge.new_challenge()
    bot_challenge.ingest_updates([update(nonce)])
    bot_challenge._verified[nonce]["expires"] = time.time() - 1

    assert bot_challenge.take_verified(nonce) is None


def test_unknown_nonce_never_becomes_verified():
    """Guessing at nonces must not accidentally authenticate anybody."""
    bot_challenge.new_challenge()
    bot_challenge.ingest_updates([update("not-a-real-nonce")])

    assert bot_challenge._verified == {}
    assert bot_challenge.take_verified("not-a-real-nonce") is None
