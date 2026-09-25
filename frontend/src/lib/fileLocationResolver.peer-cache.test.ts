import { expect, it, vi } from 'vitest';
import { createFileLocationResolver } from './fileLocationResolver.ts';
import type { FileLocation } from './storageLocation.ts';

it('reuses the generation-bound channel peer across repeated stream resolves', async () => {
  const entity = {
    id: 123n,
    title: 'Storage',
    broadcast: true,
    megagroup: false,
    adminRights: { postMessages: true },
  };
  const manager = {
    accountId: 42,
    accountsVersion: 1,
    sessionGeneration: 1,
    offline: false,
    client: {
      iterDialogs: vi.fn(async function* () { yield { entity }; }),
      invoke: vi.fn(async () => ({ participant: { className: 'ChannelParticipantAdmin' } })),
      getMessages: vi.fn(async (_peer: unknown, request: { ids: number[] }) => [{
        id: request.ids[0],
        media: {
          className: 'MessageMediaDocument',
          document: { id: 999n, accessHash: 5n, size: 10 },
        },
      }]),
    },
  } as any;
  const location: FileLocation = {
    telegram_chat_id: '123',
    telegram_message_id: 7,
    media_kind: 'document',
    media_id: '999',
    media_size: 10,
    location_version: 2,
  };
  const resolve = createFileLocationResolver(() => [manager], () => manager.accountId);

  await resolve(location, 'stream');
  await resolve(location, 'stream');

  expect(manager.client.iterDialogs).toHaveBeenCalledTimes(1);
});
