import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  summary: null as any,
  item: null as any,
  operation: null as any,
  idleChecks: 0,
  claimItemRequests: [] as any[],
  forwardCalls: 0,
  progress: [] as any[],
}));

function reset() {
  state.idleChecks = 0;
  state.claimItemRequests.length = 0;
  state.forwardCalls = 0;
  state.progress.length = 0;
  state.item = {
    migration_id: 'migration-yield-race',
    item_id: 'item-1',
    file_id: 'file-1',
    group_id: 'group-1',
    part_index: null,
    state: 'planned',
    version: 1,
    source_location: {
      telegram_user_id: 42,
      telegram_chat_id: null,
      telegram_message_id: 1001,
      telegram_media_kind: 'document',
      telegram_media_id: 'source-1001',
      telegram_media_size: 123,
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
  };
  state.operation = null;
  state.summary = {
    migration_id: 'migration-yield-race',
    state: 'planned',
    version: 1,
    dry_run: false,
    target_channel_id: '123456789',
    target_version: 3,
    accounts_version: 2,
    target_snapshot: {},
    total_items: 1,
    total_groups: 1,
    item_counts: { planned: 1 },
    next_retry_at: null,
    created_at: '2026-09-12T00:00:00Z',
    updated_at: '2026-09-12T00:00:00Z',
  };
}

vi.mock('../api/client.ts', () => ({
  api: {
    getMigrationJob: vi.fn(async () => state.summary),
    listMigrationGroups: vi.fn(async () => ({
      groups: state.item.lease_owner ? [] : [{ group_id: 'group-1', items: [state.item] }],
      next_after: null,
    })),
    claimMigrationGroup: vi.fn(async (request: any) => {
      if (request.expectedItemVersions[state.item.item_id] !== state.item.version) {
        throw new Error('group version conflict');
      }
      state.item.version += 1;
      state.item.lease_owner = request.leaseOwner;
      state.item.lease_expires_at = '2099-01-01T00:00:00Z';
      state.summary = { ...state.summary, state: 'running', version: state.summary.version + 1 };
      return { group: { group_id: 'group-1', items: [state.item] }, job: state.summary };
    }),
    createTelegramOperation: vi.fn(async (request: any) => {
      state.operation = {
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
      return state.operation;
    }),
    patchTelegramOperation: vi.fn(async (_operationId: string, request: any) => {
      if (request.expected_operation_version !== state.operation.version) throw new Error('operation version conflict');
      state.operation = { ...state.operation, state: request.state ?? state.operation.state, version: state.operation.version + 1 };
      return state.operation;
    }),
    claimMigrationItem: vi.fn(async (request: any) => {
      state.claimItemRequests.push({ ...request });
      if (request.expectedVersion !== state.item.version) throw new Error('item version conflict');
      state.item.version += 1;
      state.item.operation_id = request.operationId ?? state.item.operation_id;
      state.item.state = request.state ?? (['planned', 'retryable'].includes(state.item.state) ? 'sending' : state.item.state);
      state.item.lease_owner = request.leaseOwner;
      state.item.lease_expires_at = request.leaseSeconds === 1
        ? '2026-09-12T00:00:01Z'
        : '2099-01-01T00:00:00Z';
      return { ...state.item };
    }),
    listAccounts: vi.fn(async () => []),
  },
}));

vi.mock('../lib/accountActivityRegistry.ts', () => ({
  accountActivityRegistry: {
    isTrulyIdle: vi.fn(() => {
      state.idleChecks += 1;
      return state.idleChecks === 1;
    }),
  },
}));

vi.mock('../lib/gramjs.ts', () => ({
  getClientFor: vi.fn(() => ({
    accountId: 42,
    offline: false,
    forwardBatchToTarget: vi.fn(async () => {
      state.forwardCalls += 1;
      throw new Error('forward should not run after upload becomes busy');
    }),
  })),
}));
vi.mock('../lib/channelStorage.ts', () => ({
  resolveChannelPeerForAccount: vi.fn(async () => ({ id: 'channel' })),
  validateChannelForAccount: vi.fn(async () => ({ can_read: true })),
}));
vi.mock('../lib/telegramMedia.ts', () => ({ readMedia: vi.fn(() => null) }));
vi.mock('../lib/telegramOperationRecovery.ts', () => ({ RecoveryCursorStore: class { async save() {} } }));

import { runMigrationJob } from './migrateSavedMessagesToChannel.ts';

describe('migration upload-yield race', () => {
  it('shortens an already-prepared item lease when upload becomes busy immediately before Telegram send', async () => {
    reset();

    await expect(runMigrationJob('migration-yield-race', (progress) => {
      state.progress.push(progress);
    })).resolves.toMatchObject({ migration_id: 'migration-yield-race' });

    expect(state.forwardCalls).toBe(0);
    expect(state.claimItemRequests.map((request) => request.leaseSeconds)).toEqual([300, 1]);
    expect(state.claimItemRequests[1]).toMatchObject({
      itemId: 'item-1',
      state: 'sending',
      operationId: state.operation.operation_id,
    });
    expect(state.progress[state.progress.length - 1]).toMatchObject({
      phase: 'idle',
      currentSourceAccount: 42,
      lastError: 'Normal upload active; migration yielded',
    });
  });
});
