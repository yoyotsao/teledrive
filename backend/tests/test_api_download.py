"""/files/{id}/download and /files/by-split-group/{id}.

Neither endpoint returns bytes — that is the core architectural invariant. They
hand the browser the coordinates (message id, access hash, storage account) it
needs to fetch the file from Telegram's CDN itself.
"""
from conftest import OWNER_B


def test_download_returns_the_coordinates_not_the_file(client, make_file):
    make_file("f1", filename="clip.mp4", filesize=2048, mime_type="video/mp4",
              file_type="video", telegram_message_id=11)

    body = client.get("/api/v1/files/f1/download").json()

    assert body == {
        "file_id": "f1",
        "filename": "clip.mp4",
        "filesize": 2048,
        "mime_type": "video/mp4",
        "message_id": 11,
        "access_hash": None,
    }


def test_downloading_a_missing_file_is_a_404(client):
    assert client.get("/api/v1/files/nope/download").status_code == 404


def test_one_drive_cannot_get_anothers_download_coordinates(client, make_file):
    """message_id + access_hash *is* the ability to download the file, so this
    is the endpoint where a missing owner filter would leak actual data."""
    make_file("b_file", telegram_message_id=11, owner_id=OWNER_B)

    resp = client.get("/api/v1/files/b_file/download")

    assert resp.status_code == 404
    assert "11" not in resp.text


def test_a_trashed_file_can_still_be_downloaded(client, make_file):
    """The trash is a soft delete — the message still exists, and the details
    panel still previews trashed items."""
    make_file("f1", telegram_message_id=11)
    client.delete("/api/v1/files/f1")

    assert client.get("/api/v1/files/f1/download").status_code == 200


def test_split_parts_come_back_in_reassembly_order(client, make_file):
    """The browser concatenates the parts in this order; out of order means a
    corrupt file, not an error message."""
    for index in (2, 0, 1):
        make_file("part%d" % index, filename="big.bin", filesize=100 + index,
                  telegram_message_id=10 + index, is_split_file=True,
                  part_index=index, total_parts=3, split_group_id="grp")

    body = client.get("/api/v1/files/by-split-group/grp").json()

    assert [f["part_index"] for f in body["files"]] == [0, 1, 2]
    assert [f["telegram_message_id"] for f in body["files"]] == [10, 11, 12]
    assert body["total"] == 3


def test_each_part_carries_its_own_storage_account(client, make_file, db, run):
    """Parts of one file may sit on different linked accounts; the service
    worker picks a download client per part from this field."""
    run(db.link_account(1001, 3003))
    make_file("p0", filename="big.bin", is_split_file=True, part_index=0,
              total_parts=2, split_group_id="grp", telegram_user_id=1001)
    make_file("p1", filename="big.bin", is_split_file=True, part_index=1,
              total_parts=2, split_group_id="grp", telegram_user_id=3003)

    files = client.get("/api/v1/files/by-split-group/grp").json()["files"]

    assert [f["telegram_user_id"] for f in files] == [1001, 3003]


def test_an_unknown_split_group_is_a_404(client):
    assert client.get("/api/v1/files/by-split-group/nope").status_code == 404


def test_another_drives_split_group_is_a_404(client, make_file):
    make_file("b_part", is_split_file=True, part_index=0, total_parts=1,
              split_group_id="b-grp", telegram_message_id=11, owner_id=OWNER_B)

    resp = client.get("/api/v1/files/by-split-group/b-grp")

    assert resp.status_code == 404
