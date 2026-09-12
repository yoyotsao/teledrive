import { describe, expect, it, vi } from 'vitest';
import { resolveFrozenUploadWriters } from './durableUploadWriters.ts';
import { freezeUploadTarget } from './uploadOperations.ts';

type Manager = { accountId: number; offline?: boolean };

function accounts(...ids: number[]) {
  return ids.map((telegram_user_id, index) => ({ telegram_user_id, is_primary: index === 0 ? 1 : 0 }));
}

describe('resolveFrozenUploadWriters', () => {
  it('keeps Saved Messages pinned to the primary account without channel verification', async () => {
    const target = freezeUploadTarget(
      { storage_mode: 'saved_messages', channel_id: null, version: 1, accounts_version: 1 },
      accounts(10, 20),
    );
    const primary: Manager = { accountId: 10 };
    const secondary: Manager = { accountId: 20 };
    const verify = vi.fn();

    const writers = await resolveFrozenUploadWriters(target, [secondary, primary], verify);

    expect(writers).toEqual([{ manager: primary, peer: 'me' }]);
    expect(verify).not.toHaveBeenCalled();
  });

  it('returns every live linked channel writer with that account own peer', async () => {
    const target = freezeUploadTarget(
      { storage_mode: 'channel', channel_id: '777', version: 3, accounts_version: 5 },
      accounts(10, 20, 30, 40),
    );
    const managers: Manager[] = [
      { accountId: 10 },
      { accountId: 20 },
      { accountId: 30, offline: true },
      { accountId: 40 },
      { accountId: 99 },
    ];
    const verify = vi.fn(async (manager: Manager) => {
      if (manager.accountId === 20) throw new Error('account-local failure');
      return { can_write: true, peer: `peer-${manager.accountId}` };
    });

    const writers = await resolveFrozenUploadWriters(target, managers, verify);

    expect(writers.map((writer) => [writer.manager.accountId, writer.peer])).toEqual([
      [10, 'peer-10'],
      [40, 'peer-40'],
    ]);
    expect(verify.mock.calls.map(([manager]) => manager.accountId)).toEqual([10, 20, 40]);
  });

  it('fails instead of falling back to Saved Messages when no channel writer is usable', async () => {
    const target = freezeUploadTarget(
      { storage_mode: 'channel', channel_id: '777', version: 3, accounts_version: 5 },
      accounts(10, 20),
    );
    const managers: Manager[] = [{ accountId: 10 }, { accountId: 20 }];

    await expect(resolveFrozenUploadWriters(
      target,
      managers,
      async () => ({ can_write: false, peer: null }),
    )).rejects.toMatchObject({ code: 'UPLOAD_UNAVAILABLE' });
  });
});
