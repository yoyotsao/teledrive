import type { TelegramOperationRequest } from '../api/client.ts';

export interface ChatImportStoredMedia {
  messageId: number;
  mediaKind: 'document' | 'photo';
  mediaId: string;
  size: number;
  mimeType: string;
  accessHash?: string;
  photoVariant?: string;
  hasThumbnail: boolean;
}

export interface ChatImportOperationRecord {
  operation_id: string;
  random_id: string;
  uploader_id: number;
  target_peer_key: string;
  state: string;
  version: number;
  result_version?: number | null;
  destination_message_id?: number | null;
  destination_media_kind?: string | null;
  destination_media_id?: string | null;
  destination_size?: number | null;
  destination_access_hash?: string | null;
}

export interface ChatImportOperationDeps {
  createOperation(request: TelegramOperationRequest): Promise<ChatImportOperationRecord>;
  markSending(operation: ChatImportOperationRecord): Promise<ChatImportOperationRecord>;
  saveCursor(value: {
    operationId: string;
    randomId: string;
    uploaderId: number;
    targetPeerKey: string;
  }): Promise<void>;
  forward(randomId: string): Promise<ChatImportStoredMedia>;
  persistResult(operation: ChatImportOperationRecord, media: ChatImportStoredMedia): Promise<ChatImportOperationRecord>;
  registerOperation(operationId: string): Promise<unknown>;
  clearCursor(): Promise<void>;
}

export interface ChatImportOperationInput {
  request: TelegramOperationRequest;
  mimeType: string;
  hasThumbnail: boolean;
}

function storedFromOperation(operation: ChatImportOperationRecord, input: ChatImportOperationInput): ChatImportStoredMedia | null {
  if (
    operation.destination_message_id == null
    || !operation.destination_media_kind
    || !operation.destination_media_id
    || operation.destination_size == null
  ) return null;
  if (operation.destination_media_kind !== 'document' && operation.destination_media_kind !== 'photo') return null;
  return {
    messageId: operation.destination_message_id,
    mediaKind: operation.destination_media_kind,
    mediaId: operation.destination_media_id,
    size: operation.destination_size,
    mimeType: input.mimeType,
    accessHash: operation.destination_access_hash ?? undefined,
    hasThumbnail: input.hasThumbnail,
  };
}

/**
 * Create the immutable journal row before forwarding. Retries of an already
 * sent/registered row consume its persisted destination and never issue a
 * second Telegram forward. Ambiguous in-flight states are handed to recovery
 * instead of blind-sending with a new random id.
 */
export async function runChatImportOperation(
  input: ChatImportOperationInput,
  deps: ChatImportOperationDeps,
): Promise<ChatImportStoredMedia> {
  let operation = await deps.createOperation(input.request);
  const existing = storedFromOperation(operation, input);

  if (operation.state === 'registered' || operation.state === 'committed') {
    if (!existing) throw new Error('CHAT_IMPORT_RECOVERY_REQUIRED');
    await deps.clearCursor();
    return existing;
  }
  if (operation.state === 'sent') {
    if (!existing || operation.result_version == null) throw new Error('CHAT_IMPORT_RECOVERY_REQUIRED');
    await deps.registerOperation(operation.operation_id);
    await deps.clearCursor();
    return existing;
  }
  if (['sending', 'recovering', 'uncertain'].includes(operation.state)) {
    throw new Error('CHAT_IMPORT_RECOVERY_REQUIRED');
  }

  operation = await deps.markSending(operation);
  await deps.saveCursor({
    operationId: operation.operation_id,
    randomId: operation.random_id,
    uploaderId: operation.uploader_id,
    targetPeerKey: operation.target_peer_key,
  });
  const media = await deps.forward(operation.random_id);
  operation = await deps.persistResult(operation, media);
  if (operation.result_version == null) throw new Error('CHAT_IMPORT_RESULT_NOT_DURABLE');
  await deps.registerOperation(operation.operation_id);
  await deps.clearCursor();
  return media;
}
