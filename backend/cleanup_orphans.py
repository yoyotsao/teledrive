"""One-off cleanup for orphaned file records.

Before folder deletion became recursive, deleting a folder from the web UI
removed only the folder row itself — every file/subfolder underneath stayed
in SQLite as invisible orphans. This script removes those orphaned subtrees.

Usage:
    python cleanup_orphans.py               # dry run — report only
    python cleanup_orphans.py --apply       # backup DB, export message ids, delete
    python cleanup_orphans.py --apply --purge-user 0   # also purge legacy rows of a user id
"""
import argparse
import json
import shutil
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

DB_PATH = Path(__file__).parent / "teledrive.db"

# Every row whose parent no longer exists, plus all descendants of such rows.
ORPHAN_SUBTREE_SQL = """
WITH RECURSIVE orphan_tree(file_id) AS (
    SELECT file_id FROM files
    WHERE parent_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM files p WHERE p.file_id = files.parent_id)
    UNION
    SELECT f.file_id FROM files f JOIN orphan_tree o ON f.parent_id = o.file_id
)
SELECT * FROM files WHERE file_id IN (SELECT file_id FROM orphan_tree)
"""


def collect_targets(conn: sqlite3.Connection, purge_users: list[int]) -> list[dict]:
    rows = [dict(r) for r in conn.execute(ORPHAN_SUBTREE_SQL)]
    seen = {r["file_id"] for r in rows}
    for user_id in purge_users:
        for r in conn.execute("SELECT * FROM files WHERE telegram_user_id = ?", (user_id,)):
            row = dict(r)
            if row["file_id"] not in seen:
                seen.add(row["file_id"])
                rows.append(row)
    return rows


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="actually delete (default: dry run)")
    parser.add_argument("--purge-user", type=int, action="append", default=[],
                        help="also delete ALL rows of this telegram_user_id (repeatable)")
    parser.add_argument("--db", default=str(DB_PATH), help="path to teledrive.db")
    args = parser.parse_args()

    db_path = Path(args.db)
    if not db_path.exists():
        print(f"Database not found: {db_path}")
        return 1

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row

    total_before = conn.execute("SELECT COUNT(*) FROM files").fetchone()[0]
    targets = collect_targets(conn, args.purge_user)
    message_ids = sorted({
        mid
        for r in targets
        for mid in (r.get("telegram_message_id"),)
        if mid
    })

    print(f"Rows in files table:        {total_before}")
    print(f"Orphan/purge rows found:    {len(targets)}")
    print(f"Telegram message ids held:  {len(message_ids)}")
    print(f"Rows that would remain:     {total_before - len(targets)}")

    if not targets:
        print("Nothing to clean up.")
        return 0

    if not args.apply:
        print("\nDry run only — re-run with --apply to delete.")
        return 0

    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_path = db_path.with_suffix(f".pre-cleanup-{timestamp}.bak")
    shutil.copy2(db_path, backup_path)
    print(f"\nBackup written: {backup_path}")

    export_path = db_path.parent / f"orphan_message_ids-{timestamp}.json"
    export_path.write_text(json.dumps({
        "exported_at": datetime.now().isoformat(),
        "note": "Telegram message ids of deleted orphan records (messages NOT deleted from Telegram)",
        "message_ids": message_ids,
    }, indent=2), encoding="utf-8")
    print(f"Message ids exported: {export_path}")

    ids = [r["file_id"] for r in targets]
    batch_size = 500
    deleted = 0
    for i in range(0, len(ids), batch_size):
        batch = ids[i:i + batch_size]
        placeholders = ",".join("?" * len(batch))
        cur = conn.execute(f"DELETE FROM files WHERE file_id IN ({placeholders})", batch)
        deleted += cur.rowcount
    conn.commit()
    conn.execute("VACUUM")
    conn.close()

    print(f"Deleted {deleted} rows. Remaining: {total_before - deleted}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
