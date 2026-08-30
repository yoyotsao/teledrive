"""DELETE /files/{id} → restore → purge.

Deleting is a soft delete on purpose: the Telegram messages survive, so a
restore costs nothing. Purge is irreversible only for SQLite metadata; the
backend never opens a Telegram session or deletes Telegram messages.
"""
from conftest import OWNER_A, OWNER_B


def test_deleting_moves_the_whole_subtree_to_the_trash(client, make_file):
    make_file("folder", is_dir=True)
    make_file("file_a", parent_id="folder")
    make_file("sub", parent_id="folder", is_dir=True)
    make_file("file_b", parent_id="sub")
    make_file("unrelated")

    resp = client.delete("/api/v1/files/folder")

    assert resp.status_code == 200
    assert resp.json()["items_trashed"] == 4
    assert [f["file_id"] for f in client.get("/api/v1/files").json()["files"]] == ["unrelated"]


def test_deleting_keeps_the_metadata_needed_for_restore(client, make_file, db, run):
    """Soft delete keeps the Telegram coordinates in the trashed metadata."""
    make_file("f1", telegram_message_id=11)

    client.delete("/api/v1/files/f1")

    assert run(db.get_file("f1"))["telegram_message_id"] == 11


def test_deleting_a_missing_file_is_a_404(client):
    assert client.delete("/api/v1/files/nope").status_code == 404


def test_one_drive_cannot_trash_anothers_file(client, make_file, db, run):
    make_file("b_file", owner_id=OWNER_B)

    resp = client.delete("/api/v1/files/b_file")

    assert resp.status_code == 404
    assert run(db.get_file("b_file"))["trashed_at"] is None


def test_restore_brings_the_whole_subtree_back(client, make_file):
    make_file("folder", is_dir=True)
    make_file("nested", parent_id="folder")
    client.delete("/api/v1/files/folder")

    resp = client.post("/api/v1/files/folder/restore")

    assert resp.status_code == 200
    assert resp.json()["trashed_at"] is None
    assert [f["file_id"] for f in
            client.get("/api/v1/files", params={"parent_id": "folder"}).json()["files"]] == ["nested"]


def test_restoring_an_item_whose_folder_is_gone_puts_it_at_the_root(client, make_file, db, run):
    """Otherwise the file comes back pointing at a parent that no longer exists
    and is invisible in every listing."""
    make_file("parent", is_dir=True)
    make_file("child", parent_id="parent")
    client.delete("/api/v1/files/child")
    run(db.delete_files_by_ids(["parent"], OWNER_A))

    body = client.post("/api/v1/files/child/restore").json()

    assert body["parent_id"] is None


def test_restoring_something_that_was_never_deleted_is_a_400(client, make_file):
    make_file("live")

    resp = client.post("/api/v1/files/live/restore")

    assert resp.status_code == 400


def test_restoring_a_missing_file_is_a_404(client):
    assert client.post("/api/v1/files/nope/restore").status_code == 404


def test_purge_deletes_only_metadata_and_returns_no_message_ids(client, make_file):
    make_file("folder", is_dir=True)
    make_file("file_a", parent_id="folder", telegram_message_id=11)
    make_file("sub", parent_id="folder", is_dir=True)
    make_file("file_b", parent_id="sub", telegram_message_id=21)
    make_file("unrelated", telegram_message_id=99)
    client.delete("/api/v1/files/folder")

    resp = client.delete("/api/v1/files/folder/purge")

    assert resp.status_code == 200
    assert resp.json()["records_deleted"] == 4
    assert "message_ids" not in resp.json()
    assert "retained" in resp.json()["message"].lower()
    assert client.get("/api/v1/files/unrelated").status_code == 200


def test_purge_does_not_require_a_telegram_service(client, make_file):
    make_file("f1", telegram_message_id=11)
    client.delete("/api/v1/files/f1")
    resp = client.delete("/api/v1/files/f1/purge")

    assert resp.status_code == 200
    assert client.get("/api/v1/files/f1").status_code == 404


def test_purging_a_missing_file_is_a_404(client):
    assert client.delete("/api/v1/files/nope/purge").status_code == 404


def test_one_drive_cannot_purge_anothers_file(client, make_file, db, run):
    make_file("b_file", owner_id=OWNER_B, telegram_message_id=11, trashed=True)

    resp = client.delete("/api/v1/files/b_file/purge")

    assert resp.status_code == 404
    assert run(db.get_file("b_file")) is not None


def test_the_trash_survives_a_round_trip(client, make_file):
    """Delete → it's in the trash; restore → it's back in the drive; and the
    two listings never both show it."""
    make_file("f1")

    client.delete("/api/v1/files/f1")
    assert client.get("/api/v1/files").json()["files"] == []
    assert [f["file_id"] for f in
            client.get("/api/v1/files", params={"trashed": True}).json()["files"]] == ["f1"]

    client.post("/api/v1/files/f1/restore")
    assert [f["file_id"] for f in client.get("/api/v1/files").json()["files"]] == ["f1"]
    assert client.get("/api/v1/files", params={"trashed": True}).json()["files"] == []
