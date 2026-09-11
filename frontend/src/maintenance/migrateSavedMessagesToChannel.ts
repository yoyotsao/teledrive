import {
  api,
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

type MigrationTelegramHook = {
  forward(params: {
    accountId: number;
    sourceMessageId: number;
    targetChannelId: string;
    randomId: string;
  }): Promise<MigrationMediaResult>;
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
  verifyReader(params: {
    accountId: number;
    targetChannelId: string;
    messageId: number;
  }): Promise<MigrationMediaResult | null>;
};

declare global {
  interface Window {
    __TELEDRIVE_MIGRATION_TELEGRAM__?: MigrationTelegramHook;
  }
}

const LEASE_SECONDS = 60;

function isConflict(error: unknown): boolean {
  return Number((error as any)?.response?.status) === 409;
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

async function productionForward(
  accountId: number,
  sourceMessageId: number,
  targetChannelId: string,
  randomId: string,
): Promise<MigrationMediaResult> {
  const manager = getClientFor(accountId);
  if (manager.offline) throw new Error(`Source account ${accountId} is offline`);
  const peer = await resolveChannelPeerForAccount(manager as any, targetChannelId);
  if (!peer) throw new Error(`Channel ${targetChannelId} is unavailable to source account ${accountId}`);
  const result = await manager.forwardToTarget('me', sourceMessageId, peer, randomId);
  return {
    messageId: result.messageId,
    mediaKind: result.mediaKind,
    mediaId: result.mediaId,
    size: result.size,
    photoVariant: result.photoVariant ?? null,
  };
}

async function productionReadDestination(
  accountId: number,
  targetChannelId: string,
  messageId?: number | null,
): Promise<MigrationMediaResult | null> {
  if (!messageId) return null;
  const manager = getClientFor(accountId);
  if (manager.offline) return null;
  const peer = await resolveChannelPeerForAccount(manager as any, targetChannelId);
  const raw = (manager as any).client;
  if (!peer || !raw) return null;
  const messages = await raw.getMessages(peer, { ids: [messageId] });
  const message = messages?.[0];
  const media = message?.media ? readMedia(message.media) : null;
  if (!media) return null;
  return {
    messageId: message.id,
    mediaKind: media.kind,
    mediaId: media.id,
    size: media.size,
    photoVariant: media.kind === 'photo' ? media.fullThumbSize : null,
  };
}

async function productionReadSource(accountId: number, sourceMessageId: number): Promise<{ ok: boolean }> {
  const manager = getClientFor(accountId);
  if (manager.offline) return { ok: false };
  const raw = (manager as any).client;
  if (!raw) return { ok: false };
  const messages = await raw.getMessages('me', { ids: [sourceMessageId] });
  return { ok: Boolean(messages?.[0]?.media && readMedia(messages[0].media)) };
}

async function productionVerifyReader(
  accountId: number,
  targetChannelId: string,
  messageId: number,
): Promise<MigrationMediaResult | null> {
  const manager = getClientFor(accountId);
  if (manager.offline) return null;
  const verification = await validateChannelForAccount(manager as any, targetChannelId);
  if (!verification.can_read) return null;
  return productionReadDestination(accountId, targetChannelId, messageId);
}

function telegramAdapter(): MigrationTelegramHook {
  const hook = testHook();
  if (hook) return hook;
  return {
    forward: ({ accountId, sourceMessageId, targetChannelId, randomId }) =>
      productionForward(accountId, sourceMessageId, targetChannelId, randomId),
    readDestination: ({ accountId, targetChannelId, messageId }) =>
      productionReadDestination(accountId, targetChannelId, messageId),
    readSource: ({ accountId, sourceMessageId }) => productionReadSource(accountId, sourceMessageId),
    verifyReader: ({ accountId, targetChannelId, messageId }) =>
      productionVerifyReader(accountId, targetChannelId, messageId),
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
  const operation = await api.createTelegramOperation({
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
  return operation;
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
  requestedState?: string,
): Promise<StorageMigrationItem> {
  return api.claimMigrationItem({
    migrationId: item.migration_id,
    itemId: item.item_id,
    expectedVersion: item.version,
    leaseOwner: `browser:${operation.uploader_id}`,
    leaseSeconds: LEASE_SECONDS,
    operationId: operation.operation_id,
    state: requestedState,
  });
}

async function persistResult(
  operation: TelegramOperation,
  result: MigrationMediaResult,
): Promise<TelegramOperation> {
  const { mapping, mediaIdentity } = resultMapping(operation, result);
  return api.persistReconciledOperationResult({
    operationId: operation.operation_id,
    expectedOperationVersion: operation.version,
    mapping,
    mediaIdentity,
  });
}

async function recoverWithoutBlindSend(
  job: StorageMigrationJob,
  item: StorageMigrationItem,
  operation: TelegramOperation,
): Promise<StorageMigrationItem> {
  const adapter = telegramAdapter();
  const result = await adapter.readDestination({
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
): Promise<StorageMigrationItem> {
  let operation = await ensureOperation(job, item);
  let leased = item;
  if (!item.operation_id || !['sending', 'recovering'].includes(item.state)) {
    leased = await attachAndLease(item, operation);
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

async function collectEvidence(
  job: StorageMigrationJob,
  item: StorageMigrationItem,
): Promise<StorageMigrationItem> {
  if (!item.operation_id) return item;
  const operation = await api.getTelegramOperation(item.operation_id);
  if (operation.result_version == null || operation.destination_message_id == null) return item;
  const accounts = await api.listAccounts();
  const adapter = telegramAdapter();
  let current = item;

  for (const account of accounts) {
    if (current.evidence.some(row => row.telegram_user_id === account.telegram_user_id
      && row.result_version === operation.result_version)) continue;
    const result = await adapter.verifyReader({
      accountId: account.telegram_user_id,
      targetChannelId: job.target_channel_id,
      messageId: operation.destination_message_id,
    });
    if (!result || !sameMedia(result, operation)) continue;
    const sourceAccount = sourceNumber(item, 'telegram_user_id');
    const sourceProbe = account.telegram_user_id === sourceAccount
      ? await adapter.readSource({ accountId: sourceAccount, sourceMessageId: sourceNumber(item, 'telegram_message_id') })
      : { ok: false };
    current = await api.putMigrationEvidence({
      migrationId: job.migration_id,
      itemId: item.item_id,
      telegramUserId: account.telegram_user_id,
      evidence: {
        expected_item_version: current.version,
        result_version: operation.result_version,
        target_channel_id: job.target_channel_id,
        destination_message_id: operation.destination_message_id,
        media_kind: operation.destination_media_kind as 'document' | 'photo',
        media_id: operation.destination_media_id!,
        size_bytes: operation.destination_size!,
        photo_variant: result.photoVariant ?? null,
        read_probe_ok: true,
        checked_at: new Date().toISOString(),
        source_read_probe_ok: sourceProbe.ok,
      },
    });
  }
  return current;
}

async function processItem(job: StorageMigrationJob, item: StorageMigrationItem): Promise<StorageMigrationItem> {
  if (['applied', 'rolled_back', 'blocked', 'failed'].includes(item.state)) return item;
  let current = item;
  if (item.state === 'uncertain') {
    if (!item.operation_id) return item;
    current = await recoverWithoutBlindSend(job, item, await api.getTelegramOperation(item.operation_id));
    if (current.state === 'uncertain') return current;
  } else if (['planned', 'retryable'].includes(item.state)) {
    current = await forwardItem(job, item);
  } else if (['sending', 'recovering'].includes(item.state)) {
    if (!item.operation_id) return item;
    const operation = await api.getTelegramOperation(item.operation_id);
    current = await recoverWithoutBlindSend(job, item, operation);
    if (current.state === item.state) {
      // Sending/recovering may safely replay the *same persisted random id*.
      current = await forwardItem(job, item);
    }
  }
  if (['forwarded', 'pending_quorum', 'verified'].includes(current.state)) {
    current = await collectEvidence(job, current);
  }
  return current;
}

export async function runMigrationJob(jobId: string): Promise<StorageMigrationJob> {
  let job = await api.getMigrationJob(jobId);
  if (job.dry_run || ['completed', 'rolled_back'].includes(job.state)) return job;
  const groupIds = [...new Set(job.items.map(item => item.group_id))];

  try {
    for (const groupId of groupIds) {
      const group = job.items.filter(item => item.group_id === groupId);
      for (const item of group) await processItem(job, item);
      job = await api.getMigrationJob(jobId);
      const freshGroup = job.items.filter(item => item.group_id === groupId);
      if (freshGroup.length > 0 && freshGroup.every(item => item.state === 'verified')) {
        job = await api.commitMigrationGroup({
          migrationId: jobId,
          groupId,
          expectedJobVersion: job.version,
          expectedItemVersions: Object.fromEntries(freshGroup.map(item => [item.item_id, item.version])),
        });
      }
    }
    return await api.getMigrationJob(jobId);
  } catch (error) {
    if (isConflict(error)) return api.getMigrationJob(jobId);
    throw error;
  }
}

export function resumeMigrationJob(jobId: string): Promise<StorageMigrationJob> {
  return runMigrationJob(jobId);
}

export async function rollbackMigrationJob(jobId: string): Promise<StorageMigrationJob> {
  let job = await api.getMigrationJob(jobId);
  const groupIds = [...new Set(job.items.filter(item => item.state === 'applied').map(item => item.group_id))];
  try {
    for (const groupId of groupIds) {
      const items = job.items.filter(item => item.group_id === groupId && item.state === 'applied');
      job = await api.rollbackMigrationGroup({
        migrationId: jobId,
        groupId,
        expectedLocationVersions: Object.fromEntries(items.map(item => [
          item.item_id,
          item.applied_location_version ?? item.expected_location_version + 1,
        ])),
      });
    }
    return await api.getMigrationJob(jobId);
  } catch (error) {
    if (isConflict(error)) return api.getMigrationJob(jobId);
    throw error;
  }
}
