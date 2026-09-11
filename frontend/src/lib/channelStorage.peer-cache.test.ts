import { describe, expect, it, vi } from 'vitest';
import {
  invalidateChannelSessionGeneration,
  resolveChannelPeerForAccount,
  validateChannelForAccount,
} from './channelStorage.ts';

function manager() {
  const entity = {
    id: 123n,
    title: 'Private Storage',
    broadcast: true,
    megagroup: false,
    username: undefined,
    adminRights: { postMessages: true },
  };
  return {
    accountId: 42,
    accountsVersion: 7,
    sessionGeneration: 1,
    client: {
      iterDialogs: vi.fn(async function* () { yield { entity }; }),
      invoke: vi.fn(async () => ({ participant: { className: 'ChannelParticipantAdmin' } })),
    },
  } as any;
}

describe('channel peer cache', () => {
  it('reuses the peer resolved during verification for repeated reads', async () => {
    const m = manager();

    await validateChannelForAccount(m, '123');
    await resolveChannelPeerForAccount(m, '123');
    await resolveChannelPeerForAccount(m, '123');

    expect(m.client.iterDialogs).toHaveBeenCalledTimes(1);
  });

  it('drops the cached peer when the session generation changes', async () => {
    const m = manager();

    await validateChannelForAccount(m, '123');
    await resolveChannelPeerForAccount(m, '123');
    invalidateChannelSessionGeneration(m);
    await resolveChannelPeerForAccount(m, '123');

    expect(m.client.iterDialogs).toHaveBeenCalledTimes(2);
  });
});
