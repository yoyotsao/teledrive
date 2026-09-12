import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const state = { created: null as any };
  const api = {
    getStorageTarget: vi.fn(),
    listAccounts: vi.fn(),
    createTelegramOperation: vi.fn(async (request: any) => {
      const operation = { ...request, version: 1, state: 'planned' };
      state.created = operation;
      return operation;
    }),
    patchTelegramOperation: vi.fn(async (_operationId: string, patch: any) => ({
      ...(state.created ?? {}),
      ...patch,
      version: patch.expected_operation_version + 1,
    })),
    persistReconciledOperationResult: vi.fn(async (request: any) => ({
      ...(state.created ?? {}),
      operation_id: request.operationId,
      version: request.expectedOperationVersion + 1,
      state: 'sent',
      uploader_id: request.mapping.uploader_id,
      random_id: request.mapping.random_id,
      target_peer_key: request.mapping.target_peer_key,
      destination_message_id: request.mapping.destination_message_id,
      destination_media_kind: request.mediaIdentity.destination_media_kind,
      destination_media_id: request.mediaIdentity.destination_media_id,
      destination_size: request.mediaIdentity.destination_size,
    })),
    getTelegramOperation: vi.fn(),
    registerTelegramOperation: vi.fn(async (_operationId: string) => undefined),
    registerTelegramOperationGroup: vi.fn(async (_groupId: string) => undefined),
  };
  return {
    state,
    api,
    getAllClients: vi.fn(),
    validateChannelForAccount: vi.fn(),
    resolveChannelPeerForAccount: vi.fn(),
    withAccountSlotFrom: vi.fn(),
    uploadFileSpread: vi.fn(),
    planSegments: vi.fn(),
    cursorSave: vi.fn(async (_cursor: unknown) => undefined),
    cursorClear: vi.fn(async () => undefined),
  };
});

vi.mock('../api/client.ts', () => ({ api: mocks.api }));
vi.mock('./channelStorage.ts', () => ({
  validateChannelForAccount: mocks.validateChannelForAccount,
  resolveChannelPeerForAccount: mocks.resolveChannelPeerForAccount,
}));
vi.mock('./gramjs.ts', () => ({ getAllClients: mocks.getAllClients }));
vi.mock('./accountPool.ts', () => ({ withAccountSlotFrom: mocks.withAccountSlotFrom }));
vi.mock('./splitUpload.ts', () => ({
  SMALL_FILE_LIMIT: 10,
  planSegments: mocks.planSegments,
  uploadFileSpread: mocks.uploadFileSpread,
}));
vi.mock('./telegramOperationRecovery.ts', () => ({
  RecoveryCursorStore: class {
    save(cursor: unknown) { return mocks.cursorSave(cursor); }
    clear() { return mocks.cursorClear(); }
  },
}));

import {
  durableUploadFile,
  invalidateFrozenUploadContext,
  resolveFrozenUploadContext,
} from './durableUploadRuntime.ts';

const manager1 = { accountId: 10, offline: false, waitUntilReady: vi.fn(async () => undefined) };
const manager2 = { accountId: 20, offline: false, waitUntilReady: vi.fn(async () => undefined) };

function target(version = 1) {
  return {
    storage_mode: 'channel' as const,
    channel_id: '777',
    channel_title: 'storage',
    version,
    accounts_version: 9,
    verifications: [],
  };
}

const linkedAccounts = [
  { telegram_user_id: 10, label: 'one', is_primary: 1, file_count: 0 },
  { telegram_user_id: 20, label: 'two', is_primary: 0, file_count: 0 },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  invalidateFrozenUploadContext();
  vi.clearAllMocks();
  mocks.state.created = null;
  mocks.api.getStorageTarget.mockResolvedValue(target());
  mocks.api.listAccounts.mockResolvedValue(linkedAccounts);
  mocks.getAllClients.mockReturnValue([manager1, manager2]);
  mocks.validateChannelForAccount.mockResolvedValue({ can_write: true });
  mocks.resolveChannelPeerForAccount.mockImplementation(async (manager: { accountId: number }) => `peer-${manager.accountId}`);
  mocks.withAccountSlotFrom.mockImplementation(async (clients: any[], fn: (manager: any) => Promise<unknown>) => fn(clients[1] ?? clients[0]));
});

describe('durable upload topology cache', () => {
  it('coalesces a whole concurrent batch and then reuses the page-session snapshot', async () => {
    const contexts = await Promise.all(Array.from({ length: 32 }, () => resolveFrozenUploadContext()));
    const later = await resolveFrozenUploadContext();

    expect(contexts.every((context) => context.frozen.targetVersion === 1)).toBe(true);
    expect(later.frozen.targetVersion).toBe(1);
    expect(mocks.api.getStorageTarget).toHaveBeenCalledTimes(1);
    expect(mocks.api.listAccounts).toHaveBeenCalledTimes(1);
    expect(mocks.validateChannelForAccount).toHaveBeenCalledTimes(2);
    expect(mocks.resolveChannelPeerForAccount).toHaveBeenCalledTimes(2);
  });

  it('refreshes topology only after explicit invalidation', async () => {
    await resolveFrozenUploadContext();
    mocks.api.getStorageTarget.mockResolvedValue(target(2));

    invalidateFrozenUploadContext();
    const refreshed = await resolveFrozenUploadContext();

    expect(refreshed.frozen.targetVersion).toBe(2);
    expect(mocks.api.getStorageTarget).toHaveBeenCalledTimes(2);
    expect(mocks.api.listAccounts).toHaveBeenCalledTimes(2);
  });

  it('does not let an invalidated stale in-flight resolution overwrite the fresh cache', async () => {
    const oldTarget = deferred<ReturnType<typeof target>>();
    mocks.api.getStorageTarget.mockReset();
    mocks.api.getStorageTarget
      .mockImplementationOnce(() => oldTarget.promise)
      .mockResolvedValueOnce(target(2));

    const stalePromise = resolveFrozenUploadContext();
    await Promise.resolve();
    invalidateFrozenUploadContext();

    const fresh = await resolveFrozenUploadContext();
    oldTarget.resolve(target(1));
    const stale = await stalePromise;
    const cached = await resolveFrozenUploadContext();

    expect(stale.frozen.targetVersion).toBe(1);
    expect(fresh.frozen.targetVersion).toBe(2);
    expect(cached.frozen.targetVersion).toBe(2);
    expect(mocks.api.getStorageTarget).toHaveBeenCalledTimes(2);
  });
});

describe('durable small channel upload', () => {
  it('selects from all verified writers at slot acquisition and sends to that account own channel peer', async () => {
    mocks.uploadFileSpread.mockResolvedValue({
      parts: [{ index: 0, message_id: 501, file_id: 'media-501', size: 5, account_id: 20 }],
      originalName: 'small.bin',
      totalParts: 1,
      hasThumbnail: false,
    });
    const file = { size: 5, name: 'small.bin', type: 'application/octet-stream' } as File;

    await durableUploadFile(file, { parentId: null, fileHash: 'hash', thumb: null });

    const candidateManagers = mocks.withAccountSlotFrom.mock.calls[0][0] as Array<{ accountId: number }>;
    expect(candidateManagers.map((manager) => manager.accountId)).toEqual([10, 20]);
    expect(mocks.api.createTelegramOperation.mock.calls[0][0]).toMatchObject({
      uploader_id: 20,
      target_kind: 'channel',
      target_channel_id: '777',
      target_peer_key: '777',
    });
    expect(mocks.uploadFileSpread).toHaveBeenCalledWith(
      file,
      undefined,
      null,
      manager2,
      expect.objectContaining({ targetPeer: 'peer-20' }),
    );
  });
});
