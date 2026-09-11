"""Large-manifest regression: response/query shape must not grow with row count."""

import json

from conftest import OWNER_A
from test_storage_migration import _target_channel


async def test_65830_row_manifest_is_set_based_and_returns_bounded_summary(db):
    target = await _target_channel(db)
    await db._conn.execute(
        """
        WITH RECURSIVE seq(n) AS (
            SELECT 1
            UNION ALL
            SELECT n + 1 FROM seq WHERE n < 65830
        )
        INSERT INTO files (
            file_id, filename, filesize, file_type, telegram_message_id,
            created_at, telegram_user_id, owner_id,
            telegram_media_kind, telegram_media_id, telegram_media_size
        )
        SELECT
            printf('bulk-%05d', n), printf('bulk-%05d.bin', n), 1, 'file', n,
            datetime('now'), ?, ?, 'document', printf('%d', n), 1
        FROM seq
        """,
        (OWNER_A, OWNER_A),
    )
    await db._conn.commit()

    statements: list[str] = []
    await db._conn.set_trace_callback(statements.append)
    try:
        job = await db.create_migration_manifest(
            OWNER_A, target["version"], target["accounts_version"], dry_run=True,
        )
    finally:
        await db._conn.set_trace_callback(None)

    assert job["total_items"] == 65830
    assert job["total_groups"] == 65830
    assert job["item_counts"]["planned"] == 65830
    assert "items" not in job
    assert len(json.dumps(job)) < 10_000

    item_inserts = [
        statement for statement in statements
        if "INSERT INTO storage_migration_items" in statement
    ]
    assert len(item_inserts) == 1
    assert "SELECT" in item_inserts[0]

    # Dry runs are inert; even a 65k-row manifest cannot accidentally become runnable.
    page = await db.list_migration_groups(
        OWNER_A, job["migration_id"], scope="runnable", limit=25,
    )
    assert page == {"groups": [], "next_after": None}
