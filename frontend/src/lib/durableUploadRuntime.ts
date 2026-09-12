import { api, type TelegramOperation, type TelegramOperationRequest } from '../api/client.ts';
import { validateChannelForAccount, resolveChannelPeerForAccount } from './channelStorage.ts';
import { getAllClients, type SegmentResult, type TelegramClientManager } from './gramjs.ts';
import { withAccountSlotFrom } from './accountPool.ts';
import {
  freezeUploadTarget,
  type DurableSendResult,
  type DurableUploadPart,
  type FrozenUploadTarget,
  type FrozenUploadWriter,
  type UploadManagerLike,
} from './uploadOperations.ts';
import { resolveFrozenUploadWriters } from './durableUploadWriters.ts';
import { RecoveryCursorStore } from './telegramOperationRecovery.ts';
import {
  planSegments,
  SMALL_FILE_LIMIT,
  uploadFileSpread,
  type SplitUploadProgress,
  type SplitUploadResult,
} from './splitUpload.ts';

export interface DurableUploadRuntimeResult extends SplitUploadResult {
  registeredByOperation: true;
  operationIds: string[];
}

function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `upload-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** A positive 63-bit decimal value accepted by GramJS/Telegram random_id. */
export function generateDurableRandomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    let value = 0n;
    for (const byte of bytes) value = (value << 8n) | BigInt(byte);
    value &= (1n << 63n) - 1n;
    if (value === 0n) value = 1n;
    return value.toString();
  }
  return `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`.slice(0, 18);
}

function managerWriter(writer: FrozenUploadWriter): FrozenUploadWriter<TelegramClientManager> {
  return writer as unknown as FrozenUploadWriter<TelegramClientManager>;
}

export async function resolveFrozenUploadContext(): Promise<{
  frozen: FrozenUploadTarget;
  writer: FrozenUploadWriter<TelegramClientManager>;
  writers: FrozenUploadWriter<TelegramClientManager>[];
}> {
  const [target, accounts] = await Promise.all([api.getStorageTarget(), api.listAccounts()]);
  const frozen = freezeUploadTarget(target, accounts);
  const managers = getAllClients() as unknown as UploadManagerLike[];
  const selected = await resolveFrozenUploadWriters(frozen, managers, async (manager, channelId) => {
    const channelManager = manager as unknown as TelegramClientManager;
    // App authentication becomes visible before every Telegram handshake has
    // necessarily settled. Do not freeze a batch-wide writer snapshot while a
    // linked secondary account is still connecting.
    await channelManager.waitUntilReady();
    const verification = await validateChannelForAccount(channelManager as any, channelId);
    if (!verification.can_write) return { can_write: false, peer: null };
    const peer = await resolveChannelPeerForAccount(channelManager as any, channelId);
    return { can_write: peer != null, peer };
  });
  const writers = selected.map(managerWriter);
  return { frozen, writer: writers[0], writers };
}

function operationRequest(
  frozen: FrozenUploadTarget,
  uploaderId: number,
  file: File,
  part: DurableUploadPart,
  logicalFileId: string,
  groupId: string | null,
  totalParts: number,
  parentId: string | null,
  fileHash: string | null,
): TelegramOperationRequest {
  return {
    operation_id: part.operationId,
    kind: 'upload',
    logical_file_id: totalParts > 1 ? `${logicalFileId}:part:${part.partIndex}` : logicalFileId,
    group_id: groupId,
    part_index: part.partIndex,
    uploader_id: uploaderId,
    target_kind: frozen.storageMode,
    target_channel_id: frozen.channelId,
    target_peer_key: frozen.targetPeerKey,
    created_target_version: frozen.targetVersion,
    created_accounts_version: frozen.accountsVersion,
    random_id: part.randomId,
    rpc_kind: totalParts > 1 ? 'messages.sendMedia.part' : 'messages.sendMedia',
    request_metadata: {
      filename: file.name,
      filesize: part.size,
      mime_type: file.type || undefined,
      parent_id: parentId ?? undefined,
      has_thumbnail: Boolean(part.hasThumbnail),
      is_split_file: totalParts > 1,
      split_group_id: totalParts > 1 ? groupId ?? undefined : undefined,
      part_index: part.partIndex,
      total_parts: totalParts,
      original_name: file.name,
      ...(fileHash ? { file_hash: fileHash } : {}),
    },
  };
}

function durableResult(part: SegmentResult): DurableSendResult {
  return {
    messageId: part.message_id,
    mediaKind: 'document',
    mediaId: part.file_id,
    size: part.size,
    ...(part.access_hash ? { accessHash: part.access_hash } : {}),
  };
}

async function markSending(operation: TelegramOperation): Promise<TelegramOperation> {
  return api.patchTelegramOperation(operation.operation_id, {
    expected_operation_version: operation.version,
    state: 'sending',
  });
}

function reconcileError(error: unknown): { status: number | null; detail: string | null } {
  const response = (error as {
    response?: { status?: unknown; data?: { detail?: unknown } };
  } | null)?.response;
  return {
    status: typeof response?.status === 'number' ? response.status : null,
    detail: typeof response?.data?.detail === 'string' ? response.data.detail : null,
  };
}

function persistedResultMatches(operation: TelegramOperation, result: DurableSendResult): boolean {
  return operation.destination_message_id === result.messageId
    && operation.destination_media_kind === result.mediaKind
    && operation.destination_media_id === result.mediaId
    && operation.destination_size === result.size;
}

function persistResultRequest(operation: TelegramOperation, result: DurableSendResult) {
  return {
    operationId: operation.operation_id,
    expectedOperationVersion: operation.version,
    mapping: {
      uploader_id: operation.uploader_id,
      random_id: operation.random_id,
      target_peer_key: operation.target_peer_key,
      destination_message_id: result.messageId,
    },
    mediaIdentity: {
      destination_media_kind: result.mediaKind,
      destination_media_id: result.mediaId,
      destination_size: result.size,
      ...(result.photoVariant ? { destination_photo_variant: result.photoVariant } : {}),
    },
  };
}

async function persistResult(
  operation: TelegramOperation,
  result: DurableSendResult,
): Promise<TelegramOperation> {
  try {
    return await api.persistReconciledOperationResult(persistResultRequest(operation, result));
  } catch (error) {
    const { status, detail } = reconcileError(error);
    console.error(
      `[DurableUpload:${operation.operation_id}] reconcile-result failed`,
      { status, detail, state: operation.state, version: operation.version, uploaderId: operation.uploader_id },
    );
    if (status !== 409 || detail !== 'Telegram operation version conflict') throw error;

    // Telegram already accepted the message, so a metadata CAS race must not
    // turn a successful upload into a failed file. Refresh the journal row and
    // either retry from its current version or accept an identical terminal
    // result that another recovery path already persisted.
    const current = await api.getTelegramOperation(operation.operation_id);
    if (['sent', 'registered', 'committed'].includes(current.state)) {
      if (persistedResultMatches(current, result)) return current;
      throw error;
    }
    if (!['sending', 'recovering', 'uncertain'].includes(current.state)) throw error;

    console.warn(
      `[DurableUpload:${operation.operation_id}] reconcile CAS advanced ${operation.version} -> ${current.version}; retrying`,
    );
    return api.persistReconciledOperationResult(persistResultRequest(current, result));
  }
}

async function saveRecoveryCursor(
  cursor: RecoveryCursorStore,
  frozen: FrozenUploadTarget,
  operation: TelegramOperation,
  phase: 'intent_persisted' | 'result_persisted',
): Promise<void> {
  await cursor.save({
    ownerId: frozen.primaryAccountId,
    operationId: operation.operation_id,
    randomId: operation.random_id,
    uploaderId: operation.uploader_id,
    targetPeerKey: operation.target_peer_key,
    phase,
  });
}

export async function durableUploadFile(
  file: File,
  options: {
    parentId: string | null;
    fileHash: string | null;
    thumb?: Blob | null;
    onProgress?: SplitUploadProgress;
  },
): Promise<DurableUploadRuntimeResult> {
  const { frozen, writers } = await resolveFrozenUploadContext();
  const segmentPlan = file.size <= SMALL_FILE_LIMIT
    ? [{ index: 0, size: file.size }]
    : planSegments(file.size).map((segment) => ({ index: segment.index, size: segment.size }));
  const parts: DurableUploadPart[] = segmentPlan.map((segment) => ({
    partIndex: segment.index,
    size: segment.size,
    operationId: uuid(),
    randomId: generateDurableRandomId(),
    hasThumbnail: segment.index === 0 && Boolean(options.thumb),
  }));
  const partByIndex = new Map(parts.map((part) => [part.partIndex, part] as const));
  const logicalFileId = uuid();
  const cursor = new RecoveryCursorStore();
  let uploadResult: SplitUploadResult | null = null;
  const operationIds = parts.map((part) => part.operationId);

  if (parts.length === 1) {
    // Do not pin thousands of queued files to one writer before capacity is
    // available. Acquire a slot from the verified writer set first; only then
    // persist uploader_id and begin the Telegram RPC on that exact account.
    uploadResult = await withAccountSlotFrom(
      writers.map((writer) => writer.manager),
      async (manager) => {
        const writer = writers.find((candidate) => candidate.manager === manager)
          ?? writers.find((candidate) => candidate.manager.accountId === manager.accountId);
        if (!writer) throw new Error(`Verified writer ${manager.accountId} disappeared before upload`);

        const request = operationRequest(
          frozen,
          writer.manager.accountId,
          file,
          parts[0],
          logicalFileId,
          null,
          1,
          options.parentId,
          options.fileHash,
        );
        const planned = await api.createTelegramOperation(request);
        const sending = await markSending(planned);
        await saveRecoveryCursor(cursor, frozen, sending, 'intent_persisted');
        const result = await uploadFileSpread(
          file,
          options.onProgress,
          options.thumb,
          writer.manager,
          { targetPeer: writer.peer, randomIds: [parts[0].randomId] },
        );
        const sent = await persistResult(sending, durableResult(result.parts[0]));
        await saveRecoveryCursor(cursor, frozen, sent, 'result_persisted');
        await api.registerTelegramOperation(sent.operation_id);
        return result;
      },
    );
    await cursor.clear();
  } else {
    const groupId = uuid();
    const operations = new Map<number, TelegramOperation>();

    uploadResult = await uploadFileSpread(
      file,
      options.onProgress,
      options.thumb,
      undefined,
      {
        randomIds: parts.map((part) => part.randomId),
        writers: writers.map((writer) => ({
          manager: writer.manager,
          targetPeer: writer.peer,
        })),
        beforeSegmentAttempt: async ({ segmentIndex, accountId }) => {
          const part = partByIndex.get(segmentIndex);
          if (!part) throw new Error(`Missing durable upload part ${segmentIndex}`);
          if (operations.has(segmentIndex)) {
            throw new Error(`Durable upload segment ${segmentIndex} was dispatched more than once`);
          }
          const planned = await api.createTelegramOperation(operationRequest(
            frozen,
            accountId,
            file,
            part,
            logicalFileId,
            groupId,
            parts.length,
            options.parentId,
            options.fileHash,
          ));
          const sending = await markSending(planned);
          await saveRecoveryCursor(cursor, frozen, sending, 'intent_persisted');
          operations.set(segmentIndex, sending);
        },
        afterSegmentAttempt: async ({ segmentIndex, result }) => {
          const operation = operations.get(segmentIndex);
          if (!operation) throw new Error(`Missing durable operation for segment ${segmentIndex}`);
          const sent = await persistResult(operation, durableResult(result));
          await saveRecoveryCursor(cursor, frozen, sent, 'result_persisted');
        },
      },
    );

    if (operations.size !== parts.length) {
      throw new Error(`Incomplete durable upload intents: expected ${parts.length}, created ${operations.size}`);
    }
    await api.registerTelegramOperationGroup(groupId);
    await cursor.clear();
  }

  if (!uploadResult) throw new Error('Durable upload completed without a Telegram result');
  return { ...uploadResult, registeredByOperation: true, operationIds };
}
