"""Metadata-only storage migration journal.

This module deliberately has no Telegram client imports. Browsers perform all
MTProto reads/writes; the backend only snapshots immutable locations, verifies
persisted operation results/evidence and performs SQLite CAS updates.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional


ITEM_STATES = {
    "planned", "sending", "blocked", "failed", "forwarded", "recovering",
    "retryable", "uncertain", "pending_quorum", "verified", "applied", "rolled_back",
}
ALLOWED = {
    "planned": {"sending", "blocked", "failed", "uncertain"},
    "sending": {"forwarded", "recovering", "retryable", "uncertain"},
    "recovering": {"forwarded", "retryable", "uncertain"},
    "uncertain": set(),  # only reconcile() may leave uncertain
    "retryable": {"sending", "recovering", "failed", "uncertain"},
    "forwarded": {"pending_quorum", "verified", "retryable", "failed"},
    "pending_quorum": {"verified", "retryable", "failed"},
    "verified": {"applied", "pending_quorum", "retryable", "failed"},
    "applied": {"rolled_back"},
    "blocked": set(), "failed": set(), "rolled_back": set(),
}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: Optional[datetime] = None) -> str:
    return (value or _now()).isoformat()


def _parse_time(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("timestamp must include timezone")
    return parsed.astimezone(timezone.utc)


async def ensure_schema(db) -> None:
    conn = db._conn
    if conn is None:
        raise RuntimeError("Database not connected")
    await conn.executescript("""
        CREATE TABLE IF NOT EXISTS storage_migrations (
            migration_id TEXT PRIMARY KEY,
            owner_id INTEGER NOT NULL,
            state TEXT NOT NULL,
            version INTEGER NOT NULL DEFAULT 1,
            dry_run INTEGER NOT NULL DEFAULT 0,
            target_channel_id TEXT NOT NULL,
            target_version INTEGER NOT NULL,
            accounts_version INTEGER NOT NULL,
            target_snapshot_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_storage_migrations_owner
            ON storage_migrations(owner_id, created_at);

        CREATE TABLE IF NOT EXISTS storage_migration_items (
            migration_id TEXT NOT NULL,
            item_id TEXT NOT NULL,
            owner_id INTEGER NOT NULL,
            file_id TEXT NOT NULL,
            group_id TEXT NOT NULL,
            part_index INTEGER,
            state TEXT NOT NULL,
            version INTEGER NOT NULL DEFAULT 1,
            source_location_json TEXT NOT NULL,
            expected_location_version INTEGER NOT NULL,
            operation_id TEXT,
            operation_result_version INTEGER,
            lease_owner TEXT,
            lease_expires_at TEXT,
            retry_at TEXT,
            error TEXT,
            applied_location_version INTEGER,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (migration_id, item_id),
            UNIQUE (migration_id, file_id),
            FOREIGN KEY (migration_id) REFERENCES storage_migrations(migration_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_storage_migration_items_group
            ON storage_migration_items(migration_id, group_id, part_index);

        CREATE TABLE IF NOT EXISTS storage_migration_evidence (
            migration_id TEXT NOT NULL,
            item_id TEXT NOT NULL,
            telegram_user_id INTEGER NOT NULL,
            result_version INTEGER NOT NULL,
            target_channel_id TEXT NOT NULL,
            destination_message_id INTEGER NOT NULL,
            media_kind TEXT NOT NULL,
            media_id TEXT NOT NULL,
            size_bytes INTEGER NOT NULL,
            photo_variant TEXT,
            read_probe_ok INTEGER NOT NULL,
            checked_at TEXT NOT NULL,
            source_read_probe_ok INTEGER NOT NULL DEFAULT 0,
            source_checked_at TEXT,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (migration_id, item_id, telegram_user_id),
            FOREIGN KEY (migration_id, item_id)
              REFERENCES storage_migration_items(migration_id, item_id) ON DELETE CASCADE
        );
    """)
    await conn.commit()


def _source_snapshot(row: Dict[str, Any]) -> Dict[str, Any]:
    return {key: row.get(key) for key in (
        "file_id", "telegram_user_id", "telegram_chat_id", "telegram_message_id",
        "telegram_media_kind", "telegram_media_id", "telegram_media_size",
        "telegram_photo_variant", "location_version", "access_hash",
    )}


async def _job_row(db, owner_id: int, migration_id: str):
    cursor = await db._conn.execute(
        "SELECT * FROM storage_migrations WHERE migration_id = ? AND owner_id = ?",
        (migration_id, owner_id),
    )
    return await cursor.fetchone()


async def _item_row(db, owner_id: int, migration_id: str, item_id: str):
    cursor = await db._conn.execute("""
        SELECT i.* FROM storage_migration_items i
        JOIN storage_migrations m ON m.migration_id = i.migration_id
        WHERE i.migration_id = ? AND i.item_id = ? AND m.owner_id = ?
    """, (migration_id, item_id, owner_id))
    return await cursor.fetchone()


async def _item_record(db, owner_id: int, migration_id: str, item_id: str) -> Dict[str, Any]:
    row = await _item_row(db, owner_id, migration_id, item_id)
    if row is None:
        raise KeyError("Migration item not found")
    result = dict(row)
    result["source_location"] = json.loads(result.pop("source_location_json"))
    cursor = await db._conn.execute("""
        SELECT telegram_user_id, result_version, target_channel_id,
               destination_message_id, media_kind, media_id, size_bytes,
               photo_variant, read_probe_ok, checked_at,
               source_read_probe_ok, source_checked_at
        FROM storage_migration_evidence
        WHERE migration_id = ? AND item_id = ? ORDER BY telegram_user_id
    """, (migration_id, item_id))
    result["evidence"] = [dict(row) for row in await cursor.fetchall()]
    return result


async def get_migration_job(db, owner_id: int, migration_id: str) -> Optional[Dict[str, Any]]:
    await ensure_schema(db)
    row = await _job_row(db, owner_id, migration_id)
    if row is None:
        return None
    result = dict(row)
    result["dry_run"] = bool(result["dry_run"])
    result["target_snapshot"] = json.loads(result.pop("target_snapshot_json"))
    cursor = await db._conn.execute(
        "SELECT item_id FROM storage_migration_items WHERE migration_id = ? ORDER BY group_id, part_index, item_id",
        (migration_id,),
    )
    result["items"] = [await _item_record(db, owner_id, migration_id, item[0]) for item in await cursor.fetchall()]
    return result


async def list_migration_jobs(db, owner_id: int) -> List[Dict[str, Any]]:
    await ensure_schema(db)
    cursor = await db._conn.execute(
        "SELECT migration_id FROM storage_migrations WHERE owner_id = ? ORDER BY created_at DESC",
        (owner_id,),
    )
    return [await get_migration_job(db, owner_id, row[0]) for row in await cursor.fetchall()]


async def create_migration_manifest(
    db,
    owner_id: int,
    expected_target_version: int,
    expected_accounts_version: int,
    dry_run: bool = False,
    migration_id: Optional[str] = None,
) -> Dict[str, Any]:
    await ensure_schema(db)
    conn = db._conn
    await conn.execute("BEGIN IMMEDIATE")
    try:
        await db._ensure_storage_target(owner_id)
        cursor = await conn.execute("SELECT * FROM storage_targets WHERE owner_id = ?", (owner_id,))
        target = dict(await cursor.fetchone())
        if target["version"] != expected_target_version or target["accounts_version"] != expected_accounts_version:
            raise ValueError("storage target or account version conflict")
        if target["storage_mode"] != "channel" or not target["channel_id"]:
            raise ValueError("migration requires an enabled channel storage target")
        migration_id = migration_id or str(uuid.uuid4())
        stamp = _iso()
        snapshot = {
            "storage_mode": target["storage_mode"],
            "channel_id": target["channel_id"],
            "channel_title": target["channel_title"],
            "version": target["version"],
            "accounts_version": target["accounts_version"],
        }
        await conn.execute("""
            INSERT INTO storage_migrations (
                migration_id, owner_id, state, version, dry_run, target_channel_id,
                target_version, accounts_version, target_snapshot_json, created_at, updated_at
            ) VALUES (?, ?, 'planned', 1, ?, ?, ?, ?, ?, ?, ?)
        """, (migration_id, owner_id, 1 if dry_run else 0, target["channel_id"],
              target["version"], target["accounts_version"], json.dumps(snapshot, sort_keys=True), stamp, stamp))

        cursor = await conn.execute("""
            SELECT * FROM files
            WHERE owner_id = ? AND isDir = 0 AND telegram_chat_id IS NULL
            ORDER BY COALESCE(split_group_id, file_id), COALESCE(part_index, 0), file_id
        """, (owner_id,))
        rows = [dict(row) for row in await cursor.fetchall()]
        for row in rows:
            group_id = row["split_group_id"] or row["file_id"]
            await conn.execute("""
                INSERT INTO storage_migration_items (
                    migration_id, item_id, owner_id, file_id, group_id, part_index,
                    state, version, source_location_json, expected_location_version,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'planned', 1, ?, ?, ?, ?)
            """, (migration_id, row["file_id"], owner_id, row["file_id"], group_id,
                  row["part_index"], json.dumps(_source_snapshot(row), sort_keys=True),
                  row["location_version"], stamp, stamp))
        await conn.commit()
    except Exception:
        await conn.rollback()
        raise
    return await get_migration_job(db, owner_id, migration_id)


async def _validate_operation_for_item(db, owner_id: int, job, item, operation_id: str):
    operation = await db._owned_telegram_operation(owner_id, operation_id)
    if operation["kind"] != "migration":
        raise ValueError("migration item requires a migration operation")
    if operation["logical_file_id"] != item["file_id"]:
        raise ValueError("migration operation is bound to another file")
    if operation["target_kind"] != "channel" or operation["target_channel_id"] != job["target_channel_id"]:
        raise ValueError("migration operation target conflicts with manifest")
    source = json.loads(operation["request_metadata"]).get("source")
    if source != json.loads(item["source_location_json"]):
        raise ValueError("migration operation source conflicts with manifest")
    return operation


async def claim_migration_item(
    db,
    owner_id: int,
    migration_id: str,
    item_id: str,
    expected_version: int,
    lease_owner: str,
    lease_seconds: int,
    *,
    operation_id: Optional[str] = None,
    state: Optional[str] = None,
    error: Optional[str] = None,
) -> Dict[str, Any]:
    await ensure_schema(db)
    if not lease_owner or lease_seconds <= 0:
        raise ValueError("lease_owner and positive lease_seconds are required")
    conn = db._conn
    await conn.execute("BEGIN IMMEDIATE")
    try:
        job = await _job_row(db, owner_id, migration_id)
        if job is None:
            raise KeyError("Migration not found")
        item = await _item_row(db, owner_id, migration_id, item_id)
        if item is None:
            raise KeyError("Migration item not found")
        if item["version"] != expected_version:
            raise ValueError("migration item version conflict")
        expiry = _parse_time(item["lease_expires_at"])
        if expiry and expiry > _now() and item["lease_owner"] not in (None, lease_owner):
            raise ValueError("migration item lease is active")

        frozen_operation_id = item["operation_id"]
        if operation_id:
            if frozen_operation_id and frozen_operation_id != operation_id:
                raise ValueError("migration item operation identity is immutable")
            await _validate_operation_for_item(db, owner_id, job, item, operation_id)
            frozen_operation_id = operation_id

        next_state = state
        if next_state is None:
            if item["state"] in {"planned", "retryable"}:
                next_state = "sending"
            elif item["state"] == "sending" and expiry and expiry <= _now():
                next_state = "recovering"
            else:
                next_state = item["state"]
        if next_state not in ITEM_STATES:
            raise ValueError("unknown migration item state")
        if next_state != item["state"]:
            if item["state"] == "uncertain":
                raise ValueError("uncertain may only advance through reconcile")
            if next_state not in ALLOWED[item["state"]]:
                raise ValueError(f"cannot transition migration item {item['state']} to {next_state}")
        if next_state in {"sending", "recovering", "uncertain", "forwarded"} and not frozen_operation_id:
            raise ValueError("migration item requires a frozen operation")

        lease_expires = (_now() + timedelta(seconds=lease_seconds)).isoformat()
        await conn.execute("""
            UPDATE storage_migration_items
            SET state = ?, operation_id = ?, lease_owner = ?, lease_expires_at = ?,
                error = ?, version = version + 1, updated_at = ?
            WHERE migration_id = ? AND item_id = ? AND version = ?
        """, (next_state, frozen_operation_id, lease_owner, lease_expires, error, _iso(),
              migration_id, item_id, expected_version))
        await conn.execute("UPDATE storage_migrations SET state = 'running', version = version + 1, updated_at = ? WHERE migration_id = ?", (_iso(), migration_id))
        await conn.commit()
    except Exception:
        await conn.rollback()
        raise
    return await _item_record(db, owner_id, migration_id, item_id)


async def transition_reconciled_item(
    db, owner_id: int, migration_id: str, item_id: str,
    expected_item_version: int, operation_result_version: int,
) -> Dict[str, Any]:
    await ensure_schema(db)
    conn = db._conn
    await conn.execute("BEGIN IMMEDIATE")
    try:
        job = await _job_row(db, owner_id, migration_id)
        item = await _item_row(db, owner_id, migration_id, item_id)
        if job is None or item is None:
            raise KeyError("Migration item not found")
        if item["version"] != expected_item_version:
            raise ValueError("migration item version conflict")
        if item["state"] not in {"uncertain", "recovering", "sending"}:
            raise ValueError("only an in-flight migration item may reconcile")
        if not item["operation_id"]:
            raise ValueError("migration item has no frozen operation")
        operation = await _validate_operation_for_item(db, owner_id, job, item, item["operation_id"])
        if operation["result_version"] != operation_result_version:
            raise ValueError("operation result version conflict")
        mapping = json.loads(operation["mapping_json"] or "{}")
        media = json.loads(operation["media_identity_json"] or "{}")
        if not db._operation_result_complete(mapping, media):
            raise ValueError("operation result is incomplete")
        await conn.execute("""
            UPDATE storage_migration_items
            SET state = 'forwarded', operation_result_version = ?, lease_owner = NULL,
                lease_expires_at = NULL, version = version + 1, updated_at = ?
            WHERE migration_id = ? AND item_id = ? AND version = ?
        """, (operation_result_version, _iso(), migration_id, item_id, expected_item_version))
        await conn.execute("UPDATE storage_migrations SET version = version + 1, updated_at = ? WHERE migration_id = ?", (_iso(), migration_id))
        await conn.commit()
    except Exception:
        await conn.rollback()
        raise
    return await _item_record(db, owner_id, migration_id, item_id)


async def _quorum(db, owner_id: int, migration_id: str, item, operation) -> bool:
    cutoff = _now() - timedelta(minutes=5)
    cursor = await db._conn.execute("""
        SELECT e.telegram_user_id, e.checked_at
        FROM storage_migration_evidence e
        JOIN linked_accounts a
          ON a.owner_id = ? AND a.telegram_user_id = e.telegram_user_id
        WHERE e.migration_id = ? AND e.item_id = ?
          AND e.result_version = ? AND e.read_probe_ok = 1
    """, (owner_id, migration_id, item["item_id"], operation["result_version"]))
    valid = []
    for row in await cursor.fetchall():
        checked = _parse_time(row["checked_at"])
        if checked and cutoff <= checked <= _now():
            valid.append(row["telegram_user_id"])
    return len(set(valid)) >= 2 and any(reader != operation["uploader_id"] for reader in valid)


async def validate_commit_quorum(db, owner_id: int, migration_id: str, item_id: str) -> bool:
    await ensure_schema(db)
    job = await _job_row(db, owner_id, migration_id)
    item = await _item_row(db, owner_id, migration_id, item_id)
    if job is None or item is None or not item["operation_id"]:
        return False
    operation = await _validate_operation_for_item(db, owner_id, job, item, item["operation_id"])
    return await _quorum(db, owner_id, migration_id, item, operation)


async def upsert_migration_evidence(
    db,
    owner_id: int,
    migration_id: str,
    item_id: str,
    telegram_user_id: int,
    *,
    expected_item_version: int,
    result_version: int,
    target_channel_id: str,
    destination_message_id: int,
    media_kind: str,
    media_id: str,
    size_bytes: int,
    photo_variant: Optional[str],
    read_probe_ok: bool,
    checked_at: str,
    source_read_probe_ok: bool = False,
) -> Dict[str, Any]:
    await ensure_schema(db)
    conn = db._conn
    await conn.execute("BEGIN IMMEDIATE")
    try:
        job = await _job_row(db, owner_id, migration_id)
        item = await _item_row(db, owner_id, migration_id, item_id)
        if job is None or item is None:
            raise KeyError("Migration item not found")
        if item["version"] != expected_item_version:
            raise ValueError("migration item version conflict")
        if item["state"] not in {"forwarded", "pending_quorum", "verified"}:
            raise ValueError("migration evidence requires a forwarded item")
        cursor = await conn.execute(
            "SELECT 1 FROM linked_accounts WHERE owner_id = ? AND telegram_user_id = ?",
            (owner_id, telegram_user_id),
        )
        if await cursor.fetchone() is None:
            raise PermissionError("evidence account is not currently linked")
        operation = await _validate_operation_for_item(db, owner_id, job, item, item["operation_id"])
        if operation["result_version"] != result_version:
            raise ValueError("operation result version conflict")
        mapping = json.loads(operation["mapping_json"] or "{}")
        media = json.loads(operation["media_identity_json"] or "{}")
        expected = (
            operation["target_channel_id"], mapping.get("destination_message_id"),
            media.get("destination_media_kind"), media.get("destination_media_id"),
            media.get("destination_size"), media.get("destination_photo_variant"),
        )
        supplied = (target_channel_id, destination_message_id, media_kind, media_id, size_bytes, photo_variant)
        if expected != supplied:
            raise ValueError("migration evidence does not match persisted operation result")
        if not read_probe_ok:
            raise ValueError("migration evidence must prove destination readability")
        checked = _parse_time(checked_at)
        if checked is None or checked > _now() + timedelta(seconds=5):
            raise ValueError("migration evidence timestamp is invalid")
        stamp = _iso()
        await conn.execute("""
            INSERT INTO storage_migration_evidence (
                migration_id, item_id, telegram_user_id, result_version,
                target_channel_id, destination_message_id, media_kind, media_id,
                size_bytes, photo_variant, read_probe_ok, checked_at,
                source_read_probe_ok, source_checked_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
            ON CONFLICT(migration_id, item_id, telegram_user_id) DO UPDATE SET
                result_version = excluded.result_version,
                target_channel_id = excluded.target_channel_id,
                destination_message_id = excluded.destination_message_id,
                media_kind = excluded.media_kind,
                media_id = excluded.media_id,
                size_bytes = excluded.size_bytes,
                photo_variant = excluded.photo_variant,
                read_probe_ok = excluded.read_probe_ok,
                checked_at = excluded.checked_at,
                source_read_probe_ok = excluded.source_read_probe_ok,
                source_checked_at = excluded.source_checked_at,
                updated_at = excluded.updated_at
        """, (migration_id, item_id, telegram_user_id, result_version,
              target_channel_id, destination_message_id, media_kind, media_id,
              size_bytes, photo_variant, checked_at, 1 if source_read_probe_ok else 0,
              checked_at if source_read_probe_ok else None, stamp))
        # Evidence itself never applies metadata. It only advances the readiness hint.
        state = "verified" if await _quorum(db, owner_id, migration_id, item, operation) else "pending_quorum"
        await conn.execute("""
            UPDATE storage_migration_items SET state = ?, version = version + 1, updated_at = ?
            WHERE migration_id = ? AND item_id = ? AND version = ?
        """, (state, stamp, migration_id, item_id, expected_item_version))
        await conn.execute("UPDATE storage_migrations SET version = version + 1, updated_at = ? WHERE migration_id = ?", (stamp, migration_id))
        await conn.commit()
    except Exception:
        await conn.rollback()
        raise
    return await _item_record(db, owner_id, migration_id, item_id)


async def commit_migration_group(
    db,
    owner_id: int,
    migration_id: str,
    group_id: str,
    expected_job_version: int,
    expected_item_versions: Dict[str, int],
) -> Dict[str, Any]:
    await ensure_schema(db)
    conn = db._conn
    await conn.execute("BEGIN IMMEDIATE")
    try:
        job = await _job_row(db, owner_id, migration_id)
        if job is None:
            raise KeyError("Migration not found")
        if job["version"] != expected_job_version:
            raise ValueError("migration job version conflict")
        cursor = await conn.execute("""
            SELECT * FROM storage_migration_items
            WHERE migration_id = ? AND owner_id = ? AND group_id = ?
            ORDER BY COALESCE(part_index, 0), item_id
        """, (migration_id, owner_id, group_id))
        items = await cursor.fetchall()
        if not items:
            raise KeyError("Migration group not found")
        if set(expected_item_versions) != {item["item_id"] for item in items}:
            raise ValueError("commit must include every migration group item")

        prepared = []
        for item in items:
            if expected_item_versions[item["item_id"]] != item["version"]:
                raise ValueError("migration item version conflict")
            if item["state"] not in {"forwarded", "pending_quorum", "verified"}:
                raise ValueError("migration group contains an item that is not ready")
            if not item["operation_id"] or not item["operation_result_version"]:
                raise ValueError("migration item has no authoritative operation result")
            operation = await _validate_operation_for_item(db, owner_id, job, item, item["operation_id"])
            if not await _quorum(db, owner_id, migration_id, item, operation):
                raise ValueError("migration commit quorum is not satisfied")
            prepared.append((item, operation))

        bindings = []
        for item, _operation in prepared:
            binding = await db._validate_and_switch_file(
                owner_id, item["file_id"], item["expected_location_version"],
                item["operation_id"], item["operation_result_version"],
            )
            bindings.append(binding)
            await conn.execute("""
                UPDATE storage_migration_items
                SET state = 'applied', applied_location_version = ?, version = version + 1,
                    lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
                WHERE migration_id = ? AND item_id = ?
            """, (binding["location_version"], _iso(), migration_id, item["item_id"]))

        cursor = await conn.execute(
            "SELECT COUNT(*) FROM storage_migration_items WHERE migration_id = ? AND state != 'applied'",
            (migration_id,),
        )
        remaining = (await cursor.fetchone())[0]
        await conn.execute(
            "UPDATE storage_migrations SET state = ?, version = version + 1, updated_at = ? WHERE migration_id = ?",
            ("completed" if remaining == 0 else "running", _iso(), migration_id),
        )
        await conn.commit()
    except Exception:
        await conn.rollback()
        raise
    return await get_migration_job(db, owner_id, migration_id)


async def _fresh_source_evidence(db, owner_id: int, migration_id: str, item) -> bool:
    source = json.loads(item["source_location_json"])
    source_account = source.get("telegram_user_id")
    if source_account is None:
        return False
    cursor = await db._conn.execute("""
        SELECT e.source_checked_at
        FROM storage_migration_evidence e
        JOIN linked_accounts a
          ON a.owner_id = ? AND a.telegram_user_id = e.telegram_user_id
        WHERE e.migration_id = ? AND e.item_id = ?
          AND e.telegram_user_id = ? AND e.source_read_probe_ok = 1
    """, (owner_id, migration_id, item["item_id"], source_account))
    row = await cursor.fetchone()
    if row is None:
        return False
    checked = _parse_time(row["source_checked_at"])
    return bool(checked and _now() - timedelta(minutes=5) <= checked <= _now())


async def rollback_migration_group(
    db,
    owner_id: int,
    migration_id: str,
    group_id: str,
    expected_location_versions: Dict[str, int],
) -> Dict[str, Any]:
    await ensure_schema(db)
    conn = db._conn
    await conn.execute("BEGIN IMMEDIATE")
    try:
        job = await _job_row(db, owner_id, migration_id)
        if job is None:
            raise KeyError("Migration not found")
        cursor = await conn.execute("""
            SELECT * FROM storage_migration_items
            WHERE migration_id = ? AND owner_id = ? AND group_id = ?
            ORDER BY COALESCE(part_index, 0), item_id
        """, (migration_id, owner_id, group_id))
        items = await cursor.fetchall()
        if not items or set(expected_location_versions) != {item["item_id"] for item in items}:
            raise ValueError("rollback must include every migration group item")

        for item in items:
            if item["state"] != "applied":
                raise ValueError("only applied migration items may roll back")
            expected = expected_location_versions[item["item_id"]]
            if item["applied_location_version"] != expected:
                raise ValueError("rollback location version conflict")
            if not await _fresh_source_evidence(db, owner_id, migration_id, item):
                raise ValueError("rollback requires fresh source-read evidence")
            file_row = await db.get_file(item["file_id"], owner_id)
            if file_row is None or file_row["location_version"] != expected:
                raise ValueError("rollback location version conflict")
            operation = await _validate_operation_for_item(db, owner_id, job, item, item["operation_id"])
            mapping = json.loads(operation["mapping_json"] or "{}")
            media = json.loads(operation["media_identity_json"] or "{}")
            if (
                file_row["telegram_chat_id"] != operation["target_channel_id"]
                or file_row["telegram_message_id"] != mapping.get("destination_message_id")
                or file_row["telegram_media_kind"] != media.get("destination_media_kind")
                or file_row["telegram_media_id"] != media.get("destination_media_id")
                or file_row["telegram_media_size"] != media.get("destination_size")
            ):
                raise ValueError("applied migration location no longer matches destination")

        for item in items:
            source = json.loads(item["source_location_json"])
            expected = expected_location_versions[item["item_id"]]
            cursor = await conn.execute("""
                UPDATE files
                SET telegram_user_id = ?, telegram_chat_id = ?, telegram_message_id = ?,
                    access_hash = ?, telegram_media_kind = ?, telegram_media_id = ?,
                    telegram_media_size = ?, telegram_photo_variant = ?, location_version = ?
                WHERE owner_id = ? AND file_id = ? AND location_version = ?
            """, (
                source["telegram_user_id"], source["telegram_chat_id"], source["telegram_message_id"],
                source.get("access_hash"), source["telegram_media_kind"], source["telegram_media_id"],
                source["telegram_media_size"], source["telegram_photo_variant"], expected + 1,
                owner_id, item["file_id"], expected,
            ))
            if cursor.rowcount != 1:
                raise ValueError("rollback location version conflict")
            await conn.execute("""
                UPDATE storage_migration_items
                SET state = 'rolled_back', applied_location_version = ?, version = version + 1, updated_at = ?
                WHERE migration_id = ? AND item_id = ?
            """, (expected + 1, _iso(), migration_id, item["item_id"]))

        cursor = await conn.execute(
            "SELECT COUNT(*) FROM storage_migration_items WHERE migration_id = ? AND state != 'rolled_back'",
            (migration_id,),
        )
        remaining = (await cursor.fetchone())[0]
        await conn.execute(
            "UPDATE storage_migrations SET state = ?, version = version + 1, updated_at = ? WHERE migration_id = ?",
            ("rolled_back" if remaining == 0 else "running", _iso(), migration_id),
        )
        await conn.commit()
    except Exception:
        await conn.rollback()
        raise
    return await get_migration_job(db, owner_id, migration_id)
