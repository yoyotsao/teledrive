"""/files/check-hash and /files/check-hashes — the upload path's dedup lookup.

The browser hashes a file before uploading and asks whether the drive already
has it. A wrong answer here is expensive in both directions: a false negative
re-uploads gigabytes, and a false positive registers a row pointing at bytes
that were never uploaded.
"""
from conftest import OWNER_B

HASH_A = "a" * 64
HASH_B = "b" * 64


def test_an_unknown_hash_is_reported_as_not_found(client):
    body = client.get("/api/v1/files/check-hash", params={"hash": HASH_A}).json()

    assert body == {"found": False, "files": []}


def test_a_known_hash_comes_back_with_the_row_needed_to_reuse_it(client, make_file):
    make_file("f1", filename="clip.mp4", filesize=1024, telegram_message_id=11, file_hash=HASH_A)

    body = client.get("/api/v1/files/check-hash", params={"hash": HASH_A}).json()

    assert body["found"] is True
    assert [f["file_id"] for f in body["files"]] == ["f1"]
    # Without these the frontend cannot register a copy without re-uploading.
    assert body["files"][0]["telegram_message_id"] == 11
    assert body["files"][0]["filesize"] == 1024


def test_every_row_with_that_hash_comes_back(client, make_file):
    """A split file's parts all share the original file's hash, and the caller
    needs the whole set to decide whether the copy is even complete."""
    for index in range(3):
        make_file("p%d" % index, filename="big.bin", file_hash=HASH_A,
                  is_split_file=True, part_index=index, total_parts=3, split_group_id="grp")

    body = client.get("/api/v1/files/check-hash", params={"hash": HASH_A}).json()

    assert sorted(f["file_id"] for f in body["files"]) == ["p0", "p1", "p2"]


def test_dedup_never_reaches_into_another_drive(client, make_file):
    """A hit on someone else's row would hand out their message id and
    access_hash — the two things needed to download their file."""
    make_file("b_file", file_hash=HASH_A, telegram_message_id=11, owner_id=OWNER_B)

    body = client.get("/api/v1/files/check-hash", params={"hash": HASH_A}).json()

    assert body == {"found": False, "files": []}


def test_check_hash_requires_the_hash_parameter(client):
    assert client.get("/api/v1/files/check-hash").status_code == 422


def test_the_batch_endpoint_groups_results_by_hash(client, make_file):
    make_file("f1", file_hash=HASH_A)
    make_file("f2", file_hash=HASH_A)
    make_file("f3", file_hash=HASH_B)

    results = client.post(
        "/api/v1/files/check-hashes", json={"hashes": [HASH_A, HASH_B, "c" * 64]}
    ).json()["results"]

    assert sorted(f["file_id"] for f in results[HASH_A]) == ["f1", "f2"]
    assert [f["file_id"] for f in results[HASH_B]] == ["f3"]
    # A miss is simply absent rather than an empty list.
    assert "c" * 64 not in results


def test_an_empty_batch_is_answered_with_an_empty_result(client):
    assert client.post("/api/v1/files/check-hashes", json={"hashes": []}).json() == {"results": {}}


def test_the_batch_is_capped(client):
    """A folder upload batches its hashes; an uncapped list is an easy way to
    turn one request into a full-table scan per element."""
    resp = client.post("/api/v1/files/check-hashes", json={"hashes": [HASH_A] * 1001})

    assert resp.status_code == 422


def test_the_batch_endpoint_stops_at_the_drive_boundary_too(client, make_file):
    make_file("b_file", file_hash=HASH_A, owner_id=OWNER_B)

    results = client.post("/api/v1/files/check-hashes", json={"hashes": [HASH_A]}).json()["results"]

    assert results == {}
