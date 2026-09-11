import type { TelegramOperationRequest } from '../api/client.ts';
import { planDedupRelocation, type DurableOperationRecord, type DurableSendResult, type FrozenUploadTarget, UploadOperationError } from './uploadOperations.ts';

export interface RelocatablePart {
  file_id: string;
  filesize: number;
  telegram_message_id: number;
  telegram_user_id: number;
  telegram_chat_id: string | null;
  telegram_media_kind: 'document' | 'photo' | null;
  telegram_media_id: string | null;
  telegram_media_size: number | null;
  telegram_photo_variant: string | null;
  location_version: number;
  access_hash?: string | null;
  split_group_id?: string | null;
  part_index?: number | null;
}

export interface RelocationOperation extends DurableOperationRecord {
  uploader_id: number;
  target_peer_key: string;
}

export interface RelocationResultRecord extends RelocationOperation {
  result_version: number;
}

export interface DurableRelocationDependencies {
  createOperation(request: TelegramOperationRequest): Promise<RelocationOperation>;
  markSending(operation: RelocationOperation): Promise<RelocationOperation>;
  saveCursor(value: {
    operationId: string;
    randomId: string;
    uploaderId: number;
    targetPeerKey: string;
  }): Promise<void>;
  resolveSourceWriter(accountId: number, channelId: string): Promise<{ peer: unknown } | null>;
  forward(params: {
    sourceAccountId: number;
    sourceMessageId: number;
    targetPeer: unknown;
    randomId: string;
  }): Promise<DurableSendResult>;
  persistResult(operation: RelocationOperation, result: DurableSendResult): Promise<RelocationResultRecord>;
  switchOne(params: {
    fileId: string;
    expectedLocationVersion: number;
    operationId: string;
    resultVersion: number;
  }): Promise<unknown>;
  switchGroup(parts: Array<{
    fileId: string;
    expectedLocationVersion: number;
    operationId: string;
    resultVersion: number;
  }>): Promise<unknown>;
  clearCursor(): Promise<void>;
}

function sourceSnapshot(part: RelocatablePart): Record<string, unknown> {
  return {
    file_id: part.file_id,
    telegram_user_id: part.telegram_user_id,
    telegram_chat_id: part.telegram_chat_id,
    telegram_message_id: part.telegram_message_id,
    telegram_media_kind: part.telegram_media_kind,
    telegram_media_id: part.telegram_media_id,
    telegram_media_size: part.telegram_media_size,
    telegram_photo_variant: part.telegram_photo_variant,
    location_version: part.location_version,
    access_hash: part.access_hash ?? null,
  };
}

export async function runDurableDedupRelocation(
  input: {
    frozen: FrozenUploadTarget;
    parts: readonly RelocatablePart[];
    operationId: (part: RelocatablePart, index: number) => string;
    randomId: (part: RelocatablePart, index: number) => string;
  },
  deps: DurableRelocationDependencies,
): Promise<'reuse' | 'relocated'> {
  const plan = planDedupRelocation(input.frozen, input.parts);
  if (plan === 'reuse') return 'reuse';
  if (input.frozen.storageMode !== 'channel' || !input.frozen.channelId) {
    throw new UploadOperationError('STORAGE_TARGET_MISMATCH', 'Dedup relocation requires a frozen channel target');
  }

  const isSplit = input.parts.length > 1;
  const splitGroupId = isSplit ? input.parts[0]?.split_group_id : null;
  if (isSplit && (!splitGroupId || input.parts.some((part) => part.split_group_id !== splitGroupId))) {
    throw new UploadOperationError('STORAGE_TARGET_MISMATCH', 'Split dedup relocation requires one complete source split group');
  }

  const switches: Array<{
    fileId: string;
    expectedLocationVersion: number;
    operationId: string;
    resultVersion: number;
  }> = [];

  for (let index = 0; index < input.parts.length; index++) {
    const part = input.parts[index];
    if (part.telegram_chat_id !== null) {
      throw new UploadOperationError('STORAGE_TARGET_MISMATCH', 'Only Saved Messages rows may be relocated by dedup');
    }
    const sourceWriter = await deps.resolveSourceWriter(part.telegram_user_id, input.frozen.channelId);
    if (!sourceWriter) {
      throw new UploadOperationError(
        'STORAGE_TARGET_MISMATCH',
        `Source account ${part.telegram_user_id} cannot write the frozen target`,
      );
    }

    const operationId = input.operationId(part, index);
    const randomId = input.randomId(part, index);
    const request: TelegramOperationRequest = {
      operation_id: operationId,
      kind: 'upload',
      logical_file_id: part.file_id,
      group_id: isSplit ? splitGroupId : null,
      part_index: isSplit ? (part.part_index ?? index) : 0,
      uploader_id: part.telegram_user_id,
      target_kind: 'channel',
      target_channel_id: input.frozen.channelId,
      target_peer_key: input.frozen.targetPeerKey,
      created_target_version: input.frozen.targetVersion,
      created_accounts_version: input.frozen.accountsVersion,
      random_id: randomId,
      rpc_kind: 'messages.forwardMessages',
      request_metadata: { source: sourceSnapshot(part) },
    };

    const planned = await deps.createOperation(request);
    const sending = await deps.markSending(planned);
    await deps.saveCursor({
      operationId: sending.operation_id,
      randomId: sending.random_id,
      uploaderId: part.telegram_user_id,
      targetPeerKey: input.frozen.targetPeerKey,
    });
    const result = await deps.forward({
      sourceAccountId: part.telegram_user_id,
      sourceMessageId: part.telegram_message_id,
      targetPeer: sourceWriter.peer,
      randomId: sending.random_id,
    });
    const persisted = await deps.persistResult(sending, result);
    if (!persisted.result_version) {
      throw new UploadOperationError('RESULT_NOT_DURABLE', `Operation ${persisted.operation_id} has no result version`);
    }
    switches.push({
      fileId: part.file_id,
      expectedLocationVersion: part.location_version,
      operationId: persisted.operation_id,
      resultVersion: persisted.result_version,
    });
  }

  if (isSplit) await deps.switchGroup(switches);
  else await deps.switchOne(switches[0]);
  await deps.clearCursor();
  return 'relocated';
}
