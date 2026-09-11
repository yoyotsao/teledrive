import { describe, expect, it, vi } from 'vitest';
import {
  invalidateChannelSessionGeneration,
  validateChannelForAccount,
} from './channelStorage.ts';

function manager(overrides: Record<string, unknown> = {}) {
  return {
    accountId: 42,
    accountsVersion: 7,
    sessionGeneration: 1,
    client: {
      iterDialogs: vi.fn(async function* () {
        yield {
          entity: {
            id: 123n,
            title: 'Private Storage',
            broadcast: true,
            megagroup: false,
            username: undefined,
            adminRights: { postMessages: true },
          },
        };
      }),
      invoke: vi.fn(async () => ({ participant: { className: 'ChannelParticipantAdmin' } })),
    },
    ...overrides,
  } as any;
}

describe('validateChannelForAccount', () => {
  it('resolves an uncached private broadcast channel from that account dialogs', async () => {
    const m = manager();
    const result = await validateChannelForAccount(m, '123');

    expect(result).toMatchObject({
      telegram_user_id: 42,
      channel_title: 'Private Storage',
      channel_id: '123',
      can_read: true,
      can_write: true,
      status: 'verified',
      accounts_version: 7,
    });
    expect(new Date(result.checked_at).getTime()).toBeGreaterThan(0);
  });

  it.each([
    ['group', { id: 123n, title: 'Group', broadcast: false, megagroup: true }, 'CHANNEL_NOT_BROADCAST'],
    ['public channel', { id: 123n, title: 'Public', broadcast: true, megagroup: false, username: 'publicname' }, 'CHANNEL_NOT_PRIVATE'],
  ])('rejects unsupported %s entity', async (_label, entity, reason) => {
    const m = manager({
      client: {
        iterDialogs: vi.fn(async function* () { yield { entity }; }),
        invoke: vi.fn(),
      },
    });

    await expect(validateChannelForAccount(m, '123')).rejects.toMatchObject({ code: reason });
  });

  it('reports write failure without sending a test message', async () => {
    const m = manager({
      client: {
        iterDialogs: vi.fn(async function* () {
          yield { entity: { id: 123n, title: 'Read Only', broadcast: true, megagroup: false } };
        }),
        invoke: vi.fn(async () => ({ participant: { className: 'ChannelParticipant' } })),
        sendMessage: vi.fn(),
      },
    });

    const result = await validateChannelForAccount(m, '123');
    expect(result.can_read).toBe(true);
    expect(result.can_write).toBe(false);
    expect((m.client as any).sendMessage).not.toHaveBeenCalled();
  });

  it('fails when the account cannot resolve/read the channel', async () => {
    const m = manager({
      client: {
        iterDialogs: vi.fn(async function* () {}),
        invoke: vi.fn(),
      },
    });

    await expect(validateChannelForAccount(m, '123')).rejects.toMatchObject({ code: 'CHANNEL_NOT_FOUND' });
  });

  it('invalidates cached verification after relogin/session generation change', async () => {
    const m = manager();
    const first = await validateChannelForAccount(m, '123');
    const dialogs = m.client.iterDialogs as ReturnType<typeof vi.fn>;

    await validateChannelForAccount(m, '123');
    expect(dialogs).toHaveBeenCalledTimes(1);

    invalidateChannelSessionGeneration(m);
    const second = await validateChannelForAccount(m, '123');
    expect(dialogs).toHaveBeenCalledTimes(2);
    expect(second.checked_at).not.toBe(first.checked_at);
  });

  it('does not share verification cache across page reload/new manager instances', async () => {
    const first = manager();
    const second = manager();

    await validateChannelForAccount(first, '123');
    await validateChannelForAccount(second, '123');

    expect(first.client.iterDialogs).toHaveBeenCalledTimes(1);
    expect(second.client.iterDialogs).toHaveBeenCalledTimes(1);
  });
});
