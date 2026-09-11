import { test, expect } from '../support/fixtures.ts';
import type { Page } from '@playwright/test';

type RequestLog = { method: string; path: string; body: any };

type MigrationItem = {
  migration_id: string;
  item_id: string;
  file_id: string;
  group_id: string;
  part_index: number | null;
  state: string;
  version: number;
  source_location: Record<string, any>;
  expected_location_version: number;
  operation_id: string | null;
  operation_result_version: number | null;
  applied_location_version: number | null;
  evidence: any[];
};

type MigrationJob = {
  migration_id: string;
  state: string;
  version: number;
  dry_run: boolean;
  target_channel_id: string;
  target_version: number;
  accounts_version: number;
  target_snapshot: Record<string, any>;
  items: MigrationItem[];
};

function sourceLocation(fileId = 'saved-file') {
  return {
    file_id: fileId,
    telegram_user_id: 42,
    telegram_chat_id: null,
    telegram_message_id: 17,
    telegram_media_kind: 'document',
    telegram_media_id: '7001',
    telegram_media_size: 12,
    telegram_photo_variant: null,
    location_version: 0,
  };
}

function makeJob(overrides: Partial<MigrationJob> = {}): MigrationJob {
  const migrationId = overrides.migration_id ?? 'migration-1';
  return {
    migration_id: migrationId,
    state: 'running',
    version: 1,
    dry_run: false,
    target_channel_id: '123456789',
    target_version: 3,
    accounts_version: 2,
    target_snapshot: { storage_mode: 'channel', channel_id: '123456789', version: 3, accounts_version: 2 },
    items: [{
      migration_id: migrationId,
      item_id: 'item-1',
      file_id: 'saved-file',
      group_id: 'saved-file',
      part_index: null,
      state: 'planned',
      version: 1,
      source_location: sourceLocation(),
      expected_location_version: 0,
      operation_id: null,
      operation_result_version: null,
      applied_location_version: null,
      evidence: [],
    }],
    ...overrides,
  };
}

async function installMigrationTelegramHook(page: Page) {
  await page.addInitScript(() => {
    const append = (entry: any) => {
      const rows = JSON.parse(localStorage.getItem('task16-telegram-calls') || '[]');
      rows.push(entry);
      localStorage.setItem('task16-telegram-calls', JSON.stringify(rows));
    };
    (window as any).__TELEDRIVE_MIGRATION_TELEGRAM__ = {
      forward: async (params: any) => {
        append({ kind: 'forward', ...params });
        return { messageId: 901, mediaKind: 'document', mediaId: '9901', size: 12 };
      },
      readDestination: async (params: any) => {
        append({ kind: 'readDestination', ...params });
        return { messageId: 901, mediaKind: 'document', mediaId: '9901', size: 12 };
      },
      readSource: async (params: any) => {
        append({ kind: 'readSource', ...params });
        return { ok: true };
      },
      verifyReader: async (params: any) => {
        append({ kind: 'verifyReader', ...params });
        return { messageId: 901, mediaKind: 'document', mediaId: '9901', size: 12 };
      },
    };
  });
}

async function migrationCalls(page: Page): Promise<any[]> {
  return page.evaluate(() => JSON.parse(localStorage.getItem('task16-telegram-calls') || '[]'));
}

async function installMigrationApi(page: Page, initialJobs: MigrationJob[] = []) {
  const jobs = new Map(initialJobs.map(job => [job.migration_id, structuredClone(job)]));
  const operations = new Map<string, any>();
  const logs: RequestLog[] = [];

  await page.route('**/api/v1/accounts', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ accounts: [
      { telegram_user_id: 42, label: 'primary', is_primary: 1, file_count: 1 },
      { telegram_user_id: 77, label: 'secondary', is_primary: 0, file_count: 0 },
    ] }),
  }));
  await page.route('**/api/v1/storage-target', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      storage_mode: 'channel', channel_id: '123456789', channel_title: 'Storage',
      version: 3, accounts_version: 2, verifications: [],
    }),
  }));

  await page.route('**/api/v1/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const method = req.method();
    let body: any = null;
    try { body = req.postData() ? JSON.parse(req.postData()!) : null; } catch { body = req.postData(); }

    if (path.startsWith('/storage-migrations') || path.startsWith('/telegram-operations')) {
      logs.push({ method, path, body });
      const json = (data: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });

      if (path === '/storage-migrations' && method === 'GET') return json({ migrations: [...jobs.values()] });
      if (path === '/storage-migrations' && method === 'POST') {
        const job = makeJob({
          migration_id: `migration-${jobs.size + 1}`,
          dry_run: Boolean(body?.dry_run),
          state: body?.dry_run ? 'dry_run' : 'running',
        });
        jobs.set(job.migration_id, job);
        return json(job);
      }

      const getJob = path.match(/^\/storage-migrations\/([^/]+)$/);
      if (getJob && method === 'GET') {
        const job = jobs.get(getJob[1]);
        return job ? json(job) : json({ detail: 'not found' }, 404);
      }

      const patchItem = path.match(/^\/storage-migrations\/([^/]+)\/items\/([^/]+)$/);
      if (patchItem && method === 'PATCH') {
        const job = jobs.get(patchItem[1])!;
        const item = job.items.find(row => row.item_id === patchItem[2])!;
        if (body.expected_version !== item.version) return json({ detail: 'item version conflict' }, 409);
        item.version += 1;
        item.operation_id = body.operation_id ?? item.operation_id;
        if (body.state) item.state = body.state;
        return json(item);
      }

      const reconcile = path.match(/^\/storage-migrations\/([^/]+)\/items\/([^/]+)\/reconcile$/);
      if (reconcile && method === 'POST') {
        const job = jobs.get(reconcile[1])!;
        const item = job.items.find(row => row.item_id === reconcile[2])!;
        item.version += 1;
        item.state = 'forwarded';
        item.operation_result_version = body.operation_result_version;
        return json(item);
      }

      const evidence = path.match(/^\/storage-migrations\/([^/]+)\/items\/([^/]+)\/verifications\/(\d+)$/);
      if (evidence && method === 'PUT') {
        const job = jobs.get(evidence[1])!;
        const item = job.items.find(row => row.item_id === evidence[2])!;
        if (body.expected_item_version !== item.version) return json({ detail: 'item version conflict' }, 409);
        item.version += 1;
        item.evidence = item.evidence.filter(row => row.telegram_user_id !== Number(evidence[3]));
        item.evidence.push({ telegram_user_id: Number(evidence[3]), ...body });
        item.state = item.evidence.length >= 2 ? 'verified' : 'pending_quorum';
        return json(item);
      }

      const commit = path.match(/^\/storage-migrations\/([^/]+)\/groups\/([^/]+)\/commit$/);
      if (commit && method === 'POST') {
        const job = jobs.get(commit[1])!;
        job.version += 1;
        for (const item of job.items.filter(row => row.group_id === commit[2])) {
          item.state = 'applied';
          item.version += 1;
          item.applied_location_version = item.expected_location_version + 1;
        }
        job.state = job.items.every(item => item.state === 'applied') ? 'completed' : 'running';
        return json(job);
      }

      const rollback = path.match(/^\/storage-migrations\/([^/]+)\/groups\/([^/]+)\/rollback$/);
      if (rollback && method === 'POST') {
        const job = jobs.get(rollback[1])!;
        job.version += 1;
        for (const item of job.items.filter(row => row.group_id === rollback[2])) {
          item.state = 'rolled_back';
          item.version += 1;
        }
        return json(job);
      }

      if (path === '/telegram-operations' && method === 'POST') {
        const operation = {
          ...body,
          state: 'planned',
          version: 1,
          result_version: null,
        };
        operations.set(operation.operation_id, operation);
        return json(operation);
      }
      const operationMatch = path.match(/^\/telegram-operations\/([^/]+)$/);
      if (operationMatch && method === 'GET') {
        const operation = operations.get(operationMatch[1]);
        return operation ? json(operation) : json({ detail: 'not found' }, 404);
      }
      if (operationMatch && method === 'PATCH') {
        const operation = operations.get(operationMatch[1])!;
        operation.version += 1;
        if (body.state) operation.state = body.state;
        return json(operation);
      }
      const reconcileOperation = path.match(/^\/telegram-operations\/([^/]+)\/reconcile-result$/);
      if (reconcileOperation && method === 'POST') {
        const operation = operations.get(reconcileOperation[1])!;
        operation.version += 1;
        operation.state = 'sent';
        operation.result_version = (operation.result_version ?? 0) + 1;
        operation.destination_message_id = body.mapping.destination_message_id;
        operation.destination_media_kind = body.media_identity.destination_media_kind;
        operation.destination_media_id = body.media_identity.destination_media_id;
        operation.destination_size = body.media_identity.destination_size;
        return json(operation);
      }
      return json({ detail: `unhandled migration fake ${method} ${path}` }, 501);
    }

    return route.fallback();
  });

  return { jobs, operations, logs };
}

async function openMigration(page: Page) {
  await page.goto('/maintenance/storage-migration');
  await expect(page.getByRole('heading', { name: 'Shared Channel Storage Migration' })).toBeVisible();
}

test('feature-gated maintenance page creates a dry-run without Telegram writes', async ({ page, openDrive }) => {
  await installMigrationTelegramHook(page);
  const backend = await installMigrationApi(page);
  await openDrive();
  await openMigration(page);

  await page.getByRole('button', { name: '建立 Dry Run' }).click();
  await expect(page.getByText('migration-1')).toBeVisible();
  expect(await migrationCalls(page)).toEqual([]);
  expect(backend.logs.find(row => row.method === 'POST' && row.path === '/storage-migrations')?.body).toMatchObject({ dry_run: true });
});

test('migration forwards only from the frozen source account and stores two independent reader evidences', async ({ page, openDrive }) => {
  await installMigrationTelegramHook(page);
  const job = makeJob();
  const backend = await installMigrationApi(page, [job]);
  await openDrive();
  await openMigration(page);

  await page.getByRole('button', { name: '執行 / 繼續' }).click();
  await expect(page.getByText('completed')).toBeVisible();

  const calls = await migrationCalls(page);
  const forwards = calls.filter(call => call.kind === 'forward');
  expect(forwards).toHaveLength(1);
  expect(forwards[0]).toMatchObject({ accountId: 42, sourceMessageId: 17, targetChannelId: '123456789' });

  const readers = calls.filter(call => call.kind === 'verifyReader').map(call => call.accountId).sort();
  expect(readers).toEqual([42, 77]);
  const evidenceRequests = backend.logs.filter(row => row.method === 'PUT' && row.path.includes('/verifications/'));
  expect(evidenceRequests).toHaveLength(2);
  expect(evidenceRequests.map(row => Number(row.path.split('/').at(-1))).sort()).toEqual([42, 77]);

  // The metadata backend must never receive file bytes, sessions or peer credentials.
  const wire = JSON.stringify(backend.logs);
  expect(wire).not.toMatch(/session|access_hash|ArrayBuffer|Uint8Array|raw_bytes|file_bytes/i);
});

test('uncertain reload recovery reuses the persisted operation/random id and never blindly forwards again', async ({ page, openDrive }) => {
  await installMigrationTelegramHook(page);
  const operationId = 'migration-op-stable';
  const job = makeJob({
    items: [{
      ...makeJob().items[0],
      state: 'uncertain',
      version: 4,
      operation_id: operationId,
    }],
  });
  const backend = await installMigrationApi(page, [job]);
  backend.operations.set(operationId, {
    operation_id: operationId,
    kind: 'migration',
    logical_file_id: 'saved-file',
    group_id: 'saved-file',
    part_index: null,
    uploader_id: 42,
    target_kind: 'channel',
    target_channel_id: '123456789',
    target_peer_key: '123456789',
    created_target_version: 3,
    created_accounts_version: 2,
    random_id: '8877665544332211',
    rpc_kind: 'messages.forwardMessages',
    request_metadata: { source: sourceLocation() },
    state: 'uncertain',
    version: 7,
    result_version: null,
    destination_message_id: 901,
  });

  await openDrive();
  await openMigration(page);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Shared Channel Storage Migration' })).toBeVisible();
  await page.getByRole('button', { name: '執行 / 繼續' }).click();
  await expect(page.getByText('completed')).toBeVisible();

  const calls = await migrationCalls(page);
  expect(calls.filter(call => call.kind === 'forward')).toHaveLength(0);
  expect(calls.filter(call => call.kind === 'readDestination')).toContainEqual(expect.objectContaining({
    accountId: 42,
    randomId: '8877665544332211',
    targetChannelId: '123456789',
  }));
  const creates = backend.logs.filter(row => row.method === 'POST' && row.path === '/telegram-operations');
  expect(creates).toHaveLength(0);
});

test('applied migration exposes rollback and uses location-version CAS metadata only', async ({ page, openDrive }) => {
  await installMigrationTelegramHook(page);
  const appliedItem = { ...makeJob().items[0], state: 'applied', version: 8, applied_location_version: 1 };
  const backend = await installMigrationApi(page, [makeJob({ state: 'completed', version: 6, items: [appliedItem] })]);
  await openDrive();
  await openMigration(page);

  await page.getByRole('button', { name: '回滾' }).click();
  await expect(page.getByText('rolled_back')).toBeVisible();
  const rollback = backend.logs.find(row => row.path.endsWith('/rollback'));
  expect(rollback?.body).toEqual({ expected_location_versions: { 'item-1': 1 } });
  expect(JSON.stringify(rollback?.body)).not.toMatch(/filename|parent|session|access_hash|bytes/i);
});
