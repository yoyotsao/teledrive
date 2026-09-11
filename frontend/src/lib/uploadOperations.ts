export interface StorageTargetSnapshotLike {
  storage_mode: 'saved_messages' | 'channel';
  channel_id: string | null;
  version: number;
  accounts_version: number;
}

export interface LinkedAccountSnapshotLike {
  telegram_user_id: number;
  is_primary: number;
}

export interface FrozenUploadTarget {
  readonly storageMode: 'saved_messages' | 'channel';
  readonly channelId: string | null;
  readonly targetPeerKey: string;
  readonly targetVersion: number;
  readonly accountsVersion: number;
  readonly accountIds: readonly number[];
  readonly primaryAccountId: number;
}

export class UploadOperationError extends Error {
  constructor(public readonly code: 'UPLOAD_UNAVAILABLE' | 'STORAGE_TARGET_MISMATCH' | 'RESULT_NOT_DURABLE', message: string) {
    super(message);
    this.name = 'UploadOperationError';
  }
}

export function freezeUploadTarget(
  target: StorageTargetSnapshotLike,
  accountSnapshot: readonly LinkedAccountSnapshotLike[],
): FrozenUploadTarget {
  const primary = accountSnapshot.find((account) => account.is_primary === 1);
  if (!primary) {
    throw new UploadOperationError('UPLOAD_UNAVAILABLE', 'Primary Telegram account is not linked');
  }
  if (target.storage_mode === 'channel' && !target.channel_id) {
    throw new UploadOperationError('STORAGE_TARGET_MISMATCH', 'Channel storage target is missing its canonical channel id');
  }

  const frozen: FrozenUploadTarget = {
    storageMode: target.storage_mode,
    channelId: target.storage_mode === 'channel' ? target.channel_id : null,
    targetPeerKey: target.storage_mode === 'channel'
      ? String(target.channel_id)
      : `me:${primary.telegram_user_id}`,
    targetVersion: target.version,
    accountsVersion: target.accounts_version,
    accountIds: Object.freeze(accountSnapshot.map((account) => account.telegram_user_id)),
    primaryAccountId: primary.telegram_user_id,
  };
  return Object.freeze(frozen);
}

export interface UploadManagerLike {
  accountId: number;
  offline?: boolean;
}

export interface WriterVerification {
  can_write: boolean;
  peer: unknown | null;
}

export interface FrozenUploadWriter<M extends UploadManagerLike = UploadManagerLike> {
  manager: M;
  peer: unknown;
}

export async function chooseFrozenUploadWriter<M extends UploadManagerLike>(
  target: FrozenUploadTarget,
  managers: readonly M[],
  verifyChannelWriter: (manager: M, channelId: string) => Promise<WriterVerification>,
): Promise<FrozenUploadWriter<M>> {
  const eligible = managers.filter((manager) => !manager.offline && target.accountIds.includes(manager.accountId));

  if (target.storageMode === 'saved_messages') {
    const manager = eligible.find((candidate) => candidate.accountId === target.primaryAccountId);
    if (!manager) {
      throw new UploadOperationError('UPLOAD_UNAVAILABLE', `Saved Messages account ${target.primaryAccountId} is unavailable`);
    }
    return { manager, peer: 'me' };
  }

  const channelId = target.channelId!;
  for (const manager of eligible) {
    try {
      const verification = await verifyChannelWriter(manager, channelId);
      if (verification.can_write && verification.peer != null) {
        return { manager, peer: verification.peer };
      }
    } catch {
      // Account-local failures are recoverable. A later linked manager may
      // already have a fresh session and writable channel entity.
    }
  }
  throw new UploadOperationError(
    'UPLOAD_UNAVAILABLE',
    `No live linked account can write channel ${channelId}`,
  );
}

export interface DurableUploadPart {
  partIndex: number;
  size: number;
  operationId: string;
  randomId: string;
  hasThumbnail?: boolean;
}

export interface DurableUploadGroupInput<M extends UploadManagerLike = UploadManagerLike> {
  frozen: FrozenUploadTarget;
  writer: FrozenUploadWriter<M>;
  groupId: string;
  logicalFileId: string;
  filename: string;
  mimeType?: string | null;
  parentId?: string | null;
  fileHash?: string | null;
  parts: DurableUploadPart[];
}

export interface DurableSendResult {
  messageId: number;
  mediaKind: 'document' | 'photo';
  mediaId: string;
  size: number;
  accessHash?: string;
  photoVariant?: string;
}

export interface DurableOperationRecord {
  operation_id: string;
  part_index?: number | null;
  random_id: string;
  version: number;
  result_version?: number | null;
  state: string;
  [key: string]: unknown;
}

function uploadOperationRequest(
  input: DurableUploadGroupInput,
  part: DurableUploadPart,
): Record<string, unknown> {
  const totalParts = input.parts.length;
  return {
    operation_id: part.operationId,
    kind: 'upload',
    logical_file_id: totalParts > 1
      ? `${input.logicalFileId}:part:${part.partIndex}`
      : input.logicalFileId,
    group_id: input.groupId,
    part_index: part.partIndex,
    uploader_id: input.writer.manager.accountId,
    target_kind: input.frozen.storageMode,
    target_channel_id: input.frozen.channelId,
    target_peer_key: input.frozen.targetPeerKey,
    created_target_version: input.frozen.targetVersion,
    created_accounts_version: input.frozen.accountsVersion,
    random_id: part.randomId,
    rpc_kind: totalParts > 1 ? 'messages.sendMedia.part' : 'messages.sendMedia',
    request_metadata: {
      filename: input.filename,
      filesize: part.size,
      mime_type: input.mimeType ?? undefined,
      parent_id: input.parentId ?? undefined,
      has_thumbnail: Boolean(part.hasThumbnail),
      is_split_file: totalParts > 1,
      split_group_id: totalParts > 1 ? input.groupId : undefined,
      part_index: part.partIndex,
      total_parts: totalParts,
      original_name: input.filename,
      ...(input.fileHash ? { file_hash: input.fileHash } : {}),
    },
  };
}

export interface DurableUploadDependencies {
  createOperation(request: Record<string, unknown>): Promise<DurableOperationRecord>;
  saveCursor(cursor: {
    operationId: string;
    randomId: string;
    uploaderId: number;
    targetPeerKey: string;
    partIndex: number;
  }): Promise<void>;
  send(part: DurableUploadPart & { peer: unknown; manager: UploadManagerLike }): Promise<DurableSendResult>;
  persistResult(operation: DurableOperationRecord, result: DurableSendResult): Promise<DurableOperationRecord>;
  registerGroup(groupId: string): Promise<unknown>;
}

/**
 * Persist the immutable operation identity before every Telegram message send.
 * Group registration is deliberately the final action, after every child has
 * an authoritative persisted result, so split metadata cannot become partial.
 */
export async function runDurableUploadGroup(
  input: DurableUploadGroupInput,
  deps: DurableUploadDependencies,
): Promise<DurableOperationRecord[]> {
  const persisted: DurableOperationRecord[] = [];

  for (const part of input.parts) {
    const operation = await deps.createOperation(uploadOperationRequest(input, part));
    await deps.saveCursor({
      operationId: operation.operation_id,
      randomId: operation.random_id,
      uploaderId: input.writer.manager.accountId,
      targetPeerKey: input.frozen.targetPeerKey,
      partIndex: part.partIndex,
    });

    const result = await deps.send({ ...part, manager: input.writer.manager, peer: input.writer.peer });
    const stored = await deps.persistResult(operation, result);
    if (stored.result_version == null) {
      throw new UploadOperationError('RESULT_NOT_DURABLE', `Operation ${operation.operation_id} has no result version`);
    }
    persisted.push(stored);
  }

  await deps.registerGroup(input.groupId);
  return persisted;
}

export interface PreparedDurableUploadDependencies {
  createOperation(request: Record<string, unknown>): Promise<DurableOperationRecord>;
  markSending(operation: DurableOperationRecord): Promise<DurableOperationRecord>;
  saveCursor(cursor: {
    operationId: string;
    randomId: string;
    uploaderId: number;
    targetPeerKey: string;
    partIndex: number;
  }): Promise<void>;
  sendAll(parts: DurableUploadPart[], writer: FrozenUploadWriter): Promise<DurableSendResult[]>;
  persistResult(operation: DurableOperationRecord, result: DurableSendResult): Promise<DurableOperationRecord>;
  registerGroup(groupId: string): Promise<unknown>;
}

/**
 * Album and split transports create more than one Telegram message in one
 * transport call. Every child intent is therefore created, transitioned to
 * sending, and mirrored to the browser recovery cursor before that transport
 * call begins. A settings change after this point cannot retarget the work.
 */
export async function runPreparedDurableUploadGroup(
  input: DurableUploadGroupInput,
  deps: PreparedDurableUploadDependencies,
): Promise<DurableOperationRecord[]> {
  const operations: DurableOperationRecord[] = [];

  for (const part of input.parts) {
    const planned = await deps.createOperation(uploadOperationRequest(input, part));
    const sending = await deps.markSending(planned);
    await deps.saveCursor({
      operationId: sending.operation_id,
      randomId: sending.random_id,
      uploaderId: input.writer.manager.accountId,
      targetPeerKey: input.frozen.targetPeerKey,
      partIndex: part.partIndex,
    });
    operations.push(sending);
  }

  const results = await deps.sendAll(input.parts, input.writer);
  if (results.length !== operations.length) {
    throw new UploadOperationError(
      'RESULT_NOT_DURABLE',
      `Partial Telegram bulk response: expected ${operations.length} results, received ${results.length}`,
    );
  }

  const persisted: DurableOperationRecord[] = [];
  for (let index = 0; index < operations.length; index += 1) {
    const stored = await deps.persistResult(operations[index], results[index]);
    if (stored.result_version == null) {
      throw new UploadOperationError('RESULT_NOT_DURABLE', `Operation ${operations[index].operation_id} has no result version`);
    }
    persisted.push(stored);
  }

  await deps.registerGroup(input.groupId);
  return persisted;
}

export interface ExistingDedupLocationLike {
  file_id: string;
  telegram_chat_id?: string | null;
  telegram_user_id?: number | null;
  location_version?: number | null;
}

export type DedupRelocationPlan = 'reuse' | 'relocate';

/** A hash hit is reusable only when every part already lives in the frozen target. */
export function planDedupRelocation(
  target: FrozenUploadTarget,
  parts: readonly ExistingDedupLocationLike[],
): DedupRelocationPlan {
  if (parts.length === 0) {
    throw new UploadOperationError('STORAGE_TARGET_MISMATCH', 'Deduplication returned no complete source parts');
  }

  if (target.storageMode === 'saved_messages') {
    const sameSavedMessages = parts.every((part) =>
      part.telegram_chat_id === null && part.telegram_user_id === target.primaryAccountId,
    );
    if (sameSavedMessages) return 'reuse';
    throw new UploadOperationError('STORAGE_TARGET_MISMATCH', 'Hash match belongs to another storage target');
  }

  if (parts.every((part) => part.telegram_chat_id === target.channelId)) return 'reuse';
  if (parts.every((part) => part.telegram_chat_id === null && part.telegram_user_id != null)) return 'relocate';

  throw new UploadOperationError(
    'STORAGE_TARGET_MISMATCH',
    'Hash match is split across a different channel or incompatible storage targets',
  );
}
