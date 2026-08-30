"""GET /files/{id} and PATCH /files/{id} — reading and editing one item.

PATCH is the rename *and* the move, told apart by which fields the client sent,
so "field absent" and "field explicitly null" have to mean different things.
"""
import pytest

from conftest import OWNER_A, OWNER_B


def test_getting_a_file_returns_its_metadata(client, make_file):
    make_file("f1", filename="report.pdf", filesize=99, mime_type="application/pdf",
              file_type="document", telegram_message_id=42)

    body = client.get("/api/v1/files/f1").json()

    assert body["filename"] == "report.pdf"
    assert body["filesize"] == 99
    assert body["telegram_message_id"] == 42


def test_getting_a_missing_file_is_a_404(client):
    assert client.get("/api/v1/files/nope").status_code == 404


def test_another_drives_file_is_indistinguishable_from_a_missing_one(client, make_file):
    """404, not 403 — a 403 would confirm the file exists to someone probing ids."""
    make_file("b_file", owner_id=OWNER_B)

    resp = client.get("/api/v1/files/b_file")

    assert resp.status_code == 404


def test_renaming_changes_only_the_name(client, make_file):
    make_file("f1", filename="old.txt", parent_id=None)

    body = client.patch("/api/v1/files/f1", json={"filename": "new.txt"}).json()

    assert body["filename"] == "new.txt"
    assert body["parent_id"] is None


def test_renaming_leaves_the_folder_alone(client, make_file):
    """`parent_id` absent from the body must not be read as 'move to root'."""
    make_file("folder", is_dir=True)
    make_file("f1", filename="old.txt", parent_id="folder")

    body = client.patch("/api/v1/files/f1", json={"filename": "new.txt"}).json()

    assert body["parent_id"] == "folder"


def test_moving_into_a_folder(client, make_file):
    make_file("folder", is_dir=True)
    make_file("f1")

    body = client.patch("/api/v1/files/f1", json={"parent_id": "folder"}).json()

    assert body["parent_id"] == "folder"
    assert [f["file_id"] for f in
            client.get("/api/v1/files", params={"parent_id": "folder"}).json()["files"]] == ["f1"]


def test_an_explicit_null_parent_moves_the_file_back_to_the_root(client, make_file):
    make_file("folder", is_dir=True)
    make_file("f1", parent_id="folder")

    body = client.patch("/api/v1/files/f1", json={"parent_id": None}).json()

    assert body["parent_id"] is None
    assert [f["file_id"] for f in client.get("/api/v1/files").json()["files"]] == ["f1"]


def test_move_rejects_another_drives_parent(client, make_file):
    make_file("mine")
    make_file("their-folder", owner_id=2002, is_dir=True)

    response = client.patch(
        "/api/v1/files/mine", json={"parent_id": "their-folder"}
    )

    assert response.status_code == 400


def test_folder_cannot_be_moved_into_its_descendant(client, make_file):
    make_file("parent", is_dir=True)
    make_file("child", is_dir=True, parent_id="parent")

    response = client.patch(
        "/api/v1/files/parent", json={"parent_id": "child"}
    )

    assert response.status_code == 400


@pytest.mark.parametrize(
    "name",
    [
        pytest.param("", id="empty"),
        pytest.param("   ", id="whitespace-only"),
        pytest.param("a/b.txt", id="forward-slash"),
        pytest.param("a\\b.txt", id="backslash"),
    ],
)
def test_a_rename_that_would_break_the_tree_is_refused(client, make_file, name):
    """A separator in a filename turns one item into a fake path; the folder
    hierarchy is parent_id, and it must stay the only source of truth."""
    make_file("f1", filename="ok.txt")

    resp = client.patch("/api/v1/files/f1", json={"filename": name})

    assert resp.status_code == 400
    assert client.get("/api/v1/files/f1").json()["filename"] == "ok.txt"


def test_patching_a_missing_file_is_a_404(client):
    assert client.patch("/api/v1/files/nope", json={"filename": "x.txt"}).status_code == 404


def test_one_drive_cannot_rename_anothers_file(client, make_file, db, run):
    make_file("b_file", filename="theirs.txt", owner_id=OWNER_B)

    resp = client.patch("/api/v1/files/b_file", json={"filename": "mine.txt"})

    assert resp.status_code == 404
    assert run(db.get_file("b_file"))["filename"] == "theirs.txt"


def test_an_empty_patch_body_is_a_no_op(client, make_file):
    make_file("folder", is_dir=True)
    make_file("f1", filename="keep.txt", parent_id="folder")

    body = client.patch("/api/v1/files/f1", json={}).json()

    assert body["filename"] == "keep.txt"
    assert body["parent_id"] == "folder"


def test_delete_all_empties_only_the_callers_drive(client, other_client, make_file):
    make_file("a1", owner_id=OWNER_A)
    make_file("a2", owner_id=OWNER_A)
    make_file("b1", owner_id=OWNER_B)

    resp = client.delete("/api/v1/files")

    assert resp.status_code == 200
    assert resp.json()["count"] == 2
    assert client.get("/api/v1/files").json()["files"] == []
    assert [f["file_id"] for f in other_client.get("/api/v1/files").json()["files"]] == ["b1"]
