import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  summary: null as any,
  groups: [] as any[],
  operations: new Map<string, any>(),
  getMessagesCalls: [] as Array<{ accountId: number; peer: unknown; ids: number[] }>,
}));

function findGroup(groupId: string) {
  const group = state.groups.find((candidate) => candidate.group_id === groupId);
  if (!group) throw new Error(`missing group ${groupId}`);
  return group;
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
      const group = findGroup(request.groupId);
      for (const item of group.items) {
        if (request.expectedItemVersions[item.item_id] !== item.version) throw new Error('item version conflict');
        item.version += 1;
        item.lease_owner = request.leaseOwner;
        item.lease_expires_at = '2099-01-01T00:00:00Z';
      }
      state.summary = { ...state.summary, state: 'running', version: state.summary.version + 1 };
      return { group, job: state.summary };
    }),
    getTelegramOperation: vi.fn(async (operationId: string) => state.operations.get(operationId)),
    listAccounts: vi.fn(async () => [
      { telegram_user_id: 42 },
      { telegram_user_id: 77 },
    ]),
    putMigrationEvidence: vi.fn(async (request: any) => {
      const item = state.groups.flatMap((group) => group.items)
        .find((candidate: any) => candidate.item_id === request.itemId);
      if (!item) throw new Error(`missing item ${request.itemId}`);
      if (request.evidence.expected_item_version !== item.version) throw new Error('evidence version conflict');
      item.version += 1;
      item.evidence.push({
        telegram_user_id: request.telegramUserId,
        result_version: request.evidence.result_version,
      });
      item.state = item.evidence.length >= 2 ? 'verified' : 'pending_quorum';
      return item;
    }),
    commitMigrationGroup: vi.fn(async (request: any) => {
      const group = findGroup(request.groupId);
      for (const item of group.items) {
        item.version += 1;
        item.state = 'applied';
        item.lease_owner = null;
        item.lease_expires_at = null;
      }
      const complete = state.groups.every((candidate) =>
        candidate.items.every((item: any) => item.state === 'applied'));
      state.summary = {
        ...state.summary,
        state: complete ? 'completed' : 'running',
        version: state.summary.version + 1,
      };
      return { group, job: state.summary };
    }),
  },
}));

function mediaFor(peer: unknown, messageId: number) {
  if (peer === 'me') {
    return { __ref: { kind: 'document', id: `source-${messageId}`, size: 100 + messageId } };
  }
  const sourceId = messageId - 100_000;
  return { __ref: { kind: 'document', id: `dest-${sourceId}`, size: 100 + sourceId } };
}

function managerFor(accountId: number) {
  return {
    accountId,
    offline: false,
    client: {
      getMessages: vi.fn(async (peer: unknown, request: { ids: number[] }) => {
        state.getMessagesCalls.push({ accountId, peer, ids: [...request.ids] });
        return request.ids.map((id) => ({ id, media: mediaFor(peer, id) }));
      }),
    },
  };
}

const managers = new Map<number, any>();
vi.mock('../lib/gramjs.ts', () => ({
  getClientFor: vi.fn((accountId: number) => {
    let manager = managers.get(accountId);
    if (!manager) {
      manager = managerFor(accountId);
      managers.set(accountId, manager);
    }
    return manager;
  }),
}));
vi.mock('../lib/channelStorage.ts', () => ({
  resolveChannelPeerForAccount: vi.fn(async (manager: any) => ({ id: `channel-${manager.accountId}` })),
  validateChannelForAccount: vi.fn(async () => ({ can_read: true })),
}));
vi.mock('../lib/telegramMedia.ts', () => ({ readMedia: vi.fn((media: any) => media?.__ref ?? null) }));
vi.mock('../lib/telegramOperationRecovery.ts', () => ({ RecoveryCursorStore: class { async save() {} } }));

import { runMigrationJob } from './migrateSavedMessagesToChannel.ts';

function resetMigration(count: number) {
  managers.clear();
  state.getMessagesCalls.length = 0;
  state.operations.clear();
  state.groups = Array.from({ length: count }, (_, index) => {
    const sourceId = index + 1;
    const itemId = `item-${sourceId}`;
    const operationId = `op-${sourceId}`;
    state.operations.set(operationId, {
      operation_id: operationId,
      kind: 'migration',
      logical_file_id: `file-${sourceId}`,
      group_id: `group-${String(sourceId).padStart(4, '0')}`,
      part_index: null,
      uploader_id: 42,
      target_kind: 'channel',
      target_channel_id: '123456789',
      target_peer_key: '123456789',
      created_target_version: 3,
      created_accounts_version: 2,
      random_id: String(900_000 + sourceId),
      rpc_kind: 'messages.forwardMessages',
      request_metadata: {},
      state: 'sending',
      version: 2,
      result_version: 1,
      destination_message_id: 100_000 + sourceId,
      destination_media_kind: 'document',
      destination_media_id: `dest-${sourceId}`,
      destination_size: 100 + sourceId,
      destination_photo_variant: null,
    });
    return {
      group_id: `group-${String(sourceId).padStart(4, '0')}`,
      items: [{
        migration_id: 'migration-verify-batch',
        item_id: itemId,
        file_id: `file-${sourceId}`,
        group_id: `group-${String(sourceId).padStart(4, '0')}`,
        part_index: null,
        state: 'forwarded',
        version: 1,
        source_location: {
          telegram_user_id: 42,
          telegram_chat_id: null,
          telegram_message_id: sourceId,
          telegram_media_kind: 'document',
          telegram_media_id: `source-${sourceId}`,
          telegram_media_size: 100 + sourceId,
          telegram_photo_variant: null,
          location_version: 0,
        },
        expected_location_version: 0,
        operation_id: operationId,
        operation_result_version: 1,
        applied_location_version: null,
        lease_owner: null,
        lease_expires_at: null,
        retry_at: null,
        error: null,
        evidence: [],
      }],
    };
  });
  state.summary = {
    migration_id: 'migration-verify-batch',
    state: 'running',
    version: 1,
    dry_run: false,
    target_channel_id: '123456789',
    target_version: 3,
    accounts_version: 2,
    target_snapshot: {},
    total_items: count,
    total_groups: count,
    item_counts: { forwarded: count },
    next_retry_at: null,
    created_at: '2026-09-12T00:00:00Z',
    updated_at: '2026-09-12T00:00:00Z',
  };
}

describe('batched migration verification', () => {
  beforeEach(() => resetMigration(0));

  it('verifies 100 destinations with one Telegram read per reader plus one batched source probe', async () => {
    resetMigration(100);

    const result = await runMigrationJob('migration-verify-batch');

    expect(result.state).toBe('completed');
    expect(state.getMessagesCalls).toHaveLength(3);
    const source = state.getMessagesCalls.find((call) => call.accountId === 42 && call.peer === 'me');
    const reader42 = state.getMessagesCalls.find((call) => call.accountId === 42 && call.peer !== 'me');
    const reader77 = state.getMessagesCalls.find((call) => call.accountId === 77 && call.peer !== 'me');
    expect(source?.ids).toHaveLength(100);
    expect(reader42?.ids).toHaveLength(100);
    expect(reader77?.ids).toHaveLength(100);
  });
});
