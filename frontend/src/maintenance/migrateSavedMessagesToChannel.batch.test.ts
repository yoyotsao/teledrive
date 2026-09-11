import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  summary: null as any,
  groups: [] as any[],
  operations: new Map<string, any>(),
  batchCalls: [] as Array<{ accountId: number; entries: Array<{ messageId: number; randomId: string }> }>,
  singleCalls: [] as Array<{ accountId: number; messageId: number; randomId: string }>,
  managers: new Map<number, any>(),
}));

function findItem(itemId: string): any {
  for (const group of state.groups) {
    const item = group.items.find((candidate: any) => candidate.item_id === itemId);
    if (item) return item;
  }
  throw new Error(`missing item ${itemId}`);
}

vi.mock('../api/client.ts', () => ({
  api: {
    getMigrationJob: vi.fn(async () => state.summary),
    listMigrationGroups: vi.fn(async ({ limit }: { limit: number }) => ({
      groups: state.groups
        .filter((group) => group.items.every((item: any) =>
          !item.lease_owner && !['blocked', 'failed', 'applied', 'rolled_back'].includes(item.state)))
        .slice(0, limit),
      next_after: null,
    })),
    claimMigrationGroup: vi.fn(async (request: any) => {
      const group = state.groups.find((candidate) => candidate.group_id === request.groupId);
      if (!group) throw new Error(`missing group ${request.groupId}`);
      for (const item of group.items) {
        if (request.expectedItemVersions[item.item_id] !== item.version) {
          const error: any = new Error('migration item version conflict');
          error.response = { status: 409 };
          throw error;
        }
      }
      for (const item of group.items) {
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
      Object.assign(operation, request.state ? { state: request.state } : {}, { version: operation.version + 1 });
      return operation;
    }),
    claimMigrationItem: vi.fn(async (request: any) => {
      const item = findItem(request.itemId);
      if (item.version !== request.expectedVersion) throw new Error('item version conflict');
      item.version += 1;
      item.operation_id = request.operationId ?? item.operation_id;
      item.state = request.state ?? (['planned', 'retryable'].includes(item.state) ? 'sending' : item.state);
      item.lease_owner = request.leaseOwner;
      item.lease_expires_at = '2099-01-01T00:00:00Z';
      return item;
    }),
    persistReconciledOperationResult: vi.fn(async (request: any) => {
      const operation = state.operations.get(request.operationId);
      if (!operation) throw new Error(`missing operation ${request.operationId}`);
      if (request.expectedOperationVersion !== operation.version) throw new Error('operation version conflict');
      operation.version += 1;
      operation.result_version = (operation.result_version ?? 0) + 1;
      operation.destination_message_id = request.mapping.destination_message_id;
      operation.destination_media_kind = request.mediaIdentity.destination_media_kind;
      operation.destination_media_id = request.mediaIdentity.destination_media_id;
      operation.destination_size = request.mediaIdentity.destination_size;
      operation.destination_photo_variant = request.mediaIdentity.destination_photo_variant ?? null;
      return operation;
    }),
    reconcileMigrationItem: vi.fn(async (request: any) => {
      const item = findItem(request.itemId);
      if (item.version !== request.expectedItemVersion) throw new Error('item version conflict');
      item.version += 1;
      item.state = 'forwarded';
      item.operation_result_version = request.operationResultVersion;
      item.lease_owner = null;
      item.lease_expires_at = null;
      return item;
    }),
    listAccounts: vi.fn(async () => []),
    putMigrationEvidence: vi.fn(async () => { throw new Error('no evidence expected'); }),
    commitMigrationGroup: vi.fn(async () => { throw new Error('no commit expected without quorum'); }),
  },
}));

function managerFor(accountId: number) {
  let manager = state.managers.get(accountId);
  if (manager) return manager;
  manager = {
    accountId,
    offline: false,
    forwardBatchToTarget: vi.fn(async (_entity: unknown, entries: Array<{ messageId: number; randomId: string }>) => {
      state.batchCalls.push({ accountId, entries: entries.map((entry) => ({ ...entry })) });
      return entries.map((entry) => ({
        messageId: 100_000 + entry.messageId,
        mediaKind: 'document' as const,
        mediaId: `dest-${entry.messageId}`,
        size: 100 + entry.messageId,
        photoVariant: null,
      }));
    }),
    forwardToTarget: vi.fn(async (_entity: unknown, messageId: number, _peer: unknown, randomId: string) => {
      state.singleCalls.push({ accountId, messageId, randomId });
      return {
        messageId: 100_000 + messageId,
        mediaKind: 'document' as const,
        mediaId: `dest-${messageId}`,
        size: 100 + messageId,
        photoVariant: null,
      };
    }),
  };
  state.managers.set(accountId, manager);
  return manager;
}

vi.mock('../lib/gramjs.ts', () => ({ getClientFor: vi.fn((accountId: number) => managerFor(accountId)) }));
vi.mock('../lib/channelStorage.ts', () => ({
  resolveChannelPeerForAccount: vi.fn(async (manager: any) => ({ id: `channel-for-${manager.accountId}` })),
  validateChannelForAccount: vi.fn(async () => ({ can_read: true })),
}));
vi.mock('../lib/telegramMedia.ts', () => ({ readMedia: vi.fn(() => null) }));
vi.mock('../lib/telegramOperationRecovery.ts', () => ({ RecoveryCursorStore: class { async save() {} } }));

import { runMigrationJob } from './migrateSavedMessagesToChannel.ts';

function resetMigration(sourceAccounts: number[]) {
  state.operations.clear();
  state.batchCalls.length = 0;
  state.singleCalls.length = 0;
  state.managers.clear();
  state.groups = sourceAccounts.map((accountId, index) => ({
    group_id: `group-${String(index + 1).padStart(4, '0')}`,
    items: [{
      migration_id: 'migration-batch',
      item_id: `item-${index + 1}`,
      file_id: `file-${index + 1}`,
      group_id: `group-${String(index + 1).padStart(4, '0')}`,
      part_index: null,
      state: 'planned',
      version: 1,
      source_location: {
        telegram_user_id: accountId,
        telegram_chat_id: null,
        telegram_message_id: index + 1,
        telegram_media_kind: 'document',
        telegram_media_id: `source-${index + 1}`,
        telegram_media_size: 100 + index,
        telegram_photo_variant: null,
        location_version: 0,
      },
      expected_location_version: 0,
      operation_id: null,
      operation_result_version: null,
      applied_location_version: null,
      lease_owner: null,
      lease_expires_at: null,
      retry_at: null,
      error: null,
      evidence: [],
    }],
  }));
  state.summary = {
    migration_id: 'migration-batch',
    state: 'planned',
    version: 1,
    dry_run: false,
    target_channel_id: '123456789',
    target_version: 3,
    accounts_version: 2,
    target_snapshot: {},
    total_items: sourceAccounts.length,
    total_groups: sourceAccounts.length,
    item_counts: { planned: sourceAccounts.length },
    next_retry_at: null,
    created_at: '2026-09-12T00:00:00Z',
    updated_at: '2026-09-12T00:00:00Z',
  };
}

describe('batched storage migration forwards', () => {
  beforeEach(() => resetMigration([]));

  it('forwards 100 same-source items in one Telegram batch while retaining one operation/random id per item', async () => {
    resetMigration(Array(100).fill(42));

    await runMigrationJob('migration-batch');

    expect(state.singleCalls).toHaveLength(0);
    expect(state.batchCalls).toHaveLength(1);
    expect(state.batchCalls[0].accountId).toBe(42);
    expect(state.batchCalls[0].entries).toHaveLength(100);
    expect(state.operations).toHaveLength(100);
    expect(new Set(state.batchCalls[0].entries.map((entry) => entry.randomId)).size).toBe(100);
  });

  it('splits 101 same-source items into 100 + 1 Telegram batches', async () => {
    resetMigration(Array(101).fill(42));

    await runMigrationJob('migration-batch');

    expect(state.singleCalls).toHaveLength(0);
    expect(state.batchCalls.map((call) => call.entries.length)).toEqual([100, 1]);
  });

  it('never mixes different source accounts in one Telegram batch', async () => {
    resetMigration([...Array(60).fill(42), ...Array(40).fill(77)]);

    await runMigrationJob('migration-batch');

    expect(state.singleCalls).toHaveLength(0);
    expect(state.batchCalls.map((call) => [call.accountId, call.entries.length])).toEqual([[42, 60], [77, 40]]);
  });
});
