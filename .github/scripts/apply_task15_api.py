from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    if old not in text:
        raise SystemExit(f'pattern not found in {path}: {old[:120]!r}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')


# Migration tables are part of normal schema initialization, not merely lazy
# route state. The service remains the single DDL definition.
replace_once(
    'backend/app/services/database.py',
    '''        # Force commit and verify\n        await self._conn.commit()\n        \n        # Verify tables were created\n''',
    '''        # Force commit, then install the metadata-only migration journal.\n        await self._conn.commit()\n        from app.services import storage_migration\n        await storage_migration.ensure_schema(self)\n        \n        # Verify tables were created\n''',
)

# Request/response contracts.
replace_once(
    'backend/app/models/schemas.py',
    'from typing import Literal, Optional, List\n',
    'from typing import Dict, Literal, Optional, List\n',
)
schemas = Path('backend/app/models/schemas.py')
text = schemas.read_text(encoding='utf-8')
if 'class CreateMigrationRequest(BaseModel):' not in text:
    text += r'''


# Storage migration endpoints carry metadata/CAS versions only. Telegram
# sessions, peer access hashes and file bytes are intentionally absent.
class CreateMigrationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_target_version: int = Field(..., ge=0)
    expected_accounts_version: int = Field(..., ge=0)
    dry_run: bool = False


class ItemPatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_version: int = Field(..., ge=1)
    lease_owner: str = Field(..., min_length=1, max_length=128)
    lease_seconds: int = Field(..., ge=1, le=300)
    operation_id: Optional[str] = Field(None, min_length=1, max_length=128)
    state: Optional[str] = Field(None, min_length=1, max_length=32)
    error: Optional[str] = Field(None, max_length=1024)


class ReconcileTransitionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_item_version: int = Field(..., ge=1)
    operation_result_version: int = Field(..., ge=1)


class EvidenceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_item_version: int = Field(..., ge=1)
    result_version: int = Field(..., ge=1)
    target_channel_id: str = Field(..., min_length=1, max_length=12)
    destination_message_id: int = Field(..., gt=0)
    media_kind: Literal["document", "photo"]
    media_id: str = Field(..., min_length=1, max_length=64)
    size_bytes: int = Field(..., ge=0)
    photo_variant: Optional[str] = Field(None, max_length=255)
    read_probe_ok: bool
    checked_at: datetime
    source_read_probe_ok: bool = False

    @field_validator("target_channel_id")
    @classmethod
    def validate_target_channel(cls, value: str) -> str:
        if not is_canonical_channel_id(value):
            raise ValueError("target_channel_id must be canonical")
        return value

    @field_validator("checked_at")
    @classmethod
    def validate_checked_at(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("checked_at must include a timezone")
        return value.astimezone(timezone.utc)


class CommitGroupRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_job_version: int = Field(..., ge=1)
    expected_item_versions: Dict[str, int] = Field(..., min_length=1)


class RollbackGroupRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_location_versions: Dict[str, int] = Field(..., min_length=1)


class MigrationItemResponse(BaseModel):
    model_config = ConfigDict(extra="allow")
    migration_id: str
    item_id: str
    file_id: str
    group_id: str
    state: str
    version: int


class MigrationResponse(BaseModel):
    model_config = ConfigDict(extra="allow")
    migration_id: str
    state: str
    version: int
    dry_run: bool
    target_channel_id: str
    items: List[dict] = Field(default_factory=list)


class EvidenceResponse(BaseModel):
    model_config = ConfigDict(extra="allow")
    telegram_user_id: int
    result_version: int
    target_channel_id: str
'''
    schemas.write_text(text, encoding='utf-8')

# Route imports.
replace_once(
    'backend/app/api/routes.py',
    '''    FileListResponse,\n    FileInfo,\n''',
    '''    FileListResponse,\n    FileInfo,\n    CommitGroupRequest,\n    CreateMigrationRequest,\n    EvidenceRequest,\n    ItemPatchRequest,\n    ReconcileTransitionRequest,\n    RollbackGroupRequest,\n''',
)

# Migration error mapping is deliberately existence-obscuring across owners.
replace_once(
    'backend/app/api/routes.py',
    '''def _operation_error(exc: Exception) -> HTTPException:\n    """Map metadata journal failures without leaking another drive's records."""\n    if isinstance(exc, (KeyError, PermissionError)):\n        return HTTPException(status_code=404, detail="Telegram operation or file not found")\n    if isinstance(exc, ValueError):\n        return HTTPException(status_code=409, detail=str(exc))\n    return HTTPException(status_code=500, detail="Internal server error")\n''',
    '''def _operation_error(exc: Exception) -> HTTPException:\n    """Map metadata journal failures without leaking another drive's records."""\n    if isinstance(exc, (KeyError, PermissionError)):\n        return HTTPException(status_code=404, detail="Telegram operation or file not found")\n    if isinstance(exc, ValueError):\n        return HTTPException(status_code=409, detail=str(exc))\n    return HTTPException(status_code=500, detail="Internal server error")\n\n\ndef _migration_error(exc: Exception) -> HTTPException:\n    if isinstance(exc, (KeyError, PermissionError)):\n        return HTTPException(status_code=404, detail="Storage migration not found")\n    if isinstance(exc, ValueError):\n        return HTTPException(status_code=409, detail=str(exc))\n    return HTTPException(status_code=500, detail="Internal server error")\n''',
)

route_anchor = '@router.post("/telegram-operations")\n'
routes = Path('backend/app/api/routes.py')
text = routes.read_text(encoding='utf-8')
if '@router.post("/storage-migrations")' not in text:
    block = r'''@router.post("/storage-migrations")
async def create_storage_migration(
    request: CreateMigrationRequest, current_user: int = Depends(get_current_user),
):
    db = await get_database()
    try:
        return await db.create_migration_manifest(
            current_user, request.expected_target_version,
            request.expected_accounts_version, request.dry_run,
        )
    except Exception as exc:
        raise _migration_error(exc) from exc


@router.get("/storage-migrations")
async def list_storage_migrations(current_user: int = Depends(get_current_user)):
    db = await get_database()
    return {"migrations": await db.list_migration_jobs(current_user)}


@router.get("/storage-migrations/{migration_id}")
async def get_storage_migration(
    migration_id: str, current_user: int = Depends(get_current_user),
):
    db = await get_database()
    migration = await db.get_migration_job(current_user, migration_id)
    if migration is None:
        raise HTTPException(status_code=404, detail="Storage migration not found")
    return migration


@router.patch("/storage-migrations/{migration_id}/items/{item_id}")
async def patch_storage_migration_item(
    migration_id: str, item_id: str, request: ItemPatchRequest,
    current_user: int = Depends(get_current_user),
):
    db = await get_database()
    try:
        return await db.claim_migration_item(
            current_user, migration_id, item_id, request.expected_version,
            request.lease_owner, request.lease_seconds,
            operation_id=request.operation_id, state=request.state, error=request.error,
        )
    except Exception as exc:
        raise _migration_error(exc) from exc


@router.post("/storage-migrations/{migration_id}/items/{item_id}/reconcile")
async def reconcile_storage_migration_item(
    migration_id: str, item_id: str, request: ReconcileTransitionRequest,
    current_user: int = Depends(get_current_user),
):
    db = await get_database()
    try:
        return await db.transition_reconciled_item(
            current_user, migration_id, item_id,
            request.expected_item_version, request.operation_result_version,
        )
    except Exception as exc:
        raise _migration_error(exc) from exc


@router.put("/storage-migrations/{migration_id}/items/{item_id}/verifications/{telegram_user_id}")
async def put_storage_migration_evidence(
    migration_id: str, item_id: str, telegram_user_id: int,
    request: EvidenceRequest, current_user: int = Depends(get_current_user),
):
    db = await get_database()
    try:
        payload = request.model_dump(mode="json")
        return await db.upsert_migration_evidence(
            current_user, migration_id, item_id, telegram_user_id, **payload,
        )
    except Exception as exc:
        raise _migration_error(exc) from exc


@router.post("/storage-migrations/{migration_id}/groups/{group_id}/commit")
async def commit_storage_migration_group(
    migration_id: str, group_id: str, request: CommitGroupRequest,
    current_user: int = Depends(get_current_user),
):
    db = await get_database()
    try:
        return await db.commit_migration_group(
            current_user, migration_id, group_id,
            request.expected_job_version, request.expected_item_versions,
        )
    except Exception as exc:
        raise _migration_error(exc) from exc


@router.post("/storage-migrations/{migration_id}/groups/{group_id}/rollback")
async def rollback_storage_migration_group(
    migration_id: str, group_id: str, request: RollbackGroupRequest,
    current_user: int = Depends(get_current_user),
):
    db = await get_database()
    try:
        return await db.rollback_migration_group(
            current_user, migration_id, group_id, request.expected_location_versions,
        )
    except Exception as exc:
        raise _migration_error(exc) from exc


'''
    if route_anchor not in text:
        raise SystemExit('telegram operation route anchor not found')
    routes.write_text(text.replace(route_anchor, block + route_anchor, 1), encoding='utf-8')

# Frontend types and API methods used by Task 16.
client = Path('frontend/src/api/client.ts')
text = client.read_text(encoding='utf-8')
if 'export interface StorageMigrationJob {' not in text:
    marker = '/** Durable, metadata-only send intent. Telegram bytes and credentials stay in GramJS. */\n'
    types = r'''export interface StorageMigrationEvidence {
  telegram_user_id: number;
  result_version: number;
  target_channel_id: string;
  destination_message_id: number;
  media_kind: 'document' | 'photo';
  media_id: string;
  size_bytes: number;
  photo_variant?: string | null;
  read_probe_ok: boolean;
  checked_at: string;
  source_read_probe_ok?: boolean;
  source_checked_at?: string | null;
}

export interface StorageMigrationItem {
  migration_id: string;
  item_id: string;
  file_id: string;
  group_id: string;
  part_index?: number | null;
  state: string;
  version: number;
  source_location: Record<string, unknown>;
  expected_location_version: number;
  operation_id?: string | null;
  operation_result_version?: number | null;
  applied_location_version?: number | null;
  evidence: StorageMigrationEvidence[];
}

export interface StorageMigrationJob {
  migration_id: string;
  state: string;
  version: number;
  dry_run: boolean;
  target_channel_id: string;
  target_version: number;
  accounts_version: number;
  target_snapshot: Record<string, unknown>;
  items: StorageMigrationItem[];
}

'''
    if marker not in text:
        raise SystemExit('frontend migration type anchor not found')
    text = text.replace(marker, types + marker, 1)

if 'createMigrationManifest:' not in text:
    marker = '  createTelegramOperation: async (request: TelegramOperationRequest): Promise<TelegramOperation> => {\n'
    methods = r'''  createMigrationManifest: async (params: {
    expectedTargetVersion: number;
    expectedAccountsVersion: number;
    dryRun?: boolean;
  }): Promise<StorageMigrationJob> => {
    const response = await client.post<StorageMigrationJob>('/storage-migrations', {
      expected_target_version: params.expectedTargetVersion,
      expected_accounts_version: params.expectedAccountsVersion,
      dry_run: params.dryRun ?? false,
    });
    return response.data;
  },

  listMigrationJobs: async (): Promise<StorageMigrationJob[]> => {
    const response = await client.get<{ migrations: StorageMigrationJob[] }>('/storage-migrations');
    return response.data.migrations;
  },

  getMigrationJob: async (migrationId: string): Promise<StorageMigrationJob> => {
    const response = await client.get<StorageMigrationJob>(`/storage-migrations/${migrationId}`);
    return response.data;
  },

  claimMigrationItem: async (params: {
    migrationId: string;
    itemId: string;
    expectedVersion: number;
    leaseOwner: string;
    leaseSeconds: number;
    operationId?: string;
    state?: string;
    error?: string;
  }): Promise<StorageMigrationItem> => {
    const response = await client.patch<StorageMigrationItem>(
      `/storage-migrations/${params.migrationId}/items/${params.itemId}`,
      {
        expected_version: params.expectedVersion,
        lease_owner: params.leaseOwner,
        lease_seconds: params.leaseSeconds,
        operation_id: params.operationId,
        state: params.state,
        error: params.error,
      },
    );
    return response.data;
  },

  reconcileMigrationItem: async (params: {
    migrationId: string;
    itemId: string;
    expectedItemVersion: number;
    operationResultVersion: number;
  }): Promise<StorageMigrationItem> => {
    const response = await client.post<StorageMigrationItem>(
      `/storage-migrations/${params.migrationId}/items/${params.itemId}/reconcile`,
      {
        expected_item_version: params.expectedItemVersion,
        operation_result_version: params.operationResultVersion,
      },
    );
    return response.data;
  },

  putMigrationEvidence: async (params: {
    migrationId: string;
    itemId: string;
    telegramUserId: number;
    evidence: Omit<StorageMigrationEvidence, 'telegram_user_id' | 'source_checked_at'> & { expected_item_version: number };
  }): Promise<StorageMigrationItem> => {
    const response = await client.put<StorageMigrationItem>(
      `/storage-migrations/${params.migrationId}/items/${params.itemId}/verifications/${params.telegramUserId}`,
      params.evidence,
    );
    return response.data;
  },

  commitMigrationGroup: async (params: {
    migrationId: string;
    groupId: string;
    expectedJobVersion: number;
    expectedItemVersions: Record<string, number>;
  }): Promise<StorageMigrationJob> => {
    const response = await client.post<StorageMigrationJob>(
      `/storage-migrations/${params.migrationId}/groups/${params.groupId}/commit`,
      {
        expected_job_version: params.expectedJobVersion,
        expected_item_versions: params.expectedItemVersions,
      },
    );
    return response.data;
  },

  rollbackMigrationGroup: async (params: {
    migrationId: string;
    groupId: string;
    expectedLocationVersions: Record<string, number>;
  }): Promise<StorageMigrationJob> => {
    const response = await client.post<StorageMigrationJob>(
      `/storage-migrations/${params.migrationId}/groups/${params.groupId}/rollback`,
      { expected_location_versions: params.expectedLocationVersions },
    );
    return response.data;
  },

'''
    if marker not in text:
        raise SystemExit('frontend migration method anchor not found')
    text = text.replace(marker, methods + marker, 1)
client.write_text(text, encoding='utf-8')

# Every new route is explicitly authentication-covered.
authz = Path('backend/tests/test_api_authz.py')
text = authz.read_text(encoding='utf-8')
if '("/api/v1/storage-migrations", "GET"' not in text:
    marker = '''    ("/api/v1/storage-target", "PUT", "/api/v1/storage-target", {\n        "storage_mode": "channel", "channel_id": "1234567890",\n        "expected_version": 0, "expected_accounts_version": 0, "verifications": [],\n    }),\n'''
    entries = marker + '''    ("/api/v1/storage-migrations", "GET", "/api/v1/storage-migrations", None),\n    ("/api/v1/storage-migrations", "POST", "/api/v1/storage-migrations", {}),\n    ("/api/v1/storage-migrations/{migration_id}", "GET", "/api/v1/storage-migrations/migration", None),\n    ("/api/v1/storage-migrations/{migration_id}/items/{item_id}", "PATCH", "/api/v1/storage-migrations/migration/items/item", {}),\n    ("/api/v1/storage-migrations/{migration_id}/items/{item_id}/reconcile", "POST", "/api/v1/storage-migrations/migration/items/item/reconcile", {}),\n    ("/api/v1/storage-migrations/{migration_id}/items/{item_id}/verifications/{telegram_user_id}", "PUT", "/api/v1/storage-migrations/migration/items/item/verifications/123", {}),\n    ("/api/v1/storage-migrations/{migration_id}/groups/{group_id}/commit", "POST", "/api/v1/storage-migrations/migration/groups/group/commit", {}),\n    ("/api/v1/storage-migrations/{migration_id}/groups/{group_id}/rollback", "POST", "/api/v1/storage-migrations/migration/groups/group/rollback", {}),\n'''
    if marker not in text:
        raise SystemExit('authz storage target anchor not found')
    text = text.replace(marker, entries, 1)

if 'def test_storage_migration_routes_are_owner_scoped(' not in text:
    marker = '\n\ndef _requires_authentication(endpoint) -> bool:\n'
    test_block = r'''

def test_storage_migration_routes_are_owner_scoped(client, db, run, make_file):
    run(db.link_account(OWNER_B, OWNER_B, is_primary=True))
    target = run(db.put_storage_target(
        OWNER_B,
        {"storage_mode": "channel", "channel_id": "1234567890", "channel_title": "B migration"},
        expected_version=0,
        expected_accounts_version=1,
        verifications=[{
            "telegram_user_id": OWNER_B,
            "channel_id": "1234567890",
            "channel_title": "B migration",
            "can_read": True,
            "can_write": True,
            "status": "verified",
            "checked_at": datetime.now(timezone.utc).isoformat(),
            "accounts_version": 1,
        }],
    ))
    make_file("b-migration-file", owner_id=OWNER_B, telegram_message_id=44, filesize=1)
    job = run(db.create_migration_manifest(
        OWNER_B, target["version"], target["accounts_version"],
    ))
    item = job["items"][0]

    assert client.get("/api/v1/storage-migrations").json() == {"migrations": []}
    requests = [
        ("GET", f"/api/v1/storage-migrations/{job['migration_id']}", None),
        ("PATCH", f"/api/v1/storage-migrations/{job['migration_id']}/items/{item['item_id']}", {
            "expected_version": item["version"], "lease_owner": "other", "lease_seconds": 30,
        }),
        ("POST", f"/api/v1/storage-migrations/{job['migration_id']}/items/{item['item_id']}/reconcile", {
            "expected_item_version": item["version"], "operation_result_version": 1,
        }),
        ("PUT", f"/api/v1/storage-migrations/{job['migration_id']}/items/{item['item_id']}/verifications/{OWNER_B}", {
            "expected_item_version": item["version"], "result_version": 1,
            "target_channel_id": "1234567890", "destination_message_id": 1,
            "media_kind": "document", "media_id": "1", "size_bytes": 1,
            "read_probe_ok": True, "checked_at": datetime.now(timezone.utc).isoformat(),
        }),
        ("POST", f"/api/v1/storage-migrations/{job['migration_id']}/groups/{item['group_id']}/commit", {
            "expected_job_version": job["version"],
            "expected_item_versions": {item["item_id"]: item["version"]},
        }),
        ("POST", f"/api/v1/storage-migrations/{job['migration_id']}/groups/{item['group_id']}/rollback", {
            "expected_location_versions": {item["item_id"]: 1},
        }),
    ]
    for method, path, body in requests:
        response = client.request(method, path, json=body)
        assert response.status_code == 404, f"{method} {path} answered {response.status_code}: {response.text}"
'''
    if marker not in text:
        raise SystemExit('authz helper anchor not found')
    text = text.replace(marker, test_block + marker, 1)
authz.write_text(text, encoding='utf-8')
