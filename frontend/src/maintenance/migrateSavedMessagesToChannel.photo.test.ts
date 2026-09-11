import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  evidencePayloads: [] as any[],
  job: null as any,
  operation: null as any,
}));

vi.mock('../api/client.ts', () => ({
  api: {
    getMigrationJob: vi.fn(async () => state.job),
    getTelegramOperation: vi.fn(async () => state.operation),
    listAccounts: vi.fn(async () => [
      { telegram_user_id: 42 },
      { telegram_user_id: 77 },
    ]),
    putMigrationEvidence: vi.fn(async (request: any) => {
      state.evidencePayloads.push(request.evidence);
      const item = state.job.items[0];
      item.version += 1;
      item.evidence.push({
        telegram_user_id: request.telegramUserId,
        result_version: request.evidence.result_version,
      });
      item.state = item.evidence.length >= 2 ? 'verified' : 'pending_quorum';
      return item;
    }),
    commitMigrationGroup: vi.fn(async () => {
      state.job.items[0].state = 'applied';
      state.job.state = 'completed';
      state.job.version += 1;
      return state.job;
    }),
  },
}));

const manager = {
  offline: false,
  client: {
    getMessages: vi.fn(async (_peer: unknown, request: { ids: number[] }) => [{
      id: request.ids[0],
      media: { className: 'MessageMediaPhoto' },
    }]),
  },
};

vi.mock('../lib/gramjs.ts', () => ({
  getClientFor: vi.fn(() => manager),
}));

vi.mock('../lib/channelStorage.ts', () => ({
  resolveChannelPeerForAccount: vi.fn(async () => ({ id: 123n })),
  validateChannelForAccount: vi.fn(async () => ({ can_read: true })),
}));

vi.mock('../lib/telegramMedia.ts', () => ({
  readMedia: vi.fn(() => ({
    kind: 'photo',
    id: 'photo-999',
    size: 12,
    fullThumbSize: 'x',
  })),
}));

import { runMigrationJob } from './migrateSavedMessagesToChannel.ts';

describe('photo migration evidence', () => {
  beforeEach(() => {
    state.evidencePayloads.length = 0;
    state.operation = {
      operation_id: 'photo-op',
      uploader_id: 42,
      random_id: '12345',
      target_peer_key: '123456789',
      result_version: 4,
      destination_message_id: 901,
      destination_media_kind: 'photo',
      destination_media_id: 'photo-999',
      destination_size: 12,
      destination_photo_variant: 'x',
    };
    state.job = {
      migration_id: 'migration-photo',
      state: 'running',
      version: 1,
      dry_run: false,
      target_channel_id: '123456789',
      target_version: 3,
      accounts_version: 2,
      items: [{
        migration_id: 'migration-photo',
        item_id: 'item-photo',
        file_id: 'photo-file',
        group_id: 'photo-file',
        part_index: null,
        state: 'forwarded',
        version: 1,
        source_location: {
          telegram_user_id: 42,
          telegram_chat_id: null,
          telegram_message_id: 17,
          telegram_media_kind: 'photo',
          telegram_media_id: 'source-photo',
          telegram_media_size: 12,
          telegram_photo_variant: 'w',
          location_version: 0,
        },
        expected_location_version: 0,
        operation_id: 'photo-op',
        operation_result_version: 4,
        applied_location_version: null,
        evidence: [],
      }],
    };
  });

  it('submits the verified destination photo variant as quorum evidence', async () => {
    const result = await runMigrationJob('migration-photo');

    expect(result.state).toBe('completed');
    expect(state.evidencePayloads).toHaveLength(2);
    expect(state.evidencePayloads.map(row => row.photo_variant)).toEqual(['x', 'x']);
  });
});
