import { describe, expect, it, vi } from 'vitest';
import { Api } from 'telegram/tl';
import { TelegramClientManager } from './gramjs.ts';

function readyManager(fakeClient: Record<string, unknown>): TelegramClientManager {
  const manager = new TelegramClientManager(42, 'writer');
  (manager as any).client = fakeClient;
  (manager as any).initPromise = Promise.resolve();
  return manager;
}

describe('target-aware Telegram sends', () => {
  it('sendFileLocked uses the supplied target peer and persisted random id', async () => {
    const sendFile = vi.fn(async (_peer, _params) => ({ id: 51 }));
    const manager = readyManager({ sendFile, getMe: vi.fn() });

    await (manager as any).sendFileLocked(
      { file: 'prepared', randomId: '777' },
      1,
      'channel-peer',
    );

    expect(sendFile).toHaveBeenCalledTimes(1);
    expect(sendFile.mock.calls[0][0]).toBe('channel-peer');
    expect(String(sendFile.mock.calls[0][1].randomId)).toBe('777');
  });

  it('sendAlbum freezes one peer and the exact persisted random id for every child', async () => {
    const invoke = vi.fn(async (request: any) => ({
      updates: [
        { message: { id: 71, media: { className: 'MessageMediaDocument', document: { id: 1001n, accessHash: 2001n, size: 12, mimeType: 'application/octet-stream', attributes: [], fileReference: new Uint8Array() } } } },
        { message: { id: 72, media: { className: 'MessageMediaDocument', document: { id: 1002n, accessHash: 2002n, size: 13, mimeType: 'application/octet-stream', attributes: [], fileReference: new Uint8Array() } } } },
      ],
    }));
    const manager = readyManager({ invoke });
    const prepared = [
      { file: new File(['a'], 'a.bin'), media: {} as Api.InputMediaDocument, docId: 1001n, hasThumbnail: false },
      { file: new File(['b'], 'b.bin'), media: {} as Api.InputMediaDocument, docId: 1002n, hasThumbnail: false },
    ];

    const results = await manager.sendAlbum(prepared, {
      targetPeer: 'channel-peer',
      randomIds: ['901', '902'],
    });

    const request: any = invoke.mock.calls[0][0];
    expect(String(request.peer)).toContain('channel-peer');
    expect(request.multiMedia.map((entry: any) => String(entry.randomId))).toEqual(['901', '902']);
    expect(results.map((result: any) => [result.message_id, result.mediaKind, result.mediaId, result.size])).toEqual([
      [71, 'document', '1001', 12],
      [72, 'document', '1002', 13],
    ]);
  });

  it('forwardToTarget forwards to the supplied peer with the persisted random id', async () => {
    const forwardMessages = vi.fn(async (_peer, _params) => [[{
      id: 88,
      media: { className: 'MessageMediaDocument', document: { id: 333n, accessHash: 444n, size: 15, mimeType: 'application/pdf', attributes: [], fileReference: new Uint8Array() } },
    }]]);
    const manager = readyManager({ forwardMessages });

    const result = await manager.forwardToTarget('source-peer', 17, 'channel-peer', '1234');

    expect(forwardMessages.mock.calls[0][0]).toBe('channel-peer');
    expect(String((forwardMessages.mock.calls[0][1] as any).randomId[0])).toBe('1234');
    expect(result).toMatchObject({ messageId: 88, mediaKind: 'document', mediaId: '333', size: 15, accessHash: '444' });
  });
});
