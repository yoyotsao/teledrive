"""Authentication endpoints over HTTP, plus the Bearer-token gate.

test_bot_challenge.py pins the nonce lifecycle as pure logic. This file pins
what the *endpoints* do with it: who gets a JWT, who gets 401, and what a
first-ever login leaves behind in the database.
"""
from datetime import datetime, timedelta, timezone

import pytest
import jwt

from conftest import OWNER_A
from app.auth import JWT_ALGORITHM, JWT_SECRET
from app.services import bot_challenge


def test_challenge_returns_a_nonce_and_the_bot_to_dm_it_to(anon_client, bot_login):
    resp = anon_client.post("/api/v1/auth/challenge")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["bot_username"] == "teledrive_test_bot"
    assert body["expires_in"] == 120
    assert len(body["nonce"]) > 10


def test_challenge_is_503_when_no_bot_is_configured(anon_client, bot_login):
    """Without TELEGRAM_BOT_TOKEN there is no way to log in, and the UI needs to
    be told that rather than shown a broken QR flow."""
    bot_login.disable_bot()

    resp = anon_client.post("/api/v1/auth/challenge")

    assert resp.status_code == 503
    assert "TELEGRAM_BOT_TOKEN" in resp.json()["detail"]


def test_challenge_returns_429_when_capacity_is_full(
    anon_client, bot_login, monkeypatch
):
    monkeypatch.setattr(bot_challenge, "MAX_PENDING_CHALLENGES", 1)
    assert anon_client.post("/api/v1/auth/challenge").status_code == 200

    resp = anon_client.post("/api/v1/auth/challenge")

    assert resp.status_code == 429


def test_verify_says_keep_waiting_until_the_dm_arrives(anon_client, bot_login):
    nonce = anon_client.post("/api/v1/auth/challenge").json()["nonce"]

    resp = anon_client.post("/api/v1/auth/verify", json={"nonce": nonce})

    assert resp.status_code == 202
    assert resp.json() == {"status": "waiting"}


def test_verify_rejects_a_nonce_nobody_issued(anon_client, bot_login):
    resp = anon_client.post("/api/v1/auth/verify", json={"nonce": "made-up"})

    assert resp.status_code == 401


def test_first_login_mints_a_token_and_opens_a_drive(anon_client, bot_login, db, run):
    """A brand-new account becomes its own drive's primary account — otherwise
    its very first upload would have nowhere to be attributed."""
    nonce = anon_client.post("/api/v1/auth/challenge").json()["nonce"]
    bot_login.deliver(nonce, user_id=777, username="ann", first_name="Ann")

    resp = anon_client.post("/api/v1/auth/verify", json={"nonce": nonce})

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["user_id"] == 777
    assert body["username"] == "ann"
    assert body["token"]

    accounts = run(db.list_linked_accounts(777))
    assert [(a["telegram_user_id"], a["is_primary"]) for a in accounts] == [(777, 1)]


def test_the_minted_token_actually_opens_that_drive(anon_client, bot_login, make_file):
    """The token has to carry the drive id, not just be well-formed."""
    make_file("mine.txt", owner_id=777)
    nonce = anon_client.post("/api/v1/auth/challenge").json()["nonce"]
    bot_login.deliver(nonce, user_id=777)
    token = anon_client.post("/api/v1/auth/verify", json={"nonce": nonce}).json()["token"]

    resp = anon_client.get("/api/v1/files", headers={"Authorization": "Bearer " + token})

    assert resp.status_code == 200
    assert [f["file_id"] for f in resp.json()["files"]] == ["mine.txt"]


def test_a_nonce_buys_exactly_one_token(anon_client, bot_login):
    """Replaying an intercepted nonce must not hand out a second session."""
    nonce = anon_client.post("/api/v1/auth/challenge").json()["nonce"]
    bot_login.deliver(nonce, user_id=777)
    assert anon_client.post("/api/v1/auth/verify", json={"nonce": nonce}).status_code == 200

    replay = anon_client.post("/api/v1/auth/verify", json={"nonce": nonce})

    assert replay.status_code == 401


def test_logging_in_again_keeps_the_same_drive(anon_client, bot_login, db, run):
    """A second login must reuse the existing drive, not create a duplicate."""
    for _ in range(2):
        nonce = anon_client.post("/api/v1/auth/challenge").json()["nonce"]
        bot_login.deliver(nonce, user_id=777)
        assert anon_client.post("/api/v1/auth/verify", json={"nonce": nonce}).status_code == 200

    assert len(run(db.list_linked_accounts(777))) == 1


@pytest.mark.parametrize(
    "header",
    [
        pytest.param(None, id="missing"),
        pytest.param("", id="empty"),
        pytest.param("Bearer not-a-jwt", id="garbage"),
        pytest.param("Bearer ", id="bearer-with-no-token"),
        # A valid-looking token that simply isn't ours (different secret).
        pytest.param(
            "Bearer eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyX2lkIjo5OTk5fQ.aaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            id="foreign-signature",
        ),
        # Right shape, wrong scheme.
        pytest.param("Basic dXNlcjpwYXNz", id="wrong-scheme"),
    ],
)
def test_a_bad_authorization_header_never_reaches_the_data(make_client, make_file, header):
    make_file("secret.txt", owner_id=OWNER_A)
    client = make_client()
    if header is not None:
        client.headers["Authorization"] = header

    resp = client.get("/api/v1/files")

    assert resp.status_code == 401
    assert "secret.txt" not in resp.text


def test_a_correctly_signed_token_without_expiry_is_rejected(make_client):
    token = jwt.encode({"user_id": OWNER_A}, JWT_SECRET, algorithm=JWT_ALGORITHM)
    client = make_client()
    client.headers["Authorization"] = "Bearer " + token

    response = client.get("/api/v1/files")

    assert response.status_code == 401


def _token_expired_at(owner_id: int, expired_at: datetime, *, acting_account_id: int | None = None):
    return jwt.encode(
        {
            "user_id": owner_id,
            "acting_account_id": acting_account_id if acting_account_id is not None else owner_id,
            "exp": expired_at,
        },
        JWT_SECRET,
        algorithm=JWT_ALGORITHM,
    )


def test_a_recently_expired_token_can_be_refreshed(anon_client):
    stale = _token_expired_at(
        777,
        datetime.now(timezone.utc) - timedelta(hours=1),
        acting_account_id=778,
    )

    resp = anon_client.post(
        "/api/v1/auth/refresh",
        headers={"Authorization": "Bearer " + stale},
    )

    assert resp.status_code == 200, resp.text
    payload = jwt.decode(resp.json()["token"], JWT_SECRET, algorithms=[JWT_ALGORITHM])
    assert payload["user_id"] == 777
    assert payload["acting_account_id"] == 778


def test_refresh_rejects_a_token_outside_the_grace_period(anon_client):
    stale = _token_expired_at(
        777,
        datetime.now(timezone.utc) - timedelta(days=31),
    )

    resp = anon_client.post(
        "/api/v1/auth/refresh",
        headers={"Authorization": "Bearer " + stale},
    )

    assert resp.status_code == 401


@pytest.mark.parametrize("header", [None, "", "Bearer garbage", "Basic abc"])
def test_refresh_never_accepts_a_missing_or_invalid_bearer_token(anon_client, header):
    headers = {"Authorization": header} if header is not None else {}

    resp = anon_client.post("/api/v1/auth/refresh", headers=headers)

    assert resp.status_code == 401
