"""GET /files — folder navigation, paging, sorting, search and the trash view.

One endpoint serves four different screens, switched by query parameters, and
each switch changes which rows are even eligible. The cases below pin the
switches against each other rather than testing them one at a time in isolation.
"""
import pytest

from conftest import OWNER_A, OWNER_B


def test_root_listing_shows_only_root_files(client, make_file):
    make_file("root_file")
    make_file("folder", is_dir=True)
    make_file("nested", parent_id="folder")

    listing = client.get("/api/v1/files").json()

    # Folders are listed by /folders; /files at root returns files only.
    assert [f["file_id"] for f in listing["files"]] == ["root_file"]
    assert listing["total"] == 1


def test_parent_id_navigates_into_a_folder(client, make_file):
    make_file("folder", is_dir=True)
    make_file("nested", parent_id="folder")
    make_file("root_file")

    listing = client.get("/api/v1/files", params={"parent_id": "folder"}).json()

    assert [f["file_id"] for f in listing["files"]] == ["nested"]


def test_the_literal_string_null_means_the_drive_root(client, make_file):
    """The frontend puts the current folder in the URL, so 'null' arrives as text."""
    make_file("root_file")
    make_file("folder", is_dir=True)
    make_file("nested", parent_id="folder")

    listing = client.get("/api/v1/files", params={"parent_id": "null"}).json()

    assert [f["file_id"] for f in listing["files"]] == ["root_file"]


def test_paging_reports_the_full_total_not_the_page_size(client, make_file):
    for i in range(5):
        make_file("f%d" % i, filename="f%d.txt" % i)

    page = client.get("/api/v1/files", params={"page": 2, "page_size": 2}).json()

    assert page["total"] == 5
    assert page["page"] == 2
    assert len(page["files"]) == 2


def test_paging_walks_every_row_exactly_once(client, make_file):
    """A tiebreak-less ORDER BY would repeat or drop rows across page borders."""
    for i in range(7):
        make_file("f%d" % i, filename="same-name.txt")

    seen = []
    for page in (1, 2, 3):
        seen += [f["file_id"] for f in
                 client.get("/api/v1/files", params={"page": page, "page_size": 3}).json()["files"]]

    assert sorted(seen) == ["f0", "f1", "f2", "f3", "f4", "f5", "f6"]


@pytest.mark.parametrize(
    "sort_by,sort_order,expected",
    [
        ("name", "asc", ["Apple", "banana", "cherry"]),
        ("name", "desc", ["cherry", "banana", "Apple"]),
        ("size", "asc", ["cherry", "Apple", "banana"]),
        ("size", "desc", ["banana", "Apple", "cherry"]),
        ("date", "asc", ["banana", "Apple", "cherry"]),
        ("date", "desc", ["cherry", "Apple", "banana"]),
    ],
)
def test_sorting(client, make_file, sort_by, sort_order, expected):
    # Insertion order is the date order; sizes and names deliberately disagree.
    make_file("b", filename="banana", filesize=300)
    make_file("a", filename="Apple", filesize=200)
    make_file("c", filename="cherry", filesize=100)

    listing = client.get(
        "/api/v1/files", params={"sort_by": sort_by, "sort_order": sort_order}
    ).json()

    assert [f["filename"] for f in listing["files"]] == expected


def test_an_unknown_sort_key_is_rejected_rather_than_interpolated(client, make_file):
    """Sort keys reach an ORDER BY clause; only the whitelist may get there."""
    make_file("f1")

    resp = client.get("/api/v1/files", params={"sort_by": "filename; DROP TABLE files"})

    assert resp.status_code == 422


def test_search_spans_the_whole_drive_and_includes_folders(client, make_file):
    make_file("folder", filename="holiday", is_dir=True)
    make_file("deep", filename="holiday-photo.jpg", parent_id="folder")
    make_file("other", filename="unrelated.txt")

    listing = client.get("/api/v1/files", params={"search": "holiday"}).json()

    assert {f["file_id"] for f in listing["files"]} == {"folder", "deep"}


def test_search_treats_percent_as_a_character_not_a_wildcard(client, make_file):
    make_file("id1", filename="50% off.txt")
    make_file("id2", filename="5000 off.txt")

    listing = client.get("/api/v1/files", params={"search": "50%"}).json()

    assert [f["file_id"] for f in listing["files"]] == ["id1"]


def test_search_treats_underscore_as_a_character_too(client, make_file):
    make_file("id1", filename="a_b.txt")
    make_file("id2", filename="axb.txt")

    listing = client.get("/api/v1/files", params={"search": "a_b"}).json()

    assert [f["file_id"] for f in listing["files"]] == ["id1"]


def test_a_whitespace_only_search_is_not_a_search(client, make_file):
    make_file("folder", is_dir=True)
    make_file("root_file")

    listing = client.get("/api/v1/files", params={"search": "   "}).json()

    # Back to plain root listing — folders excluded — rather than matching everything.
    assert [f["file_id"] for f in listing["files"]] == ["root_file"]


def test_the_trash_view_lists_only_trashed_roots(client, make_file):
    make_file("folder", is_dir=True)
    make_file("nested", parent_id="folder")
    make_file("live_file")
    client.delete("/api/v1/files/folder")

    trash = client.get("/api/v1/files", params={"trashed": True}).json()

    # The folder's contents went to the trash with it, but listing them would
    # bury the actual thing the user deleted.
    assert [f["file_id"] for f in trash["files"]] == ["folder"]


def test_split_group_filter_returns_the_parts_in_order(client, make_file):
    for index in (2, 0, 1):
        make_file(
            "part%d" % index, filename="big.bin", is_split_file=True,
            part_index=index, total_parts=3, split_group_id="grp",
        )

    listing = client.get("/api/v1/files", params={"split_group_id": "grp"}).json()

    assert [f["part_index"] for f in listing["files"]] == [0, 1, 2]


def test_one_drive_never_sees_anothers_files(client, other_client, make_file):
    make_file("a_file", owner_id=OWNER_A)
    make_file("b_file", owner_id=OWNER_B)

    assert [f["file_id"] for f in client.get("/api/v1/files").json()["files"]] == ["a_file"]
    assert [f["file_id"] for f in other_client.get("/api/v1/files").json()["files"]] == ["b_file"]


def test_search_does_not_leak_across_drives(client, make_file):
    """Search ignores parent_id and isDir; the owner filter must still hold."""
    make_file("b_secret", filename="secret.txt", owner_id=OWNER_B)

    listing = client.get("/api/v1/files", params={"search": "secret"}).json()

    assert listing["files"] == []
    assert listing["total"] == 0


@pytest.mark.parametrize(
    "params",
    [
        pytest.param({"page": 0}, id="page-below-1"),
        pytest.param({"page_size": 0}, id="page-size-below-1"),
        pytest.param({"page_size": 10001}, id="page-size-above-cap"),
        pytest.param({"sort_order": "sideways"}, id="bad-sort-order"),
    ],
)
def test_out_of_range_query_parameters_are_rejected(client, params):
    assert client.get("/api/v1/files", params=params).status_code == 422
