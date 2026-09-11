import { describe, expect, it, vi } from 'vitest';
import { runChatImportOperation } from './chatImportOperation.ts';

function request() {
  return {
    operation_id: 'chat-import:7:42:900',
    kind: 'chat_import' as const,
    logical_file_id: 'import-900',
    uploader_id: 7,
    target_kind: 'channel' as const,
    target_channel_id: '123456789',
    target_peer_key: '123456789',
    created_target_version: 5,
    created_accounts_version: 3,
    random_id: '9001001',
    rpc_kind: 'messages.forwardMessages',
    request_metadata: { filename: 'a.mp4', filesize: 10 },
  };
}

function deps(events: string[], state = 'planned') {
  const base: any = { ...request(), state, version: 1, result_version: null };
  return {
    createOperation: vi.fn(async () => base),
    markSending: vi.fn(async (operation: any) => {
      events.push(`sending:${operation.random_id}`);
      return { ...operation, state: 'sending', version: 2 };
    }),
    saveCursor: vi.fn(async (value: any) => { events.push(`cursor:${value.randomId}`); }),
    forward: vi.fn(async (randomId: string) => {
      events.push(`forward:${randomId}`);
      return {
        messageId: 88,
        mediaKind: 'document' as const,
        mediaId: 'dst-900',
        size: 10,
        mimeType: 'video/mp4',
        accessHash: 'ah',
        hasThumbnail: true,
      };
    }),
    persistResult: vi.fn(async (operation: any, media: any) => {
      events.push(`result:${media.messageId}`);
      return {
        ...operation,
        state: 'sent',
        version: 3,
        result_version: 1,
        destination_message_id: media.messageId,
        destination_media_kind: media.mediaKind,
        destination_media_id: media.mediaId,
        destination_size: media.size,
        destination_access_hash: media.accessHash,
      };
    }),
    registerOperation: vi.fn(async (operationId: string) => { events.push(`register:${operationId}`); }),
    clearCursor: vi.fn(async () => { events.push('clear'); }),
  };
}

describe('runChatImportOperation', () => {
  it('persists cursor/random id before the channel forward and registers after result', async () => {
    const events: string[] = [];
    const d = deps(events);
    const result = await runChatImportOperation({ request: request(), mimeType: 'video/mp4', hasThumbnail: true }, d);

    expect(result).toMatchObject({ messageId: 88, mediaId: 'dst-900' });
    expect(events.indexOf('cursor:9001001')).toBeLessThan(events.indexOf('forward:9001001'));
    expect(events.indexOf('result:88')).toBeLessThan(events.indexOf('register:chat-import:7:42:900'));
  });

  it('reuses an already-sent result after reload without forwarding again', async () => {
    const events: string[] = [];
    const d = deps(events, 'sent');
    d.createOperation.mockResolvedValue({
      ...request(),
      state: 'sent', version: 3, result_version: 1,
      destination_message_id: 88,
      destination_media_kind: 'document',
      destination_media_id: 'dst-900',
      destination_size: 10,
      destination_access_hash: 'ah',
    });

    await runChatImportOperation({ request: request(), mimeType: 'video/mp4', hasThumbnail: true }, d);

    expect(d.forward).not.toHaveBeenCalled();
    expect(d.registerOperation).toHaveBeenCalledWith('chat-import:7:42:900');
  });

  it('never blind-resends an ambiguous in-flight operation', async () => {
    const events: string[] = [];
    const d = deps(events, 'uncertain');

    await expect(runChatImportOperation({ request: request(), mimeType: 'video/mp4', hasThumbnail: false }, d))
      .rejects.toThrow('CHAT_IMPORT_RECOVERY_REQUIRED');
    expect(d.forward).not.toHaveBeenCalled();
  });
});
