"""/folders — the only rows in `files` with isDir = 1.

Folder creation is idempotent by design: a folder upload creates each directory
before the files inside it, and re-uploading the same tree must not fan out into
a second copy of the hierarchy.
"""
from conftest import OWNER_B


def test_creating_a_folder_returns_a_directory_row(client):
    body = client.post("/api/v1/folders", json={"name": "photos"}).json()

    assert body["filename"] == "photos"
    assert body["isDir"] is True
    assert body["filesize"] == 0
    assert body["telegram_message_id"] is None


def test_creating_the_same_folder_twice_reuses_the_first(client):
    """A re-uploaded folder tree must land in the existing folder, not beside it."""
    first = client.post("/api/v1/folders", json={"name": "photos"}).json()

    second = client.post("/api/v1/folders", json={"name": "photos"}).json()

    assert second["file_id"] == first["file_id"]
    assert len(client.get("/api/v1/folders").json()["files"]) == 1


def test_the_same_name_under_different_parents_is_a_different_folder(client):
    outer = client.post("/api/v1/folders", json={"name": "2026"}).json()

    nested = client.post("/api/v1/folders", json={"name": "2026", "parent_id": outer["file_id"]}).json()

    assert nested["file_id"] != outer["file_id"]
    assert nested["parent_id"] == outer["file_id"]


def test_listing_folders_is_scoped_to_one_parent(client):
    outer = client.post("/api/v1/folders", json={"name": "outer"}).json()
    client.post("/api/v1/folders", json={"name": "inner", "parent_id": outer["file_id"]})
    client.post("/api/v1/folders", json={"name": "sibling"})

    root = client.get("/api/v1/folders").json()
    inside = client.get("/api/v1/folders", params={"parent_id": outer["file_id"]}).json()

    assert sorted(f["filename"] for f in root["files"]) == ["outer", "sibling"]
    assert [f["filename"] for f in inside["files"]] == ["inner"]


def test_listing_folders_never_returns_files(client, make_file):
    client.post("/api/v1/folders", json={"name": "photos"})
    make_file("a_file")

    listing = client.get("/api/v1/folders").json()

    assert [f["filename"] for f in listing["files"]] == ["photos"]


def test_folders_are_not_shared_between_drives(client, make_file):
    make_file("b_folder", filename="theirs", is_dir=True, owner_id=OWNER_B)

    assert client.get("/api/v1/folders").json()["files"] == []


def test_deleting_a_folder_trashes_everything_under_it(client, make_file):
    """The bug this pins: deleting a folder once removed only the folder row,
    orphaning 97k+ descendant rows in SQLite."""
    make_file("folder", is_dir=True)
    make_file("file_a", parent_id="folder")
    make_file("sub", parent_id="folder", is_dir=True)
    make_file("file_b", parent_id="sub")

    resp = client.delete("/api/v1/folders/folder")

    assert resp.status_code == 200
    assert resp.json()["items_trashed"] == 4
    assert client.get("/api/v1/folders").json()["files"] == []
    assert client.get("/api/v1/files", params={"parent_id": "sub"}).json()["files"] == []


def test_the_folder_endpoint_refuses_a_plain_file(client, make_file):
    make_file("f1")

    resp = client.delete("/api/v1/folders/f1")

    assert resp.status_code == 400
    assert client.get("/api/v1/files/f1").status_code == 200


def test_deleting_a_missing_folder_is_a_404(client):
    assert client.delete("/api/v1/folders/nope").status_code == 404


def test_one_drive_cannot_delete_anothers_folder(client, make_file, db, run):
    make_file("b_folder", is_dir=True, owner_id=OWNER_B)

    resp = client.delete("/api/v1/folders/b_folder")

    assert resp.status_code == 404
    assert run(db.get_file("b_folder"))["trashed_at"] is None


def test_folder_cannot_be_created_under_another_drive(client, make_file):
    make_file("their-folder", owner_id=OWNER_B, is_dir=True)

    response = client.post(
        "/api/v1/folders",
        json={"name": "hidden", "parent_id": "their-folder"},
    )

    assert response.status_code == 400
