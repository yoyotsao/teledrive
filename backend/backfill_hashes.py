"""
Backfill file_hash for DB records whose source file exists locally.
Resolves each file's parent_id chain to find the correct local subdirectory.
Usage: python backfill_hashes.py <base_directory>
"""

import hashlib
import sqlite3
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

DB_PATH = Path(__file__).parent / "teledrive.db"
SAMPLE_SIZE = 100 * 1024 * 1024  # first 100 MB
CHUNK = 8 * 1024 * 1024


def sha256_file(path: Path) -> str:
    """SHA-256 of first 100 MB + file size, matching frontend hashFile.ts format."""
    h = hashlib.sha256()
    remaining = SAMPLE_SIZE
    with open(path, "rb") as f:
        while remaining > 0:
            chunk = f.read(min(CHUNK, remaining))
            if not chunk:
                break
            h.update(chunk)
            remaining -= len(chunk)
    size = path.stat().st_size
    return f"{h.hexdigest()}:{size}"


def build_folder_paths(conn: sqlite3.Connection, base: Path) -> dict:
    """Build a map of file_id -> local Path for all folder records."""
    folders = conn.execute(
        "SELECT file_id, filename, parent_id FROM files WHERE isDir=1"
    ).fetchall()

    id_to_row = {row["file_id"]: row for row in folders}
    id_to_path: dict = {}

    def resolve(file_id: str) -> Path:
        if file_id in id_to_path:
            return id_to_path[file_id]
        row = id_to_row.get(file_id)
        if row is None:
            return base
        parent_id = row["parent_id"]
        if parent_id is None:
            # root folder — map to base directory
            path = base
        else:
            path = resolve(parent_id) / row["filename"]
        id_to_path[file_id] = path
        return path

    for fid in id_to_row:
        resolve(fid)

    return id_to_path


def main(directory: str) -> None:
    base = Path(directory)
    if not base.is_dir():
        print(f"Not a directory: {directory}", file=sys.stderr)
        sys.exit(1)

    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row

    folder_paths = build_folder_paths(conn, base)
    print("Folder map:")
    for fid, path in folder_paths.items():
        print(f"  {fid} -> {path}")

    # Fetch all files still missing a hash, with their parent_id
    rows = conn.execute(
        "SELECT file_id, filename, parent_id FROM files WHERE file_hash IS NULL AND isDir=0"
    ).fetchall()
    print(f"\nDB records without hash: {len(rows)}")

    updated = 0
    missing = 0

    for row in rows:
        parent_id = row["parent_id"]
        if parent_id is not None and parent_id in folder_paths:
            local_dir = folder_paths[parent_id]
        else:
            local_dir = base

        local_path = local_dir / row["filename"]
        if not local_path.exists():
            print(f"  [MISS] {local_dir.name}/{row['filename']}")
            missing += 1
            continue

        print(f"  [HASH] {local_dir.name}/{row['filename']} ... ", end="", flush=True)
        file_hash = sha256_file(local_path)
        print(file_hash[:12] + "...")

        conn.execute(
            "UPDATE files SET file_hash=? WHERE file_id=? AND file_hash IS NULL",
            (file_hash, row["file_id"]),
        )
        conn.commit()
        updated += 1

    print(f"\nDone. updated={updated} rows, missing={missing} local files")
    conn.close()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(f"Usage: python {sys.argv[0]} <base_directory>")
        sys.exit(1)
    main(sys.argv[1])
