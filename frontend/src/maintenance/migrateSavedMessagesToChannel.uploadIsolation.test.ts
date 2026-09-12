import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  claimCalls: 0,
  progress: [] as any[],
}));

const item = {
  migration_id: 'migration-upload-isolation',
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
  lease_owner: null,
  lease_expires_at: null,
  retry_at: null,
  error: null,
  evidence: [],
};

const summary = {
  migration_id: 'migration-upload-isolation',
  state: 'planned',
  version: 1,
  dry_run: false,
  target_channel_id: '123456789',
  target_version: 1,
  accounts_version: 1,
  target_snapshot: {},
  total_items: 1,
  total_groups: 1,
  item_counts: { planned: 1 },
  next_retry_at: null,
  created_at: '2026-09-12T00:00:00Z',
  updated_at: '2026-09-12T00:00:00Z',
};

vi.mock('../api/client.ts', () => ({
  api: {
    getMigrationJob: vi.fn(async () => summary),
    listMigrationGroups: vi.fn(async () => ({
      groups: [{ group_id: 'group-1', items: [item] }],
      next_after: null,
    })),
    claimMigrationGroup: vi.fn(async () => {
      state.claimCalls += 1;
      throw new Error('migration must not claim work while the source account is uploading');
    }),
  },
}));

vi.mock('../lib/accountActivityRegistry.ts', () => ({
  accountActivityRegistry: {
    isTrulyIdle: vi.fn((accountId: number) => accountId !== 42),
  },
}));

vi.mock('../lib/gramjs.ts', () => ({
  getClientFor: vi.fn(() => {
    throw new Error('Telegram must not be touched while normal upload is active');
  }),
}));
vi.mock('../lib/channelStorage.ts', () => ({
  resolveChannelPeerForAccount: vi.fn(),
  validateChannelForAccount: vi.fn(),
}));
vi.mock('../lib/telegramMedia.ts', () => ({ readMedia: vi.fn(() => null) }));
vi.mock('../lib/telegramOperationRecovery.ts', () => ({ RecoveryCursorStore: class { async save() {} } }));

import { runMigrationJob } from './migrateSavedMessagesToChannel.ts';

describe('migration isolation from normal uploads', () => {
  it('yields before claiming or touching Telegram when the source account is busy', async () => {
    state.claimCalls = 0;
    state.progress.length = 0;

    await expect(runMigrationJob('migration-upload-isolation', (progress) => {
      state.progress.push(progress);
    })).resolves.toEqual(summary);

    expect(state.claimCalls).toBe(0);
    expect(state.progress.at(-1)).toMatchObject({
      phase: 'idle',
      currentSourceAccount: 42,
      lastError: 'Normal upload active; migration yielded',
    });
  });
});
