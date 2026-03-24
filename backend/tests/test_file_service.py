import asyncio
from datetime import datetime

from app.services.file_service import FileService
from app.models.schemas import FileInfo, FileType


def test_list_files_by_parent_filtering():
    fs = FileService()
    # Create a folder and two files under it
    folder = fs.create_folder("docs")

    file1 = FileInfo(
        file_id="f1",
        filename="readme.txt",
        filesize=1024,
        mime_type=None,
        file_type=FileType.DOCUMENT,
        telegram_message_id=None,
        created_at=datetime.utcnow(),
        direct_url=None,
        access_hash=None,
        parent_id=folder.file_id,
        isDir=False,
    )
    file2 = FileInfo(
        file_id="f2",
        filename="notes.md",
        filesize=2048,
        mime_type=None,
        file_type=FileType.DOCUMENT,
        telegram_message_id=None,
        created_at=datetime.utcnow(),
        direct_url=None,
        access_hash=None,
        parent_id=None,
        isDir=False,
    )
    fs._files_metadata[file1.file_id] = file1
    fs._files_metadata[file2.file_id] = file2

    # List only files under the folder
    result = asyncio.get_event_loop().run_until_complete(
        fs.list_files(page=1, page_size=10, parent_id=folder.file_id)
    )
    files, total = result
    assert total == 1
    assert files[0].file_id == file1.file_id
    assert files[0].parent_id == folder.file_id
