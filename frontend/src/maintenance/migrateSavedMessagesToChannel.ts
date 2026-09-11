import {
  api,
  type StorageMigrationGroup,
  type StorageMigrationItem,
  type StorageMigrationJob,
  type TelegramOperation,
} from '../api/client.ts';
import { getClientFor } from '../lib/gramjs.ts';
import { readMedia } from '../lib/telegramMedia.ts';
import { resolveChannelPeerForAccount, validateChannelForAccount } from '../lib/channelStorage.ts';
import { RecoveryCursorStore } from '../lib/telegramOperationRecovery.ts';

type MigrationMediaResult = {
  messageId: number;
  mediaKind: 'document' | 'photo';
  mediaId: string;
  size: number;
  photoVariant?: string | null;
};

type MigrationForwardBatchEntry = { sourceMessageId: number; randomId: string };

type MigrationTelegramHook = {
  forward(params: {
    accountId: number;
    sourceMessageId: number;
    targetChannelId: string;
    randomId: string;
  }): Promise<MigrationMediaResult>;
  forwardBatch?(params: {
    accountId: number;
    targetChannelId: string;
    entries: MigrationForwardBatchEntry[];
  }): Promise<MigrationMediaResult[]>;
  readDestination(params: {
    accountId: number;
    targetChannelId: string;
    randomId: string;
    messageId?: number | null;
  }): Promise<MigrationMediaResult | null>;
  readSource(params: {
    accountId: number;
    sourceMessageId: number;
  }): Promise<{ ok: boolean }>;
  readSourceBatch?(params: {
    accountId: number;
    sourceMessageIds: number[];
  }): Promise<Array<{ ok: boolean }>>;
  verifyReader(params: {
    accountId: number;
    targetChannelId: string;
    messageId: number;
  }): Promise<MigrationMediaResult | null>;
  verifyReaderBatch?(params: {
    accountId: number;
    targetChannelId: string;
    messageIds: number[];
  }): Promise<Array<MigrationMediaResult | null>>;
};

export type MigrationRunProgress = {
  phase: 'running' | 'paused' | 'idle';
  currentGroupId?: string;
  currentSourceAccount?: number;
  lastError?: string;
};

type RunControl = {
  runId: string;
  pauseRequested: boolean;
};

declare global {
  interface Window {
    __TELEDRIVE_MIGRATION_TELEGRAM__?: MigrationTelegramHook;
  }
}

const LEASE_SECONDS = 300;
const GROUP_PAGE_SIZE = 25;
const FORWARD_BATCH_SIZE = 100;
const activeRuns = new Map<string, RunControl>();

function isConflict(error: unknown): boolean {
  return Number((error as any)?.response?.status) === 409;
}

class MigrationForwardBatchError extends Error {
  constructor(readonly original: unknown) {
    super((original as Error)?.message ?? String(original));
    this.name = 'MigrationForwardBatchError';
  }
}

function forwardErrorText(error: unknown): string {
  const value = error as any;
  return [value?.errorMessage, value?.message, value?.response?.data?.detail]
    .filter(Boolean)
    .join(' ');
}

function transientForwardLeaseSeconds(error: unknown): number | null {
  const value = error as any;
  const text = forwardErrorText(error);
  if (text.includes('WORKER_BUSY_TOO_LONG_RETRY')) return 15;
  if (text.includes('FLOOD')) {
    const seconds = Number(value?.seconds);
    return Number.isFinite(seconds) && seconds > 0 ? Math.min(300, Math.max(1, Math.ceil(seconds))) : 30;
  }
  const status = Number(value?.response?.status);
  if ((status >= 500 && status < 600) || /(^|\D)5\d\d(?=\D|$)/.test(text)) return 10;
  return null;
}

function sourceNumber(item: StorageMigrationItem, key: string): number {
  const value = item.source_location[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Migration item ${item.item_id} is missing numeric ${key}`);
  }
  return value;
}

function generateRandomId(): string {
  const words = new Uint32Array(2);
  crypto.getRandomValues(words);
  const value = ((BigInt(words[0] & 0x7fffffff) << 32n) | BigInt(words[1])) || 1n;
  return value.toString();
}

function generateOperationId(item: StorageMigrationItem): string {
  return `migration:${item.migration_id}:${item.item_id}:${crypto.randomUUID()}`;
}

function testHook(): MigrationTelegramHook | null {
  if (import.meta.env.VITE_E2E_TEST_HOOKS !== '1') return null;
  return window.__TELEDRIVE_MIGRATION_TELEGRAM__ ?? null;
}

async function productionForwardBatch(
  accountId: number,
  targetChannelId: string,
  entries: MigrationForwardBatchEntry[],
): Promise<MigrationMediaResult[]> {
  const manager = getClientFor(accountId);
  if (manager.offline) throw new Error(`Source account ${accountId} is offline`);
  const peer = await resolveChannelPeerForAccount(manager as any, targetChannelId);
  if (!peer) throw new Error(`Channel ${targetChannelId} is unavailable to source account ${accountId}`);
  const results = await manager.forwardBatchToTarget(
    'me',
    entries.map((entry) => ({ messageId: entry.sourceMessageId, randomId: entry.randomId })),
    peer,
  );
  return results.map((result) => ({
    messageId: result.messageId,
    mediaKind: result.mediaKind,
    mediaId: result.mediaId,
    size: result.size,
    photoVariant: result.photoVariant ?? null,
  }));
}

async function productionForward(
  accountId: number,
  sourceMessageId: number,
  targetChannelId: string,
  randomId: string,
): Promise<MigrationMediaResult> {
  return (await productionForwardBatch(accountId, targetChannelId, [{ sourceMessageId, randomId }]))[0];
}

function migrationMediaResult(message: any): MigrationMediaResult | null {
  const media = message?.media ? readMedia(message.media) : null;
  if (!message?.id || !media) return null;
  return {
    messageId: message.id,
    mediaKind: media.kind,
    mediaId: media.id,
    size: media.size,
    photoVariant: media.kind === 'photo' ? media.fullThumbSize : null,
  };
}

async function productionReadDestinationBatch(
  accountId: number,
  targetChannelId: string,
  messageIds: number[],
): Promise<Array<MigrationMediaResult | null>> {
  if (messageIds.length === 0) return [];
  const manager = getClientFor(accountId);
  if (manager.offline) return messageIds.map(() => null);
  const peer = await resolveChannelPeerForAccount(manager as any, targetChannelId);
  const raw = (manager as any).client;
  if (!peer || !raw) return messageIds.map(() => null);
  const messages = await raw.getMessages(peer, { ids: messageIds });
  const byId = new Map<number, any>();
  for (const message of messages ?? []) {
    if (message?.id != null) byId.set(Number(message.id), message);
  }
  return messageIds.map((messageId) => migrationMediaResult(byId.get(messageId)));
}

async function productionReadDestination(
  accountId: number,
  targetChannelId: string,
  messageId?: number | null,
): Promise<MigrationMediaResult | null> {
  if (!messageId) return null;
  return (await productionReadDestinationBatch(accountId, targetChannelId, [messageId]))[0];
}

async function productionReadSourceBatch(
  accountId: number,
  sourceMessageIds: number[],
): Promise<Array<{ ok: boolean }>> {
  if (sourceMessageIds.length === 0) return [];
  const manager = getClientFor(accountId);
  if (manager.offline) return sourceMessageIds.map(() => ({ ok: false }));
  const raw = (manager as any).client;
  if (!raw) return sourceMessageIds.map(() => ({ ok: false }));
  const messages = await raw.getMessages('me', { ids: sourceMessageIds });
  const byId = new Map<number, any>();
  for (const message of messages ?? []) {
    if (message?.id != null) byId.set(Number(message.id), message);
  }
  return sourceMessageIds.map((messageId) => {
    const message = byId.get(messageId);
    return { ok: Boolean(message?.media && readMedia(message.media)) };
  });
}

async function productionReadSource(accountId: number, sourceMessageId: number): Promise<{ ok: boolean }> {
  return (await productionReadSourceBatch(accountId, [sourceMessageId]))[0];
}

async function productionVerifyReaderBatch(
  accountId: number,
  targetChannelId: string,
  messageIds: number[],
): Promise<Array<MigrationMediaResult | null>> {
  if (messageIds.length === 0) return [];
  const manager = getClientFor(accountId);
  if (manager.offline) return messageIds.map(() => null);
  const verification = await validateChannelForAccount(manager as any, targetChannelId);
  if (!verification.can_read) return messageIds.map(() => null);
  return productionReadDestinationBatch(accountId, targetChannelId, messageIds);
}

async function productionVerifyReader(
  accountId: number,
  targetChannelId: string,
  messageId: number,
): Promise<MigrationMediaResult | null> {
  return (await productionVerifyReaderBatch(accountId, targetChannelId, [messageId]))[0];
}

type MigrationTelegramAdapter = MigrationTelegramHook & {
  forwardBatch(params: {
    accountId: number;
    targetChannelId: string;
    entries: MigrationForwardBatchEntry[];
  }): Promise<MigrationMediaResult[]>;
  readSourceBatch(params: {
    accountId: number;
    sourceMessageIds: number[];
  }): Promise<Array<{ ok: boolean }>>;
  verifyReaderBatch(params: {
    accountId: number;
    targetChannelId: string;
    messageIds: number[];
  }): Promise<Array<MigrationMediaResult | null>>;
};

function telegramAdapter(): MigrationTelegramAdapter {
  const hook = testHook();
  if (hook) {
    return {
      ...hook,
      forwardBatch: hook.forwardBatch ?? (({ accountId, targetChannelId, entries }) =>
        Promise.all(entries.map((entry) => hook.forward({
          accountId,
          targetChannelId,
          sourceMessageId: entry.sourceMessageId,
          randomId: entry.randomId,
        })))),
      readSourceBatch: hook.readSourceBatch ?? (({ accountId, sourceMessageIds }) =>
        Promise.all(sourceMessageIds.map((sourceMessageId) => hook.readSource({
          accountId,
          sourceMessageId,
        })))),
      verifyReaderBatch: hook.verifyReaderBatch ?? (({ accountId, targetChannelId, messageIds }) =>
        Promise.all(messageIds.map((messageId) => hook.verifyReader({
          accountId,
          targetChannelId,
          messageId,
        })))),
    };
  }
  return {
    forward: ({ accountId, sourceMessageId, targetChannelId, randomId }) =>
      productionForward(accountId, sourceMessageId, targetChannelId, randomId),
    forwardBatch: ({ accountId, targetChannelId, entries }) =>
      productionForwardBatch(accountId, targetChannelId, entries),
    readDestination: ({ accountId, targetChannelId, messageId }) =>
      productionReadDestination(accountId, targetChannelId, messageId),
    readSource: ({ accountId, sourceMessageId }) => productionReadSource(accountId, sourceMessageId),
    readSourceBatch: ({ accountId, sourceMessageIds }) =>
      productionReadSourceBatch(accountId, sourceMessageIds),
    verifyReader: ({ accountId, targetChannelId, messageId }) =>
      productionVerifyReader(accountId, targetChannelId, messageId),
    verifyReaderBatch: ({ accountId, targetChannelId, messageIds }) =>
      productionVerifyReaderBatch(accountId, targetChannelId, messageIds),
  };
}

function resultMapping(operation: TelegramOperation, result: MigrationMediaResult) {
  return {
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

async function ensureOperation(job: StorageMigrationJob, item: StorageMigrationItem): Promise<TelegramOperation> {
  if (item.operation_id) return api.getTelegramOperation(item.operation_id);
  const sourceAccountId = sourceNumber(item, 'telegram_user_id');
  return api.createTelegramOperation({
    operation_id: generateOperationId(item),
    kind: 'migration',
    logical_file_id: item.file_id,
    group_id: item.group_id,
    part_index: item.part_index ?? null,
    uploader_id: sourceAccountId,
    target_kind: 'channel',
    target_channel_id: job.target_channel_id,
    target_peer_key: job.target_channel_id,
    created_target_version: job.target_version,
    created_accounts_version: job.accounts_version,
    random_id: generateRandomId(),
    rpc_kind: 'messages.forwardMessages',
    request_metadata: { source: item.source_location },
  });
}

async function markOperationSending(operation: TelegramOperation): Promise<TelegramOperation> {
  if (operation.state === 'planned' || operation.state === 'retryable') {
    return api.patchTelegramOperation(operation.operation_id, {
      expected_operation_version: operation.version,
      state: 'sending',
    });
  }
  return operation;
}

async function attachAndLease(
  item: StorageMigrationItem,
  operation: TelegramOperation,
  leaseOwner: string,
  requestedState?: string,
): Promise<StorageMigrationItem> {
  return api.claimMigrationItem({
    migrationId: item.migration_id,
    itemId: item.item_id,
    expectedVersion: item.version,
    leaseOwner,
    leaseSeconds: LEASE_SECONDS,
    operationId: operation.operation_id,
    state: requestedState,
  });
}

async function persistResult(operation: TelegramOperation, result: MigrationMediaResult): Promise<TelegramOperation> {
  const { mapping, mediaIdentity } = resultMapping(operation, result);
  return api.persistReconciledOperationResult({
    operationId: operation.operation_id,
    expectedOperationVersion: operation.version,
    mapping,
    mediaIdentity,
  });
}

type PreparedForward = {
  item: StorageMigrationItem;
  leased: StorageMigrationItem;
  operation: TelegramOperation;
  sourceAccountId: number;
  sourceMessageId: number;
};

async function prepareFreshForward(
  job: StorageMigrationJob,
  item: StorageMigrationItem,
  leaseOwner: string,
): Promise<PreparedForward> {
  let operation = await ensureOperation(job, item);
  const leased = await attachAndLease(item, operation, leaseOwner);
  operation = await markOperationSending(operation);
  const sourceAccountId = sourceNumber(item, 'telegram_user_id');
  const sourceMessageId = sourceNumber(item, 'telegram_message_id');
  await new RecoveryCursorStore().save({
    ownerId: sourceAccountId,
    operationId: operation.operation_id,
    randomId: operation.random_id,
    uploaderId: sourceAccountId,
    targetPeerKey: job.target_channel_id,
    phase: 'rpc_started',
  });
  return { item, leased, operation, sourceAccountId, sourceMessageId };
}

async function sendPreparedBatch(
  job: StorageMigrationJob,
  prepared: PreparedForward[],
): Promise<StorageMigrationItem[]> {
  if (prepared.length < 1 || prepared.length > FORWARD_BATCH_SIZE) {
    throw new Error(`Migration forward batch must contain 1-${FORWARD_BATCH_SIZE} items`);
  }
  const sourceAccountId = prepared[0].sourceAccountId;
  if (prepared.some((entry) => entry.sourceAccountId !== sourceAccountId)) {
    throw new Error('Migration forward batch may not mix source accounts');
  }
  let results: MigrationMediaResult[];
  try {
    results = await telegramAdapter().forwardBatch({
      accountId: sourceAccountId,
      targetChannelId: job.target_channel_id,
      entries: prepared.map((entry) => ({
        sourceMessageId: entry.sourceMessageId,
        randomId: entry.operation.random_id,
      })),
    });
  } catch (error) {
    throw new MigrationForwardBatchError(error);
  }
  if (results.length !== prepared.length) {
    throw new Error(`Migration forward result count mismatch: expected ${prepared.length}, got ${results.length}`);
  }

  const reconciled: StorageMigrationItem[] = [];
  for (let index = 0; index < prepared.length; index++) {
    const entry = prepared[index];
    const persisted = await persistResult(entry.operation, results[index]);
    if (persisted.result_version == null) throw new Error('Migration result is not durable');
    reconciled.push(await api.reconcileMigrationItem({
      migrationId: entry.item.migration_id,
      itemId: entry.item.item_id,
      expectedItemVersion: entry.leased.version,
      operationResultVersion: persisted.result_version,
    }));
  }
  return reconciled;
}

async function parkTransientForwardBatch(
  prepared: PreparedForward[],
  leaseOwner: string,
  error: unknown,
  leaseSeconds: number,
): Promise<StorageMigrationItem[]> {
  const detail = forwardErrorText(error).slice(0, 1024) || 'Transient Telegram forward failure';
  const parked: StorageMigrationItem[] = [];
  for (const entry of prepared) {
    try {
      await api.patchTelegramOperation(entry.operation.operation_id, {
        expected_operation_version: entry.operation.version,
        state: 'retryable',
        error_code: detail.slice(0, 255),
      });
    } catch (operationError) {
      if (!isConflict(operationError)) {
        console.warn('[Migration] Failed to mark operation retryable:', entry.operation.operation_id, operationError);
      }
    }
    try {
      parked.push(await api.claimMigrationItem({
        migrationId: entry.item.migration_id,
        itemId: entry.item.item_id,
        expectedVersion: entry.leased.version,
        leaseOwner,
        leaseSeconds,
        operationId: entry.operation.operation_id,
        state: 'retryable',
        error: detail,
      }));
    } catch (itemError) {
      if (!isConflict(itemError)) {
        console.warn('[Migration] Failed to park item after transient forward error:', entry.item.item_id, itemError);
      }
      parked.push(entry.leased);
    }
  }
  return parked;
}

async function recoverWithoutBlindSend(
  job: StorageMigrationJob,
  item: StorageMigrationItem,
  operation: TelegramOperation,
): Promise<StorageMigrationItem> {
  const result = await telegramAdapter().readDestination({
    accountId: operation.uploader_id,
    targetChannelId: job.target_channel_id,
    randomId: operation.random_id,
    messageId: operation.destination_message_id,
  });
  if (!result) return item;
  const persisted = await persistResult(operation, result);
  if (persisted.result_version == null) throw new Error('Recovered migration result is not durable');
  return api.reconcileMigrationItem({
    migrationId: item.migration_id,
    itemId: item.item_id,
    expectedItemVersion: item.version,
    operationResultVersion: persisted.result_version,
  });
}

async function forwardItem(
  job: StorageMigrationJob,
  item: StorageMigrationItem,
  leaseOwner: string,
): Promise<StorageMigrationItem> {
  let operation = await ensureOperation(job, item);
  let leased = item;
  if (!item.operation_id || !['sending', 'recovering'].includes(item.state)) {
    leased = await attachAndLease(item, operation, leaseOwner);
  }
  operation = await markOperationSending(operation);

  const sourceAccountId = sourceNumber(item, 'telegram_user_id');
  const sourceMessageId = sourceNumber(item, 'telegram_message_id');
  await new RecoveryCursorStore().save({
    ownerId: sourceAccountId,
    operationId: operation.operation_id,
    randomId: operation.random_id,
    uploaderId: sourceAccountId,
    targetPeerKey: job.target_channel_id,
    phase: 'rpc_started',
  });

  const result = await telegramAdapter().forward({
    accountId: sourceAccountId,
    sourceMessageId,
    targetChannelId: job.target_channel_id,
    randomId: operation.random_id,
  });
  const persisted = await persistResult(operation, result);
  if (persisted.result_version == null) throw new Error('Migration result is not durable');
  return api.reconcileMigrationItem({
    migrationId: item.migration_id,
    itemId: item.item_id,
    expectedItemVersion: leased.version,
    operationResultVersion: persisted.result_version,
  });
}

function sameMedia(result: MigrationMediaResult, operation: TelegramOperation): boolean {
  return result.messageId === operation.destination_message_id
    && result.mediaKind === operation.destination_media_kind
    && result.mediaId === operation.destination_media_id
    && result.size === operation.destination_size
    && (result.photoVariant ?? null) === (operation.destination_photo_variant ?? null);
}

async function collectEvidenceBatch(
  job: StorageMigrationJob,
  items: StorageMigrationItem[],
): Promise<StorageMigrationItem[]> {
  if (items.length === 0) return [];
  const currentByItem = new Map(items.map((item) => [item.item_id, item]));
  const operations = new Map<string, TelegramOperation>();
  await Promise.all(items.map(async (item) => {
    if (!item.operation_id) return;
    const operation = await api.getTelegramOperation(item.operation_id);
    if (operation.result_version != null && operation.destination_message_id != null) {
      operations.set(item.item_id, operation);
    }
  }));

  const accounts = await api.listAccounts();
  const adapter = telegramAdapter();
  for (const account of accounts) {
    const candidates = items.flatMap((original) => {
      const current = currentByItem.get(original.item_id) ?? original;
      const operation = operations.get(original.item_id);
      if (!operation) return [];
      if (current.evidence.some((row) => row.telegram_user_id === account.telegram_user_id
        && row.result_version === operation.result_version)) return [];
      return [{ item: current, operation }];
    });
    if (candidates.length === 0) continue;

    const results = await adapter.verifyReaderBatch({
      accountId: account.telegram_user_id,
      targetChannelId: job.target_channel_id,
      messageIds: candidates.map(({ operation }) => operation.destination_message_id!),
    });
    if (results.length !== candidates.length) {
      throw new Error(`Migration verification result count mismatch: expected ${candidates.length}, got ${results.length}`);
    }

    const sourceCandidates = candidates.filter(({ item }) =>
      sourceNumber(item, 'telegram_user_id') === account.telegram_user_id);
    const sourceResults = sourceCandidates.length > 0
      ? await adapter.readSourceBatch({
        accountId: account.telegram_user_id,
        sourceMessageIds: sourceCandidates.map(({ item }) => sourceNumber(item, 'telegram_message_id')),
      })
      : [];
    if (sourceResults.length !== sourceCandidates.length) {
      throw new Error(`Migration source verification result count mismatch: expected ${sourceCandidates.length}, got ${sourceResults.length}`);
    }
    const sourceOk = new Map(sourceCandidates.map(({ item }, index) => [
      item.item_id,
      sourceResults[index]?.ok === true,
    ]));

    for (let index = 0; index < candidates.length; index++) {
      const { item: original, operation } = candidates[index];
      const result = results[index];
      if (!result || !sameMedia(result, operation)) continue;
      const current = currentByItem.get(original.item_id) ?? original;
      const updated = await api.putMigrationEvidence({
        migrationId: job.migration_id,
        itemId: current.item_id,
        telegramUserId: account.telegram_user_id,
        evidence: {
          expected_item_version: current.version,
          result_version: operation.result_version!,
          target_channel_id: job.target_channel_id,
          destination_message_id: operation.destination_message_id!,
          media_kind: operation.destination_media_kind as 'document' | 'photo',
          media_id: operation.destination_media_id!,
          size_bytes: operation.destination_size!,
          photo_variant: result.photoVariant ?? null,
          read_probe_ok: true,
          checked_at: new Date().toISOString(),
          source_read_probe_ok: sourceOk.get(current.item_id) ?? false,
        },
      });
      currentByItem.set(updated.item_id, updated);
    }
  }

  return items.map((item) => currentByItem.get(item.item_id) ?? item);
}

async function processItem(
  job: StorageMigrationJob,
  item: StorageMigrationItem,
  leaseOwner: string,
): Promise<StorageMigrationItem> {
  if (['applied', 'rolled_back', 'blocked', 'failed'].includes(item.state)) return item;
  let current = item;
  if (item.state === 'uncertain') {
    if (!item.operation_id) return item;
    current = await recoverWithoutBlindSend(job, item, await api.getTelegramOperation(item.operation_id));
    if (current.state === 'uncertain') return current;
  } else if (['planned', 'retryable'].includes(item.state)) {
    current = await forwardItem(job, item, leaseOwner);
  } else if (['sending', 'recovering'].includes(item.state)) {
    if (!item.operation_id) return item;
    const operation = await api.getTelegramOperation(item.operation_id);
    current = await recoverWithoutBlindSend(job, item, operation);
    if (current.state === item.state) {
      // Sending/recovering may safely replay the same persisted random id only.
      current = await forwardItem(job, item, leaseOwner);
    }
  }
  return current;
}

function expectedVersions(group: StorageMigrationGroup): Record<string, number> {
  return Object.fromEntries(group.items.map(item => [item.item_id, item.version]));
}

export function pauseMigrationJob(jobId: string): void {
  const control = activeRuns.get(jobId);
  if (control) control.pauseRequested = true;
}

export async function runMigrationJob(
  jobId: string,
  onProgress?: (progress: MigrationRunProgress) => void,
): Promise<StorageMigrationJob> {
  let job = await api.getMigrationJob(jobId);
  if (job.dry_run || ['completed', 'rolled_back'].includes(job.state)) return job;

  const control: RunControl = { runId: `browser:${crypto.randomUUID()}`, pauseRequested: false };
  activeRuns.set(jobId, control);
  onProgress?.({ phase: 'running' });

  const claimWindow = async (): Promise<StorageMigrationGroup[]> => {
    const claimed: StorageMigrationGroup[] = [];
    let itemCount = 0;
    while (!control.pauseRequested && itemCount < FORWARD_BATCH_SIZE) {
      const page = await api.listMigrationGroups({
        migrationId: jobId,
        scope: 'runnable',
        limit: GROUP_PAGE_SIZE,
      });
      if (page.groups.length === 0) break;

      let claimedAny = false;
      for (const candidate of page.groups) {
        if (control.pauseRequested) break;
        if (claimed.length > 0 && itemCount + candidate.items.length > FORWARD_BATCH_SIZE) break;
        try {
          const result = await api.claimMigrationGroup({
            migrationId: jobId,
            groupId: candidate.group_id,
            expectedItemVersions: expectedVersions(candidate),
            leaseOwner: control.runId,
            leaseSeconds: LEASE_SECONDS,
          });
          claimed.push(result.group);
          itemCount += result.group.items.length;
          job = result.job;
          claimedAny = true;
          if (itemCount >= FORWARD_BATCH_SIZE) break;
        } catch (error) {
          if (!isConflict(error)) throw error;
          job = await api.getMigrationJob(jobId);
        }
      }
      if (!claimedAny) break;
    }
    return claimed;
  };

  try {
    while (!control.pauseRequested) {
      const claimedGroups = await claimWindow();
      if (claimedGroups.length === 0) break;

      const currentByItem = new Map<string, StorageMigrationItem>();
      const prepared: PreparedForward[] = [];
      const skippedGroupIds = new Set<string>();

      for (const group of claimedGroups) {
        for (const item of group.items) {
          if (control.pauseRequested) break;
          onProgress?.({
            phase: 'running',
            currentGroupId: group.group_id,
            currentSourceAccount: sourceNumber(item, 'telegram_user_id'),
          });
          if (['planned', 'retryable'].includes(item.state)) {
            const entry = await prepareFreshForward(job, item, control.runId);
            prepared.push(entry);
            currentByItem.set(item.item_id, entry.leased);
          } else {
            currentByItem.set(item.item_id, await processItem(job, item, control.runId));
          }
        }
        if (control.pauseRequested) break;
      }
      if (control.pauseRequested) break;

      const bySource = new Map<number, PreparedForward[]>();
      for (const entry of prepared) {
        const bucket = bySource.get(entry.sourceAccountId) ?? [];
        bucket.push(entry);
        bySource.set(entry.sourceAccountId, bucket);
      }

      for (const entries of bySource.values()) {
        for (let offset = 0; offset < entries.length; offset += FORWARD_BATCH_SIZE) {
          if (control.pauseRequested) break;
          const chunk = entries.slice(offset, offset + FORWARD_BATCH_SIZE);
          try {
            const reconciled = await sendPreparedBatch(job, chunk);
            reconciled.forEach((item) => currentByItem.set(item.item_id, item));
          } catch (error) {
            if (!(error instanceof MigrationForwardBatchError)) throw error;
            const leaseSeconds = transientForwardLeaseSeconds(error.original);
            if (leaseSeconds == null) throw error.original;
            const parked = await parkTransientForwardBatch(chunk, control.runId, error.original, leaseSeconds);
            parked.forEach((item) => currentByItem.set(item.item_id, item));
            chunk.forEach((entry) => skippedGroupIds.add(entry.item.group_id));
            onProgress?.({
              phase: 'running',
              currentGroupId: chunk[0]?.item.group_id,
              currentSourceAccount: chunk[0]?.sourceAccountId,
              lastError: `Skipped transient forward batch (${chunk.length} items): ${forwardErrorText(error.original)}`,
            });
            console.warn(`[Migration] Skipped transient forward batch x${chunk.length}; retry in ~${leaseSeconds}s`, error.original);
          }
        }
        if (control.pauseRequested) break;
      }
      if (control.pauseRequested) break;

      const evidenceCandidates = claimedGroups
        .flatMap((group) => group.items.map((item) => currentByItem.get(item.item_id) ?? item))
        .filter((item) => ['forwarded', 'pending_quorum', 'verified'].includes(item.state));
      const evidenced = await collectEvidenceBatch(job, evidenceCandidates);
      evidenced.forEach((item) => currentByItem.set(item.item_id, item));

      for (const group of claimedGroups) {
        if (skippedGroupIds.has(group.group_id)) continue;
        const processed = group.items.map((item) => currentByItem.get(item.item_id) ?? item);
        if (processed.length > 0 && processed.every((item) => item.state === 'verified')) {
          job = await api.getMigrationJob(jobId);
          try {
            const result = await api.commitMigrationGroup({
              migrationId: jobId,
              groupId: group.group_id,
              expectedJobVersion: job.version,
              expectedItemVersions: Object.fromEntries(processed.map((item) => [item.item_id, item.version])),
            });
            job = result.job;
            result.group.items.forEach((item) => currentByItem.set(item.item_id, item));
          } catch (error) {
            if (!isConflict(error)) throw error;
            job = await api.getMigrationJob(jobId);
          }
        } else {
          // Re-lease incomplete groups after reconcile clears item leases. This
          // parks quorum/recovery work so the next bounded page can advance to
          // later groups instead of spinning on the same first 25 groups.
          try {
            const result = await api.claimMigrationGroup({
              migrationId: jobId,
              groupId: group.group_id,
              expectedItemVersions: Object.fromEntries(processed.map((item) => [item.item_id, item.version])),
              leaseOwner: control.runId,
              leaseSeconds: LEASE_SECONDS,
            });
            job = result.job;
            result.group.items.forEach((item) => currentByItem.set(item.item_id, item));
          } catch (error) {
            if (!isConflict(error)) throw error;
            job = await api.getMigrationJob(jobId);
          }
        }
      }
      if (job.state === 'completed') break;
    }

    job = await api.getMigrationJob(jobId);
    if (control.pauseRequested) onProgress?.({ phase: 'paused' });
    else onProgress?.({ phase: 'idle' });
    return job;
  } catch (error) {
    onProgress?.({
      phase: control.pauseRequested ? 'paused' : 'idle',
      lastError: (error as any)?.response?.data?.detail ?? (error as Error)?.message ?? String(error),
    });
    if (isConflict(error)) return api.getMigrationJob(jobId);
    throw error;
  } finally {
    if (activeRuns.get(jobId) === control) activeRuns.delete(jobId);
  }
}

export function resumeMigrationJob(
  jobId: string,
  onProgress?: (progress: MigrationRunProgress) => void,
): Promise<StorageMigrationJob> {
  return runMigrationJob(jobId, onProgress);
}

async function refreshRollbackEvidence(
  job: StorageMigrationJob,
  item: StorageMigrationItem,
): Promise<StorageMigrationItem> {
  if (!item.operation_id) throw new Error(`Applied migration item ${item.item_id} has no operation`);
  const operation = await api.getTelegramOperation(item.operation_id);
  if (operation.result_version == null || operation.destination_message_id == null) {
    throw new Error(`Applied migration item ${item.item_id} has no durable result`);
  }
  const sourceAccount = sourceNumber(item, 'telegram_user_id');
  const adapter = telegramAdapter();
  const destination = await adapter.verifyReader({
    accountId: sourceAccount,
    targetChannelId: job.target_channel_id,
    messageId: operation.destination_message_id,
  });
  const source = await adapter.readSource({
    accountId: sourceAccount,
    sourceMessageId: sourceNumber(item, 'telegram_message_id'),
  });
  if (!destination || !sameMedia(destination, operation) || !source.ok) {
    throw new Error(`Rollback source verification failed for ${item.item_id}`);
  }
  return api.putMigrationEvidence({
    migrationId: job.migration_id,
    itemId: item.item_id,
    telegramUserId: sourceAccount,
    evidence: {
      expected_item_version: item.version,
      result_version: operation.result_version,
      target_channel_id: job.target_channel_id,
      destination_message_id: operation.destination_message_id,
      media_kind: operation.destination_media_kind as 'document' | 'photo',
      media_id: operation.destination_media_id!,
      size_bytes: operation.destination_size!,
      photo_variant: destination.photoVariant ?? null,
      read_probe_ok: true,
      checked_at: new Date().toISOString(),
      source_read_probe_ok: true,
    },
  });
}

export async function rollbackMigrationJob(
  jobId: string,
  onProgress?: (progress: MigrationRunProgress) => void,
): Promise<StorageMigrationJob> {
  let job = await api.getMigrationJob(jobId);
  let after: string | undefined;
  onProgress?.({ phase: 'running' });
  try {
    while (true) {
      const page = await api.listMigrationGroups({
        migrationId: jobId,
        scope: 'applied',
        limit: GROUP_PAGE_SIZE,
        after,
      });
      if (page.groups.length === 0) break;
      for (const group of page.groups) {
        onProgress?.({ phase: 'running', currentGroupId: group.group_id });
        const verified: StorageMigrationItem[] = [];
        for (const item of group.items) verified.push(await refreshRollbackEvidence(job, item));
        const result = await api.rollbackMigrationGroup({
          migrationId: jobId,
          groupId: group.group_id,
          expectedLocationVersions: Object.fromEntries(verified.map(item => [
            item.item_id,
            item.applied_location_version ?? item.expected_location_version + 1,
          ])),
        });
        job = result.job;
      }
      if (!page.next_after) break;
      after = page.next_after;
    }
    onProgress?.({ phase: 'idle' });
    return await api.getMigrationJob(jobId);
  } catch (error) {
    onProgress?.({ phase: 'idle', lastError: (error as Error)?.message ?? String(error) });
    if (isConflict(error)) return api.getMigrationJob(jobId);
    throw error;
  }
}
