import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  summary: null as any,
  pages: [] as any[],
  groups: new Map<string, any>(),
  claims: [] as string[],
  commits: [] as string[],
}));

vi.mock('../api/client.ts', () => ({
  api: {
    getMigrationJob: vi.fn(async () => state.summary),
    listMigrationGroups: vi.fn(async () => state.pages.shift() ?? { groups: [], next_after: null }),
    claimMigrationGroup: vi.fn(async (request: any) => {
      state.claims.push(request.groupId);
      return { group: structuredClone(state.groups.get(request.groupId)), job: state.summary };
    }),
    commitMigrationGroup: vi.fn(async (request: any) => {
      state.commits.push(request.groupId);
      state.summary = {
        ...state.summary,
        version: state.summary.version + 1,
        state: state.commits.length >= 2 ? 'completed' : 'running',
        item_counts: {
          ...state.summary.item_counts,
          verified: Math.max(0, state.summary.item_counts.verified - 1),
          applied: state.summary.item_counts.applied + 1,
        },
      };
      return { group: { group_id: request.groupId, items: [] }, job: state.summary };
    }),
    listAccounts: vi.fn(async () => []),
  },
}));

vi.mock('../lib/gramjs.ts', () => ({ getClientFor: vi.fn(() => ({ offline: true })) }));
vi.mock('../lib/channelStorage.ts', () => ({
  resolveChannelPeerForAccount: vi.fn(),
  validateChannelForAccount: vi.fn(),
}));
vi.mock('../lib/telegramMedia.ts', () => ({ readMedia: vi.fn() }));
vi.mock('../lib/telegramOperationRecovery.ts', () => ({ RecoveryCursorStore: class { async save() {} } }));

import { runMigrationJob } from './migrateSavedMessagesToChannel.ts';

function item(groupId: string) {
  return {
    migration_id: 'migration-bounded',
    item_id: `item-${groupId}`,
    file_id: `file-${groupId}`,
    group_id: groupId,
    part_index: null,
    state: 'verified',
    version: 1,
    source_location: { telegram_user_id: 42, telegram_message_id: 17, location_version: 0 },
    expected_location_version: 0,
    operation_id: null,
    operation_result_version: null,
    applied_location_version: null,
    lease_owner: null,
    lease_expires_at: null,
    retry_at: null,
    evidence: [],
  };
}

describe('bounded migration runner', () => {
  beforeEach(() => {
    state.claims.length = 0;
    state.commits.length = 0;
    state.groups.clear();
    state.summary = {
      migration_id: 'migration-bounded', state: 'running', version: 1, dry_run: false,
      target_channel_id: '123456789', target_version: 3, accounts_version: 2,
      target_snapshot: {}, total_items: 2, total_groups: 2,
      item_counts: {
        planned: 0, sending: 0, blocked: 0, failed: 0, forwarded: 0,
        recovering: 0, retryable: 0, uncertain: 0, pending_quorum: 0,
        verified: 2, applied: 0, rolled_back: 0,
      },
      next_retry_at: null,
      created_at: '2026-09-12T00:00:00+00:00', updated_at: '2026-09-12T00:00:00+00:00',
    };
    const a = { group_id: 'group-a', items: [item('group-a')] };
    const b = { group_id: 'group-b', items: [item('group-b')] };
    state.groups.set(a.group_id, a);
    state.groups.set(b.group_id, b);
    state.pages = [
      { groups: [a], next_after: null },
      { groups: [b], next_after: null },
      { groups: [], next_after: null },
    ];
  });

  it('pulls bounded runnable groups without requiring an items array on the job summary', async () => {
    const result = await runMigrationJob('migration-bounded');
    expect(result.state).toBe('completed');
    expect(state.claims).toEqual(['group-a', 'group-b']);
    expect(state.commits).toEqual(['group-a', 'group-b']);
  });
});
