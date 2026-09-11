import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OperationMappingReducer,
  RecoveryCursorStore,
  recoverPendingOperations,
  type RecoveryCursor,
  type RecoveryStoreAdapter,
} from './telegramOperationRecovery.ts';

function memoryAdapter(): RecoveryStoreAdapter {
  const data = new Map<string, unknown>();
  return {
    async get<T>(key: string): Promise<T | undefined> {
      return data.get(key) as T | undefined;
    },
    async set<T>(key: string, value: T): Promise<void> {
      data.set(key, structuredClone(value));
    },
    async delete(key: string): Promise<void> {
      data.delete(key);
    },
  };
}

describe('OperationMappingReducer', () => {
  it('accepts a Telegram update mapping before the RPC response arrives', () => {
    const reducer = new OperationMappingReducer();
    expect(reducer.apply({ randomId: '91', messageId: 5001 })).toBe('applied');
    expect(reducer.get('91')).toEqual({ randomId: '91', messageId: 5001 });
  });

  it('treats an identical replay as duplicate', () => {
    const reducer = new OperationMappingReducer();
    reducer.apply({ randomId: '91', messageId: 5001 });
    expect(reducer.apply({ randomId: '91', messageId: 5001 })).toBe('duplicate');
  });

  it('rejects a conflicting mapping for the same random id', () => {
    const reducer = new OperationMappingReducer();
    reducer.apply({ randomId: '91', messageId: 5001 });
    expect(reducer.apply({ randomId: '91', messageId: 5002 })).toBe('conflict');
  });
});

describe('RecoveryCursorStore', () => {
  let store: RecoveryCursorStore;

  beforeEach(() => {
    store = new RecoveryCursorStore(memoryAdapter());
  });

  it('survives reload by loading the last persisted cursor', async () => {
    const cursor: RecoveryCursor = {
      ownerId: 7,
      operationId: 'op-1',
      randomId: '91',
      uploaderId: 42,
      targetPeerKey: 'channel:123',
      phase: 'rpc_started',
    };
    await store.save(cursor);

    const reloaded = new RecoveryCursorStore(store.adapter);
    expect(await reloaded.load()).toEqual(cursor);
  });
});

describe('recoverPendingOperations', () => {
  it('reduces RANDOM_ID_DUPLICATE through reconciliation and never sends again', async () => {
    const adapter = memoryAdapter();
    const store = new RecoveryCursorStore(adapter);
    await store.save({
      ownerId: 7,
      operationId: 'op-dup',
      randomId: '99',
      uploaderId: 42,
      targetPeerKey: 'channel:123',
      phase: 'rpc_started',
    });

    const send = vi.fn();
    const persistReconciledOperationResult = vi.fn(async () => ({
      operation_id: 'op-dup',
      version: 4,
      result_version: 2,
      state: 'sent',
    }));

    const result = await recoverPendingOperations({
      store,
      listOperations: async () => [{
        operation_id: 'op-dup',
        version: 3,
        result_version: null,
        state: 'uncertain',
        random_id: '99',
        uploader_id: 42,
        target_peer_key: 'channel:123',
      }],
      readFrozenResult: async () => ({
        mapping: { random_id: '99', destination_message_id: 5001 },
        mediaIdentity: { media_kind: 'document', media_id: 'm1', size: 12 },
      }),
      persistReconciledOperationResult,
      send,
    });

    expect(send).not.toHaveBeenCalled();
    expect(persistReconciledOperationResult).toHaveBeenCalledTimes(1);
    expect(result).toEqual([{ operationId: 'op-dup', status: 'reconciled', resultVersion: 2 }]);
  });
});
