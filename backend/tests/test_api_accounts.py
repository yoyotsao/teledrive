"""/accounts — linking a second Telegram account to a drive, and unlinking it.

The walls here are the same ones test_linked_accounts.py pins at the database
layer; this file proves the HTTP endpoints actually enforce them.
"""
from conftest import OWNER_A, OWNER_B

A_SECOND = 3003  # a second Telegram account, not yet linked anywhere


def test_accounts_lists_only_this_drives_accounts(client, db, run):
    run(db.link_account(OWNER_A, OWNER_A, is_primary=True, label="a-primary"))
    run(db.link_account(OWNER_A, A_SECOND, label="a-second"))
    run(db.link_account(OWNER_B, OWNER_B, is_primary=True, label="b-primary"))

    accounts = client.get("/api/v1/accounts").json()["accounts"]

    assert [a["telegram_user_id"] for a in accounts] == [OWNER_A, A_SECOND]


def test_accounts_reports_how_many_files_each_one_stores(client, db, run, make_file):
    """The settings UI needs this to explain why an unlink is refused."""
    run(db.link_account(OWNER_A, OWNER_A, is_primary=True))
    run(db.link_account(OWNER_A, A_SECOND))
    make_file("f1", telegram_user_id=A_SECOND)
    make_file("f2", telegram_user_id=A_SECOND)

    accounts = client.get("/api/v1/accounts").json()["accounts"]

    assert {a["telegram_user_id"]: a["file_count"] for a in accounts} == {OWNER_A: 0, A_SECOND: 2}


def test_link_challenge_needs_a_bot_too(client, bot_login):
    assert client.post("/api/v1/accounts/challenge").status_code == 200

    bot_login.disable_bot()
    assert client.post("/api/v1/accounts/challenge").status_code == 503


def test_linking_waits_for_the_dm_then_attaches_the_account(client, bot_login, db, run):
    nonce = client.post("/api/v1/accounts/challenge").json()["nonce"]
    assert client.post("/api/v1/accounts/verify", json={"nonce": nonce}).status_code == 202

    bot_login.deliver(nonce, user_id=A_SECOND, username="second")
    resp = client.post("/api/v1/accounts/verify", json={"nonce": nonce})

    assert resp.status_code == 200, resp.text
    assert resp.json() == {
        "telegram_user_id": A_SECOND,
        "label": "second",
        "is_primary": 0,
        "file_count": 0,
    }
    assert run(db.get_owner_of(A_SECOND)) == OWNER_A


def test_relinking_an_account_this_drive_already_has_is_a_conflict(client, bot_login, db, run):
    run(db.link_account(OWNER_A, A_SECOND))
    nonce = client.post("/api/v1/accounts/challenge").json()["nonce"]
    bot_login.deliver(nonce, user_id=A_SECOND)

    resp = client.post("/api/v1/accounts/verify", json={"nonce": nonce})

    assert resp.status_code == 409
    assert "already linked to your drive" in resp.json()["detail"]


def test_an_account_cannot_be_stolen_from_another_drive(client, bot_login, db, run):
    """This is the wall that stops drive A from reading drive B's files by
    linking B's storage account to itself."""
    run(db.link_account(OWNER_B, A_SECOND))
    nonce = client.post("/api/v1/accounts/challenge").json()["nonce"]
    bot_login.deliver(nonce, user_id=A_SECOND)

    resp = client.post("/api/v1/accounts/verify", json={"nonce": nonce})

    assert resp.status_code == 409
    assert run(db.get_owner_of(A_SECOND)) == OWNER_B


def test_unlinking_an_account_of_someone_elses_drive_is_a_404(client, db, run):
    run(db.link_account(OWNER_B, A_SECOND))

    resp = client.delete("/api/v1/accounts/%d" % A_SECOND)

    assert resp.status_code == 404
    assert run(db.get_owner_of(A_SECOND)) == OWNER_B


def test_the_primary_account_cannot_be_unlinked(client, db, run):
    run(db.link_account(OWNER_A, OWNER_A, is_primary=True))

    resp = client.delete("/api/v1/accounts/%d" % OWNER_A)

    assert resp.status_code == 409
    assert "primary" in resp.json()["detail"]


def test_unlink_is_refused_while_files_still_live_on_that_account(client, db, run, make_file):
    """access_hash is account-scoped: unlinking would make those files
    permanently undownloadable, so the endpoint has to say no."""
    run(db.link_account(OWNER_A, OWNER_A, is_primary=True))
    run(db.link_account(OWNER_A, A_SECOND))
    make_file("stored_there", telegram_user_id=A_SECOND)

    resp = client.delete("/api/v1/accounts/%d" % A_SECOND)

    assert resp.status_code == 409
    assert "1 file(s)" in resp.json()["detail"]
    assert run(db.get_owner_of(A_SECOND)) == OWNER_A


def test_an_empty_secondary_account_unlinks_cleanly(client, db, run):
    run(db.link_account(OWNER_A, OWNER_A, is_primary=True))
    run(db.link_account(OWNER_A, A_SECOND))

    resp = client.delete("/api/v1/accounts/%d" % A_SECOND)

    assert resp.status_code == 200
    assert run(db.get_owner_of(A_SECOND)) is None
