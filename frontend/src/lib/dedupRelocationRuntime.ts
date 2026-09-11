import { api, type TelegramOperation, type TelegramOperationRequest } from '../api/client.ts';
import { resolveChannelPeerForAccount, validateChannelForAccount } from './channelStorage.ts';
import { runDurableDedupRelocation, type RelocatablePart, type RelocationOperation } from './dedupRelocation.ts';
import { generateDurableRandomId } from './durableUploadRuntime.ts';
import { getAllClients } from './gramjs.ts';
import { freezeUploadTarget, type DurableSendResult } from './uploadOperations.ts';
import type { RegisterableExistingPart } from './uploadPlanner.ts';
import { RecoveryCursorStore } from './telegramOperationRecovery.ts';

function operationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `relocate-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function toRelocatable(part: RegisterableExistingPart): RelocatablePart {
  if (!part.file_id || part.telegram_user_id == null || part.telegram_message_id == null || part.location_version == null) {
    throw new Error('STORAGE_TARGET_MISMATCH: dedup source is missing durable location identity');
  }
  return {
    file_id: part.file_id,
    filesize: part.filesize,
    telegram_message_id: part.telegram_message_id,
    telegram_user_id: part.telegram_user_id,
    telegram_chat_id: part.telegram_chat_id ?? null,
    telegram_media_kind: part.telegram_media_kind ?? null,
    telegram_media_id: part.telegram_media_id ?? null,
    telegram_media_size: part.telegram_media_size ?? null,
    telegram_photo_variant: part.telegram_photo_variant ?? null,
    location_version: part.location_version,
    access_hash: part.access_hash ?? null,
    split_group_id: part.split_group_id ?? null,
    part_index: part.part_index ?? null,
  };
}

function fromFile(file: any): RegisterableExistingPart {
  return {
    file_id: file.file_id,
    filesize: file.filesize,
    mime_type: file.mime_type,
    telegram_message_id: file.telegram_message_id,
    access_hash: file.access_hash,
    part_index: file.part_index,
    has_thumbnail: file.has_thumbnail,
    telegram_user_id: file.telegram_user_id,
    telegram_chat_id: file.telegram_chat_id,
    telegram_media_kind: file.telegram_media_kind,
    telegram_media_id: file.telegram_media_id,
    telegram_media_size: file.telegram_media_size,
    telegram_photo_variant: file.telegram_photo_variant,
    location_version: file.location_version,
    split_group_id: file.split_group_id,
    is_split_file: file.is_split_file,
  };
}

function asRelocationOperation(operation: TelegramOperation): RelocationOperation {
  return operation as unknown as RelocationOperation;
}

async function persistResult(operation: RelocationOperation, result: DurableSendResult) {
  const stored = await api.persistReconciledOperationResult({
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
  return stored as unknown as RelocationOperation & { result_version: number };
}

/**
 * Same-channel hits keep their current physical identity. Saved-Messages hits
 * are first moved to the frozen channel through journaled forwards and the
 * backend's location-only CAS, then returned with the refreshed location so a
 * normal dedup registration can safely reference the channel copy.
 */
export async function ensureDedupPartsInCurrentTarget(
  parts: readonly RegisterableExistingPart[],
): Promise<RegisterableExistingPart[]> {
  const target = await api.getStorageTarget();
  if (target.storage_mode === 'saved_messages') return [...parts];
  const accounts = await api.listAccounts();
  const frozen = freezeUploadTarget(target, accounts);
  const relocatable = parts.map(toRelocatable);
  const cursor = new RecoveryCursorStore();

  const outcome = await runDurableDedupRelocation({
    frozen,
    parts: relocatable,
    operationId: () => operationId(),
    randomId: () => generateDurableRandomId(),
  }, {
    createOperation: async (request) => asRelocationOperation(await api.createTelegramOperation(request as TelegramOperationRequest)),
    markSending: async (operation) => asRelocationOperation(await api.patchTelegramOperation(operation.operation_id, {
      expected_operation_version: operation.version,
      state: 'sending',
    })),
    saveCursor: async (value) => cursor.save({
      ownerId: frozen.primaryAccountId,
      operationId: value.operationId,
      randomId: value.randomId,
      uploaderId: value.uploaderId,
      targetPeerKey: value.targetPeerKey,
      phase: 'intent_persisted',
    }),
    resolveSourceWriter: async (accountId, channelId) => {
      const manager = getAllClients().find((candidate) => candidate.accountId === accountId && !candidate.offline);
      if (!manager) return null;
      const verification = await validateChannelForAccount(manager as any, channelId);
      if (!verification.can_write) return null;
      const peer = await resolveChannelPeerForAccount(manager as any, channelId);
      return peer ? { peer } : null;
    },
    forward: async ({ sourceAccountId, sourceMessageId, targetPeer, randomId }) => {
      const manager = getAllClients().find((candidate) => candidate.accountId === sourceAccountId && !candidate.offline);
      if (!manager) throw new Error(`STORAGE_TARGET_MISMATCH: source account ${sourceAccountId} is unavailable`);
      const sent = await manager.forwardToTarget('me', sourceMessageId, targetPeer, randomId);
      return {
        messageId: sent.messageId,
        mediaKind: sent.mediaKind,
        mediaId: sent.mediaId,
        size: sent.size,
        ...(sent.accessHash ? { accessHash: sent.accessHash } : {}),
        ...(sent.photoVariant ? { photoVariant: sent.photoVariant } : {}),
      };
    },
    persistResult,
    switchOne: api.switchExistingFileLocation,
    switchGroup: api.switchExistingFileLocationGroup,
    clearCursor: () => cursor.clear(),
  });

  if (outcome === 'reuse') return [...parts];
  const refreshed = await Promise.all(relocatable.map((part) => api.getFile(part.file_id)));
  return refreshed.map(fromFile);
}
