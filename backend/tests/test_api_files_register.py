"""POST /files/register — the only way a file ever enters the drive.

Binary data never touches this backend; the browser uploads to Telegram and
then posts the metadata here. Everything this endpoint is told is therefore
attacker-controlled, which is why most of the file below is about trust
boundaries rather than happy paths.
"""
from conftest import OWNER_A, OWNER_B

A_SECOND = 3003


def register_payload(file_id="doc1", **overrides):
    payload = {
        "filename": "photo.jpg",
        "filesize": 1234,
        "mime_type": "image/jpeg",
        "message_id": 11,
        "file_id": file_id,
        "access_hash": "ah-1",
        "has_thumbnail": True,
    }
    payload.update(overrides)
    return payload


def test_registering_stores_the_metadata_and_returns_it(client, db, run):
    resp = client.post("/api/v1/files/register", json=register_payload())

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["file_id"] == "doc1"
    assert body["filename"] == "photo.jpg"
    assert body["file_type"] == "photo"
    assert body["has_thumbnail"] is True

    row = run(db.get_file("doc1"))
    assert row["owner_id"] == OWNER_A
    assert row["telegram_message_id"] == 11
    assert row["access_hash"] == "ah-1"


def test_the_file_lands_in_the_requested_folder(client):
    folder = client.post("/api/v1/folders", json={"name": "trip"}).json()

    client.post("/api/v1/files/register", json=register_payload(parent_id=folder["file_id"]))

    listing = client.get("/api/v1/files", params={"parent_id": folder["file_id"]}).json()
    assert [f["file_id"] for f in listing["files"]] == ["doc1"]


def test_a_file_cannot_be_registered_under_another_drives_folder(
    client, make_file, db, run
):
    make_file("their-folder", owner_id=OWNER_B, is_dir=True)

    resp = client.post(
        "/api/v1/files/register",
        json=register_payload(parent_id="their-folder"),
    )

    assert resp.status_code == 400
    assert run(db.get_file("doc1")) is None


def test_a_file_cannot_be_attributed_to_an_unlinked_account(client, db, run):
    """`telegram_user_id` says which account's Saved Messages holds the message.
    Accepting an arbitrary one would let a caller pin rows onto a stranger."""
    resp = client.post("/api/v1/files/register", json=register_payload(telegram_user_id=A_SECOND))

    assert resp.status_code == 403
    assert run(db.get_file("doc1")) is None


def test_a_linked_account_may_be_named_as_the_storage_account(client, db, run):
    run(db.link_account(OWNER_A, A_SECOND))

    resp = client.post("/api/v1/files/register", json=register_payload(telegram_user_id=A_SECOND))

    assert resp.status_code == 200, resp.text
    assert run(db.get_file("doc1"))["telegram_user_id"] == A_SECOND


def test_another_drive_cannot_overwrite_an_existing_row(client, other_client, db, run):
    """`file_id` is a global primary key and insert_file is INSERT OR REPLACE.
    Two drives importing the same public channel produce the same file_id, so
    without this guard the second registration silently steals the first
    drive's row, owner_id included.
    """
    client.post("/api/v1/files/register", json=register_payload("shared", filename="a.jpg"))

    resp = other_client.post(
        "/api/v1/files/register", json=register_payload("shared", filename="stolen.jpg")
    )

    assert resp.status_code == 409
    row = run(db.get_file("shared"))
    assert row["owner_id"] == OWNER_A
    assert row["filename"] == "a.jpg"


def test_the_same_drive_may_re_register_its_own_file(client, db, run):
    """Upload retries and re-imports must not trip the ownership guard."""
    client.post("/api/v1/files/register", json=register_payload("own"))

    resp = client.post("/api/v1/files/register", json=register_payload("own", message_id=22))

    assert resp.status_code == 200, resp.text
    assert run(db.get_file("own"))["telegram_message_id"] == 22


def test_re_uploading_a_name_replaces_the_previous_file(client):
    """One folder once accumulated six copies of the same multi-GB video because
    a re-upload appended instead of replacing."""
    client.post("/api/v1/files/register", json=register_payload("old", filename="clip.mp4"))
    client.post("/api/v1/files/register", json=register_payload("new", filename="clip.mp4"))

    files = client.get("/api/v1/files").json()["files"]

    assert [f["file_id"] for f in files] == ["new"]


def test_a_trashed_namesake_is_left_alone(client, make_file):
    """Replacing a live file must not quietly purge the trashed one behind it,
    which is still restorable."""
    make_file("trashed_clip", filename="clip.mp4", trashed=True)

    client.post("/api/v1/files/register", json=register_payload("fresh", filename="clip.mp4"))

    trash = client.get("/api/v1/files", params={"trashed": True}).json()["files"]
    assert [f["file_id"] for f in trash] == ["trashed_clip"]


def test_sibling_split_parts_do_not_delete_each_other(client, db, run):
    """Every part shares one filename. If the replace sweep didn't exclude the
    incoming group, part 1 would delete part 0."""
    for index in range(3):
        resp = client.post(
            "/api/v1/files/register",
            json=register_payload(
                "big_part%d" % index,
                filename="big.bin",
                is_split_file=True,
                part_index=index,
                total_parts=3,
                split_group_id="grp-1",
            ),
        )
        assert resp.status_code == 200, resp.text

    parts = run(db.get_files_by_split_group("grp-1", owner_id=OWNER_A))
    assert sorted(r["file_id"] for r in parts) == ["big_part0", "big_part1", "big_part2"]


def test_a_split_file_appears_once_in_a_listing(client):
    for index in range(3):
        client.post(
            "/api/v1/files/register",
            json=register_payload(
                "p%d" % index, filename="big.bin", is_split_file=True,
                part_index=index, total_parts=3, split_group_id="grp-1",
            ),
        )

    listing = client.get("/api/v1/files").json()

    assert [f["file_id"] for f in listing["files"]] == ["p0"]
    assert listing["total"] == 1


def test_the_legacy_binary_upload_endpoint_does_not_exist(client):
    """Binary through the Python backend is the one thing the architecture
    forbids; the endpoint must stay dead rather than quietly work again."""
    resp = client.post("/api/v1/files/upload", files={"file": ("x.txt", b"hello")})

    # /files/{file_id} still exists for metadata reads/updates, so Starlette
    # resolves "upload" as a file id and correctly rejects POST with 405.
    assert resp.status_code == 405


def test_register_rejects_a_payload_missing_required_metadata(client):
    resp = client.post("/api/v1/files/register", json={"filename": "x.txt"})

    assert resp.status_code == 422


def test_registering_needs_a_token(anon_client, db, run):
    resp = anon_client.post("/api/v1/files/register", json=register_payload())

    assert resp.status_code == 401
    assert run(db.get_file("doc1")) is None


def test_re_registering_one_split_part_is_not_a_conflict(client, db, run):
    """Retrying a single failed part of a large upload must not look like
    another drive trying to claim the file_id."""
    part = register_payload(
        "big_part0", filename="big.bin", is_split_file=True,
        part_index=0, total_parts=2, split_group_id="grp-1",
    )
    assert client.post("/api/v1/files/register", json=part).status_code == 200

    resp = client.post("/api/v1/files/register", json=part)

    assert resp.status_code == 200, resp.text
    assert run(db.get_file("big_part0"))["owner_id"] == OWNER_A
