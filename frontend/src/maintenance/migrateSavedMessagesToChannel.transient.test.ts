import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  summary: null as any,
  groups: [] as any[],
  operations: new Map<string, any>(),
  forwardedAccounts: [] as number[],
  parkRequests: [] as any[],
}));

function itemFor(id: string): any {
  for (const group of state.groups) {
    const item = group.items.find((candidate: any) => candidate.item_id === id);
    if (item) return item;
  }
  throw new Error(`missing item ${id}`);
}

vi.mock('../api/client.ts', () => ({
  api: {
    getMigrationJob: vi.fn(async () => state.summary),
    listMigrationGroups: vi.fn(async ({ limit }: { limit: number }) => ({
      groups: state.groups.filter((group) => group.items.every((item: any) =>
        !item.lease_owner && !['blocked', 'failed', 'applied', 'rolled_back'].includes(item.state)))
        .slice(0, limit),
      next_after: null,
    })),
    claimMigrationGroup: vi.fn(async (request: any) => {
      const group = state.groups.find((candidate) => candidate.group_id === request.groupId);
      if (!group) throw new Error(`missing group ${request.groupId}`);
      for (const item of group.items) {
        if (request.expectedItemVersions[item.item_id] !== item.version) throw new Error('item version conflict');
        item.version += 1;
        item.lease_owner = request.leaseOwner;
        item.lease_expires_at = '2099-01-01T00:00:00Z';
      }
      state.summary = { ...state.summary, state: 'running', version: state.summary.version + 1 };
      return { group, job: state.summary };
    }),
    createTelegramOperation: vi.fn(async (request: any) => {
      const operation = {
        ...request,
        state: 'planned',
        version: 1,
        result_version: null,
        destination_message_id: null,
        destination_media_kind: null,
        destination_media_id: null,
        destination_size: null,
        destination_photo_variant: null,
      };
      state.operations.set(operation.operation_id, operation);
      return operation;
    }),
    getTelegramOperation: vi.fn(async (operationId: string) => state.operations.get(operationId)),
    patchTelegramOperation: vi.fn(async (operationId: string, request: any) => {
      const operation = state.operations.get(operationId);
      if (!operation) throw new Error(`missing operation ${operationId}`);
      if (request.expected_operation_version !== operation.version) throw new Error('operation version conflict');
      if (request.state) operation.state = request.state;
      operation.error_code = request.error_code ?? operation.error_code;
      operation.version += 1;
      return operation;
    }),
    claimMigrationItem: vi.fn(async (request: any) => {
      const item = itemFor(request.itemId);
      if (item.version !== request.expectedVersion) throw new Error('item version conflict');
      item.version += 1;
      item.operation_id = request.operationId ?? item.operation_id;
      item.state = request.state ?? (['planned', 'retryable'].includes(item.state) ? 'sending' : item.state);
      item.error = request.error ?? null;
      item.lease_owner = request.leaseOwner;
      item.lease_expires_at = request.leaseSeconds <= 30 ? '2026-09-12T00:00:05Z' : '2099-01-01T00:00:00Z';
      if (request.state === 'retryable') state.parkRequests.push({ ...request });
      return item;
    }),
    persistReconciledOperationResult: vi.fn(async (request: any) => {
      const operation = state.operations.get(request.operationId);
      operation.version += 1;
      operation.result_version = 1;
      operation.destination_message_id = request.mapping.destination_message_id;
      operation.destination_media_kind = request.mediaIdentity.destination_media_kind;
      operation.destination_media_id = request.mediaIdentity.destination_media_id;
      operation.destination_size = request.mediaIdentity.destination_size;
      return operation;
    }),
    reconcileMigrationItem: vi.fn(async (request: any) => {
      const item = itemFor(request.itemId);
      item.version += 1;
      item.state = 'forwarded';
      item.operation_result_version = request.operationResultVersion;
      item.lease_owner = null;
      item.lease_expires_at = null;
      return item;
    }),
    listAccounts: vi.fn(async () => []),
    putMigrationEvidence: vi.fn(async () => { throw new Error('no evidence expected'); }),
    commitMigrationGroup: vi.fn(async () => { throw new Error('no commit expected'); }),
  },
}));

vi.mock('../lib/gramjs.ts', () => ({
  getClientFor: vi.fn((accountId: number) => ({
    accountId,
    offline: false,
    forwardBatchToTarget: vi.fn(async (_entity: unknown, entries: Array<{ messageId: number; randomId: string }>) => {
      state.forwardedAccounts.push(accountId);
      if (accountId === 42) throw new Error('500: WORKER_BUSY_TOO_LONG_RETRY (caused by messages.ForwardMessages)');
      return entries.map((entry) => ({
        messageId: 100_000 + entry.messageId,
        mediaKind: 'document' as const,
        mediaId: `dest-${entry.messageId}`,
        size: 123,
        photoVariant: null,
      }));
    }),
    forwardToTarget: vi.fn(),
  })),
}));
vi.mock('../lib/channelStorage.ts', () => ({
  resolveChannelPeerForAccount: vi.fn(async (_manager: any, channelId: string) => ({ id: channelId })),
  validateChannelForAccount: vi.fn(async () => ({ can_read: true })),
}));
vi.mock('../lib/telegramMedia.ts', () => ({ readMedia: vi.fn(() => null) }));
vi.mock('../lib/telegramOperationRecovery.ts', () => ({ RecoveryCursorStore: class { async save() {} } }));

import { runMigrationJob } from './migrateSavedMessagesToChannel.ts';

function makeItem(accountId: number, index: number) {
  return {
    migration_id: 'migration-transient',
    item_id: `item-${index}`,
    file_id: `file-${index}`,
    group_id: `group-${index}`,
    part_index: null,
    state: 'planned',
    version: 1,
    source_location: {
      telegram_user_id: accountId,
      telegram_chat_id: null,
      telegram_message_id: index,
      telegram_media_kind: 'document',
      telegram_media_id: `source-${index}`,
      telegram_media_size: 123,
      telegram_photo_variant: null,
      location_version: 0,
    },
    expected_location_version: 0,
    operation_id: null,
    operation_result_version: null,
    lease_owner: null,
    lease_expires_at: null,
    retry_at: null,
    error: null,
    evidence: [],
  };
}

describe('transient migration forward errors', () => {
  beforeEach(() => {
    state.operations.clear();
    state.forwardedAccounts.length = 0;
    state.parkRequests.length = 0;
    state.groups = [
      { group_id: 'group-1', items: [makeItem(42, 1)] },
      { group_id: 'group-2', items: [makeItem(77, 2)] },
    ];
    state.summary = {
      migration_id: 'migration-transient', state: 'planned', version: 1, dry_run: false,
      target_channel_id: '123456789', target_version: 1, accounts_version: 1,
      target_snapshot: {}, total_items: 2, total_groups: 2,
      item_counts: { planned: 2 }, next_retry_at: null,
      created_at: '2026-09-12T00:00:00Z', updated_at: '2026-09-12T00:00:00Z',
    };
  });

  it('parks WORKER_BUSY batch as retryable and continues forwarding another account', async () => {
    await expect(runMigrationJob('migration-transient')).resolves.toBeTruthy();

    expect(state.forwardedAccounts).toEqual([42, 77]);
    expect(itemFor('item-1').state).toBe('retryable');
    expect(state.operations.get(itemFor('item-1').operation_id)?.state).toBe('retryable');
    expect(state.parkRequests[0]?.leaseSeconds).toBeLessThanOrEqual(30);
    expect(itemFor('item-2').state).toBe('forwarded');
  });
});
