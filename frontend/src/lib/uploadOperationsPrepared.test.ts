import { describe, expect, it, vi } from 'vitest';
import { freezeUploadTarget, runPreparedDurableUploadGroup } from './uploadOperations.ts';

const accounts = [
  { telegram_user_id: 11, is_primary: 1 },
  { telegram_user_id: 22, is_primary: 0 },
];

const targetA = {
  storage_mode: 'channel' as const,
  channel_id: '111',
  version: 1,
  accounts_version: 3,
};

const targetB = {
  ...targetA,
  channel_id: '222',
  version: 2,
};

describe('runPreparedDurableUploadGroup', () => {
  it('persists every child identity before one bulk send and registers against the frozen target', async () => {
    const frozen = freezeUploadTarget(targetA, accounts);
    let currentTarget = targetA;
    const events: string[] = [];
    const registerGroup = vi.fn(async () => {
      events.push(`register:${frozen.targetPeerKey}:${currentTarget.channel_id}`);
      return [];
    });

    await runPreparedDurableUploadGroup({
      frozen,
      writer: { manager: { accountId: 22 }, peer: 'peer-A' },
      groupId: 'group-a',
      logicalFileId: 'logical-a',
      filename: 'movie.bin',
      mimeType: 'application/octet-stream',
      parentId: 'folder-1',
      fileHash: 'f'.repeat(64),
      parts: [
        { partIndex: 0, size: 10, operationId: 'op-0', randomId: '5001', hasThumbnail: true },
        { partIndex: 1, size: 20, operationId: 'op-1', randomId: '5002', hasThumbnail: false },
      ],
    }, {
      createOperation: async (request: any) => {
        events.push(`create:${request.part_index}:${request.target_peer_key}`);
        return { ...request, version: 0, state: 'planned' };
      },
      markSending: async (operation: any) => {
        events.push(`sending:${operation.part_index}`);
        return { ...operation, version: 1, state: 'sending' };
      },
      saveCursor: async (cursor: any) => {
        events.push(`cursor:${cursor.partIndex}:${cursor.randomId}`);
      },
      sendAll: async (parts: any[], writer: any) => {
        // This is the exact race in the plan: settings change after the frozen
        // identities exist but before the Telegram responses are registered.
        currentTarget = targetB;
        events.push(`send:${writer.peer}:${parts.map((p) => p.randomId).join(',')}`);
        return parts.map((part) => ({
          messageId: 100 + part.partIndex,
          mediaKind: 'document' as const,
          mediaId: `media-${part.partIndex}`,
          size: part.size,
        }));
      },
      persistResult: async (operation: any, result: any) => {
        events.push(`result:${operation.part_index}:${result.messageId}`);
        return { ...operation, state: 'sent', version: 2, result_version: 1 };
      },
      registerGroup,
    });

    const sendIndex = events.findIndex((event) => event.startsWith('send:'));
    expect(events.filter((event) => event.startsWith('create:')).length).toBe(2);
    expect(events.filter((event) => event.startsWith('cursor:')).length).toBe(2);
    expect(events.findIndex((event) => event === 'cursor:0:5001')).toBeLessThan(sendIndex);
    expect(events.findIndex((event) => event === 'cursor:1:5002')).toBeLessThan(sendIndex);
    expect(events[sendIndex]).toBe('send:peer-A:5001,5002');
    expect(registerGroup).toHaveBeenCalledWith('group-a');
    expect(events[events.length - 1]).toBe('register:111:222');
  });

  it('never group-registers a partial bulk response', async () => {
    const registerGroup = vi.fn();
    await expect(runPreparedDurableUploadGroup({
      frozen: freezeUploadTarget(targetA, accounts),
      writer: { manager: { accountId: 22 }, peer: 'peer-A' },
      groupId: 'group-b',
      logicalFileId: 'logical-b',
      filename: 'broken.bin',
      parts: [
        { partIndex: 0, size: 10, operationId: 'op-a', randomId: '6001' },
        { partIndex: 1, size: 20, operationId: 'op-b', randomId: '6002' },
      ],
    }, {
      createOperation: async (request: any) => ({ ...request, version: 0, state: 'planned' }),
      markSending: async (operation: any) => ({ ...operation, version: 1, state: 'sending' }),
      saveCursor: async () => undefined,
      sendAll: async () => [{ messageId: 1, mediaKind: 'document' as const, mediaId: 'one', size: 10 }],
      persistResult: async (operation: any) => ({ ...operation, version: 2, state: 'sent', result_version: 1 }),
      registerGroup,
    })).rejects.toThrow(/partial/i);
    expect(registerGroup).not.toHaveBeenCalled();
  });
});
