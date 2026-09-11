import { api, type TelegramOperation, type TelegramOperationRequest } from '../api/client.ts';
import { validateChannelForAccount, resolveChannelPeerForAccount } from './channelStorage.ts';
import { getAllClients, type SegmentResult, type TelegramClientManager } from './gramjs.ts';
import {
  chooseFrozenUploadWriter,
  freezeUploadTarget,
  runPreparedDurableUploadGroup,
  type DurableOperationRecord,
  type DurableSendResult,
  type DurableUploadPart,
  type FrozenUploadTarget,
  type FrozenUploadWriter,
  type UploadManagerLike,
} from './uploadOperations.ts';
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
}> {
  const [target, accounts] = await Promise.all([api.getStorageTarget(), api.listAccounts()]);
  const frozen = freezeUploadTarget(target, accounts);
  const managers = getAllClients() as unknown as UploadManagerLike[];
  const selected = await chooseFrozenUploadWriter(frozen, managers, async (manager, channelId) => {
    const channelManager = manager as unknown as TelegramClientManager;
    const verification = await validateChannelForAccount(channelManager as any, channelId);
    if (!verification.can_write) return { can_write: false, peer: null };
    const peer = await resolveChannelPeerForAccount(channelManager as any, channelId);
    return { can_write: peer != null, peer };
  });
  return { frozen, writer: managerWriter(selected) };
}

function operationRequest(
  frozen: FrozenUploadTarget,
  writer: FrozenUploadWriter<TelegramClientManager>,
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
    uploader_id: writer.manager.accountId,
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
      original_name: file.name,
      total_parts: totalParts,
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

async function persistResult(
  operation: TelegramOperation,
  result: DurableSendResult,
): Promise<TelegramOperation> {
  return api.persistReconciledOperationResult({
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
  const { frozen, writer } = await resolveFrozenUploadContext();
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
  const logicalFileId = uuid();
  const cursor = new RecoveryCursorStore();
  let uploadResult: SplitUploadResult | null = null;
  const operationIds = parts.map((part) => part.operationId);

  if (parts.length === 1) {
    const request = operationRequest(
      frozen, writer, file, parts[0], logicalFileId, null, 1, options.parentId, options.fileHash,
    );
    const planned = await api.createTelegramOperation(request);
    const sending = await markSending(planned);
    await cursor.save({
      ownerId: frozen.primaryAccountId,
      operationId: sending.operation_id,
      randomId: sending.random_id,
      uploaderId: sending.uploader_id,
      targetPeerKey: sending.target_peer_key,
      phase: 'intent_persisted',
    });
    uploadResult = await uploadFileSpread(
      file,
      options.onProgress,
      options.thumb,
      writer.manager,
      { targetPeer: writer.peer, randomIds: [parts[0].randomId] },
    );
    const sent = await persistResult(sending, durableResult(uploadResult.parts[0]));
    await cursor.save({
      ownerId: frozen.primaryAccountId,
      operationId: sent.operation_id,
      randomId: sent.random_id,
      uploaderId: sent.uploader_id,
      targetPeerKey: sent.target_peer_key,
      phase: 'result_persisted',
    });
    await api.registerTelegramOperation(sent.operation_id);
    await cursor.clear();
  } else {
    const groupId = uuid();
    await runPreparedDurableUploadGroup({
      frozen,
      writer,
      groupId,
      logicalFileId,
      filename: file.name,
      mimeType: file.type || undefined,
      parentId: options.parentId,
      fileHash: options.fileHash,
      parts,
    }, {
      createOperation: async (raw) => api.createTelegramOperation(raw as unknown as TelegramOperationRequest) as unknown as Promise<DurableOperationRecord>,
      markSending: async (operation) => markSending(operation as unknown as TelegramOperation) as unknown as Promise<DurableOperationRecord>,
      saveCursor: async (value) => cursor.save({
        ownerId: frozen.primaryAccountId,
        operationId: value.operationId,
        randomId: value.randomId,
        uploaderId: value.uploaderId,
        targetPeerKey: value.targetPeerKey,
        phase: 'intent_persisted',
      }),
      sendAll: async (preparedParts) => {
        uploadResult = await uploadFileSpread(
          file,
          options.onProgress,
          options.thumb,
          writer.manager,
          { targetPeer: writer.peer, randomIds: preparedParts.map((part) => part.randomId) },
        );
        return uploadResult.parts.map(durableResult);
      },
      persistResult: async (operation, result) => {
        const sent = await persistResult(operation as unknown as TelegramOperation, result);
        await cursor.save({
          ownerId: frozen.primaryAccountId,
          operationId: sent.operation_id,
          randomId: sent.random_id,
          uploaderId: sent.uploader_id,
          targetPeerKey: sent.target_peer_key,
          phase: 'result_persisted',
        });
        return sent as unknown as DurableOperationRecord;
      },
      registerGroup: async (id) => api.registerTelegramOperationGroup(id),
    });
    await cursor.clear();
  }

  if (!uploadResult) throw new Error('Durable upload completed without a Telegram result');
  return { ...uploadResult, registeredByOperation: true, operationIds };
}
