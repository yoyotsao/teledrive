"""FileService listing behaviour, below the HTTP layer.

test_api_files_listing.py covers the same ground through the endpoint; this
file exists because the service is also called directly (backfill and cleanup
scripts in backend/scripts/), so its contract has to hold on its own.
"""
from conftest import OWNER_A, OWNER_B


async def test_listing_is_scoped_to_one_folder(file_service, make_file):
    await make_file("folder", is_dir=True)
    await make_file("inside", parent_id="folder")
    await make_file("at_root")

    files, total = await file_service.list_files(page=1, page_size=10,
                                                 parent_id="folder", owner_id=OWNER_A)

    assert total == 1
    assert [f.file_id for f in files] == ["inside"]
    assert files[0].parent_id == "folder"


async def test_listing_is_scoped_to_one_drive(file_service, make_file):
    await make_file("mine", owner_id=OWNER_A)
    await make_file("theirs", owner_id=OWNER_B)

    files, total = await file_service.list_files(owner_id=OWNER_A)

    assert total == 1
    assert [f.file_id for f in files] == ["mine"]


async def test_creating_a_folder_returns_a_directory_entry(file_service):
    folder = await file_service.create_folder("docs", owner_id=OWNER_A)

    assert folder.isDir is True
    assert folder.filename == "docs"
    assert folder.telegram_message_id is None


async def test_creating_the_same_folder_twice_reuses_the_first(file_service):
    """Folder uploads re-create every directory on the path each time."""
    first = await file_service.create_folder("docs", owner_id=OWNER_A)

    second = await file_service.create_folder("docs", owner_id=OWNER_A)

    assert second.file_id == first.file_id


async def test_two_drives_can_each_have_a_folder_of_the_same_name(file_service):
    """The reuse lookup is per-drive; sharing it would leak a folder id."""
    mine = await file_service.create_folder("docs", owner_id=OWNER_A)

    theirs = await file_service.create_folder("docs", owner_id=OWNER_B)

    assert theirs.file_id != mine.file_id
