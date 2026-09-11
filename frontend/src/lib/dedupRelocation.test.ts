import { describe, expect, it, vi } from 'vitest';
import { runDurableDedupRelocation, type RelocatablePart } from './dedupRelocation.ts';
import { freezeUploadTarget } from './uploadOperations.ts';

const frozen = freezeUploadTarget({
  storage_mode: 'channel', channel_id: '123456789', version: 5, accounts_version: 3,
}, [
  { telegram_user_id: 11, is_primary: 1 },
  { telegram_user_id: 22, is_primary: 0 },
]);

function part(index: number, account = 11): RelocatablePart {
  return {
    file_id: `file-${index}`,
    filesize: 10 + index,
    telegram_message_id: 100 + index,
    telegram_user_id: account,
    telegram_chat_id: null,
    telegram_media_kind: 'document',
    telegram_media_id: `media-${index}`,
    telegram_media_size: 10 + index,
    telegram_photo_variant: null,
    location_version: 7 + index,
    access_hash: `hash-${index}`,
    split_group_id: 'source-group',
    part_index: index,
  };
}

function deps(events: string[]) {
  return {
    createOperation: vi.fn(async (request: any) => {
      events.push(`create:${request.logical_file_id}:${request.random_id}`);
      return { ...request, state: 'planned', version: 1 };
    }),
    markSending: vi.fn(async (operation: any) => {
      events.push(`sending:${operation.logical_file_id}`);
      return { ...operation, state: 'sending', version: 2 };
    }),
    saveCursor: vi.fn(async (value: any) => { events.push(`cursor:${value.randomId}`); }),
    resolveSourceWriter: vi.fn(async (accountId: number) => ({ peer: { accountId } })),
    forward: vi.fn(async (value: any) => {
      events.push(`forward:${value.sourceAccountId}:${value.randomId}`);
      return { messageId: value.sourceMessageId + 1000, mediaKind: 'document' as const, mediaId: `dst-${value.sourceMessageId}`, size: 10 };
    }),
    persistResult: vi.fn(async (operation: any) => {
      events.push(`result:${operation.logical_file_id}`);
      return { ...operation, state: 'sent', version: 3, result_version: 1 };
    }),
    switchOne: vi.fn(async (value: any) => { events.push(`switch-one:${value.fileId}`); }),
    switchGroup: vi.fn(async (values: any[]) => { events.push(`switch-group:${values.length}`); }),
    clearCursor: vi.fn(async () => { events.push('clear'); }),
  };
}

describe('runDurableDedupRelocation', () => {
  it('reuses a same-channel hit without Telegram writes', async () => {
    const events: string[] = [];
    const d = deps(events);
    const same = { ...part(0), telegram_chat_id: '123456789' };

    await expect(runDurableDedupRelocation({
      frozen,
      parts: [same],
      operationId: () => 'op',
      randomId: () => '9001',
    }, d)).resolves.toBe('reuse');

    expect(events).toEqual([]);
  });

  it('persists identity before forwarding and switches one row only after the result', async () => {
    const events: string[] = [];
    const d = deps(events);

    await expect(runDurableDedupRelocation({
      frozen,
      parts: [{ ...part(0), split_group_id: null }],
      operationId: () => 'op-1',
      randomId: () => '9001',
    }, d)).resolves.toBe('relocated');

    expect(events.indexOf('create:file-0:9001')).toBeLessThan(events.indexOf('forward:11:9001'));
    expect(events.indexOf('cursor:9001')).toBeLessThan(events.indexOf('forward:11:9001'));
    expect(events.indexOf('result:file-0')).toBeLessThan(events.indexOf('switch-one:file-0'));
    expect(d.switchGroup).not.toHaveBeenCalled();
  });

  it('forwards every split part from its original account and performs one all-parts CAS', async () => {
    const events: string[] = [];
    const d = deps(events);

    await runDurableDedupRelocation({
      frozen,
      parts: [part(0, 11), part(1, 22)],
      operationId: (_part, i) => `op-${i}`,
      randomId: (_part, i) => `91${i}`,
    }, d);

    expect(d.forward).toHaveBeenCalledWith(expect.objectContaining({ sourceAccountId: 11, randomId: '910' }));
    expect(d.forward).toHaveBeenCalledWith(expect.objectContaining({ sourceAccountId: 22, randomId: '911' }));
    expect(d.switchGroup).toHaveBeenCalledTimes(1);
    expect(d.switchGroup).toHaveBeenCalledWith([
      { fileId: 'file-0', expectedLocationVersion: 7, operationId: 'op-0', resultVersion: 1 },
      { fileId: 'file-1', expectedLocationVersion: 8, operationId: 'op-1', resultVersion: 1 },
    ]);
    expect(d.switchOne).not.toHaveBeenCalled();
  });

  it('fails closed when the source account cannot write the frozen target', async () => {
    const events: string[] = [];
    const d = deps(events);
    (d.resolveSourceWriter as any).mockResolvedValue(null);

    await expect(runDurableDedupRelocation({
      frozen,
      parts: [{ ...part(0), split_group_id: null }],
      operationId: () => 'op',
      randomId: () => '9001',
    }, d)).rejects.toMatchObject({ code: 'STORAGE_TARGET_MISMATCH' });

    expect(d.forward).not.toHaveBeenCalled();
    expect(d.switchOne).not.toHaveBeenCalled();
  });
});
