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


def test_pending_store_is_bounded(monkeypatch):
    monkeypatch.setattr(bot_challenge, "MAX_PENDING_CHALLENGES", 2)
    bot_challenge.new_challenge()
    bot_challenge.new_challenge()

    with pytest.raises(bot_challenge.ChallengeCapacityError):
        bot_challenge.new_challenge()


def test_expired_entries_are_pruned_from_both_stores():
    now = time.time()
    bot_challenge._pending["expired-pending"] = now - 1
    bot_challenge._verified["expired-verified"] = {
        "user_id": 1,
        "expires": now - 1,
    }

    bot_challenge.new_challenge()

    assert "expired-pending" not in bot_challenge._pending
    assert "expired-verified" not in bot_challenge._verified


def test_verified_store_is_bounded(monkeypatch):
    monkeypatch.setattr(bot_challenge, "MAX_VERIFIED_CHALLENGES", 1)
    first = bot_challenge.new_challenge()
    second = bot_challenge.new_challenge()

    bot_challenge.ingest_updates([update(first), update(second, user_id=43)])

    assert list(bot_challenge._verified) == [first]
    assert second in bot_challenge._pending
