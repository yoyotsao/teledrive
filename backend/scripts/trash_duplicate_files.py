"""Soft-delete redundant duplicate file records.

Scope: logical files that share the SAME parent folder, the SAME filename and the
SAME file_hash. Those are unambiguously redundant — a re-upload into the folder it
already lived in, which older backends appended instead of replacing (split files
skipped the replace path entirely, so one folder could hold the same multi-GB video
five or six times).

Deliberately NOT touched:
  * same content under a different filename (distinct names the user chose)
  * same name+content in a different folder (a deliberate second location)
  * anything already in the trash
  * Telegram messages — only DB rows are affected, nothing is deleted from the cloud

Rows are soft-deleted (trashed_at set), so everything stays restorable from the trash.

Usage:
    python backend/scripts/trash_duplicate_files.py            # dry run, prints the plan
    python backend/scripts/trash_duplicate_files.py --apply    # back up the DB, then apply
"""

from __future__ import annotations

import argparse
import shutil
import sqlite3
import sys
import time
from collections import defaultdict
from datetime import datetime
from pathlib import Path

DB_PATH = Path(__file__).resolve().parents[1] / "teledrive.db"


def logical_key(row: sqlite3.Row) -> str:
    """A logical file is one split group, or one standalone row."""
    return row["split_group_id"] or row["file_id"]


def main() -> int:
    # Filenames are CJK-heavy; a cp950/cp1252 console would otherwise abort the report.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="write changes (default: dry run)")
    parser.add_argument("--db", default=str(DB_PATH), help="path to teledrive.db")
    args = parser.parse_args()

    db_path = Path(args.db)
    if not db_path.exists():
        print(f"DB not found: {db_path}", file=sys.stderr)
        return 1

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT file_id, filename, filesize, parent_id, split_group_id, file_hash,"
        "       telegram_message_id, telegram_user_id, created_at"
        "  FROM files WHERE isDir = 0 AND trashed_at IS NULL"
    ).fetchall()

    # Collapse rows into logical files.
    logical: dict[str, dict] = {}
    for row in rows:
        entry = logical.setdefault(
            logical_key(row),
            {
                "file_ids": [],
                "messages": set(),
                "bytes": 0,
                "name": row["filename"],
                "parent": row["parent_id"],
                "hash": row["file_hash"],
                "user": row["telegram_user_id"],
                "created": row["created_at"] or "",
            },
        )
        entry["file_ids"].append(row["file_id"])
        entry["messages"].add(row["telegram_message_id"])
        entry["bytes"] += row["filesize"] or 0
        if (row["created_at"] or "") < entry["created"]:
            entry["created"] = row["created_at"] or ""

    groups: dict[tuple, list[tuple[str, dict]]] = defaultdict(list)
    unhashed = 0
    for key, entry in logical.items():
        if not entry["hash"]:
            unhashed += 1
            continue
        groups[(entry["user"], entry["parent"], entry["name"], entry["hash"])].append((key, entry))

    doomed_ids: list[str] = []
    plan: list[tuple[int, int, str, bool]] = []
    for _, members in groups.items():
        if len(members) < 2:
            continue
        # Keep the oldest copy; file_id breaks ties so the choice is deterministic.
        members.sort(key=lambda m: (m[1]["created"], m[0]))
        keeper, *extras = members
        shares_storage = all(e["messages"] <= keeper[1]["messages"] for _, e in extras)
        removed_rows = sum(len(e["file_ids"]) for _, e in extras)
        for _, e in extras:
            doomed_ids.extend(e["file_ids"])
        plan.append((len(extras), removed_rows, keeper[1]["name"], shares_storage))

    # Same name+folder but genuinely different content — a real conflict, left for a human.
    conflicts = defaultdict(set)
    for key, entry in logical.items():
        if entry["hash"]:
            conflicts[(entry["user"], entry["parent"], entry["name"])].add(entry["hash"])
    conflicting = [k for k, v in conflicts.items() if len(v) > 1]

    plan.sort(reverse=True)
    print(f"live file rows            : {len(rows)}")
    print(f"live logical files        : {len(logical)}  (without a hash: {unhashed})")
    print(f"redundant groups          : {len(plan)}")
    print(f"logical copies to trash   : {sum(p[0] for p in plan)}")
    print(f"DB rows to trash          : {len(doomed_ids)}")
    orphaning = [p for p in plan if not p[3]]
    print(f"groups whose copies hold their own Telegram messages: {len(orphaning)}")
    print(f"same name+folder, different content (skipped, needs a human): {len(conflicting)}")
    print()
    for extras, removed_rows, name, shared in plan[:25]:
        tag = "shared storage" if shared else "OWN MESSAGES -> will orphan them"
        print(f"  -{extras} copies ({removed_rows} rows) [{tag}]  {name[:62]}")
    if len(plan) > 25:
        print(f"  ... and {len(plan) - 25} more groups")

    if not doomed_ids:
        print("\nNothing to do.")
        return 0

    if not args.apply:
        print("\nDry run — nothing written. Re-run with --apply to trash these rows.")
        return 0

    backup = db_path.with_name(f"{db_path.name}.bak-dup-{int(time.time())}")
    shutil.copy2(db_path, backup)
    print(f"\nbackup: {backup}")

    trashed_at = datetime.utcnow().isoformat()
    changed = 0
    for i in range(0, len(doomed_ids), 500):
        batch = doomed_ids[i : i + 500]
        placeholders = ",".join("?" * len(batch))
        cursor = conn.execute(
            f"UPDATE files SET trashed_at = ? WHERE file_id IN ({placeholders})",
            [trashed_at, *batch],
        )
        changed += cursor.rowcount
    conn.commit()
    print(f"trashed {changed} rows at {trashed_at}")
    print("Restore from the app's trash, or: UPDATE files SET trashed_at = NULL WHERE trashed_at = '<ts>'")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
