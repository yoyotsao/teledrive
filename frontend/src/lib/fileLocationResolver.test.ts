import { describe, expect, it, vi } from 'vitest';
import { createFileLocationResolver, FileLocationResolutionError } from './fileLocationResolver.ts';
import type { FileLocation } from './storageLocation.ts';

function documentMedia(id: string, size = 10) {
  return { className: 'MessageMediaDocument', document: { id: BigInt(id), accessHash: 5n, size } };
}

function manager(accountId: number, options: { channel?: boolean; mediaId?: string; size?: number; messageId?: number } = {}) {
  const entity = { id: 123n, title: 'Storage', broadcast: true, megagroup: false, adminRights: { postMessages: true } };
  return {
    accountId,
    accountsVersion: 1,
    sessionGeneration: 1,
    offline: false,
    client: {
      iterDialogs: vi.fn(async function* () { if (options.channel) yield { entity }; }),
      invoke: vi.fn(async () => ({ participant: { className: 'ChannelParticipantAdmin' } })),
      getMessages: vi.fn(async (peer: unknown, request: { ids: number[] }) => [{
        id: options.messageId ?? request.ids[0],
        media: documentMedia(options.mediaId ?? '999', options.size ?? 10),
        peer,
      }]),
    },
  } as any;
}

const savedLocation: FileLocation = {
  telegram_chat_id: null,
  telegram_user_id: 42,
  telegram_message_id: 7,
  media_kind: 'document',
  media_id: '999',
  media_size: 10,
  location_version: 1,
};

const channelLocation: FileLocation = {
  telegram_chat_id: '123',
  telegram_message_id: 7,
  media_kind: 'document',
  media_id: '999',
  media_size: 10,
  location_version: 2,
};

describe('file location resolver', () => {
  it('uses only the original account for Saved Messages', async () => {
    const original = manager(42);
    const other = manager(43);
    const resolve = createFileLocationResolver(() => [other, original]);

    const result = await resolve(savedLocation, 'download');
    expect(result.client).toBe(original.client);
    expect(original.client.getMessages).toHaveBeenCalledWith('me', { ids: [7] });
    expect(other.client.getMessages).not.toHaveBeenCalled();
  });

  it('fails over between live channel readers without trying Saved Messages', async () => {
    const unavailable = manager(42, { channel: false });
    const reader = manager(43, { channel: true });
    const resolve = createFileLocationResolver(() => [unavailable, reader]);

    const result = await resolve(channelLocation, 'preview');
    expect(result.client).toBe(reader.client);
    expect(reader.client.getMessages).toHaveBeenCalledTimes(1);
  });

  it('returns READ_UNAVAILABLE when no linked manager can read the channel', async () => {
    const resolve = createFileLocationResolver(() => [manager(42), manager(43)]);
    await expect(resolve(channelLocation, 'download')).rejects.toMatchObject({ code: 'READ_UNAVAILABLE' });
  });

  it('rejects a message whose stored media identity is stale', async () => {
    const resolve = createFileLocationResolver(() => [manager(42, { channel: true, mediaId: '1000' })]);
    await expect(resolve(channelLocation, 'download')).rejects.toMatchObject({ code: 'STALE_LOCATION' });
  });

  it('keeps same message numbers in two chats distinct', async () => {
    const saved = manager(42, { mediaId: '999' });
    const channel = manager(43, { channel: true, mediaId: '999' });
    const resolve = createFileLocationResolver(() => [saved, channel]);

    const a = await resolve(savedLocation, 'download');
    const b = await resolve(channelLocation, 'download');
    expect(a.peer).toBe('me');
    expect(b.peer).not.toBe('me');
  });

  it('reports a finite diagnostic error type', async () => {
    const resolve = createFileLocationResolver(() => []);
    try {
      await resolve(channelLocation, 'download');
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(FileLocationResolutionError);
      expect((error as FileLocationResolutionError).attempts).toBe(0);
    }
  });
});
