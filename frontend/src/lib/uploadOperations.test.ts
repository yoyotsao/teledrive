import { describe, expect, it, vi } from 'vitest';
import {
  UploadOperationError,
  chooseFrozenUploadWriter,
  freezeUploadTarget,
  planDedupRelocation,
  runDurableUploadGroup,
} from './uploadOperations.ts';

const channelTarget = {
  storage_mode: 'channel' as const,
  channel_id: '123456789',
  channel_title: 'Storage',
  version: 7,
  accounts_version: 4,
  verifications: [],
};

const accounts = [
  { telegram_user_id: 11, label: 'primary', is_primary: 1, file_count: 1 },
  { telegram_user_id: 22, label: 'secondary', is_primary: 0, file_count: 0 },
];

describe('freezeUploadTarget', () => {
  it('freezes channel/version/account identity for the whole upload', () => {
    const frozen = freezeUploadTarget(channelTarget, accounts);
    expect(frozen).toEqual({
      storageMode: 'channel',
      channelId: '123456789',
      targetPeerKey: '123456789',
      targetVersion: 7,
      accountsVersion: 4,
      accountIds: [11, 22],
      primaryAccountId: 11,
    });
    expect(Object.isFrozen(frozen)).toBe(true);
  });

  it('binds Saved Messages to the primary account instead of a floating @me', () => {
    const frozen = freezeUploadTarget({ ...channelTarget, storage_mode: 'saved_messages', channel_id: null }, accounts);
    expect(frozen.targetPeerKey).toBe('me:11');
    expect(frozen.primaryAccountId).toBe(11);
  });
});

describe('chooseFrozenUploadWriter', () => {
  it('uses a currently live channel writer and never falls back to @me', async () => {
    const frozen = freezeUploadTarget(channelTarget, accounts);
    const managers = [{ accountId: 11 }, { accountId: 22 }];
    const result = await chooseFrozenUploadWriter(frozen, managers, async (manager) => ({
      can_write: manager.accountId === 22,
      peer: manager.accountId === 22 ? { id: 'peer-123456789' } : null,
    }));
    expect(result.manager.accountId).toBe(22);
    expect(result.peer).toEqual({ id: 'peer-123456789' });
  });

  it('returns UPLOAD_UNAVAILABLE when the channel has zero live writers', async () => {
    const frozen = freezeUploadTarget(channelTarget, accounts);
    await expect(chooseFrozenUploadWriter(
      frozen,
      [{ accountId: 11 }, { accountId: 22 }],
      async () => ({ can_write: false, peer: null }),
    )).rejects.toMatchObject({ code: 'UPLOAD_UNAVAILABLE' });
  });
});

describe('runDurableUploadGroup', () => {
  it('persists every operation/random id before its Telegram send and registers only after every result', async () => {
    const events: string[] = [];
    const createOperation = vi.fn(async (request: any) => {
      events.push(`create:${request.part_index}:${request.random_id}`);
      return { ...request, version: 1, state: 'planned' };
    });
    const saveCursor = vi.fn(async (cursor: any) => {
      events.push(`cursor:${cursor.partIndex}:${cursor.randomId}`);
    });
    const send = vi.fn(async (part: any) => {
      events.push(`send:${part.partIndex}:${part.randomId}`);
      return {
        messageId: 100 + part.partIndex,
        mediaKind: 'document' as const,
        mediaId: `media-${part.partIndex}`,
        size: part.size,
      };
    });
    const persistResult = vi.fn(async (operation: any, result: any) => {
      events.push(`result:${operation.part_index}:${result.messageId}`);
      return { ...operation, state: 'sent', version: 2, result_version: 1 };
    });
    const registerGroup = vi.fn(async (groupId: string) => {
      events.push(`register:${groupId}`);
      return [];
    });

    await runDurableUploadGroup({
      frozen: freezeUploadTarget(channelTarget, accounts),
      writer: { manager: { accountId: 22 }, peer: { id: 'peer-123456789' } },
      groupId: 'group-1',
      logicalFileId: 'file-1',
      filename: 'big.bin',
      fileHash: 'a'.repeat(64),
      parts: [
        { partIndex: 0, size: 10, operationId: 'op-0', randomId: '9001' },
        { partIndex: 1, size: 20, operationId: 'op-1', randomId: '9002' },
      ],
    }, { createOperation, saveCursor, send, persistResult, registerGroup });

    expect(events.indexOf('create:0:9001')).toBeLessThan(events.indexOf('send:0:9001'));
    expect(events.indexOf('cursor:0:9001')).toBeLessThan(events.indexOf('send:0:9001'));
    expect(events.indexOf('create:1:9002')).toBeLessThan(events.indexOf('send:1:9002'));
    expect(events.indexOf('cursor:1:9002')).toBeLessThan(events.indexOf('send:1:9002'));
    expect(events[events.length - 1]).toBe('register:group-1');
    expect(registerGroup).toHaveBeenCalledTimes(1);
  });

  it('does not group-register when any part send/result is incomplete', async () => {
    const registerGroup = vi.fn();
    await expect(runDurableUploadGroup({
      frozen: freezeUploadTarget(channelTarget, accounts),
      writer: { manager: { accountId: 22 }, peer: { id: 'peer-123456789' } },
      groupId: 'group-2',
      logicalFileId: 'file-2',
      filename: 'broken.bin',
      parts: [
        { partIndex: 0, size: 10, operationId: 'op-a', randomId: '9101' },
        { partIndex: 1, size: 20, operationId: 'op-b', randomId: '9102' },
      ],
    }, {
      createOperation: async (request: any) => ({ ...request, version: 1, state: 'planned' }),
      saveCursor: async () => undefined,
      send: async (part: any) => {
        if (part.partIndex === 1) throw new Error('telegram failed');
        return { messageId: 101, mediaKind: 'document' as const, mediaId: 'm', size: part.size };
      },
      persistResult: async (operation: any) => ({ ...operation, version: 2, result_version: 1, state: 'sent' }),
      registerGroup,
    })).rejects.toThrow('telegram failed');
    expect(registerGroup).not.toHaveBeenCalled();
  });
});

describe('planDedupRelocation', () => {
  it('reuses a complete same-channel hash match without another Telegram send', () => {
    const frozen = freezeUploadTarget(channelTarget, accounts);
    expect(planDedupRelocation(frozen, [
      { file_id: 'a', telegram_chat_id: '123456789', telegram_user_id: 11, location_version: 3 },
    ])).toBe('reuse');
  });

  it('requires durable relocation for Saved Messages and rejects another channel', () => {
    const frozen = freezeUploadTarget(channelTarget, accounts);
    expect(planDedupRelocation(frozen, [
      { file_id: 'a', telegram_chat_id: null, telegram_user_id: 11, location_version: 3 },
    ])).toBe('relocate');
    expect(() => planDedupRelocation(frozen, [
      { file_id: 'a', telegram_chat_id: '999', telegram_user_id: 11, location_version: 3 },
    ])).toThrowError(UploadOperationError);
  });
});
